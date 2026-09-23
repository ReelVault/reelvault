import Elysia from "elysia";
import { authRoutes } from "./auth.routes";
import { collectionRoutes } from "./collections.routes";
import { companiesRoutes } from "./companies.routes";
import { discoverRoutes } from "./discover.routes";
import { downloadsRoutes } from "./downloads.routes";
import { episodesRoutes } from "./episodes.routes";
import { eventsRoutes } from "./events.routes";
import { genreRoutes } from "./genres.routes";
import { healthRoutes } from "./health.routes";
import { imagesRoutes } from "./images.routes";
import { keywordsRoutes } from "./keywords.routes";
import { librariesRoutes } from "./libraries.routes";
import { meRoutes } from "./me.routes";
import { mediaFilesRoutes } from "./media-files.routes";
import { metadataRoutes } from "./metadata.routes";
import { notificationsRoutes } from "./notifications.routes";
import { peopleRoutes } from "./people.routes";
import { playbackSessionsRoutes } from "./playback-sessions.routes";
import { pluginsRoutes } from "./plugins.routes";
import { pluginsUiRoutes } from "./plugins-ui.routes";
import { profilesRoutes } from "./profiles.routes";
import { providersRoutes } from "./providers.routes";
import { seasonsRoutes } from "./seasons.routes";
import { setupRoutes } from "./setup.routes";
import { subtitlesRoutes } from "./subtitles.routes";
import { twoFactorRoutes } from "./two-factor.routes";

export const v1Routes = new Elysia()
	// Auth & User
	.use(setupRoutes)
	.use(authRoutes)
	.use(twoFactorRoutes)
	.use(profilesRoutes)
	.use(notificationsRoutes)
	.use(discoverRoutes)
	.use(downloadsRoutes)
	.use(meRoutes)

	// Media Files
	.use(librariesRoutes)
	.use(mediaFilesRoutes)
	.use(playbackSessionsRoutes)
	.use(subtitlesRoutes)

	// Metadata
	.use(metadataRoutes)
	.use(collectionRoutes)
	.use(companiesRoutes)
	.use(genreRoutes)
	.use(keywordsRoutes)
	.use(peopleRoutes)
	.use(imagesRoutes)
	.use(seasonsRoutes)
	.use(episodesRoutes)

	// System
	.use(healthRoutes)
	.use(eventsRoutes)

	// Plugins
	.use(providersRoutes)
	.use(pluginsUiRoutes)
	.use(pluginsRoutes);
