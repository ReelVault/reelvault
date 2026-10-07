import type { FieldsConfig, Image, SelectFields } from "@reelvault/sdk/common";
import { and, asc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { episodesRepository } from "@/database/repositories/episodes.repository";
import { metadataRepository } from "@/database/repositories/metadata.repository";
import { peopleRepository } from "@/database/repositories/people.repository";
import { profilesRepository } from "@/database/repositories/profiles.repository";
import { seasonsRepository } from "@/database/repositories/seasons.repository";
import { schema } from "@/database/schema";
import { defineTableAccess } from "@/database/table-access";
import type { DatabaseTransaction } from "@/database/types";
import { QueryFields } from "@/database/utils/fields";
import { metadataImageOn } from "@/database/utils/join-conditions";
import { collectKeysetPages } from "@/database/utils/keyset-pages";
import { createLocalStableKey } from "@/database/utils/stable-key";
import { MINUTE, serverConstants } from "@/server.constants";
import { ConflictError, NotFoundError } from "@/utils/errors";
import { MemoryCache } from "@/utils/memory-cache";
import { PathUtils } from "@/utils/path.utils";

/** Public image URL prefix embedded in `profiles.avatar_url`. */
const AVATAR_URL_IMAGE_PREFIX = "/v1/images/";

export interface ImageProcess {
	url?: string | undefined;
	type: "poster" | "backdrop";
}

/** Keyset page size for image sweep queries (optimization candidates, orphan scan). */
const IMAGE_SWEEP_PAGE_SIZE = 1000;

export interface PersistedImageInput {
	localPath: string;
	contentType: string;
	width: number;
	height: number;
	fileSize: number;
	sourceHash: string;
	stableKey: string;
}

export interface ImageOwnerTarget {
	ownerStableKey: string;
	currentLocalPath?: string | undefined;
}

const IMAGE_FILE_CACHE_TTL_MS = 30 * MINUTE;
const IMAGE_FILE_CACHE_MAX_ENTRIES = 5000;

const images = defineTableAccess("images", { primaryKeyColumn: "id" });

class ImageRepository {
	readonly table = schema.images;
	readonly primaryKeyColumn = images.primaryKeyColumn;
	readonly query = images.query;
	readonly selectMany = images.selectMany;
	readonly selectFirst = images.selectFirst;
	readonly findOrCreate = images.findOrCreate;
	readonly insert = images.insert;
	readonly update = images.update;
	readonly count = images.count;
	readonly isExists = images.isExists;
	readonly delete = images.delete;
	readonly insertReturning = images.insertReturning;
	readonly updateReturning = images.updateReturning;
	readonly updateAndReturn = images.updateAndReturn;
	readonly deleteReturning = images.deleteReturning;
	readonly findByIds = images.findByIds;
	readonly findByColumnIn = images.findByColumnIn;

	private readonly fileReadCache = new MemoryCache<{ localPath: string; contentType: string }>({
		ttlMs: IMAGE_FILE_CACHE_TTL_MS,
		maxSize: IMAGE_FILE_CACHE_MAX_ENTRIES,
		name: "image-file-read",
	});

	async findById<F extends string>({
		primaryId,
		fields,
		tx,
	}: {
		primaryId: string;
		fields?: FieldsConfig<F> | undefined;
		tx?: DatabaseTransaction | undefined;
	}): Promise<SelectFields<Image, F> | undefined> {
		const image = await this.selectFirst({ where: eq(this.primaryKeyColumn, primaryId), tx });

		return image ? QueryFields.apply(image, fields) : undefined;
	}

	async findForFileRead(imageId: string): Promise<{ localPath: string; contentType: string } | undefined> {
		const cached = this.fileReadCache.get(imageId);
		if (cached) return cached;

		const result = await this.findById({ primaryId: imageId, fields: QueryFields.parse({ fields: "localPath,contentType" }) });
		if (result?.localPath && result.contentType) {
			const entry = { localPath: result.localPath, contentType: result.contentType };
			this.fileReadCache.set(imageId, entry);

			return entry;
		}

		return undefined;
	}

	async deleteAndReturn(imageId: string) {
		this.fileReadCache.delete(imageId);

		return await images.deleteAndReturn({ primaryId: imageId });
	}

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
	}

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
	}

	async markImageOptimizationVersion(
		imageId: string,
		currentVersion: number,
		values: { width?: number | null; height?: number | null; fileSize?: number | null } = {},
	) {
		await this.update({ primaryId: imageId, values: { optimizationVersion: currentVersion, ...values } });
	}

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
					if (row.localPath) localPaths.add(PathUtils.normalize(row.localPath));

					if (row.id) imageIds.add(row.id);
				}
			},
		});

		return { localPaths, imageIds };
	}

	private async findMetadataForImage(metadataId: string, tx?: DatabaseTransaction) {
		const metadata = await metadataRepository.findById({
			primaryId: metadataId,
			fields: QueryFields.parse({ fields: "stableKey" }),
			tx,
		});
		if (!metadata) throw new NotFoundError(`Metadata ${metadataId} does not exist`);

		return metadata;
	}

	async getMetadataTarget(metadataId: string, type: ImageProcess["type"]): Promise<ImageOwnerTarget> {
		const [metadata, currentLocalPath] = await Promise.all([
			this.findMetadataForImage(metadataId),
			this.findMetadataImagePath(metadataId, type),
		]);

		return { ownerStableKey: metadata.stableKey, currentLocalPath };
	}

	/**
	 * Shared image replacement for an owner row: load the owner (its specific
	 * not-found/ownership error stays in the loader), upsert the image, let the
	 * owner-specific writer persist the new id, then purge stale image rows that
	 * nothing references anymore.
	 */
	private async replaceOwnerImage<TOwner>(
		image: PersistedImageInput,
		loadOwner: (tx: DatabaseTransaction) => Promise<TOwner>,
		applyImage: (owner: TOwner, persisted: typeof schema.images.$inferSelect, tx: DatabaseTransaction) => Promise<string[]>,
	): Promise<void> {
		await databaseFactory.transaction(
			async (tx) => {
				const owner = await loadOwner(tx);
				const persisted = await this.upsertImage(image, tx);
				const staleImageIds = await applyImage(owner, persisted, tx);
				for (const staleImageId of staleImageIds) {
					if (staleImageId !== persisted.id) await this.deleteImageIfUnreferenced(staleImageId, tx);
				}
			},
			{ immediate: true },
		);
	}

	async replaceMetadataImage(metadataId: string, type: ImageProcess["type"], image: PersistedImageInput) {
		await this.replaceOwnerImage(
			image,
			async (tx) => await this.findMetadataForImage(metadataId, tx),
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
	}

	/**
	 * Removes an image row nothing points at anymore (join table or nullable
	 * owner pointers). Without this, a replaced image row keeps protecting its
	 * file from the orphan purge forever. The file itself is reaped by
	 * `purgeOrphanedImages` once the row is gone.
	 */
	private async deleteImageIfUnreferenced(imageId: string, tx: DatabaseTransaction): Promise<void> {
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
		this.fileReadCache.delete(imageId);
	}

	private async findSeasonOwnedBy(metadataId: string, seasonId: string, tx?: DatabaseTransaction) {
		const season = await seasonsRepository.findByPrimaryId({
			primaryId: seasonId,
			fields: QueryFields.parse({ fields: "metadataId,imageId,stableKey" }),
			tx,
		});
		if (!season || season.metadataId !== metadataId)
			throw new NotFoundError(`Season ${seasonId} does not belong to metadata ${metadataId}`);

		return season;
	}

	async getSeasonTarget(metadataId: string, seasonId: string): Promise<ImageOwnerTarget> {
		const season = await this.findSeasonOwnedBy(metadataId, seasonId);

		return {
			ownerStableKey: season.stableKey,
			currentLocalPath: await this.findImagePath(season.imageId),
		};
	}

	async replaceSeasonImage(metadataId: string, seasonId: string, image: PersistedImageInput) {
		await this.replaceOwnerImage(
			image,
			async (tx) => await this.findSeasonOwnedBy(metadataId, seasonId, tx),
			async (season, persisted, tx) => {
				await seasonsRepository.update({ primaryId: seasonId, values: { imageId: persisted.id }, tx });

				return season.imageId ? [season.imageId] : [];
			},
		);
	}

	private async findEpisodeOwnedBy(metadataId: string, episodeId: string, tx?: DatabaseTransaction) {
		const client = databaseFactory.getClient({ tx });
		const [row] = await client
			.select({ stableKey: schema.episodes.stableKey, imageId: schema.episodes.imageId })
			.from(schema.episodes)
			.innerJoin(schema.seasons, eq(schema.seasons.id, schema.episodes.seasonId))
			.where(and(eq(schema.episodes.id, episodeId), eq(schema.seasons.metadataId, metadataId)))
			.limit(1);

		if (!row) throw new NotFoundError(`Episode ${episodeId} does not belong to metadata ${metadataId}`);

		return row;
	}

	async getEpisodeTarget(metadataId: string, episodeId: string): Promise<ImageOwnerTarget> {
		const row = await this.findEpisodeOwnedBy(metadataId, episodeId);

		return {
			ownerStableKey: row.stableKey,
			currentLocalPath: await this.findImagePath(row.imageId),
		};
	}

	async replaceEpisodeImage(metadataId: string, episodeId: string, image: PersistedImageInput) {
		await this.replaceOwnerImage(
			image,
			async (tx) => await this.findEpisodeOwnedBy(metadataId, episodeId, tx),
			async (row, persisted, tx) => {
				await episodesRepository.update({ primaryId: episodeId, values: { imageId: persisted.id }, tx });

				return row.imageId ? [row.imageId] : [];
			},
		);
	}

	private async findPersonForImage(personId: string, tx?: DatabaseTransaction) {
		const person = await peopleRepository.findByPrimaryId({
			primaryId: personId,
			fields: QueryFields.parse({ fields: "stableKey,imageId" }),
			tx,
		});
		if (!person) throw new NotFoundError(`Person ${personId} does not exist`);

		return person;
	}

	async getPersonTarget(personId: string): Promise<ImageOwnerTarget> {
		const person = await this.findPersonForImage(personId);

		return {
			ownerStableKey: person.stableKey,
			currentLocalPath: await this.findImagePath(person.imageId),
		};
	}

	async replacePersonImage(personId: string, image: PersistedImageInput) {
		await this.replaceOwnerImage(
			image,
			async (tx) => await this.findPersonForImage(personId, tx),
			async (person, persisted, tx) => {
				await peopleRepository.update({ primaryId: personId, values: { imageId: persisted.id }, tx });

				return person.imageId ? [person.imageId] : [];
			},
		);
	}

	async getProfileAvatarTarget(profileId: string): Promise<ImageOwnerTarget> {
		if (!(await profilesRepository.isExists({ primaryId: profileId }))) throw new NotFoundError(`Profile ${profileId} does not exist`);

		return { ownerStableKey: createLocalStableKey({ namespace: "profile", value: profileId }) };
	}

	async replaceProfileAvatar(profileId: string, image: PersistedImageInput): Promise<{ imageId: string; avatarUrl: string }> {
		return await databaseFactory.transaction(
			async (tx) => {
				const client = databaseFactory.getClient({ tx });
				const [profile] = await client
					.select({ id: schema.profiles.id, avatarUrl: schema.profiles.avatarUrl })
					.from(schema.profiles)
					.where(eq(schema.profiles.id, profileId))
					.limit(1);
				if (!profile) throw new NotFoundError(`Profile ${profileId} does not exist`);

				const persisted = await this.upsertImage(image, tx);
				const avatarUrl = `/v1/images/${persisted.id}`;
				await profilesRepository.update({ primaryId: profileId, values: { avatarUrl }, tx });

				// The replaced avatar row (and file) would otherwise leak forever —
				// profiles are not part of the generic owner-collection path.
				const previousImageId = profile.avatarUrl?.startsWith(AVATAR_URL_IMAGE_PREFIX)
					? profile.avatarUrl.slice(AVATAR_URL_IMAGE_PREFIX.length)
					: undefined;
				if (previousImageId && previousImageId !== persisted.id) {
					await this.deleteImageIfUnreferenced(previousImageId, tx);
				}

				return { imageId: persisted.id, avatarUrl };
			},
			{ immediate: true },
		);
	}

	private async findImagePath(imageId: string | null | undefined, tx?: DatabaseTransaction): Promise<string | undefined> {
		const image = imageId ? await this.findById({ primaryId: imageId, fields: QueryFields.parse({ fields: "localPath" }), tx }) : undefined;

		return image?.localPath;
	}

	async findMetadataImagePath(metadataId: string, imageType: ImageProcess["type"], tx?: DatabaseTransaction) {
		const [row] = await databaseFactory
			.getClient({ tx })
			.select({ localPath: schema.images.localPath })
			.from(schema.metadataImages)
			.innerJoin(schema.images, metadataImageOn)
			.where(and(eq(schema.metadataImages.metadataId, metadataId), eq(schema.metadataImages.imageType, imageType)))
			.limit(1);

		return row?.localPath;
	}

	private async upsertImage(image: PersistedImageInput, tx?: DatabaseTransaction) {
		// Serialize the select→update/insert so a concurrent upsert cannot race the
		// check and produce a unique-constraint failure.
		if (tx) return await this.upsertImageOnce(image, tx);

		return await databaseFactory.transaction(async (innerTx) => await this.upsertImageOnce(image, innerTx));
	}

	private async upsertImageOnce(image: PersistedImageInput, tx: DatabaseTransaction) {
		const { sourceHash: _sourceHash, ...values } = image;
		const optimizationVersion = serverConstants.images.currentOptimizationVersion;
		const client = databaseFactory.getClient({ tx });
		const [existing] = await client
			.select({ id: this.table.id })
			.from(this.table)
			.where(or(eq(this.table.stableKey, image.stableKey), eq(this.table.localPath, image.localPath)))
			.limit(1);

		if (existing) {
			const [updated] = await client
				.update(this.table)
				.set({ ...values, optimizationVersion, updatedAt: new Date() })
				.where(eq(this.table.id, existing.id))
				.returning();
			if (updated) return updated;
		}

		const [persisted] = await client
			.insert(this.table)
			.values({ ...values, optimizationVersion })
			.returning();
		if (!persisted) throw new ConflictError(`Failed to save image: ${image.localPath}`);

		return persisted;
	}
}

export const imageRepository = new ImageRepository();
