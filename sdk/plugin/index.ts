export type { Static, TSchema } from "@sinclair/typebox";

export { Type as t } from "@sinclair/typebox";

export type { PluginAccess, PluginAccessContext, PluginAccessDenial, PluginAccessPolicy } from "./access";

export type {
	ConfigDefinition,
	ConfigField,
	InferConfig,
	InferFields,
	PluginConfig,
	PluginConfigField,
	PluginConfigFieldOption,
	PluginConfigFieldType,
	PluginConfigShape,
} from "./config";

export { defineConfig, field, isConfigDefinition } from "./config";

export type {
	PluginEventDataMap,
	PluginEventEnvelope,
	PluginEventHandler,
	PluginEventInput,
	PluginEventMap,
	PluginEventName,
	PluginEvents,
} from "./events";

export { createPluginEventPayload } from "./events";

export type {
	ArtifactCreationCandidate,
	BeforeArtifactCreateContext,
	BeforeArtifactCreateHook,
	BeforeMediaRecognitionContext,
	BeforeMediaRecognitionHook,
	BeforeMetadataSaveContext,
	BeforeMetadataSaveHook,
	MediaRecognitionCandidate,
	PluginHooks,
} from "./hooks";

export { PluginHookRejection, rejectPluginHook } from "./hooks";

export type {
	PluginHttpMethod,
	PluginHttpRequest,
	PluginHttpResponse,
	PluginHttpRoute,
	PluginHttpUser,
	PluginRouteAccess,
	RouteDefinition,
} from "./http";

export { created, fail, ok, route } from "./http";

export type { PluginCapabilityName, PluginManifest } from "./manifest";

export type { PluginNotification, PluginNotifications } from "./notifications";

export type { PluginRealtime } from "./realtime";

export type { PluginBlob, PluginBlobMetadata, PluginBlobWriteOptions, PluginStorage } from "./storage";

export { readStored, updateStored } from "./storage";

export type {
	BackoffType,
	ConfiguredReelVaultPlugin,
	ExternalIdentifierAwareProvider,
	ExternalIdentifiers,
	ExtractedFrame,
	ExtractedSprite,
	FrameExtractionRequest,
	FrameImageFormat,
	MediaAnalysis,
	MediaAnalyzer,
	MediaAnalyzerContext,
	MetadataAvailability,
	MetadataProvider,
	MetadataProviderContext,
	PluginEnqueueOptions,
	PluginEpisodeMediaFile,
	PluginFetch,
	PluginHost,
	PluginJobContext,
	PluginJobDefinition,
	PluginJobHandle,
	PluginJobOptions,
	PluginLifecycleState,
	PluginLoadPhase,
	PluginMediaRevision,
	PluginModule,
	PluginRuntime,
	PluginScheduledTaskDefinition,
	PluginStatus,
	ProviderDiscoveryCategory,
	ProviderDiscoveryPage,
	ProviderDiscoveryRequest,
	ProviderDiscoveryResult,
	ProviderEpisodeResult,
	ProviderImageResult,
	ProviderMediaType,
	ProviderMetadataResult,
	ProviderPersonGender,
	ProviderPersonResult,
	ProviderRating,
	ProviderResultCast,
	ProviderResultCollection,
	ProviderResultCrew,
	ProviderResultGenre,
	ProviderResultKeyword,
	ProviderResultProductionCompany,
	ProviderSearchRequest,
	ProviderSearchResponse,
	ProviderSearchResult,
	ProviderSeasonResult,
	ProviderStatus,
	ReelVaultPlugin,
	SpriteExtractionRequest,
	SubtitleDownload,
	SubtitleProvider,
	SubtitleProviderContext,
	SubtitleProviderStatus,
	SubtitleSearchRequest,
	SubtitleSearchResult,
} from "./types";

export { definePlugin } from "./types";

export type {
	PluginPlayerState,
	PluginUiApi,
	PluginUiApiCallOptions,
	PluginUiContext,
	PluginUiDeviceContext,
	PluginUiHost,
	PluginUiPlayerContext,
	PluginUiProfileContext,
	PluginUiToastLevel,
	PluginUiUserContext,
} from "./ui-host";

export { PLUGIN_UI_PROTOCOL_VERSION } from "./ui-host";

export type {
	PluginDialogContribution,
	PluginLocalizedText,
	PluginPageContribution,
	PluginSlotAction,
	PluginSlotContribution,
	PluginSlotName,
	PluginSurface,
	PluginSurfaceDefinition,
	PluginTabContribution,
	PluginTabHostName,
	PluginUiManifest,
	PluginUiManifestResponse,
} from "./ui-manifest";

export type {
	PluginSchemaAction,
	PluginSchemaCondition,
	PluginSchemaDataSource,
	PluginSchemaField,
	PluginSchemaFieldNode,
	PluginSchemaNode,
	PluginSchemaValue,
	PluginUiSchemaSurface,
} from "./ui-schema";

export type {
	PluginDialogSize,
	PluginSchemaActionType,
	PluginSchemaConditionOp,
	PluginSchemaFieldInput,
} from "./vocabulary";

export {
	PLUGIN_CAPABILITIES,
	PLUGIN_CAPABILITY_SET,
	PLUGIN_DIALOG_SIZES,
	PLUGIN_SCHEMA_ACTION_TYPES,
	PLUGIN_SCHEMA_CONDITION_OPS,
	PLUGIN_SCHEMA_FIELD_INPUTS,
	PLUGIN_SCHEMA_NODE_TYPES,
	PLUGIN_SLOT_NAMES,
	PLUGIN_TAB_HOST_NAMES,
} from "./vocabulary";
