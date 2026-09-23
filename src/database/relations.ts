import { defineRelations } from "drizzle-orm";
import { schema } from "./schema";

/**
 * Single source of truth for query relations.
 *
 * Tables stay focused on columns and constraints while this file describes
 * how the domain graph is traversed. This is the relation model expected by
 * Drizzle 1.0 and keeps relation definitions out of every table module.
 */
export const relations = defineRelations(schema, (r) => ({
	accounts: {
		user: r.one.users({ from: r.accounts.userId, to: r.users.id }),
	},
	collections: {
		providers: r.many.collectionProviders(),
		metadata: r.many.metadataCollections(),
	},
	collectionProviders: {
		collection: r.one.collections({ from: r.collectionProviders.collectionId, to: r.collections.id }),
		provider: r.one.providers({ from: r.collectionProviders.providerId, to: r.providers.id }),
	},
	companies: {
		image: r.one.images({ from: r.companies.imageId, to: r.images.id }),
		providers: r.many.companyProviders(),
		metadata: r.many.metadataCompanies(),
	},
	companyProviders: {
		company: r.one.companies({ from: r.companyProviders.companyId, to: r.companies.id }),
		provider: r.one.providers({ from: r.companyProviders.providerId, to: r.providers.id }),
	},
	episodes: {
		season: r.one.seasons({ from: r.episodes.seasonId, to: r.seasons.id }),
		image: r.one.images({ from: r.episodes.imageId, to: r.images.id }),
		ratings: r.many.episodeRatings(),
		providers: r.many.episodeProviders(),
		mediaFiles: r.many.mediaFiles(),
	},
	episodeRatings: {
		episode: r.one.episodes({ from: r.episodeRatings.episodeId, to: r.episodes.id }),
	},
	episodeProviders: {
		episode: r.one.episodes({ from: r.episodeProviders.episodeId, to: r.episodes.id }),
		provider: r.one.providers({ from: r.episodeProviders.providerId, to: r.providers.id }),
	},
	genres: {
		providers: r.many.genreProviders(),
		metadata: r.many.metadataGenres(),
	},
	genreProviders: {
		genre: r.one.genres({ from: r.genreProviders.genreId, to: r.genres.id }),
		provider: r.one.providers({ from: r.genreProviders.providerId, to: r.providers.id }),
	},
	images: {
		metadata: r.many.metadataImages(),
		companies: r.many.companies(),
		people: r.many.people(),
		episodes: r.many.episodes(),
		seasons: r.many.seasons(),
	},
	keywords: {
		providers: r.many.keywordProviders(),
		metadata: r.many.metadataKeywords(),
	},
	keywordProviders: {
		keyword: r.one.keywords({ from: r.keywordProviders.keywordId, to: r.keywords.id }),
		provider: r.one.providers({ from: r.keywordProviders.providerId, to: r.providers.id }),
	},
	libraries: {
		paths: r.many.libraryPaths(),
		mediaFiles: r.many.mediaFiles(),
	},
	libraryPaths: {
		library: r.one.libraries({ from: r.libraryPaths.libraryId, to: r.libraries.id }),
	},
	mediaFiles: {
		artifacts: r.many.mediaArtifacts(),
		videoStreams: r.many.mediaFileVideoStreams(),
		audioStreams: r.many.mediaFileAudioStreams(),
		subtitles: r.many.subtitles(),
		library: r.one.libraries({ from: r.mediaFiles.libraryId, to: r.libraries.id }),
		metadata: r.one.metadata({ from: r.mediaFiles.metadataId, to: r.metadata.id }),
		movie: r.one.movies({ from: r.mediaFiles.movieId, to: r.movies.id }),
		episode: r.one.episodes({ from: r.mediaFiles.episodeId, to: r.episodes.id }),
		watchedHistory: r.many.watchedHistory(),
		playbackProgress: r.many.playbackProgress(),
		markers: r.many.mediaMarkers(),
		downloads: r.many.downloads(),
	},
	mediaMarkers: {
		mediaFile: r.one.mediaFiles({ from: r.mediaMarkers.mediaFileId, to: r.mediaFiles.id }),
	},
	mediaFileVideoStreams: {
		mediaFile: r.one.mediaFiles({ from: r.mediaFileVideoStreams.mediaFileId, to: r.mediaFiles.id }),
	},
	mediaArtifacts: {
		mediaFile: r.one.mediaFiles({ from: r.mediaArtifacts.mediaFileId, to: r.mediaFiles.id }),
	},
	mediaFileAudioStreams: {
		mediaFile: r.one.mediaFiles({ from: r.mediaFileAudioStreams.mediaFileId, to: r.mediaFiles.id }),
	},
	metadata: {
		collections: r.many.metadataCollections(),
		companies: r.many.metadataCompanies(),
		genres: r.many.metadataGenres(),
		keywords: r.many.metadataKeywords(),
		cast: r.many.metadataCast(),
		crew: r.many.metadataCrew(),
		images: r.many.metadataImages(),
		rating: r.many.metadataRatings(),
		providers: r.many.metadataProviders(),
		userRatings: r.many.userRatings(),
		watchlist: r.many.watchlist(),
		mediaFiles: r.many.mediaFiles(),
		movies: r.many.movies(),
		seasons: r.many.seasons(),
		streamPrefs: r.many.profileStreamPrefs(),
	},
	downloads: {
		profile: r.one.profiles({ from: r.downloads.profileId, to: r.profiles.id }),
		mediaFile: r.one.mediaFiles({ from: r.downloads.mediaFileId, to: r.mediaFiles.id }),
	},
	metadataCollections: {
		metadata: r.one.metadata({ from: r.metadataCollections.metadataId, to: r.metadata.id }),
		collection: r.one.collections({ from: r.metadataCollections.collectionId, to: r.collections.id }),
	},
	metadataCompanies: {
		metadata: r.one.metadata({ from: r.metadataCompanies.metadataId, to: r.metadata.id }),
		company: r.one.companies({ from: r.metadataCompanies.companyId, to: r.companies.id }),
	},
	metadataGenres: {
		metadata: r.one.metadata({ from: r.metadataGenres.metadataId, to: r.metadata.id }),
		genre: r.one.genres({ from: r.metadataGenres.genreId, to: r.genres.id }),
	},
	metadataKeywords: {
		metadata: r.one.metadata({ from: r.metadataKeywords.metadataId, to: r.metadata.id }),
		keyword: r.one.keywords({ from: r.metadataKeywords.keywordId, to: r.keywords.id }),
	},
	metadataCast: {
		metadata: r.one.metadata({ from: r.metadataCast.metadataId, to: r.metadata.id }),
		person: r.one.people({ from: r.metadataCast.personId, to: r.people.id }),
	},
	metadataCrew: {
		metadata: r.one.metadata({ from: r.metadataCrew.metadataId, to: r.metadata.id }),
		person: r.one.people({ from: r.metadataCrew.personId, to: r.people.id }),
	},
	metadataExternalIds: {
		metadata: r.one.metadata({ from: r.metadataExternalIds.metadataId, to: r.metadata.id }),
	},
	metadataImages: {
		metadata: r.one.metadata({ from: r.metadataImages.metadataId, to: r.metadata.id }),
		image: r.one.images({ from: r.metadataImages.imageId, to: r.images.id }),
	},
	metadataRatings: {
		metadata: r.one.metadata({ from: r.metadataRatings.metadataId, to: r.metadata.id }),
	},
	metadataProviders: {
		metadata: r.one.metadata({ from: r.metadataProviders.metadataId, to: r.metadata.id }),
		provider: r.one.providers({ from: r.metadataProviders.providerId, to: r.providers.id }),
	},
	movies: {
		metadata: r.one.metadata({ from: r.movies.metadataId, to: r.metadata.id }),
		mediaFiles: r.many.mediaFiles(),
	},
	people: {
		image: r.one.images({ from: r.people.imageId, to: r.images.id }),
		providers: r.many.personProviders(),
		cast: r.many.metadataCast(),
		crew: r.many.metadataCrew(),
	},
	personProviders: {
		person: r.one.people({ from: r.personProviders.personId, to: r.people.id }),
		provider: r.one.providers({ from: r.personProviders.providerId, to: r.providers.id }),
	},
	playbackProgress: {
		profile: r.one.profiles({ from: r.playbackProgress.profileId, to: r.profiles.id }),
		mediaFile: r.one.mediaFiles({ from: r.playbackProgress.mediaFileId, to: r.mediaFiles.id }),
	},
	profileStreamPrefs: {
		profile: r.one.profiles({ from: r.profileStreamPrefs.profileId, to: r.profiles.id }),
		metadata: r.one.metadata({ from: r.profileStreamPrefs.metadataId, to: r.metadata.id }),
	},
	profilePreferenceOverrides: {
		profile: r.one.profiles({ from: r.profilePreferenceOverrides.profileId, to: r.profiles.id }),
	},
	profiles: {
		user: r.one.users({ from: r.profiles.userId, to: r.users.id }),
		notifications: r.many.notifications(),
		watchlist: r.many.watchlist(),
		userRatings: r.many.userRatings(),
		watchedHistory: r.many.watchedHistory(),
		playbackProgress: r.many.playbackProgress(),
		preferences: r.many.profilePreferenceOverrides(),
		streamPrefs: r.many.profileStreamPrefs(),
		downloads: r.many.downloads(),
	},
	providers: {
		collections: r.many.collectionProviders(),
		companies: r.many.companyProviders(),
		episodes: r.many.episodeProviders(),
		genres: r.many.genreProviders(),
		keywords: r.many.keywordProviders(),
		metadata: r.many.metadataProviders(),
		people: r.many.personProviders(),
		seasons: r.many.seasonProviders(),
	},
	seasons: {
		metadata: r.one.metadata({ from: r.seasons.metadataId, to: r.metadata.id }),
		image: r.one.images({ from: r.seasons.imageId, to: r.images.id }),
		rating: r.many.seasonRatings(),
		providers: r.many.seasonProviders(),
		episodes: r.many.episodes(),
	},
	seasonRatings: {
		season: r.one.seasons({ from: r.seasonRatings.seasonId, to: r.seasons.id }),
	},
	seasonProviders: {
		season: r.one.seasons({ from: r.seasonProviders.seasonId, to: r.seasons.id }),
		provider: r.one.providers({ from: r.seasonProviders.providerId, to: r.providers.id }),
	},
	sessions: {
		user: r.one.users({ from: r.sessions.userId, to: r.users.id }),
	},
	subtitles: {
		mediaFile: r.one.mediaFiles({ from: r.subtitles.mediaFileId, to: r.mediaFiles.id }),
	},
	userRatings: {
		profile: r.one.profiles({ from: r.userRatings.profileId, to: r.profiles.id }),
		metadata: r.one.metadata({ from: r.userRatings.metadataId, to: r.metadata.id }),
	},
	users: {
		profiles: r.many.profiles(),
		sessions: r.many.sessions(),
		accounts: r.many.accounts(),
		notifications: r.many.notifications(),
	},
	notifications: {
		user: r.one.users({ from: r.notifications.userId, to: r.users.id }),
		profile: r.one.profiles({ from: r.notifications.profileId, to: r.profiles.id }),
	},
	watchedHistory: {
		mediaFile: r.one.mediaFiles({ from: r.watchedHistory.mediaFileId, to: r.mediaFiles.id }),
		profile: r.one.profiles({ from: r.watchedHistory.profileId, to: r.profiles.id }),
	},
	watchlist: {
		profile: r.one.profiles({ from: r.watchlist.profileId, to: r.profiles.id }),
		metadata: r.one.metadata({ from: r.watchlist.metadataId, to: r.metadata.id }),
	},
}));
