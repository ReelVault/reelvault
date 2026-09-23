export { ReelVaultClient } from "./core/app-client";

export { InFlightDeduper, TtlCache } from "./core/cache";

export type { ApiProblemDetails } from "./core/errors";

export { isRetryableStatus, NetworkError, ReelVaultError, ReelVaultValidationError, TimeoutError } from "./core/errors";

export { isRetryableError } from "./core/retry";

export { TokenManager } from "./core/token-manager";

export type {
	ClientConfig,
	Fetcher,
	HeadersInput,
	QueryParams,
	RequestInterceptor,
	ResourceConfig,
	ResponseInterceptor,
} from "./core/types";

export { AdminClient } from "./resources/admin";

export { AuthClient } from "./resources/auth";

export { CollectionsClient } from "./resources/collections";

export { CompaniesClient } from "./resources/companies";

export { DiscoverClient } from "./resources/discover";

export { DownloadsClient } from "./resources/downloads";

export { EpisodesClient } from "./resources/episodes";

export { EventsClient } from "./resources/events";

export { GenresClient } from "./resources/genres";

export { HealthClient } from "./resources/health";

export { ImagesClient } from "./resources/images";

export { KeywordsClient } from "./resources/keywords";

export { LibrariesClient } from "./resources/libraries";

export { MeClient } from "./resources/me";

export { MediaFileClient } from "./resources/media";

export { MetadataClient } from "./resources/metadata";

export { NotificationsClient } from "./resources/notifications";

export { PeopleClient } from "./resources/people";

export { PlaybackSessionsClient } from "./resources/playback-sessions";

export { PluginsClient } from "./resources/plugins";

export { ProfilesClient } from "./resources/profiles";

export { ProvidersClient } from "./resources/providers";

export { SeasonsClient } from "./resources/seasons";

export { SetupClient } from "./resources/setup";

export { SubtitlesClient } from "./resources/subtitles";
