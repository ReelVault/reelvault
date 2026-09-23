import type {
	CatalogMediaType,
	CreateMediaMarker,
	MediaItem,
	MediaMarker,
	MetadataItem,
	PlaybackArtifact,
	PlaybackArtifactWrite,
	PluginMediaFile,
	TaskTrigger,
} from "../common";
import type { Logger } from "../common/logger";
import type { PluginLifecycleState, PluginLoadPhase } from "../common/plugins";
import type { PluginAccess } from "./access";
import type { ConfigDefinition, InferConfig, PluginConfig, PluginConfigShape } from "./config";
import { isConfigDefinition } from "./config";
import type { PluginEvents } from "./events";
import type { PluginHooks } from "./hooks";
import type { PluginHttpRoute } from "./http";
import type { PluginManifest } from "./manifest";
import type { PluginNotifications } from "./notifications";
import type { PluginRealtime } from "./realtime";
import type { PluginStorage } from "./storage";

export interface ProviderSearchResult {
	externalId: string;
	title: string;
	originalTitle?: string | undefined;
	originalLanguage?: string | undefined;
	releaseDate: string;
	posterPath?: string | undefined;
	backdropPath?: string | undefined;
	overview?: string | undefined;
	popularity?: number | undefined;
	voteAverage?: number | undefined;
	voteCount?: number | undefined;
}

export type ProviderImageType = "poster" | "backdrop";

/**
 * Provider-namespaced external identifiers, e.g. `{ imdb: "tt0816692", tmdb: "157336", mal: "5114" }`.
 * Keys are provider ids / namespaces, values are that provider's id for the entity. This keeps the
 * server independent of any single metadata source (TMDB, IMDb, TVDB, AniList, MAL, …).
 */
export type ExternalIdentifiers = Readonly<Record<string, string>>;

export type ProviderMediaType = "movie" | "tv_show";

export interface ExternalIdentifierAwareProvider<TMetadata> {
	getDetailsByExternalIds(type: ProviderMediaType, identifiers: ExternalIdentifiers): Promise<TMetadata | null>;
}

export interface ProviderImageResult {
	url: string;
	type: ProviderImageType;
	width?: number | undefined;
	height?: number | undefined;
	language?: string | undefined;
	score?: number | undefined;
}

export type ProviderPersonGender = "male" | "female" | "other";

/**
 * A single external rating contributed by a metadata provider. Providers may
 * expose several sources at once (e.g. OMDb returns IMDb, Rotten Tomatoes and
 * Metacritic in one response). `source` is a stable machine id used for
 * de-duplication and merging across providers.
 */
export interface ProviderRating {
	source: string;
	label?: string | undefined;
	value: number;
	maxValue?: number | undefined;
	votes?: number | undefined;
	url?: string | undefined;
}

export interface ProviderResultCollection {
	id: string;
	name: string;
}

export interface ProviderResultCast {
	id: string;
	role: string;
	character: string;
	order: number;
	name: string;
	profilePath?: string | undefined;
	gender?: ProviderPersonGender | null | undefined;
	popularity?: number | undefined;
}

export interface ProviderResultCrew {
	id: string;
	job: string;
	department: string;
	name: string;
	profilePath?: string | undefined;
	gender?: ProviderPersonGender | null | undefined;
	popularity?: number | undefined;
}

export interface ProviderResultKeyword {
	id: string;
	name: string;
}

export interface ProviderResultGenre {
	id: string;
	name: string;
}

export interface ProviderResultProductionCompany {
	id: string;
	name: string;
}

/**
 * Curated discovery feed a provider may expose on top of search/details.
 * Categories map to the provider's own endpoints; providers that do not
 * support a category simply omit it (`discover` returns null / empty items).
 */
export type ProviderDiscoveryCategory = "trending" | "popular" | "upcoming" | "top_rated" | "now_playing" | "recommendations" | "similar";

export interface ProviderDiscoveryRequest {
	type: ProviderMediaType;
	category: ProviderDiscoveryCategory;
	/** 1-based page. Defaults to 1. */
	page?: number | undefined;
	/** Trending time window. Defaults to "week". */
	window?: "day" | "week" | undefined;
	/** Source title id required by `recommendations` / `similar`. */
	externalId?: string | undefined;
	/** Optional discover filter (provider-native genre id). */
	genreId?: string | undefined;
	/** Optional discover filter (release year). */
	year?: number | undefined;
	/** Optional ISO locale override for this request. */
	language?: string | undefined;
	/** Optional ISO region for release-date based feeds. */
	region?: string | undefined;
	/** Target a specific provider; ignored by provider implementations. */
	providerId?: string | undefined;
}

/** One page of a discovery feed, as returned by a metadata provider. */
export interface ProviderDiscoveryPage {
	items: ProviderSearchResult[];
	page: number;
	totalPages: number;
	totalResults: number;
}

/** Discovery page annotated with the provider that produced it. */
export interface ProviderDiscoveryResult extends ProviderDiscoveryPage {
	providerId: string;
}

export interface ProviderSearchRequest {
	type: ProviderMediaType;
	query: string;
	year?: number | undefined;
	/** Search a single provider instead of every enabled one. */
	providerId?: string | undefined;
}

/** Search results produced by one provider. */
export interface ProviderSearchResponse {
	providerId: string;
	results: ProviderSearchResult[];
}

/** Library availability of a title known to a metadata provider. */
export interface MetadataAvailability {
	externalId: string;
	metadataId: string;
	title: string;
	type: ProviderMediaType;
	/** True when the title has at least one playable media file. */
	hasFiles: boolean;
	fileCount: number;
}

export interface ProviderMetadataResult {
	externalId: string;
	title: string;
	originalTitle?: string | undefined;
	overview?: string | undefined;
	tagline?: string | undefined;
	releaseDate: string;
	status?: string | undefined;
	budget?: number | undefined;
	revenue?: number | undefined;
	popularity?: number | undefined;
	productionCompanies?: ProviderResultProductionCompany[] | undefined;
	genres?: ProviderResultGenre[] | undefined;
	/** Multiple external ratings; when absent the server derives one from `voteAverage`/`voteCount`. */
	ratings?: ProviderRating[] | undefined;
	voteAverage?: number | undefined;
	voteCount?: number | undefined;
	posterPath?: string | undefined;
	backdropPath?: string | undefined;
	logoPath?: string | undefined;
	cast?: ProviderResultCast[] | undefined;
	crew?: ProviderResultCrew[] | undefined;
	keywords?: ProviderResultKeyword[] | undefined;
	collection?: ProviderResultCollection[] | undefined;
	seasons?: ProviderSeasonResult[] | undefined;
	hasMissingTranslation?: boolean | undefined;
}

export interface ProviderSeasonResult {
	externalId: string;
	seasonNumber: string | number;
	/** Optional — when absent the frontend renders a localized "Season N" label. */
	name?: string | undefined;
	overview?: string | undefined;
	/** Declared episode count (TMDB details expose it without an episode list). */
	episodeCount?: number | undefined;
	airDate?: string | undefined;
	status?: string | undefined;
	voteAverage?: number | undefined;
	voteCount?: number | undefined;
	posterPath?: string | undefined;
	episodes?: ProviderEpisodeResult[] | undefined;
	hasMissingTranslation?: boolean | undefined;
}

export interface ProviderEpisodeResult {
	externalId: string;
	seasonNumber: string | number;
	episodeNumber: string | number;
	/** Absolute (anime-style) episode number, when the provider supplies one. */
	absoluteNumber?: string | number | undefined;
	/** Optional — when absent the frontend renders a localized "Episode N" label. */
	name?: string | undefined;
	overview?: string | undefined;
	airDate?: string | undefined;
	status?: string | undefined;
	voteAverage?: number | undefined;
	voteCount?: number | undefined;
	cast?: ProviderResultCast[] | undefined;
	thumbnailPath?: string | undefined;
	hasMissingTranslation?: boolean | undefined;
}

export interface ProviderPersonResult {
	externalId: string;
	name: string;
	biography?: string | undefined;
	birthday?: string | undefined;
	gender?: ProviderPersonGender | null | undefined;
	popularity?: number | undefined;
	profilePath?: string | undefined;
}

/**
 * Host-provided outbound HTTP. Signature-compatible with `fetch`, but the host
 * SSRF-guards every hop (protocol allowlist, private-address rejection,
 * redirect validation) — do not assume the global `fetch` extensions.
 */
export type PluginFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface MetadataProviderContext {
	logger: Logger;
	http: PluginFetch;
	config: Readonly<Record<string, unknown>>;
}

export interface MetadataProvider {
	readonly id: string;
	readonly name: string;
	readonly version: string;
	readonly supportedTypes?: CatalogMediaType[] | undefined;
	initialize(context: MetadataProviderContext): void | Promise<void>;
	dispose?(): void | Promise<void>;
	search(type: CatalogMediaType, query: string, year?: number): Promise<ProviderSearchResult[]>;
	getDetails(type: CatalogMediaType, externalId: string): Promise<ProviderMetadataResult | null>;
	getDetailsByExternalIds?(type: ProviderMediaType, identifiers: ExternalIdentifiers): Promise<ProviderMetadataResult | null>;
	getImages?(type: CatalogMediaType, externalId: string): Promise<ProviderImageResult[]>;
	getSeasonDetails(externalId: string, seasonNumber: number): Promise<ProviderSeasonResult | null>;
	getEpisodeDetails(externalId: string, seasonNumber: number, episodeNumber: number): Promise<ProviderEpisodeResult | null>;
	getPersonDetails?(externalId: string): Promise<ProviderPersonResult | null>;
	/** Optional curated feeds (trending/popular/upcoming/recommendations…). */
	discover?(request: ProviderDiscoveryRequest): Promise<ProviderDiscoveryPage>;
	/** Optional genre catalogue used by discovery filtering. */
	getGenres?(type: ProviderMediaType): Promise<ProviderResultGenre[]>;
	test?(): Promise<boolean>;
}

export interface SubtitleProviderContext {
	logger: Logger;
	http: PluginFetch;
	config: Readonly<Record<string, unknown>>;
}

export interface SubtitleSearchRequest {
	media: MediaItem;
	languages?: string[] | undefined;
}

export interface SubtitleSearchResult {
	id: string;
	language: string;
	label?: string | undefined;
	format: string;
	isForced?: boolean | undefined;
	isHearingImpaired?: boolean | undefined;
}

export interface SubtitleDownload {
	id: string;
	language: string;
	label?: string | undefined;
	format: string;
	content: Blob | Uint8Array;
	isForced?: boolean | undefined;
	isHearingImpaired?: boolean | undefined;
}

export interface SubtitleProvider {
	readonly id: string;
	readonly name: string;
	readonly version: string;
	initialize(context: SubtitleProviderContext): void | Promise<void>;
	dispose?(): void | Promise<void>;
	search(request: SubtitleSearchRequest): Promise<SubtitleSearchResult[]>;
	download(subtitleId: string): Promise<SubtitleDownload | null>;
}

export interface MediaAnalysis {
	source?: string | null | undefined;
	edition?: string | null | undefined;
	qualityTag?: string | null | undefined;
}

export interface MediaAnalyzerContext {
	media: PluginMediaFile;
	logger: Logger;
}

export interface MediaAnalyzer {
	readonly id: string;
	readonly name: string;
	readonly version: string;
	analyze(context: MediaAnalyzerContext): MediaAnalysis | Promise<MediaAnalysis | undefined> | undefined;
	/** Optional cleanup, invoked when the owning plugin is reloaded or unloaded. */
	dispose?(): void | Promise<void>;
}

export type FrameImageFormat = "webp" | "jpeg";

export interface FrameExtractionRequest {
	mediaFileId: string;
	timeMs: number;
	width?: number | undefined;
	format?: FrameImageFormat | undefined;
}

export interface ExtractedFrame {
	content: Blob | Uint8Array;
	contentType: "image/webp" | "image/jpeg";
}

export interface SpriteExtractionRequest {
	mediaFileId: string;
	timeMs: number[];
	width: number;
	height: number;
	columns: number;
	format?: FrameImageFormat | undefined;
}

export interface ExtractedSprite extends ExtractedFrame {
	frameWidth: number;
	frameHeight: number;
	columns: number;
	rows: number;
}

export type BackoffType = "fixed" | "exponential";

export interface PluginJobContext<TData = unknown> {
	taskId: string;
	name: string;
	data: TData;
	attempt: number;
	signal: AbortSignal;
	logger: Logger;
	operationId?: string | undefined;
	updateProgress?: ((percent: number) => Promise<void>) | undefined;
}

export interface PluginJobOptions {
	attempts?: number | undefined;
	backoff?: { type: BackoffType; delayMs: number } | undefined;
	removeOnComplete?: boolean | number | undefined;
	removeOnFail?: boolean | number | undefined;
	concurrency?: number | undefined;
	timeoutMs?: number | undefined;
}

export interface PluginEnqueueOptions {
	operationId?: string | undefined;
	dedupeKey?: string | undefined;
	reference?: { type: string; id: string } | undefined;
	priority?: number | undefined;
	delayMs?: number | undefined;
	attempts?: number | undefined;
	backoff?: { type: BackoffType; delayMs: number } | undefined;
}

export interface PluginJobHandle {
	id: string;
	name: string;
	operationId?: string | undefined;
}

export interface PluginMediaFileRef {
	mediaFileId: string;
	filePath: string;
	fileName: string;
	durationSeconds: number;
	title?: string | undefined;
}

export interface PluginEpisodeMediaFile extends PluginMediaFileRef {
	episodeId: string;
	seasonId: string;
	episodeNumber: number;
}

export interface PluginMediaFileInfo extends PluginMediaFileRef {
	mediaType: "movie" | "episode";
	movieId?: string | null | undefined;
	episodeId?: string | null | undefined;
}

/** Source-revision fingerprint for freshness checks on derived data (analysis caches, thumbnails). */
export interface PluginMediaRevision {
	size: number | null;
	sourceMtimeMs: number | null;
	audioStreams: Array<{ index: number; channels: number | null; isDefault: boolean }>;
}

export interface PluginScheduledTaskDefinition {
	id: string;
	name: string;
	description: string;
	defaultTriggers?: TaskTrigger[] | undefined;
	run: () => Promise<string | undefined>;
}

export interface PluginJobDefinition<TData = unknown, TResult = unknown> {
	name: string;
	title?: string | undefined;
	description?: string | undefined;
	handler(job: PluginJobContext<TData>): Promise<TResult> | TResult;
	options?: PluginJobOptions | undefined;
	schedule?: { cron?: string; data?: TData; defaultTriggers?: TaskTrigger[] } | undefined;
}

export interface PluginHost<TConfig extends PluginConfig = PluginConfig> {
	readonly logger: Logger;
	readonly config: TConfig;
	readonly media: {
		get(mediaFileId: string): Promise<PluginMediaFile | null>;
		/** Technical fingerprint used for freshness checks (e.g. analysis caches keyed on source revision). */
		getRevision(mediaFileId: string): Promise<PluginMediaRevision | null>;
		listEpisodeFilesBySeason(): Promise<Map<string, PluginEpisodeMediaFile[]>>;
		/** Optional paging — without it the full library is returned (full table scan). */
		listAllMediaFiles(options?: { limit?: number; offset?: number }): Promise<PluginMediaFileInfo[]>;
		registerAnalyzer(analyzer: MediaAnalyzer): Promise<void>;
	};
	readonly metadata: {
		get(metadataId: string): Promise<MetadataItem | null>;
		/** Library title linked to a provider's external id, with file availability. */
		findByExternalId(providerId: string, externalId: string, type: ProviderMediaType): Promise<MetadataAvailability | null>;
		/** Batch form of {@link PluginHost.metadata.findByExternalId} (one lookup per id is a table scan). */
		findManyByExternalIds(providerId: string, externalIds: readonly string[], type: ProviderMediaType): Promise<MetadataAvailability[]>;
	};
	readonly artifacts: {
		list(mediaFileId: string): Promise<PlaybackArtifact[]>;
		write(artifact: PlaybackArtifactWrite): Promise<PlaybackArtifact>;
		deleteByKind?(mediaFileId: string, kind: string): Promise<number>;
	};
	readonly ffmpeg: {
		extractFrame(request: FrameExtractionRequest): Promise<ExtractedFrame>;
		extractSprite(request: SpriteExtractionRequest): Promise<ExtractedSprite>;
		/**
		 * Generic ffmpeg run for analysis jobs (args are file-level, no shell).
		 * Network protocols are blocked and the output must land in server-managed
		 * temp directories. `captureStdout` returns raw stdout bytes (capped), for
		 * pipelines that emit machine-readable data (PCM, JSON) on stdout.
		 * `useHardwareDecode` injects the server-configured `-hwaccel` before each
		 * input (no-op when the server runs without hardware acceleration).
		 */
		runAnalyse(
			args: string[],
			options?: {
				timeoutMs?: number | undefined;
				captureStdout?: boolean | undefined;
				/** Cap for captured stdout bytes (default 64 MiB). */
				maxStdoutBytes?: number | undefined;
				useHardwareDecode?: boolean | undefined;
			},
		): Promise<{ exitCode: number; stderr: string; stdout?: Uint8Array }>;
	};
	readonly http: {
		/**
		 * Outbound HTTP (capability `httpFetch`). Signature-compatible with `fetch`;
		 * every hop is SSRF-guarded and destination hosts can be restricted
		 * server-side with the `plugins.http.allowedDomains` setting.
		 */
		readonly fetch: PluginFetch;
	};
	readonly providers: {
		register(provider: MetadataProvider): Promise<void>;
		/** Enabled metadata providers in configured priority order. */
		list(): Promise<ProviderStatus[]>;
		/** Title search across enabled providers. */
		search(request: ProviderSearchRequest): Promise<ProviderSearchResponse[]>;
		/** Detail lookup in a single provider's own id namespace. */
		getDetails(providerId: string, type: ProviderMediaType, externalId: string): Promise<ProviderMetadataResult | null>;
		/** Season (with episodes) lookup in a single provider's own id namespace. */
		getSeasonDetails(providerId: string, externalId: string, seasonNumber: number): Promise<ProviderSeasonResult | null>;
		/** Aggregated detail lookup resolving a title to the best matching provider. */
		resolveDetails(type: ProviderMediaType, title: string, year?: number): Promise<ProviderMetadataResult | null>;
		/** Curated feed from the highest-priority provider that supports it. */
		discover(request: ProviderDiscoveryRequest): Promise<ProviderDiscoveryResult | null>;
		/** Genre catalogue from a provider (defaults to the highest-priority one that exposes it). */
		getGenres(type: ProviderMediaType, providerId?: string): Promise<ProviderResultGenre[]>;
	};
	readonly subtitles: {
		register(provider: SubtitleProvider): Promise<void>;
	};
	readonly jobs: {
		register<TData = unknown, TResult = unknown>(definition: PluginJobDefinition<TData, TResult>): Promise<void>;
		enqueue(name: string, data: unknown, options?: PluginEnqueueOptions): Promise<PluginJobHandle>;
		enqueueMany(
			name: string,
			items: Array<{ data: unknown; options?: PluginEnqueueOptions }>,
			commonOptions?: { operationId?: string; reference?: { type: string; id: string } },
		): Promise<PluginJobHandle[]>;
	};
	readonly tasks: {
		register(task: PluginScheduledTaskDefinition): Promise<void>;
	};
	/** Registers inbound HTTP routes exposed by the plugin. Outbound requests use the fetch client in provider contexts. */
	readonly routes: {
		register(route: PluginHttpRoute): Promise<void>;
	};
	readonly access: PluginAccess;
	readonly notifications: PluginNotifications;
	readonly realtime: PluginRealtime;
	readonly storage: PluginStorage;
	readonly markers: {
		list(mediaFileId: string): Promise<MediaMarker[]>;
		set(mediaFileId: string, markers: readonly CreateMediaMarker[]): Promise<MediaMarker[]>;
		clear(mediaFileId: string): Promise<void>;
	};
	readonly events: PluginEvents;
	readonly hooks: PluginHooks;
}

export interface ReelVaultPlugin<TConfig extends PluginConfig = PluginConfig> {
	setup(host: PluginHost<TConfig>): void | Promise<void>;
	onEnable?(): void | Promise<void>;
	onDisable?(): void | Promise<void>;
	onUnload?(): void | Promise<void>;
}

/** A plugin that also carries its declarative config definition. */
export type ConfiguredReelVaultPlugin<TConfig extends PluginConfig = PluginConfig> = ReelVaultPlugin<TConfig> & {
	readonly config: ConfigDefinition;
};

export interface PluginModule {
	default: ReelVaultPlugin;
}

// Plugin lifecycle naming lives in the shared contract (`common/plugins`) —
// re-exported here so the plugin surface keeps a single source of truth.
export type { PluginLifecycleState, PluginLoadPhase } from "../common/plugins";

export type { SubtitleProviderStatus } from "../common/subtitles";

export interface PluginRuntime {
	manifest: PluginManifest;
	plugin?: ReelVaultPlugin | undefined;
	/** Parsed configuration schema carried by the plugin module, when declared. */
	configDefinition?: ConfigDefinition | undefined;
	state: PluginLifecycleState;
	providerIds: string[];
	subtitleProviderIds: string[];
	analyzerIds: string[];
	jobNames: string[];
	error?: string | undefined;
	failurePhase?: PluginLoadPhase | undefined;
}

export interface PluginStatus {
	id: string;
	name: string;
	version: string;
	description?: string;
	state: PluginLifecycleState;
	providers: number;
	subtitleProviders: number;
	jobs: number;
	error?: string;
	failurePhase?: PluginLoadPhase;
}

export interface ProviderStatus {
	id: string;
	name: string;
	version: string;
	pluginId: string;
}

export function definePlugin<TFields extends PluginConfigShape>(
	config: ConfigDefinition<TFields>,
	plugin: ReelVaultPlugin<InferConfig<TFields>>,
): ConfiguredReelVaultPlugin<InferConfig<TFields>>;

export function definePlugin(plugin: ReelVaultPlugin): ReelVaultPlugin;

export function definePlugin(
	configOrPlugin: ConfigDefinition | ReelVaultPlugin,
	plugin?: ReelVaultPlugin,
): ConfiguredReelVaultPlugin | ReelVaultPlugin {
	if (isConfigDefinition(configOrPlugin)) {
		if (!plugin) throw new Error("definePlugin(config, plugin) requires both arguments");

		return { ...plugin, config: configOrPlugin };
	}

	return configOrPlugin;
}
