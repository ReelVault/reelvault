import { and, asc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { MINUTE, serverConstants } from "@/config/server/server.constants";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { collectKeysetPages } from "@/integrations/drizzle-orm/query/keyset/keyset-pages.utils";
import { parseFields } from "@/integrations/drizzle-orm/query/parsing/fields.parser";
import { defineRepository, defineTableAccess } from "@/integrations/drizzle-orm/query/table-access/table-access.factory";
import { metadataImageOn } from "@/integrations/drizzle-orm/utils/join-conditions.utils";
import { createLocalStableKey } from "@/integrations/drizzle-orm/utils/stable-key.utils";
import type { ImageOwnerTarget, ImageProcess, PersistedImageInput } from "@/modules/images/images.ports";
import { episodesRepository } from "@/repositories/episodes.repository";
import { metadataRepository } from "@/repositories/metadata.repository";
import { peopleRepository } from "@/repositories/people.repository";
import { profilesRepository } from "@/repositories/profiles.repository";
import { seasonsRepository } from "@/repositories/seasons.repository";
import { assertExists, DomainError } from "@/utils/domain.errors";
import { MemoryCache } from "@/utils/memory.cache";
import { normalizePath } from "@/utils/path.utils";

/** Public image URL prefix embedded in `profiles.avatar_url`. */
const AVATAR_URL_IMAGE_PREFIX = "/v1/images/";

/** Keyset page size for image sweep queries (optimization candidates, orphan scan). */
const IMAGE_SWEEP_PAGE_SIZE = 1000;

const IMAGE_FILE_CACHE_TTL_MS = 30 * MINUTE;
const IMAGE_FILE_CACHE_MAX_ENTRIES = 5000;

const images = defineTableAccess("images", { primaryKeyColumn: "id" });

const fileReadCache = new MemoryCache<{ localPath: string; contentType: string }>({
	ttlMs: IMAGE_FILE_CACHE_TTL_MS,
	maxSize: IMAGE_FILE_CACHE_MAX_ENTRIES,
	name: "image-file-read",
});

const overrides = {
	async findForFileRead(imageId: string): Promise<{ localPath: string; contentType: string } | undefined> {
		const cached = fileReadCache.get(imageId);
		if (cached) return cached;

		const result = await images.findById({ primaryId: imageId, fields: parseFields({ fields: "localPath,contentType" }) });
		if (result?.localPath && result.contentType) {
			const entry = { localPath: result.localPath, contentType: result.contentType };
			fileReadCache.set(imageId, entry);

			return entry;
		}

		return undefined;
	},

	async deleteAndReturn(imageId: string) {
		fileReadCache.delete(imageId);

		return await images.deleteAndReturn({ primaryId: imageId });
	},

	async findOutdatedImageIds(currentVersion: number) {
		// Keyset-paged sweep — the optimization worker only needs the id list, but a
		// single SELECT over a huge library would pin the event loop.
		const ids: string[] = [];
		await collectKeysetPages({
			pageSize: IMAGE_SWEEP_PAGE_SIZE,
			fetchPage: (cursor) =>
				databaseFactory
					.getClient()
					.select({ id: schema.images.id })
					.from(schema.images)
					.where(
						and(
							or(isNull(schema.images.optimizationVersion), lt(schema.images.optimizationVersion, currentVersion)),
							cursor ? gt(schema.images.id, cursor) : undefined,
						),
					)
					.orderBy(asc(schema.images.id))
					.limit(IMAGE_SWEEP_PAGE_SIZE),
			onPage: (rows) => {
				ids.push(...rows.map((row) => row.id));
			},
		});

		return ids;
	},

	async findImageOptimizationCandidate(imageId: string, currentVersion: number) {
		const client = databaseFactory.getClient();
		const [row] = await client
			.select({
				id: schema.images.id,
				localPath: schema.images.localPath,
				width: schema.images.width,
				height: schema.images.height,
				fileSize: schema.images.fileSize,
			})
			.from(schema.images)
			.where(
				and(
					eq(schema.images.id, imageId),
					or(isNull(schema.images.optimizationVersion), lt(schema.images.optimizationVersion, currentVersion)),
				),
			)
			.limit(1);

		return row;
	},

	async markImageOptimizationVersion(
		imageId: string,
		currentVersion: number,
		values: { width?: number | null; height?: number | null; fileSize?: number | null } = {},
	) {
		await images.update({ primaryId: imageId, values: { optimizationVersion: currentVersion, ...values } });
	},

	async findAllImageStorageIdentifiers(tx?: DatabaseTransaction): Promise<{ localPaths: Set<string>; imageIds: Set<string> }> {
		const client = databaseFactory.getClient({ tx });
		const localPaths = new Set<string>();
		const imageIds = new Set<string>();

		// Keyset-paged sweep — orphan detection still needs the full set, but the
		// query must not materialize every row in one go.
		await collectKeysetPages({
			pageSize: IMAGE_SWEEP_PAGE_SIZE,
			fetchPage: (cursor) =>
				client
					.select({
						id: schema.images.id,
						localPath: schema.images.localPath,
					})
					.from(schema.images)
					.where(cursor ? gt(schema.images.id, cursor) : undefined)
					.orderBy(asc(schema.images.id))
					.limit(IMAGE_SWEEP_PAGE_SIZE),
			onPage: (rows) => {
				for (const row of rows) {
					if (row.localPath) localPaths.add(normalizePath(row.localPath));

					if (row.id) imageIds.add(row.id);
				}
			},
		});

		return { localPaths, imageIds };
	},

	async getMetadataTarget(metadataId: string, type: ImageProcess["type"]): Promise<ImageOwnerTarget> {
		const [metadata, currentLocalPath] = await Promise.all([
			findMetadataForImage(metadataId),
			getImageRepository().findMetadataImagePath(metadataId, type),
		]);

		return { ownerStableKey: metadata.stableKey, currentLocalPath };
	},

	/**
	 * Shared image replacement for an owner row: load the owner (its specific
	 * not-found/ownership error stays in the loader), upsert the image, let the
	 * owner-specific writer persist the new id, then purge stale image rows that
	 * nothing references anymore.
	 */

	async replaceMetadataImage(metadataId: string, type: ImageProcess["type"], image: PersistedImageInput) {
		await replaceOwnerImage(
			image,
			async (tx) => await findMetadataForImage(metadataId, tx),
			async (_metadata, persisted, tx) => {
				const previous = await databaseFactory
					.getClient({ tx })
					.select({ imageId: schema.metadataImages.imageId })
					.from(schema.metadataImages)
					.where(and(eq(schema.metadataImages.metadataId, metadataId), eq(schema.metadataImages.imageType, type)));
				await metadataRepository.deleteImages({
					where: and(eq(schema.metadataImages.metadataId, metadataId), eq(schema.metadataImages.imageType, type)),
					tx,
				});
				await metadataRepository.insertImages({ values: { metadataId, imageId: persisted.id, imageType: type }, tx });

				return previous.map((row) => row.imageId);
			},
		);
	},

	/**
	 * Removes an image row nothing points at anymore (join table or nullable
	 * owner pointers). Without this, a replaced image row keeps protecting its
	 * file from the orphan purge forever. The file itself is reaped by
	 * `purgeOrphanedImages` once the row is gone.
	 */

	/** Target of an owner row that points at one image (season, episode, person). */

	async getSeasonTarget(metadataId: string, seasonId: string): Promise<ImageOwnerTarget> {
		const season = await findSeasonOwnedBy(metadataId, seasonId);

		return await ownerTarget(season.stableKey, season.imageId);
	},

	/** Replaces the single image an owner row points at; the image it held before is purged when unreferenced. */

	async replaceSeasonImage(metadataId: string, seasonId: string, image: PersistedImageInput) {
		await replaceReferencedImage(
			image,
			async (tx) => await findSeasonOwnedBy(metadataId, seasonId, tx),
			(imageId, tx) => seasonsRepository.update({ primaryId: seasonId, values: { imageId }, tx }),
		);
	},

	async getEpisodeTarget(metadataId: string, episodeId: string): Promise<ImageOwnerTarget> {
		const row = await findEpisodeOwnedBy(metadataId, episodeId);

		return await ownerTarget(row.stableKey, row.imageId);
	},

	async replaceEpisodeImage(metadataId: string, episodeId: string, image: PersistedImageInput) {
		await replaceReferencedImage(
			image,
			async (tx) => await findEpisodeOwnedBy(metadataId, episodeId, tx),
			(imageId, tx) => episodesRepository.update({ primaryId: episodeId, values: { imageId }, tx }),
		);
	},

	async getPersonTarget(personId: string): Promise<ImageOwnerTarget> {
		const person = await findPersonForImage(personId);

		return await ownerTarget(person.stableKey, person.imageId);
	},

	async replacePersonImage(personId: string, image: PersistedImageInput) {
		await replaceReferencedImage(
			image,
			async (tx) => await findPersonForImage(personId, tx),
			(imageId, tx) => peopleRepository.update({ primaryId: personId, values: { imageId }, tx }),
		);
	},

	async getProfileAvatarTarget(profileId: string): Promise<ImageOwnerTarget> {
		assertExists(
			await profilesRepository.isExists({ primaryId: profileId }),
			"Profile",
			profileId,
			new DomainError("not_found", `Profile ${profileId} does not exist`, { code: "profile.not_found" }),
		);

		return { ownerStableKey: createLocalStableKey({ namespace: "profile", value: profileId }) };
	},

	async replaceProfileAvatar(profileId: string, image: PersistedImageInput): Promise<{ imageId: string; avatarUrl: string }> {
		const replaced = await databaseFactory.transaction(
			async (tx) => {
				const client = databaseFactory.getClient({ tx });
				const [profile] = await client
					.select({ id: schema.profiles.id, avatarUrl: schema.profiles.avatarUrl })
					.from(schema.profiles)
					.where(eq(schema.profiles.id, profileId))
					.limit(1);
				if (!profile) throw new DomainError("not_found", `Profile ${profileId} does not exist`, { code: "profile.not_found" });

				const persisted = await upsertImage(image, tx);
				const avatarUrl = `${AVATAR_URL_IMAGE_PREFIX}${persisted.id}`;
				await profilesRepository.update({ primaryId: profileId, values: { avatarUrl }, tx });

				// The replaced avatar row (and file) would otherwise leak forever —
				// profiles are not part of the generic owner-collection path.
				const previousImageId = profile.avatarUrl?.startsWith(AVATAR_URL_IMAGE_PREFIX)
					? profile.avatarUrl.slice(AVATAR_URL_IMAGE_PREFIX.length)
					: undefined;
				if (previousImageId && previousImageId !== persisted.id) {
					await deleteImageIfUnreferenced(previousImageId, tx);
				}

				return { imageId: persisted.id, avatarUrl };
			},
			{ immediate: true },
		);
		// The auth hot path caches the profile for a few seconds; drop it only after the commit
		// so a concurrent read cannot repopulate the cache with the old avatar.
		profilesRepository.invalidateCached(profileId);

		return replaced;
	},

	async findMetadataImagePath(metadataId: string, imageType: ImageProcess["type"], tx?: DatabaseTransaction) {
		const [row] = await databaseFactory
			.getClient({ tx })
			.select({ localPath: schema.images.localPath })
			.from(schema.metadataImages)
			.innerJoin(schema.images, metadataImageOn)
			.where(and(eq(schema.metadataImages.metadataId, metadataId), eq(schema.metadataImages.imageType, imageType)))
			.limit(1);

		return row?.localPath;
	},
};

export const imageRepository = defineRepository(images, overrides);

/** Methods dispatch through the singleton: the lint rule forbids referencing the const before its definition. */
function getImageRepository() {
	return imageRepository;
}

async function findMetadataForImage(metadataId: string, tx?: DatabaseTransaction) {
	const metadata = await metadataRepository.findById({
		primaryId: metadataId,
		fields: parseFields({ fields: "stableKey" }),
		tx,
	});
	if (!metadata) throw new DomainError("not_found", `Metadata ${metadataId} does not exist`, { code: "metadata.not_found" });

	return metadata;
}

async function replaceOwnerImage<TOwner>(
	image: PersistedImageInput,
	loadOwner: (tx: DatabaseTransaction) => Promise<TOwner>,
	applyImage: (owner: TOwner, persisted: typeof schema.images.$inferSelect, tx: DatabaseTransaction) => Promise<string[]>,
): Promise<void> {
	await databaseFactory.transaction(
		async (tx) => {
			const owner = await loadOwner(tx);
			const persisted = await upsertImage(image, tx);
			const staleImageIds = await applyImage(owner, persisted, tx);
			for (const staleImageId of staleImageIds) {
				if (staleImageId !== persisted.id) await deleteImageIfUnreferenced(staleImageId, tx);
			}
		},
		{ immediate: true },
	);
}

async function deleteImageIfUnreferenced(imageId: string, tx: DatabaseTransaction): Promise<void> {
	const client = databaseFactory.getClient({ tx });
	// One EXISTS probe per referencing table instead of five round-trips per image.
	const [row] = await client
		.select({
			referenced: sql<number>`CASE WHEN (
				EXISTS(SELECT 1 FROM ${schema.metadataImages} WHERE ${schema.metadataImages.imageId} = ${imageId})
				OR EXISTS(SELECT 1 FROM ${schema.seasons} WHERE ${schema.seasons.imageId} = ${imageId})
				OR EXISTS(SELECT 1 FROM ${schema.episodes} WHERE ${schema.episodes.imageId} = ${imageId})
				OR EXISTS(SELECT 1 FROM ${schema.people} WHERE ${schema.people.imageId} = ${imageId})
				OR EXISTS(SELECT 1 FROM ${schema.companies} WHERE ${schema.companies.imageId} = ${imageId})
				OR EXISTS(SELECT 1 FROM ${schema.profiles} WHERE ${schema.profiles.avatarUrl} = ${AVATAR_URL_IMAGE_PREFIX} || ${imageId})
			) THEN 1 ELSE 0 END`,
		})
		.from(schema.images)
		.where(eq(schema.images.id, imageId))
		.limit(1);
	if (row?.referenced) return;

	await client.delete(schema.images).where(eq(schema.images.id, imageId));
	fileReadCache.delete(imageId);
}

async function findSeasonOwnedBy(metadataId: string, seasonId: string, tx?: DatabaseTransaction) {
	const season = await seasonsRepository.findByPrimaryId({
		primaryId: seasonId,
		fields: parseFields({ fields: "metadataId,imageId,stableKey" }),
		tx,
	});
	if (!season || season.metadataId !== metadataId)
		throw new DomainError("not_found", `Season ${seasonId} does not belong to metadata ${metadataId}`, { code: "season.not_found" });

	return season;
}

async function ownerTarget(stableKey: string, imageId: string | null): Promise<ImageOwnerTarget> {
	return { ownerStableKey: stableKey, currentLocalPath: await findImagePath(imageId) };
}

async function replaceReferencedImage<TOwner extends { imageId: string | null }>(
	image: PersistedImageInput,
	loadOwner: (tx: DatabaseTransaction) => Promise<TOwner>,
	pointOwnerAt: (imageId: string, tx: DatabaseTransaction) => Promise<unknown>,
): Promise<void> {
	await replaceOwnerImage(image, loadOwner, async (owner, persisted, tx) => {
		await pointOwnerAt(persisted.id, tx);

		return owner.imageId ? [owner.imageId] : [];
	});
}

async function findEpisodeOwnedBy(metadataId: string, episodeId: string, tx?: DatabaseTransaction) {
	const client = databaseFactory.getClient({ tx });
	const [row] = await client
		.select({ stableKey: schema.episodes.stableKey, imageId: schema.episodes.imageId })
		.from(schema.episodes)
		.innerJoin(schema.seasons, eq(schema.seasons.id, schema.episodes.seasonId))
		.where(and(eq(schema.episodes.id, episodeId), eq(schema.seasons.metadataId, metadataId)))
		.limit(1);

	if (!row)
		throw new DomainError("not_found", `Episode ${episodeId} does not belong to metadata ${metadataId}`, { code: "episode.not_found" });

	return row;
}

async function findPersonForImage(personId: string, tx?: DatabaseTransaction) {
	const person = await peopleRepository.findByPrimaryId({
		primaryId: personId,
		fields: parseFields({ fields: "stableKey,imageId" }),
		tx,
	});
	if (!person) throw new DomainError("not_found", `Person ${personId} does not exist`, { code: "person.not_found" });

	return person;
}

async function findImagePath(imageId: string | null | undefined, tx?: DatabaseTransaction): Promise<string | undefined> {
	if (!imageId) return undefined;

	const image = await images.findById({ primaryId: imageId, fields: parseFields({ fields: "localPath" }), tx });

	return image?.localPath;
}

async function upsertImage(image: PersistedImageInput, tx?: DatabaseTransaction) {
	// Serialize the select→update/insert so a concurrent upsert cannot race the
	// check and produce a unique-constraint failure.
	if (tx) return await upsertImageOnce(image, tx);

	return await databaseFactory.transaction(async (innerTx) => await upsertImageOnce(image, innerTx));
}

async function upsertImageOnce(image: PersistedImageInput, tx: DatabaseTransaction) {
	const { sourceHash: _sourceHash, ...values } = image;
	const optimizationVersion = serverConstants.images.currentOptimizationVersion;
	const client = databaseFactory.getClient({ tx });
	const [existing] = await client
		.select({ id: images.table.id })
		.from(images.table)
		.where(or(eq(images.table.stableKey, image.stableKey), eq(images.table.localPath, image.localPath)))
		.limit(1);

	if (existing) {
		const [updated] = await client
			.update(images.table)
			.set({ ...values, optimizationVersion, updatedAt: new Date() })
			.where(eq(images.table.id, existing.id))
			.returning();
		if (updated) return updated;
	}

	const [persisted] = await client
		.insert(images.table)
		.values({ ...values, optimizationVersion })
		.returning();
	if (!persisted) throw new DomainError("internal", `Failed to save image: ${image.localPath}`, { code: "images.save_failed" });

	return persisted;
}
