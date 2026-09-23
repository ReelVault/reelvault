import * as adminAudit from "./schemas/admin-audit.schema";
import * as auth from "./schemas/auth.schema";
import * as collections from "./schemas/collections.schema";
import * as companies from "./schemas/companies.schema";
import * as downloads from "./schemas/downloads.schema";
import * as episodes from "./schemas/episodes.schema";
import * as genres from "./schemas/genres.schema";
import * as images from "./schemas/images.schema";
import * as keywords from "./schemas/keywords.schema";
import * as libraries from "./schemas/libraries.schema";
import * as mediaArtifacts from "./schemas/media-artifacts.schema";
import * as mediaFileIngestState from "./schemas/media-file-ingest-state.schema";
import * as mediaFiles from "./schemas/media-files.schema";
import * as mediaMarkers from "./schemas/media-markers.schema";
import * as metadata from "./schemas/metadata.schema";
import * as metadataExternalIds from "./schemas/metadata-external-ids.schema";
import * as metadataProviderSettings from "./schemas/metadata-provider-settings.schema";
import * as movies from "./schemas/movies.schema";
import * as notifications from "./schemas/notifications.schema";
import * as people from "./schemas/people.schema";
import * as playbackProgress from "./schemas/playback-progress.schema";
import * as pluginRepositories from "./schemas/plugin-repositories.schema";
import * as pluginStorage from "./schemas/plugin-storage.schema";
import * as profilePreferenceOverrides from "./schemas/profile-preferences.schema";
import * as profileStreamPrefs from "./schemas/profile-stream-prefs.schema";
import * as profiles from "./schemas/profiles.schema";
import * as providers from "./schemas/providers.schema";
import * as resourceMetrics from "./schemas/resource-metrics.schema";
import * as scanFindings from "./schemas/scan-findings.schema";
import * as scanState from "./schemas/scan-state.schema";
import * as seasons from "./schemas/seasons.schema";
import * as subtitles from "./schemas/subtitles.schema";
import * as systemSettings from "./schemas/system-settings.schema";
import * as userRatings from "./schemas/user-ratings.schema";
import * as watchedHistory from "./schemas/watched-history.schema";
import * as watchlist from "./schemas/watchlist.schema";
import * as worker from "./schemas/worker.schema";
import * as workerOperations from "./schemas/worker-operations.schema";
import * as workerSchedules from "./schemas/worker-schedules.schema";

export const schema = {
	...adminAudit,
	...auth,
	...collections,
	...downloads,
	...companies,
	...episodes,
	...genres,
	...images,
	...keywords,
	...libraries,
	...mediaArtifacts,
	...mediaFileIngestState,
	...mediaFiles,
	...mediaMarkers,
	...metadata,
	...metadataExternalIds,
	...metadataProviderSettings,
	...notifications,
	...movies,
	...people,
	...pluginStorage,
	...pluginRepositories,
	...playbackProgress,
	...resourceMetrics,
	...profiles,
	...profilePreferenceOverrides,
	...profileStreamPrefs,
	...providers,
	...systemSettings,
	...worker,
	...workerOperations,
	...workerSchedules,
	...scanFindings,
	...scanState,
	...seasons,
	...subtitles,
	...userRatings,
	...watchedHistory,
	...watchlist,
};
