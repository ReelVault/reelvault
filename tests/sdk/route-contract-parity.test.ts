import { describe, expect, test } from "bun:test";
import {
	CollectionWithRelationsSchema,
	CompanySchema,
	EpisodeWithRelationsSchema,
	GenreSchema,
	KeywordSchema,
	LibraryDetailSchema,
	LibraryWithRelationsSchema,
	MediaFileWithRelationSchema,
	MetadataWithRelationSchema,
	PaginatedResponseSchema,
	PersonWithRelationsSchema,
	ProfileSchema,
	ProjectedResponseSchema,
	SeasonSchema,
	SubtitleSchema,
	UserRatingSchema,
	WatchedHistoryWithRelationsSchema,
	WatchlistSchema,
} from "@reelvault/sdk/common";
import { type TSchema, t } from "elysia";
import { collectionRoutes } from "@/api/routes/v1/collections.routes";
import { companiesRoutes } from "@/api/routes/v1/companies.routes";
import { episodesRoutes } from "@/api/routes/v1/episodes.routes";
import { genreRoutes } from "@/api/routes/v1/genres.routes";
import { keywordsRoutes } from "@/api/routes/v1/keywords.routes";
import { librariesRoutes } from "@/api/routes/v1/libraries.routes";
import { meRoutes } from "@/api/routes/v1/me.routes";
import { mediaFilesRoutes } from "@/api/routes/v1/media-files.routes";
import { metadataRoutes } from "@/api/routes/v1/metadata.routes";
import { peopleRoutes } from "@/api/routes/v1/people.routes";
import { profilesRoutes } from "@/api/routes/v1/profiles.routes";
import { seasonsRoutes } from "@/api/routes/v1/seasons.routes";
import { subtitlesRoutes } from "@/api/routes/v1/subtitles.routes";
import { collectPropertyPaths } from "../helpers/schema-contract";

/**
 * Contract-honesty registry: every named entity response model declared by a
 * route must be derived from the SAME SDK contract schema the client types
 * promise, wrapped the same way (projected + paginated).
 *
 * This is the guard for the `/admin/media` class of bug, where a route declared
 * its list items as the bare `MediaFileSchema` while the handler returned
 * `MediaFileWithRelation` rows — `ProjectedResponseSchema` deep-partials every
 * property, so Elysia's response validation silently accepts the mismatch and
 * only the frontend crashes on the missing relation. Swapping either side of a
 * row below (route model or contract) fails the property-path comparison.
 */
interface ContractRow {
	family: string;
	/** Route module whose Elysia model registry is introspected. */
	module: unknown;
	model: string;
	contract: TSchema;
	/** Whether the endpoint supports `?fields=` (route model wraps the contract in ProjectedResponseSchema). */
	projected: boolean;
	/** Whether the model is a PaginatedResponseSchema envelope around the contract. */
	paginated: boolean;
}

/**
 * Resolves a registered model through the Elysia model registry. The registry
 * mixes ModelValidator entries with a `modules` bucket — only validator entries
 * carry `.schema` — so a narrow local cast beats duplicating Elysia's generics.
 */
function registeredSchema(module: unknown, name: string): { schema?: unknown } | undefined {
	if (!(module instanceof Object && "models" in module && module.models instanceof Object)) return undefined;

	const models = module.models as Record<string, { schema?: unknown } | undefined>;

	return models[name];
}

const REGISTRY: ContractRow[] = [
	// media-files
	{
		family: "media-file detail",
		module: mediaFilesRoutes,
		model: "media-file.schema",
		contract: MediaFileWithRelationSchema,
		projected: true,
		paginated: false,
	},
	{
		family: "media-files list",
		module: mediaFilesRoutes,
		model: "media-files.paginated.schema",
		contract: MediaFileWithRelationSchema,
		projected: true,
		paginated: true,
	},
	// metadata
	{
		family: "metadata detail",
		module: metadataRoutes,
		model: "metadata.schema",
		contract: MetadataWithRelationSchema,
		projected: true,
		paginated: false,
	},
	{
		family: "metadata list",
		module: metadataRoutes,
		model: "metadata.paginated.schema",
		contract: MetadataWithRelationSchema,
		projected: true,
		paginated: true,
	},
	// episodes
	{
		family: "episode detail",
		module: episodesRoutes,
		model: "episode.schema",
		contract: EpisodeWithRelationsSchema,
		projected: true,
		paginated: false,
	},
	{
		family: "episodes list",
		module: episodesRoutes,
		model: "episodes.paginated.schema",
		contract: EpisodeWithRelationsSchema,
		projected: true,
		paginated: true,
	},
	// seasons (no relations contract exists — the base entity is the promise)
	{ family: "season detail", module: seasonsRoutes, model: "season.schema", contract: SeasonSchema, projected: true, paginated: false },
	{
		family: "seasons list",
		module: seasonsRoutes,
		model: "seasons.paginated.schema",
		contract: SeasonSchema,
		projected: true,
		paginated: true,
	},
	// libraries — the detail promises LibraryDetail (optional `siblings`), the list the plain relations contract
	{
		family: "library detail",
		module: librariesRoutes,
		model: "library.schema",
		contract: LibraryDetailSchema,
		projected: true,
		paginated: false,
	},
	{
		family: "libraries list",
		module: librariesRoutes,
		model: "libraries.paginated.schema",
		contract: LibraryWithRelationsSchema,
		projected: true,
		paginated: true,
	},
	// collections
	{
		family: "collection detail",
		module: collectionRoutes,
		model: "collection.schema",
		contract: CollectionWithRelationsSchema,
		projected: true,
		paginated: false,
	},
	{
		family: "collections list",
		module: collectionRoutes,
		model: "collections.paginated.schema",
		contract: CollectionWithRelationsSchema,
		projected: true,
		paginated: true,
	},
	// people
	{
		family: "person detail",
		module: peopleRoutes,
		model: "person.schema",
		contract: PersonWithRelationsSchema,
		projected: true,
		paginated: false,
	},
	{
		family: "people list",
		module: peopleRoutes,
		model: "people.paginated.schema",
		contract: PersonWithRelationsSchema,
		projected: true,
		paginated: true,
	},
	// genres / keywords / companies (base entities by contract)
	{ family: "genre detail", module: genreRoutes, model: "genre.schema", contract: GenreSchema, projected: true, paginated: false },
	{ family: "genres list", module: genreRoutes, model: "genres.paginated.schema", contract: GenreSchema, projected: true, paginated: true },
	{ family: "keyword detail", module: keywordsRoutes, model: "keyword.schema", contract: KeywordSchema, projected: true, paginated: false },
	{
		family: "keywords list",
		module: keywordsRoutes,
		model: "keywords.paginated.schema",
		contract: KeywordSchema,
		projected: true,
		paginated: true,
	},
	{
		family: "company detail",
		module: companiesRoutes,
		model: "company.schema",
		contract: CompanySchema,
		projected: true,
		paginated: false,
	},
	{
		family: "companies list",
		module: companiesRoutes,
		model: "companies.paginated.schema",
		contract: CompanySchema,
		projected: true,
		paginated: true,
	},
	// profiles (PIN stripped server-side, no relations)
	{ family: "profile detail", module: profilesRoutes, model: "profile.schema", contract: ProfileSchema, projected: true, paginated: false },
	{
		family: "profiles list",
		module: profilesRoutes,
		model: "profiles.paginated.schema",
		contract: ProfileSchema,
		projected: true,
		paginated: true,
	},
	// me routes
	{
		family: "watchlist detail",
		module: meRoutes,
		model: "me.watchlist.schema",
		contract: WatchlistSchema,
		projected: true,
		paginated: false,
	},
	{
		family: "watchlist list",
		module: meRoutes,
		model: "me.watchlist.paginated.schema",
		contract: WatchlistSchema,
		projected: true,
		paginated: true,
	},
	{
		family: "user rating detail",
		module: meRoutes,
		model: "me.userRating.schema",
		contract: UserRatingSchema,
		projected: true,
		paginated: false,
	},
	{
		family: "user ratings list",
		module: meRoutes,
		model: "me.userRatings.paginated.schema",
		contract: UserRatingSchema,
		projected: true,
		paginated: true,
	},
	// watched history and subtitles do NOT support `?fields=` — strict (non-projected) contracts
	{
		family: "watched history detail",
		module: meRoutes,
		model: "me.watchedHistory.schema",
		contract: WatchedHistoryWithRelationsSchema,
		projected: false,
		paginated: false,
	},
	{
		family: "watched history list",
		module: meRoutes,
		model: "me.watchedHistory.paginated.schema",
		contract: WatchedHistoryWithRelationsSchema,
		projected: false,
		paginated: true,
	},
	{
		family: "subtitle detail",
		module: subtitlesRoutes,
		model: "subtitle.schema",
		contract: SubtitleSchema,
		projected: false,
		paginated: false,
	},
	{
		family: "subtitles list",
		module: subtitlesRoutes,
		model: "subtitles.paginated.schema",
		contract: SubtitleSchema,
		projected: false,
		paginated: true,
	},
];

/** Rebuilds the schema expression the route is expected to have registered. */
function expectedModelSchema(row: ContractRow): unknown {
	const item = row.projected ? ProjectedResponseSchema(row.contract) : row.contract;

	return row.paginated ? PaginatedResponseSchema(item) : item;
}

describe("route response models match SDK contracts", () => {
	for (const row of REGISTRY) {
		test(`${row.family} (${row.model})`, () => {
			const registered = registeredSchema(row.module, row.model);
			expect(registered, `model ${row.model} must be registered on the routes module`).toBeDefined();

			const actual = collectPropertyPaths(registered?.schema);
			const expected = collectPropertyPaths(expectedModelSchema(row));
			expect([...actual].toSorted(), `property tree drift between ${row.model} and its SDK contract`).toEqual([...expected].toSorted());
		});
	}

	test("registry stays exhaustive over t.Object envelope fields", () => {
		// Guards the guard: if PaginatedResponseSchema ever gains/loses envelope
		// fields, the whole-tree comparison above must still be meaningful.
		const envelope = collectPropertyPaths(PaginatedResponseSchema(t.Object({})));
		expect([...envelope].toSorted()).toEqual(["data", "limit", "nextCursor", "page", "total", "totalPages"].toSorted());
	});
});
