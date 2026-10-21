import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import type { DatabaseTransaction, InferTable } from "@/integrations/drizzle-orm/database.types";
import type { PrimaryIdReadParams } from "@/integrations/drizzle-orm/query/primary-id.reader";
import { libraryProviderSettingsRepository } from "@/repositories/library-provider-settings.repository";
import { mediaRepository } from "@/repositories/media-files.repository";
import { mediaMarkersRepository } from "@/repositories/media-markers.repository";
import { metadataRepository } from "@/repositories/metadata.repository";
import { metadataProviderSettingsRepository } from "@/repositories/metadata-provider-settings.repository";
import { pluginRepositoriesRepository } from "@/repositories/plugin-repositories.repository";
import { pluginBlobsRepository, pluginStorageRepository } from "@/repositories/plugin-storage.repository";
import { pluginUiOverridesRepository } from "@/repositories/plugin-ui-overrides.repository";
import { subtitleProviderSettingsRepository } from "@/repositories/subtitle-provider-settings.repository";
import { subtitlesRepository } from "@/repositories/subtitles.repository";
import { usersRepository } from "@/repositories/users.repository";

// Plugin capabilities read and write through these facades, never through repositories.
// Each member calls the repository at call time, so the repositories are not touched at import.

export type { MetadataProviderSetting } from "@/repositories/metadata-provider-settings.repository";
export type PluginBlobRow = InferTable<"pluginBlobs">;
export type PluginBlobTransaction = DatabaseTransaction;

export const pluginStorageData = {
	findValue: (...args: Parameters<typeof pluginStorageRepository.find>) => pluginStorageRepository.find(...args),
	set: (...args: Parameters<typeof pluginStorageRepository.set>) => pluginStorageRepository.set(...args),
	delete: (...args: Parameters<typeof pluginStorageRepository.delete>) => pluginStorageRepository.delete(...args),
	findKeysByPlugin: (...args: Parameters<typeof pluginStorageRepository.findKeysByPlugin>) =>
		pluginStorageRepository.findKeysByPlugin(...args),
	deleteForPlugin: (...args: Parameters<typeof pluginStorageRepository.deleteForPlugin>) =>
		pluginStorageRepository.deleteForPlugin(...args),
};

export const pluginBlobData = {
	transaction: async <T>(callback: (tx: DatabaseTransaction) => Promise<T>): Promise<T> => await databaseFactory.transaction(callback),
	findEntry: (...args: Parameters<typeof pluginBlobsRepository.find>) => pluginBlobsRepository.find(...args),
	set: (...args: Parameters<typeof pluginBlobsRepository.set>) => pluginBlobsRepository.set(...args),
	delete: (...args: Parameters<typeof pluginBlobsRepository.delete>) => pluginBlobsRepository.delete(...args),
	findByPlugin: (...args: Parameters<typeof pluginBlobsRepository.findByPlugin>) => pluginBlobsRepository.findByPlugin(...args),
	deleteByKeys: (...args: Parameters<typeof pluginBlobsRepository.deleteByKeys>) => pluginBlobsRepository.deleteByKeys(...args),
	findExpired: (...args: Parameters<typeof pluginBlobsRepository.findExpired>) => pluginBlobsRepository.findExpired(...args),
	sumSizeByPlugin: (...args: Parameters<typeof pluginBlobsRepository.sumSizeByPlugin>) => pluginBlobsRepository.sumSizeByPlugin(...args),
};

export const pluginMediaData = {
	findByPrimaryId: <F extends string>(params: PrimaryIdReadParams<F>) => mediaRepository.findByPrimaryId(params),
	findForPlaybackSession: (mediaFileId: string) => mediaRepository.findForPlaybackSession(mediaFileId),
	isExists: (...args: Parameters<typeof mediaRepository.isExists>) => mediaRepository.isExists(...args),
	findEpisodeFileRows: () => mediaRepository.findEpisodeFileRowsForPlugins(),
	findFileRowsPage: (options: { limit: number; offset: number }) => mediaRepository.findFileRowsPageForPlugins(options),
};

export const pluginMetadataData = {
	findById: <F extends string>(params: PrimaryIdReadParams<F>) => metadataRepository.findById(params),
	findByProviderExternalIds: (...args: Parameters<typeof metadataRepository.findByProviderExternalIds>) =>
		metadataRepository.findByProviderExternalIds(...args),
};

export const pluginMarkerData = {
	findByMediaFileIdAndPlugin: (...args: Parameters<typeof mediaMarkersRepository.findByMediaFileIdAndPlugin>) =>
		mediaMarkersRepository.findByMediaFileIdAndPlugin(...args),
	replaceMarkersForMediaFile: (...args: Parameters<typeof mediaMarkersRepository.replaceMarkersForMediaFile>) =>
		mediaMarkersRepository.replaceMarkersForMediaFile(...args),
};

export const pluginSubtitleData = {
	findExternalByMediaFileAndLanguage: (...args: Parameters<typeof subtitlesRepository.findExternalByMediaFileAndLanguage>) =>
		subtitlesRepository.findExternalByMediaFileAndLanguage(...args),
	findByPrimaryId: <F extends string>(params: PrimaryIdReadParams<F>) => subtitlesRepository.findByPrimaryId(params),
	update: (...args: Parameters<typeof subtitlesRepository.update>) => subtitlesRepository.update(...args),
	insert: (...args: Parameters<typeof subtitlesRepository.insert>) => subtitlesRepository.insert(...args),
};

export const pluginSubtitleSettingsData = {
	listDisabledIds: () => subtitleProviderSettingsRepository.listDisabledIds(),
	isDisabled: (providerId: string) => subtitleProviderSettingsRepository.isDisabled(providerId),
	setEnabled: (providerId: string, enabled: boolean) => subtitleProviderSettingsRepository.setEnabled(providerId, enabled),
};

export const pluginProviderSettingsData = {
	listLibraryPriorities: (libraryId: string) => libraryProviderSettingsRepository.listForLibrary(libraryId),
	replaceLibraryPriorities: (...args: Parameters<typeof libraryProviderSettingsRepository.replaceForLibrary>) =>
		libraryProviderSettingsRepository.replaceForLibrary(...args),
	listMetadataProviderSettings: () => metadataProviderSettingsRepository.list(),
	reorderMetadataProviders: (providerIds: readonly string[]) => metadataProviderSettingsRepository.reorder(providerIds),
	upsertMetadataProviderSetting: (...args: Parameters<typeof metadataProviderSettingsRepository.upsert>) =>
		metadataProviderSettingsRepository.upsert(...args),
};

export const pluginCatalogRepositoryData = {
	findById: (id: string) => pluginRepositoriesRepository.findById(id),
	list: () => pluginRepositoriesRepository.list(),
	create: (...args: Parameters<typeof pluginRepositoriesRepository.create>) => pluginRepositoriesRepository.create(...args),
	update: (...args: Parameters<typeof pluginRepositoriesRepository.update>) => pluginRepositoriesRepository.update(...args),
	delete: (id: string) => pluginRepositoriesRepository.delete(id),
	count: () => pluginRepositoriesRepository.count(),
	createIfAbsent: (...args: Parameters<typeof pluginRepositoriesRepository.createIfAbsent>) =>
		pluginRepositoriesRepository.createIfAbsent(...args),
};

export const pluginUiOverrideData = {
	listAll: () => pluginUiOverridesRepository.listAll(),
	replaceForPlugin: (pluginId: string, keys: readonly string[]) => pluginUiOverridesRepository.replaceForPlugin(pluginId, keys),
};

export const pluginUserData = {
	findById: (userId: string) => usersRepository.findById(userId),
};
