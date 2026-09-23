import { AdminClient } from "../resources/admin";
import { AuthClient } from "../resources/auth";
import { CollectionsClient } from "../resources/collections";
import { CompaniesClient } from "../resources/companies";
import { DiscoverClient } from "../resources/discover";
import { DownloadsClient } from "../resources/downloads";
import { EpisodesClient } from "../resources/episodes";
import { EventsClient } from "../resources/events";
import { GenresClient } from "../resources/genres";
import { HealthClient } from "../resources/health";
import { ImagesClient } from "../resources/images";
import { KeywordsClient } from "../resources/keywords";
import { LibrariesClient } from "../resources/libraries";
import { MeClient } from "../resources/me";
import { MediaFileClient } from "../resources/media";
import { MetadataClient } from "../resources/metadata";
import { NotificationsClient } from "../resources/notifications";
import { PeopleClient } from "../resources/people";
import { PlaybackSessionsClient } from "../resources/playback-sessions";
import { PluginsClient } from "../resources/plugins";
import { ProfilesClient } from "../resources/profiles";
import { ProvidersClient } from "../resources/providers";
import { SeasonsClient } from "../resources/seasons";
import { SetupClient } from "../resources/setup";
import { SubtitlesClient } from "../resources/subtitles";
import type { BaseResource } from "./base-resource";
import { HttpClient } from "./http-client";
import type { ClientConfig, ResourceConfig } from "./types";
import { normalizeHeaders } from "./utils";

const TRAILING_SLASH_REGEX = /\/$/;

export class ReelVaultClient {
	// Administracja
	public readonly admin: AdminClient;

	// User & profile
	public readonly auth: AuthClient;
	public readonly setup: SetupClient;
	public readonly profiles: ProfilesClient;
	public readonly notifications: NotificationsClient;
	public readonly me: MeClient;

	// Biblioteka & pliki
	public readonly libraries: LibrariesClient;
	public readonly media: MediaFileClient;

	// Metadane
	public readonly metadata: MetadataClient;
	public readonly collections: CollectionsClient;
	public readonly companies: CompaniesClient;
	public readonly genres: GenresClient;
	public readonly keywords: KeywordsClient;
	public readonly people: PeopleClient;
	public readonly images: ImagesClient;

	// Video content
	public readonly seasons: SeasonsClient;
	public readonly episodes: EpisodesClient;

	// Browse & playback
	public readonly discover: DiscoverClient;
	public readonly playbackSessions: PlaybackSessionsClient;
	public readonly downloads: DownloadsClient;
	public readonly subtitles: SubtitlesClient;
	public readonly providers: ProvidersClient;
	public readonly plugins: PluginsClient;
	public readonly events: EventsClient;

	// Utilities
	public readonly health: HealthClient;

	private readonly resourceConfig: ResourceConfig;
	private readonly http: HttpClient;

	constructor(config: ClientConfig) {
		if (!config.baseUrl) {
			throw new Error("baseUrl is required");
		}

		this.resourceConfig = {
			baseUrl: typeof config.baseUrl === "function" ? config.baseUrl : config.baseUrl.replace(TRAILING_SLASH_REGEX, ""),
			fetcher: config.fetcher ?? fetch.bind(globalThis),
			defaultHeaders: normalizeHeaders(config.headers),
			accessToken: config.accessToken,
			onTokenExpired: config.onTokenExpired,
			requestInterceptors: config.requestInterceptors ?? [],
			responseInterceptors: config.responseInterceptors ?? [],
			enableRetry: config.enableRetry ?? true,
			maxRetries: config.maxRetries ?? 3,
			timeout: config.timeout ?? 30_000,
			credentials: config.credentials ?? "same-origin",
			enableCache: config.enableCache,
			cacheTtlMs: config.cacheTtlMs,
			maxTokenRefreshAttempts: config.maxTokenRefreshAttempts,
		};

		// One shared HttpClient = global GET dedup, cache and a single token-refresh
		// mutex for every resource.
		this.http = new HttpClient(this.resourceConfig);

		this.auth = this.createResource(AuthClient);
		this.admin = this.createResource(AdminClient);
		this.setup = this.createResource(SetupClient);
		this.profiles = this.createResource(ProfilesClient);
		this.notifications = this.createResource(NotificationsClient);
		this.me = this.createResource(MeClient);

		this.libraries = this.createResource(LibrariesClient);
		this.media = this.createResource(MediaFileClient);

		this.metadata = this.createResource(MetadataClient);
		this.collections = this.createResource(CollectionsClient);
		this.companies = this.createResource(CompaniesClient);
		this.genres = this.createResource(GenresClient);
		this.keywords = this.createResource(KeywordsClient);
		this.people = this.createResource(PeopleClient);
		this.images = this.createResource(ImagesClient);

		this.seasons = this.createResource(SeasonsClient);
		this.episodes = this.createResource(EpisodesClient);

		this.discover = this.createResource(DiscoverClient);
		this.playbackSessions = this.createResource(PlaybackSessionsClient);
		this.downloads = this.createResource(DownloadsClient);
		this.subtitles = this.createResource(SubtitlesClient);
		this.providers = this.createResource(ProvidersClient);
		this.plugins = this.createResource(PluginsClient);
		this.events = this.createResource(EventsClient);

		this.health = this.createResource(HealthClient);
	}

	setAccessToken(token: string | undefined): void {
		this.http.setAccessToken(token);
	}

	getAccessToken(): string | undefined {
		return this.http.getAccessToken();
	}

	/**
	 * Clears the shared cache and in-flight deduplication.
	 */
	clearCache(): void {
		this.http.clearCache();
	}

	/**
	 * Creates a resource instance with the current configuration.
	 * To add a resource: implement a class extending BaseResource, add a public
	 * field above and call `this.createResource(ResourceName)`.
	 */
	private createResource<T extends BaseResource>(Resource: new (config: ResourceConfig, http: HttpClient) => T): T {
		return new Resource(this.resourceConfig, this.http);
	}
}
