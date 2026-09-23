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
import { createLocalStableKey } from "@/database/utils/stable-key";
import { serverConfig } from "@/server.config";
import { MINUTE } from "@/server.constants";
import { ConflictError, NotFoundError } from "@/utils/errors";
import { MemoryCache } from "@/utils/memory-cache";
import { PathUtils } from "@/utils/path.utils";

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
		let cursor: string | undefined;
		for (;;) {
			const rows = await databaseFactory
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
				.limit(IMAGE_SWEEP_PAGE_SIZE);
			ids.push(...rows.map((row) => row.id));
			if (rows.length < IMAGE_SWEEP_PAGE_SIZE) break;

			const lastId = rows.at(-1)?.id;
			if (!lastId) break;

			cursor = lastId;
		}

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
		let cursor: string | undefined;
		for (;;) {
			const rows = await client
				.select({
					id: schema.images.id,
					localPath: schema.images.localPath,
				})
				.from(schema.images)
				.where(cursor ? gt(schema.images.id, cursor) : undefined)
				.orderBy(asc(schema.images.id))
				.limit(IMAGE_SWEEP_PAGE_SIZE);

			for (const row of rows) {
				if (row.localPath) localPaths.add(PathUtils.normalize(row.localPath));

				if (row.id) imageIds.add(row.id);
			}

			if (rows.length < IMAGE_SWEEP_PAGE_SIZE) break;

			const lastId = rows.at(-1)?.id;
			if (!lastId) break;

			cursor = lastId;
		}

		return { localPaths, imageIds };
	}

	async getMetadataTarget(metadataId: string, type: ImageProcess["type"]): Promise<ImageOwnerTarget> {
		const [metadata, currentLocalPath] = await Promise.all([
			metadataRepository.findById({
				primaryId: metadataId,
				fields: QueryFields.parse({ fields: "stableKey" }),
			}),
			this.findMetadataImagePath(metadataId, type),
		]);
		if (!metadata) throw new NotFoundError(`Metadata ${metadataId} does not exist`);

		return { ownerStableKey: metadata.stableKey, currentLocalPath };
	}

	async replaceMetadataImage(metadataId: string, type: ImageProcess["type"], image: PersistedImageInput) {
		await databaseFactory.transaction(async (tx) => {
			await this.assertMetadataExists(metadataId, tx);
			const previous = await databaseFactory
				.getClient({ tx })
				.select({ imageId: schema.metadataImages.imageId })
				.from(schema.metadataImages)
				.where(and(eq(schema.metadataImages.metadataId, metadataId), eq(schema.metadataImages.imageType, type)));
			const persisted = await this.upsertImage(image, tx);
			await metadataRepository.deleteImages({
				where: and(eq(schema.metadataImages.metadataId, metadataId), eq(schema.metadataImages.imageType, type)),
				tx,
			});
			await metadataRepository.insertImages({ values: { metadataId, imageId: persisted.id, imageType: type }, tx });
			for (const row of previous) {
				if (row.imageId !== persisted.id) await this.deleteImageIfUnreferenced(row.imageId, tx);
			}
		});
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
				) THEN 1 ELSE 0 END`,
			})
			.from(schema.images)
			.where(eq(schema.images.id, imageId))
			.limit(1);
		if (row?.referenced) return;

		await client.delete(schema.images).where(eq(schema.images.id, imageId));
		this.fileReadCache.delete(imageId);
	}

	async getSeasonTarget(metadataId: string, seasonId: string): Promise<ImageOwnerTarget> {
		const season = await seasonsRepository.findByPrimaryId({
			primaryId: seasonId,
			fields: QueryFields.parse({ fields: "metadataId,imageId,stableKey" }),
		});
		if (!season || season.metadataId !== metadataId)
			throw new NotFoundError(`Season ${seasonId} does not belong to metadata ${metadataId}`);

		return {
			ownerStableKey: season.stableKey,
			currentLocalPath: await this.findImagePath(season.imageId),
		};
	}

	async replaceSeasonImage(metadataId: string, seasonId: string, image: PersistedImageInput) {
		await databaseFactory.transaction(async (tx) => {
			const season = await seasonsRepository.findByPrimaryId({
				primaryId: seasonId,
				fields: QueryFields.parse({ fields: "metadataId,imageId" }),
				tx,
			});
			if (!season || season.metadataId !== metadataId)
				throw new NotFoundError(`Season ${seasonId} does not belong to metadata ${metadataId}`);

			const persisted = await this.upsertImage(image, tx);
			await seasonsRepository.update({ primaryId: seasonId, values: { imageId: persisted.id }, tx });
			if (season.imageId && season.imageId !== persisted.id) await this.deleteImageIfUnreferenced(season.imageId, tx);
		});
	}

	async getEpisodeTarget(metadataId: string, episodeId: string): Promise<ImageOwnerTarget> {
		const client = databaseFactory.getClient();
		const [row] = await client
			.select({
				stableKey: schema.episodes.stableKey,
				imageId: schema.episodes.imageId,
			})
			.from(schema.episodes)
			.innerJoin(schema.seasons, eq(schema.seasons.id, schema.episodes.seasonId))
			.where(and(eq(schema.episodes.id, episodeId), eq(schema.seasons.metadataId, metadataId)))
			.limit(1);

		if (!row) throw new NotFoundError(`Episode ${episodeId} does not belong to metadata ${metadataId}`);

		return {
			ownerStableKey: row.stableKey,
			currentLocalPath: await this.findImagePath(row.imageId),
		};
	}

	async replaceEpisodeImage(metadataId: string, episodeId: string, image: PersistedImageInput) {
		await databaseFactory.transaction(async (tx) => {
			const client = databaseFactory.getClient({ tx });
			const [row] = await client
				.select({ id: schema.episodes.id, imageId: schema.episodes.imageId })
				.from(schema.episodes)
				.innerJoin(schema.seasons, eq(schema.seasons.id, schema.episodes.seasonId))
				.where(and(eq(schema.episodes.id, episodeId), eq(schema.seasons.metadataId, metadataId)))
				.limit(1);

			if (!row) throw new NotFoundError(`Episode ${episodeId} does not belong to metadata ${metadataId}`);

			const persisted = await this.upsertImage(image, tx);
			await episodesRepository.update({ primaryId: episodeId, values: { imageId: persisted.id }, tx });
			if (row.imageId && row.imageId !== persisted.id) await this.deleteImageIfUnreferenced(row.imageId, tx);
		});
	}

	async getPersonTarget(personId: string): Promise<ImageOwnerTarget> {
		const person = await peopleRepository.findByPrimaryId({
			primaryId: personId,
			fields: QueryFields.parse({ fields: "stableKey,imageId" }),
		});
		if (!person) throw new NotFoundError(`Person ${personId} does not exist`);

		return {
			ownerStableKey: person.stableKey,
			currentLocalPath: await this.findImagePath(person.imageId),
		};
	}

	async replacePersonImage(personId: string, image: PersistedImageInput) {
		await databaseFactory.transaction(async (tx) => {
			const person = await peopleRepository.findByPrimaryId({
				primaryId: personId,
				fields: QueryFields.parse({ fields: "imageId" }),
				tx,
			});
			if (!person) throw new NotFoundError(`Person ${personId} does not exist`);

			const persisted = await this.upsertImage(image, tx);
			await peopleRepository.update({ primaryId: personId, values: { imageId: persisted.id }, tx });
			if (person.imageId && person.imageId !== persisted.id) await this.deleteImageIfUnreferenced(person.imageId, tx);
		});
	}

	async getProfileAvatarTarget(profileId: string): Promise<ImageOwnerTarget> {
		if (!(await profilesRepository.isExists({ primaryId: profileId }))) throw new NotFoundError(`Profile ${profileId} does not exist`);

		return { ownerStableKey: createLocalStableKey({ namespace: "profile", value: profileId }) };
	}

	async replaceProfileAvatar(profileId: string, image: PersistedImageInput): Promise<{ imageId: string; avatarUrl: string }> {
		return await databaseFactory.transaction(async (tx) => {
			if (!(await profilesRepository.isExists({ primaryId: profileId, tx })))
				throw new NotFoundError(`Profile ${profileId} does not exist`);

			const persisted = await this.upsertImage(image, tx);
			const avatarUrl = `/v1/images/${persisted.id}`;
			await profilesRepository.update({ primaryId: profileId, values: { avatarUrl }, tx });

			return { imageId: persisted.id, avatarUrl };
		});
	}

	private async assertMetadataExists(metadataId: string, tx?: DatabaseTransaction) {
		if (!(await metadataRepository.isExists({ primaryId: metadataId, tx })))
			throw new NotFoundError(`Metadata ${metadataId} does not exist`);
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
			.innerJoin(schema.images, eq(schema.images.id, schema.metadataImages.imageId))
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
		const optimizationVersion = serverConfig.images.currentOptimizationVersion;
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
