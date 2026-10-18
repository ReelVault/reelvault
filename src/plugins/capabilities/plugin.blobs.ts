import type { PluginBlob, PluginBlobMetadata, PluginBlobWriteOptions } from "@reelvault/sdk/plugin";
import { file } from "bun";
import { type PluginBlobRow, type PluginBlobTransaction, pluginBlobData } from "@/app/plugins/plugin-data.service";
import { serverConfig } from "@/config/server/server.config";
import { contentByteSize, createDirectoryOnce, writeFileWithRollback } from "@/plugins/shared/plugin.file-record.utils";
import { KeyedMutex } from "@/utils/concurrency.utils";
import { DomainError } from "@/utils/domain.errors";
import { FileUtils } from "@/utils/file.utils";
import { createLogger } from "@/utils/logger.utils";
import { PathUtils } from "@/utils/path.utils";
import { PromiseUtils } from "@/utils/promise.utils";
import { isExpired } from "@/utils/time.utils";
import { assertPluginBlobWrite } from "./plugin.blobs.validator";
import { assertStorageKey } from "./plugin.storage.validator";

class PluginBlobsService {
	readonly serviceName = "PluginBlobsService";
	readonly logger = createLogger("PluginBlobsService");

	private readonly operationQueue = new KeyedMutex();
	/** Creates the blob storage directory once per process instead of on every put(). */
	private readonly ensureStorageDirectory = createDirectoryOnce(
		serverConfig.paths.pluginBlobs,
		() =>
			new DomainError("validation", `Failed to create plugin blob storage directory: ${serverConfig.paths.pluginBlobs}`, {
				code: "plugin.blobs_storage_failed",
			}),
	);

	async put(pluginId: string, key: string, content: Blob | Uint8Array, options: PluginBlobWriteOptions): Promise<PluginBlobMetadata> {
		assertStorageKey(key);
		assertPluginBlobWrite(content, options);

		return await this.operationQueue.runExclusive(pluginId, async () => {
			await this.removeExpiredForPluginKey(pluginId, key);
			const size = contentByteSize(content);

			const storageKey = crypto.randomUUID();
			const now = new Date();
			const expiresAt = new Date(now.getTime() + options.expiresInMs);
			await this.ensureStorageDirectory();

			let current: PluginBlobRow | undefined;
			await pluginBlobData.transaction(async (tx) => {
				current = await pluginBlobData.findEntry(pluginId, key, tx);
				await this.assertWithinPluginQuota(pluginId, size, current, tx);
				await writeFileWithRollback(this.storagePath(storageKey), content, () =>
					pluginBlobData.set(
						{
							pluginId,
							key,
							storageKey,
							contentType: options.contentType,
							size,
							expiresAt,
							createdAt: now,
							updatedAt: now,
						},
						tx,
					),
				);
			});

			if (current) await FileUtils.delete(this.storagePath(current.storageKey));

			return { key, contentType: options.contentType, size, createdAt: now.toISOString(), expiresAt: expiresAt.toISOString() };
		});
	}

	async get(pluginId: string, key: string): Promise<PluginBlob | undefined> {
		assertStorageKey(key);

		return await this.operationQueue.runExclusive(pluginId, async (): Promise<PluginBlob | undefined> => {
			const entry = await pluginBlobData.findEntry(pluginId, key);
			if (!entry) return undefined;

			if (isExpired(entry.expiresAt)) {
				await this.deleteEntry(entry);

				return undefined;
			}

			const content = file(this.storagePath(entry.storageKey));
			if (!(await content.exists())) {
				await pluginBlobData.delete(pluginId, key);

				return undefined;
			}

			return { ...this.toMetadata(entry), content };
		});
	}

	async delete(pluginId: string, key: string): Promise<void> {
		assertStorageKey(key);
		await this.operationQueue.runExclusive(pluginId, async () => {
			const entry = await pluginBlobData.findEntry(pluginId, key);
			if (entry) await this.deleteEntry(entry);
		});
	}

	async removeForPlugin(pluginId: string): Promise<void> {
		await this.operationQueue.runExclusive(pluginId, async () => {
			// Page by key so a plugin with many tiny blobs is never loaded at once.
			// Rows are deleted page-by-page (before their files), keeping the
			// delete-then-unlink ordering of the previous implementation.
			const pageSize = serverConfig.database.queryChunkSize;
			let afterKey: string | undefined;
			for (;;) {
				const page = await pluginBlobData.findByPlugin(pluginId, { afterKey, limit: pageSize });
				if (page.length === 0) break;

				const keys = page.map((entry) => entry.key);
				await pluginBlobData.deleteByKeys(pluginId, keys);
				await PromiseUtils.mapConcurrent(page, serverConfig.plugins.blobs.cleanupConcurrency, (entry) =>
					FileUtils.delete(this.storagePath(entry.storageKey)),
				);

				if (page.length < pageSize) break;

				afterKey = keys[keys.length - 1];
			}
		});
	}

	async purgeExpired(signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		const pageSize = serverConfig.database.queryChunkSize;
		// Each page's `deleteEntry` removes its rows, so repeated calls make progress.
		for (;;) {
			const entries = await pluginBlobData.findExpired(new Date(), pageSize);
			if (entries.length === 0) break;

			await PromiseUtils.mapConcurrent(
				entries,
				serverConfig.plugins.blobs.cleanupConcurrency,
				(entry) =>
					this.operationQueue.runExclusive(entry.pluginId, async () => {
						const current = await pluginBlobData.findEntry(entry.pluginId, entry.key);
						if (current?.storageKey === entry.storageKey) await this.deleteEntry(current);
					}),
				signal,
			);

			if (entries.length < pageSize) break;

			signal?.throwIfAborted();
		}
	}

	private async assertWithinPluginQuota(
		pluginId: string,
		newEntrySize: number,
		replacing: PluginBlobRow | undefined,
		tx: PluginBlobTransaction,
	): Promise<void> {
		const totalSize = (await pluginBlobData.sumSizeByPlugin(pluginId, tx)) - (replacing?.size ?? 0) + newEntrySize;
		if (totalSize > serverConfig.plugins.blobs.maxStorageBytes) {
			throw new DomainError("validation", `Plugin blob storage must not exceed ${serverConfig.plugins.blobs.maxStorageBytes} bytes`, {
				code: "plugin.blobs_quota_exceeded",
				params: { maxBytes: serverConfig.plugins.blobs.maxStorageBytes },
			});
		}
	}

	private async removeExpiredForPluginKey(pluginId: string, key: string): Promise<void> {
		const entry = await pluginBlobData.findEntry(pluginId, key);
		if (entry && isExpired(entry.expiresAt)) await this.deleteEntry(entry);
	}

	private async deleteEntry(entry: PluginBlobRow): Promise<void> {
		await pluginBlobData.delete(entry.pluginId, entry.key);
		await FileUtils.delete(this.storagePath(entry.storageKey));
	}

	private toMetadata(entry: PluginBlobRow): PluginBlobMetadata {
		return {
			key: entry.key,
			contentType: entry.contentType,
			size: entry.size,
			createdAt: entry.createdAt.toISOString(),
			expiresAt: entry.expiresAt.toISOString(),
		};
	}

	private storagePath(storageKey: string): string {
		return PathUtils.join(serverConfig.paths.pluginBlobs, storageKey);
	}
}

export const pluginBlobsService = new PluginBlobsService();
