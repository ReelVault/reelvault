import {
	type HttpScenarioResult,
	type HttpScenarioRun,
	httpScenarioResult,
	main,
	printHttpResults,
	runHttpScenario,
	suiteArgs,
	task,
} from "benchkit";

import { createServerFixture } from "./lib/server-fixture";

interface ScenarioContext {
	baseUrl: string;
	cookies: readonly string[];
	/** Admin session cookie — admin-only endpoints reject the worker identities. */
	adminCookie: string;
	profileIdFor: (workerIndex: number) => string;
	imageId: string;
	movieDetailId: string;
	tvDetailId: string;
	mediaFileId: string;
	libraryId: string;
	seasonId: string;
	episodeId: string;
	genreId: string;
	personId: string;
	/** Seeded catalog rows — scenarios scale off it (e.g. deep pagination pages). */
	seededRows: number;
	/** When true, requests send `Cache-Control: no-cache` to bypass the server-side body cache. */
	noCache: boolean;
}

type RequestBuilder = (context: ScenarioContext, workerIndex: number, requestIndex: number) => Request;

/** Fallback identity scheme used before a managed server provides real profiles. */
const defaultProfileIdFor = (index: number): string => `profile-bench-${index}`;

function authHeaders(context: ScenarioContext, workerIndex: number, requestIndex: number, withProfile = false): RequestInit {
	const identityIndex = (workerIndex * 997 + requestIndex) % Math.max(context.cookies.length, 1);
	const cookie = context.cookies[identityIndex];
	const ip = `10.77.${Math.floor(identityIndex / 250) % 250}.${(identityIndex % 250) + 1}`;
	const headers: Record<string, string> = {
		...(cookie ? { cookie } : {}),
		"x-forwarded-for": ip,
	};
	if (withProfile) {
		headers["x-profile-id"] = context.profileIdFor(identityIndex);
	}

	if (context.noCache) headers["cache-control"] = "no-cache";

	return { headers };
}

const health: RequestBuilder = (context) => new Request(`${context.baseUrl}/v1/health`);

const metadataList: RequestBuilder = (context, workerIndex, requestIndex) =>
	new Request(`${context.baseUrl}/v1/metadata?limit=24&page=${(requestIndex % 20) + 1}`, authHeaders(context, workerIndex, requestIndex));

const globalSearch: RequestBuilder = (context, workerIndex, requestIndex) =>
	new Request(
		`${context.baseUrl}/v1/metadata/search/global?q=${encodeURIComponent(requestIndex % 2 === 0 ? "star" : "benchmark")}&limit=10`,
		authHeaders(context, workerIndex, requestIndex),
	);

// A non-prefix (typo) query: FTS prefix matches nothing, so the handler falls
// back to leading-wildcard LIKE + per-candidate fuzzy scoring — a distinct,
// much heavier code path than the prefix search above.
const typoSearch: RequestBuilder = (context, workerIndex, requestIndex) =>
	new Request(`${context.baseUrl}/v1/metadata/search/global?q=statr&limit=10`, authHeaders(context, workerIndex, requestIndex));

const imageServing: RequestBuilder = (context, workerIndex, requestIndex) =>
	new Request(`${context.baseUrl}/v1/images/${context.imageId}?w=342`, authHeaders(context, workerIndex, requestIndex));

const discoverFeed: RequestBuilder = (context, workerIndex, requestIndex) =>
	new Request(`${context.baseUrl}/v1/discover?limit=10`, authHeaders(context, workerIndex, requestIndex, true));

// ─── Composite detail / per-profile scenarios ────────────────────────────────

const movieDetail: RequestBuilder = (context, workerIndex, requestIndex) =>
	new Request(`${context.baseUrl}/v1/metadata/${context.movieDetailId}`, authHeaders(context, workerIndex, requestIndex));

const tvDetail: RequestBuilder = (context, workerIndex, requestIndex) =>
	new Request(`${context.baseUrl}/v1/metadata/${context.tvDetailId}`, authHeaders(context, workerIndex, requestIndex));

const similarTitles: RequestBuilder = (context, workerIndex, requestIndex) =>
	new Request(`${context.baseUrl}/v1/metadata/${context.movieDetailId}/similar?limit=12`, authHeaders(context, workerIndex, requestIndex));

const continueWatching: RequestBuilder = (context, workerIndex, requestIndex) =>
	new Request(`${context.baseUrl}/v1/me/continue-watching?limit=12`, authHeaders(context, workerIndex, requestIndex, true));

const playbackView: RequestBuilder = (context, workerIndex, requestIndex) =>
	new Request(`${context.baseUrl}/v1/playback-sessions/view/${context.mediaFileId}`, authHeaders(context, workerIndex, requestIndex, true));

const watchedHistory: RequestBuilder = (context, workerIndex, requestIndex) =>
	new Request(`${context.baseUrl}/v1/me/watched-history?limit=50`, authHeaders(context, workerIndex, requestIndex, true));

const watchedInsights: RequestBuilder = (context, workerIndex, requestIndex) =>
	new Request(`${context.baseUrl}/v1/me/watched-history/insights?range=30d`, authHeaders(context, workerIndex, requestIndex, true));

const watchlist: RequestBuilder = (context, workerIndex, requestIndex) =>
	new Request(`${context.baseUrl}/v1/me/watchlist?limit=24`, authHeaders(context, workerIndex, requestIndex, true));

const unreadCount: RequestBuilder = (context, workerIndex, requestIndex) =>
	new Request(`${context.baseUrl}/v1/notifications/unread-count`, authHeaders(context, workerIndex, requestIndex, true));

const deepPage: RequestBuilder = (context, workerIndex, requestIndex) => {
	// Halfway through the catalog — OFFSET must scan past ~half the rows, so
	// this scenario exposes how pagination cost grows with `--rows`.
	const page = Math.max(1, Math.floor(context.seededRows / 24 / 2));

	return new Request(`${context.baseUrl}/v1/metadata?limit=24&page=${page}`, authHeaders(context, workerIndex, requestIndex));
};

const projectedBrowse: RequestBuilder = (context, workerIndex, requestIndex) =>
	new Request(
		`${context.baseUrl}/v1/metadata?limit=24&fields=id,title,type,releaseDate,overview`,
		authHeaders(context, workerIndex, requestIndex),
	);

const filteredBrowse: RequestBuilder = (context, workerIndex, requestIndex) =>
	new Request(
		`${context.baseUrl}/v1/metadata?limit=24&yearFrom=2020&yearTo=2023&genreIds=genre-1`,
		authHeaders(context, workerIndex, requestIndex),
	);

// ─── Untested catalog / per-profile / admin surfaces ─────────────────────────

const adminHeaders = (context: ScenarioContext, profileId: string): RequestInit => ({
	headers: {
		cookie: context.adminCookie,
		"x-profile-id": profileId,
		...(context.noCache ? { "cache-control": "no-cache" } : {}),
	},
});

const detailsView: RequestBuilder = (context, workerIndex, requestIndex) =>
	new Request(
		`${context.baseUrl}/v1/metadata/${context.movieDetailId}/details-view`,
		authHeaders(context, workerIndex, requestIndex, true),
	);

const seasonsList: RequestBuilder = (context, workerIndex, requestIndex) =>
	new Request(`${context.baseUrl}/v1/seasons?limit=24&page=1`, authHeaders(context, workerIndex, requestIndex));

const episodesList: RequestBuilder = (context, workerIndex, requestIndex) =>
	new Request(`${context.baseUrl}/v1/episodes?limit=24&page=1`, authHeaders(context, workerIndex, requestIndex));

const librariesList: RequestBuilder = (context, workerIndex, requestIndex) =>
	new Request(`${context.baseUrl}/v1/libraries?limit=24&page=1`, authHeaders(context, workerIndex, requestIndex));

const libraryDetail: RequestBuilder = (context, workerIndex, requestIndex) =>
	new Request(`${context.baseUrl}/v1/libraries/${context.libraryId}`, authHeaders(context, workerIndex, requestIndex));

const seasonDetail: RequestBuilder = (context, workerIndex, requestIndex) =>
	new Request(`${context.baseUrl}/v1/seasons/${context.seasonId}`, authHeaders(context, workerIndex, requestIndex));

const episodeDetail: RequestBuilder = (context, workerIndex, requestIndex) =>
	new Request(`${context.baseUrl}/v1/episodes/${context.episodeId}`, authHeaders(context, workerIndex, requestIndex));

const personDetail: RequestBuilder = (context, workerIndex, requestIndex) =>
	new Request(`${context.baseUrl}/v1/people/${context.personId}`, authHeaders(context, workerIndex, requestIndex));

const genreDetail: RequestBuilder = (context, workerIndex, requestIndex) =>
	new Request(`${context.baseUrl}/v1/genres/${context.genreId}`, authHeaders(context, workerIndex, requestIndex));

const genresList: RequestBuilder = (context, workerIndex, requestIndex) =>
	new Request(`${context.baseUrl}/v1/genres?limit=50&page=1`, authHeaders(context, workerIndex, requestIndex));

const peopleList: RequestBuilder = (context, workerIndex, requestIndex) =>
	new Request(`${context.baseUrl}/v1/people?limit=24&page=1`, authHeaders(context, workerIndex, requestIndex));

const notificationsList: RequestBuilder = (context, workerIndex, requestIndex) =>
	new Request(`${context.baseUrl}/v1/notifications?limit=20`, authHeaders(context, workerIndex, requestIndex, true));

const userRatings: RequestBuilder = (context, workerIndex, requestIndex) =>
	new Request(`${context.baseUrl}/v1/me/ratings?limit=24`, authHeaders(context, workerIndex, requestIndex, true));

const watchlistStatuses: RequestBuilder = (context, workerIndex, requestIndex) => {
	const ids = [context.movieDetailId, context.tvDetailId, "meta-0000010", "meta-0000020"].join(",");

	return new Request(`${context.baseUrl}/v1/me/watchlist/statuses?ids=${ids}`, authHeaders(context, workerIndex, requestIndex, true));
};

const playbackProgress: RequestBuilder = (context, workerIndex, requestIndex) =>
	new Request(`${context.baseUrl}/v1/me/playback-progress/${context.movieDetailId}`, authHeaders(context, workerIndex, requestIndex, true));

const watchedWrapped: RequestBuilder = (context, workerIndex, requestIndex) =>
	new Request(`${context.baseUrl}/v1/me/watched-history/wrapped?year=2026`, authHeaders(context, workerIndex, requestIndex, true));

const adminDashboard: RequestBuilder = (context, workerIndex) =>
	new Request(`${context.baseUrl}/v1/admin/dashboard`, adminHeaders(context, context.profileIdFor(workerIndex)));

const adminAudit: RequestBuilder = (context, workerIndex) =>
	new Request(`${context.baseUrl}/v1/admin/audit?page=1&limit=20`, adminHeaders(context, context.profileIdFor(workerIndex)));

const adminWorkers: RequestBuilder = (context, workerIndex) =>
	new Request(`${context.baseUrl}/v1/admin/workers`, adminHeaders(context, context.profileIdFor(workerIndex)));

// Breadth over the admin surface that no other scenario touches — every route
// here is a real GET in src/api/routes/admin (verified against the routers).
const ADMIN_BREADTH_PATHS: readonly string[] = [
	"/v1/admin/settings",
	"/v1/admin/users",
	"/v1/admin/logs",
	"/v1/admin/analytics",
	"/v1/admin/live-activity",
	"/v1/admin/processes",
	"/v1/admin/database/backups",
	"/v1/admin/ffmpeg-capabilities",
	"/v1/admin/network/remote-access",
];

const adminBreadth: RequestBuilder = (context, workerIndex, requestIndex) => {
	const path = ADMIN_BREADTH_PATHS[requestIndex % ADMIN_BREADTH_PATHS.length] ?? "/v1/admin/settings";

	return new Request(`${context.baseUrl}${path}`, adminHeaders(context, context.profileIdFor(workerIndex)));
};

// Catalog route groups that had no scenario: list endpoints only (their detail
// ids are not seeded, and a 404 would pollute the error rate).
const collectionsList: RequestBuilder = (context, workerIndex, requestIndex) =>
	new Request(`${context.baseUrl}/v1/collections?limit=24`, authHeaders(context, workerIndex, requestIndex));

const companiesList: RequestBuilder = (context, workerIndex, requestIndex) =>
	new Request(`${context.baseUrl}/v1/companies?limit=24`, authHeaders(context, workerIndex, requestIndex));

const keywordsList: RequestBuilder = (context, workerIndex, requestIndex) =>
	new Request(`${context.baseUrl}/v1/keywords?limit=24`, authHeaders(context, workerIndex, requestIndex));

const providersList: RequestBuilder = (context, workerIndex, requestIndex) =>
	new Request(`${context.baseUrl}/v1/providers`, authHeaders(context, workerIndex, requestIndex));

const pluginsList: RequestBuilder = (context, workerIndex, _requestIndex) =>
	new Request(`${context.baseUrl}/v1/plugins`, adminHeaders(context, context.profileIdFor(workerIndex)));

const mediaFilesList: RequestBuilder = (context, workerIndex, requestIndex) =>
	new Request(`${context.baseUrl}/v1/media-files?limit=24`, authHeaders(context, workerIndex, requestIndex));

const MIX: ReadonlyArray<readonly [RequestBuilder, number]> = [
	[metadataList, 0.35],
	[globalSearch, 0.18],
	[imageServing, 0.12],
	[continueWatching, 0.08],
	[movieDetail, 0.08],
	[tvDetail, 0.05],
	[unreadCount, 0.05],
	[discoverFeed, 0.03],
	[deepPage, 0.02],
];

const mixedTraffic: RequestBuilder = (context, workerIndex, requestIndex) => {
	const draw = (requestIndex * 2654435761) % 1000;
	let threshold = 0;
	for (const [builder, weight] of MIX) {
		threshold += weight * 1000;
		if (draw < threshold) return builder(context, workerIndex, requestIndex);
	}

	return metadataList(context, workerIndex, requestIndex);
};

interface ScenarioDefinition {
	name: string;
	builder: RequestBuilder;
}

const SCENARIOS: readonly ScenarioDefinition[] = [
	{ name: "GET /v1/health (public baseline)", builder: health },
	{ name: "GET /v1/metadata?limit=24 (catalog browse)", builder: metadataList },
	{ name: "GET /v1/metadata?fields=... (projected browse)", builder: projectedBrowse },
	{ name: "GET /v1/metadata?year+genre (filtered browse)", builder: filteredBrowse },
	{ name: "GET /v1/metadata?page=rows/2 (deep offset page)", builder: deepPage },
	{ name: "GET /v1/metadata/search (FTS5 search)", builder: globalSearch },
	{ name: "GET /v1/metadata/search?q=statr (typo → fuzzy fallback)", builder: typoSearch },
	{ name: "GET /v1/metadata/:id (movie detail)", builder: movieDetail },
	{ name: "GET /v1/metadata/:id (tv detail + episodes)", builder: tvDetail },
	{ name: "GET /v1/metadata/:id/similar", builder: similarTitles },
	{ name: "GET /v1/me/continue-watching", builder: continueWatching },
	{ name: "GET /v1/playback-sessions/view/:mediaFileId", builder: playbackView },
	{ name: "GET /v1/me/watched-history?limit=50", builder: watchedHistory },
	{ name: "GET /v1/me/watched-history/insights", builder: watchedInsights },
	{ name: "GET /v1/me/watchlist?limit=24", builder: watchlist },
	{ name: "GET /v1/notifications/unread-count", builder: unreadCount },
	{ name: "GET /v1/images/:id?w=342 (Sharp image)", builder: imageServing },
	{ name: "GET /v1/discover (personalized feed)", builder: discoverFeed },
	{ name: "GET /v1/metadata/:id/details-view", builder: detailsView },
	{ name: "GET /v1/seasons?limit=24", builder: seasonsList },
	{ name: "GET /v1/episodes?limit=24", builder: episodesList },
	{ name: "GET /v1/libraries?limit=24", builder: librariesList },
	{ name: "GET /v1/libraries/:id", builder: libraryDetail },
	{ name: "GET /v1/seasons/:id", builder: seasonDetail },
	{ name: "GET /v1/episodes/:id", builder: episodeDetail },
	{ name: "GET /v1/genres?limit=50", builder: genresList },
	{ name: "GET /v1/genres/:id", builder: genreDetail },
	{ name: "GET /v1/people?limit=24", builder: peopleList },
	{ name: "GET /v1/people/:id", builder: personDetail },
	{ name: "GET /v1/notifications?limit=20", builder: notificationsList },
	{ name: "GET /v1/me/ratings?limit=24", builder: userRatings },
	{ name: "GET /v1/me/watchlist/statuses", builder: watchlistStatuses },
	{ name: "GET /v1/me/playback-progress/:metadataId", builder: playbackProgress },
	{ name: "GET /v1/me/watched-history/wrapped", builder: watchedWrapped },
	{ name: "GET /v1/admin/dashboard (admin)", builder: adminDashboard },
	{ name: "GET /v1/admin/audit (admin)", builder: adminAudit },
	{ name: "GET /v1/admin/workers (admin)", builder: adminWorkers },
	{ name: "GET /v1/admin/* breadth (admin, 9 routes)", builder: adminBreadth },
	{ name: "GET /v1/collections?limit=24", builder: collectionsList },
	{ name: "GET /v1/companies?limit=24", builder: companiesList },
	{ name: "GET /v1/keywords?limit=24", builder: keywordsList },
	{ name: "GET /v1/providers", builder: providersList },
	{ name: "GET /v1/plugins (admin)", builder: pluginsList },
	{ name: "GET /v1/media-files?limit=24", builder: mediaFilesList },
	{
		name: "Mixed traffic (35% browse, 18% search, 12% image, 8% continue+detail, ...)",
		builder: mixedTraffic,
	},
];

function runScenario(
	scenario: ScenarioDefinition,
	concurrency: number,
	context: ScenarioContext,
	warmupMs: number,
	durationMs: number,
): Promise<HttpScenarioRun> {
	return runHttpScenario({
		concurrency,
		warmupMs,
		durationMs,
		work: async (workerIndex, requestIndex) => {
			try {
				const response = await fetch(scenario.builder(context, workerIndex, requestIndex));
				const ok = response.ok;
				await response.arrayBuffer();

				return { ok };
			} catch {
				return { ok: false };
			}
		},
	});
}

export const meta = { description: "HTTP API throughput & latency (browse, search, images, discover, mixed)" };

const args = suiteArgs();

if (!args.help) {
	const serverFixture = createServerFixture({
		seedRows: args.rows,
		workerCount: Math.max(...args.concurrency),
		keepServer: args.keepServer,
	});

	task("http: scenarios", async () => {
		let baseUrl = args.baseUrl;
		let cookies: readonly string[] = [];
		let profileIdFor: (index: number) => string = defaultProfileIdFor;
		let imageId = "img-benchmark";
		let movieDetailId = "meta-0000001";
		let tvDetailId = "meta-0000000";
		let mediaFileId = "mf-meta-0000001";
		let adminCookie = "";
		let libraryId = "lib-benchmark";
		let seasonId = "season-0-0";
		let episodeId = "ep-0-0-0";
		let genreId = "genre-1";
		let personId = "person-0";
		let seededRows = args.rows;

		if (baseUrl) {
			console.log(`[http] targeting external server at ${baseUrl}`);
		} else {
			const managed = await serverFixture();
			baseUrl = managed.baseUrl;
			cookies = managed.workerCookies;
			profileIdFor = (idx) => managed.profileIdFor(idx);
			imageId = managed.benchmarkImageId;
			movieDetailId = managed.benchmarkMovieDetailId;
			tvDetailId = managed.benchmarkTvDetailId;
			mediaFileId = managed.benchmarkMediaFileId;
			adminCookie = managed.cookie;
			libraryId = managed.benchmarkLibraryId;
			seasonId = managed.benchmarkSeasonId;
			episodeId = managed.benchmarkEpisodeId;
			genreId = managed.benchmarkGenreId;
			personId = managed.benchmarkPersonId;
			seededRows = managed.seededRows;
			console.log(`[http] server ready with ${cookies.length} client identities and ${args.rows} catalog rows`);
		}

		const context: ScenarioContext = {
			baseUrl,
			cookies,
			adminCookie,
			profileIdFor,
			imageId,
			movieDetailId,
			tvDetailId,
			mediaFileId,
			libraryId,
			seasonId,
			episodeId,
			genreId,
			personId,
			seededRows,
			noCache: args.noCache,
		};
		const results: HttpScenarioResult[] = [];

		const scenarios = args.scenario ? SCENARIOS.filter((scenario) => scenario.name.includes(args.scenario ?? "")) : SCENARIOS;

		for (const concurrency of args.concurrency) {
			console.log(`\n[http] concurrency ${concurrency} (warmup ${args.warmupMs}ms, measure ${args.durationMs}ms)`);
			for (const scenario of scenarios) {
				const run = await runScenario(scenario, concurrency, context, args.warmupMs, args.durationMs);
				const result = httpScenarioResult(scenario.name, concurrency, run, args.durationMs);
				results.push(result);
				const failureNote = result.errorRatePercent > 0 ? `, errors ${result.errorRatePercent.toFixed(1)}%` : "";
				console.log(
					`  ${scenario.name}: ${result.requestsPerSecond.toFixed(0)} req/s, p95 ${result.stats.p95Ms.toFixed(1)}ms${failureNote}`,
				);
			}
		}

		printHttpResults(results);
	});
}

await main(import.meta);
