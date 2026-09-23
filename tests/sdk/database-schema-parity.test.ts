import { describe, expect, test } from "bun:test";
import {
	CollectionSchema,
	CompanySchema,
	EpisodeSchema,
	GenreSchema,
	ImageSchema,
	KeywordSchema,
	LibraryPathSchema,
	LibrarySchema,
	MediaFileAudioStreamSchema,
	MediaFileSchema,
	MediaFileVideoStreamSchema,
	MetadataImageSchema,
	MetadataRatingSchema,
	MetadataSchema,
	MovieSchema,
	PersonSchema,
	ProfileSchema,
	ProviderSchema,
	SeasonSchema,
	SessionSchema,
	UserRatingSchema,
	UserSchema,
	WatchedHistorySchema,
	WatchlistSchema,
} from "@sdk";
import { SubtitleEntitySchema } from "@sdk/common/subtitle.types";
import { createSelectSchema } from "drizzle-typebox";
import { schema } from "@/database/schema";

interface ObjectSchema {
	properties: Record<string, unknown>;
	required?: string[];
}

const models: Array<[string, unknown, ObjectSchema]> = [
	["collections", schema.collections, CollectionSchema],
	["companies", schema.companies, CompanySchema],
	["episodes", schema.episodes, EpisodeSchema],
	["genres", schema.genres, GenreSchema],
	["images", schema.images, ImageSchema],
	["keywords", schema.keywords, KeywordSchema],
	["libraries", schema.libraries, LibrarySchema],
	["libraryPaths", schema.libraryPaths, LibraryPathSchema],
	["mediaFiles", schema.mediaFiles, MediaFileSchema],
	["mediaFileVideoStreams", schema.mediaFileVideoStreams, MediaFileVideoStreamSchema],
	["mediaFileAudioStreams", schema.mediaFileAudioStreams, MediaFileAudioStreamSchema],
	["metadata", schema.metadata, MetadataSchema],
	["metadataRatings", schema.metadataRatings, MetadataRatingSchema],
	["metadataImages", schema.metadataImages, MetadataImageSchema],
	["movies", schema.movies, MovieSchema],
	["people", schema.people, PersonSchema],
	["profiles", schema.profiles, ProfileSchema],
	["providers", schema.providers, ProviderSchema],
	["seasons", schema.seasons, SeasonSchema],
	["sessions", schema.sessions, SessionSchema],
	["subtitles", schema.subtitles, SubtitleEntitySchema],
	["users", schema.users, UserSchema],
	["userRatings", schema.userRatings, UserRatingSchema],
	["watchedHistory", schema.watchedHistory, WatchedHistorySchema],
	["watchlist", schema.watchlist, WatchlistSchema],
];

describe("SDK database schemas", () => {
	for (const [name, table, sdkSchema] of models) {
		test(`${name} exposes the same columns and required fields as Drizzle`, () => {
			const databaseSchema = (createSelectSchema as (value: unknown) => ObjectSchema)(table);
			expect(Object.keys(sdkSchema.properties).toSorted()).toEqual(Object.keys(databaseSchema.properties).toSorted());
			expect([...(sdkSchema.required ?? [])].toSorted()).toEqual([...(databaseSchema.required ?? [])].toSorted());
		});
	}
});
