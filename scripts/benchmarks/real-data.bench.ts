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
import { subnetIp } from "./lib/identity";

/**
 * HTTP scenarios against an EXTERNAL server seeded with real data:
 *   RV_BENCH_EMAIL / RV_BENCH_PASSWORD  (or RV_BENCH_COOKIE for a raw cookie header)
 *   bun run scripts/benchmark.ts real-data -- --baseUrl http://127.0.0.1:3037
 * Without --baseUrl the suite is a no-op (it never spawns a fixture).
 */

interface BenchContext {
	baseUrl: string;
	cookie: string;
	profileId: string;
	libraryId: string;
	movieId: string;
	tvId: string;
	mediaFileId: string;
	seasonId: string;
	episodeId: string;
	genreId: string;
	personId: string;
	adminUserId: string;
	imageId: string;
	searchTerm: string;
	totalMetadata: number;
	noCache: boolean;
}

type RequestBuilder = (context: BenchContext, workerIndex: number, requestIndex: number) => Request;

function authHeaders(context: BenchContext, withProfile = false): RequestInit {
	return {
		headers: {
			cookie: context.cookie,
			...(withProfile ? { "x-profile-id": context.profileId } : {}),
			...(context.noCache ? { "cache-control": "no-cache" } : {}),
		},
	};
}

const adminHeaders = (context: BenchContext): RequestInit => authHeaders(context);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function listItems(body: unknown): Array<Record<string, unknown>> {
	if (!(isRecord(body) && Array.isArray(body.data))) return [];

	return body.data.filter((item) => isRecord(item));
}

function totalOf(body: unknown, fallback: number): number {
	const total = isRecord(body) ? body.total : undefined;

	return typeof total === "number" ? total : fallback;
}

function stringField(item: Record<string, unknown> | undefined, key: string): string {
	const value = item?.[key];

	return typeof value === "string" ? value : "";
}

async function getJson(context: BenchContext, path: string, withProfile = false): Promise<unknown> {
	const response = await fetch(`${context.baseUrl}${path}`, authHeaders(context, withProfile));
	const body: unknown = await response.json();
	if (!response.ok) throw new Error(`${path} → ${response.status}`);
	return body;
}

async function login(baseUrl: string): Promise<string> {
	const cookieEnv = process.env.RV_BENCH_COOKIE;
	if (cookieEnv) return cookieEnv;

	const email = process.env.RV_BENCH_EMAIL;
	const password = process.env.RV_BENCH_PASSWORD;
	if (!(email && password)) {
		throw new Error("real-data bench needs RV_BENCH_COOKIE or RV_BENCH_EMAIL + RV_BENCH_PASSWORD");
	}

	const response = await fetch(`${baseUrl}/v1/auth/login`, {
		method: "POST",
		headers: { "content-type": "application/json", origin: baseUrl },
		body: JSON.stringify({ email, password }),
	});
	if (!response.ok) throw new Error(`login failed: ${response.status}`);

	const setCookies = response.headers.getSetCookie();
	const session = setCookies.find((cookie) => cookie.includes("session_token"));
	if (!session) throw new Error("login response carried no session cookie");
	await response.arrayBuffer();

	const cookiePair = session.split(";")[0];
	return cookiePair ?? session;
}

async function resolveContext(args: { baseUrl: string; noCache: boolean }): Promise<BenchContext> {
	const context: BenchContext = {
		baseUrl: args.baseUrl,
		cookie: "",
		profileId: "",
		libraryId: "",
		movieId: "",
		tvId: "",
		mediaFileId: "",
		seasonId: "",
		episodeId: "",
		genreId: "",
		personId: "",
		adminUserId: "",
		imageId: "",
		searchTerm: "star",
		totalMetadata: 0,
		noCache: args.noCache,
	};

	context.cookie = await login(args.baseUrl);

	context.profileId = stringField(listItems(await getJson(context, "/v1/profiles"))[0], "id");
	context.libraryId = stringField(listItems(await getJson(context, "/v1/libraries?limit=10"))[0], "id");

	const metadataBody = await getJson(context, "/v1/metadata?limit=50");
	const items = listItems(metadataBody);
	context.totalMetadata = totalOf(metadataBody, items.length);
	const movie = items.find((item) => item.type === "movie") ?? items[0];
	const tv = items.find((item) => item.type !== "movie");
	context.movieId = stringField(movie, "id");
	context.tvId = stringField(tv, "id");
	const title = stringField(movie, "title");
	context.searchTerm = title.length >= 3 ? title.slice(0, 4) : "star";

	const movieDetail = await getJson(context, `/v1/metadata/${context.movieId}`);
	const images = isRecord(movieDetail) && Array.isArray(movieDetail.images) ? movieDetail.images : [];
	const firstImage = images.find((image) => isRecord(image));
	const imagePayload = firstImage && isRecord(firstImage.data) ? firstImage.data : undefined;
	context.imageId = stringField(imagePayload, "id");

	context.seasonId = stringField(listItems(await getJson(context, "/v1/seasons?limit=1"))[0], "id");
	context.episodeId = stringField(listItems(await getJson(context, "/v1/episodes?limit=1"))[0], "id");
	context.mediaFileId = stringField(listItems(await getJson(context, "/v1/media-files?limit=1"))[0], "id");
	context.genreId = stringField(listItems(await getJson(context, "/v1/genres?limit=1"))[0], "id");
	context.personId = stringField(listItems(await getJson(context, "/v1/people?limit=1"))[0], "id");
	try {
		context.adminUserId = stringField(listItems(await getJson(context, "/v1/admin/users?page=1&limit=1"))[0], "id");
	} catch {
		// Non-admin sessions (or stricter query schemas) skip the admin detail ids —
		// scenarios interpolating {adminUserId} will 4xx and show up in the error rate.
		context.adminUserId = "";
	}

	console.log(
		`[real-data] resolved ids — library ${context.libraryId ? "ok" : "?"}, movie ${context.movieId ? "ok" : "?"}, tv ${context.tvId ? "ok" : "?"}, image ${context.imageId ? "ok" : "?"}, total ${context.totalMetadata}`,
	);

	return context;
}

const analyticsDays =
	(days: string): RequestBuilder =>
	(context) =>
		new Request(`${context.baseUrl}/v1/admin/analytics${days ? `?days=${days}` : ""}`, adminHeaders(context));

const adminPath =
	(path: string): RequestBuilder =>
	(context) =>
		new Request(`${context.baseUrl}${path}`, adminHeaders(context));

const metadataBrowse: RequestBuilder = (context, _worker, requestIndex) =>
	new Request(`${context.baseUrl}/v1/metadata?limit=24&page=${(requestIndex % 20) + 1}`, authHeaders(context));

const deepPage: RequestBuilder = (context) => {
	const page = Math.max(1, Math.floor(context.totalMetadata / 24 / 2));
	return new Request(`${context.baseUrl}/v1/metadata?limit=24&page=${page}`, authHeaders(context));
};

const prefixSearch: RequestBuilder = (context) =>
	new Request(`${context.baseUrl}/v1/metadata/search/global?q=${encodeURIComponent(context.searchTerm)}&limit=10`, authHeaders(context));

const typoSearch: RequestBuilder = (context) => {
	const term = context.searchTerm;
	const typo = term.length > 1 ? `${term.slice(0, -2)}${term.slice(-1)}${term.slice(-2, -1)}` : term;

	return new Request(`${context.baseUrl}/v1/metadata/search/global?q=${encodeURIComponent(typo)}&limit=10`, authHeaders(context));
};

/** {key} placeholders resolve against the live context before each run. */
function interpolatePath(context: BenchContext, template: string): string {
	return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
		const fields: Record<string, string | undefined> = {
			genreId: context.genreId,
			movieId: context.movieId,
			tvId: context.tvId,
			personId: context.personId,
			seasonId: context.seasonId,
			episodeId: context.episodeId,
			libraryId: context.libraryId,
			adminUserId: context.adminUserId,
			imageId: context.imageId,
			mediaFileId: context.mediaFileId,
			searchTerm: context.searchTerm,
		};

		return fields[key] ?? "unknown";
	});
}

type MatrixEntry = readonly [string, string, boolean?];

const HEADLINE_SCENARIOS: ReadonlyArray<readonly [string, RequestBuilder]> = [
	["admin: analytics days=7", analyticsDays("7")],
	["admin: analytics days=30", analyticsDays("30")],
	["admin: analytics days=90", analyticsDays("90")],
	["admin: analytics all", analyticsDays("")],
	["admin: dashboard", adminPath("/v1/admin/dashboard")],
	["admin: stats", adminPath("/v1/admin/stats")],
	["admin: resources", adminPath("/v1/admin/resources")],
	["admin: logs (dashboard card)", adminPath("/v1/admin/logs?level=warn,error,fatal&limit=6")],
	["admin: logs (full page)", adminPath("/v1/admin/logs?limit=100")],
	["admin: cache-stats", adminPath("/v1/admin/cache-stats")],
	["admin: update/status", adminPath("/v1/admin/update/status")],
	["admin: live-activity", adminPath("/v1/admin/live-activity")],
	["admin: audit", adminPath("/v1/admin/audit?page=1&limit=20")],
	["admin: workers", adminPath("/v1/admin/workers")],
	["admin: workers/operations", adminPath("/v1/admin/workers/operations?page=1&limit=8")],
	["admin: processes", adminPath("/v1/admin/processes")],
	["admin: settings", adminPath("/v1/admin/settings")],
	["admin: users", adminPath("/v1/admin/users?page=1&limit=20")],
	["admin: plugins", adminPath("/v1/admin/plugins")],
	["core: libraries", adminPath("/v1/libraries?limit=24")],
	["core: library detail", (context) => new Request(`${context.baseUrl}/v1/libraries/${context.libraryId}`, authHeaders(context))],
	["core: metadata browse", metadataBrowse],
	["core: metadata deep page", deepPage],
	["core: search (prefix)", prefixSearch],
	["core: search (typo fuzzy)", typoSearch],
	["core: movie detail", (context) => new Request(`${context.baseUrl}/v1/metadata/${context.movieId}`, authHeaders(context))],
	["core: tv detail", (context) => new Request(`${context.baseUrl}/v1/metadata/${context.tvId}`, authHeaders(context))],
	[
		"core: movie similar",
		(context) => new Request(`${context.baseUrl}/v1/metadata/${context.movieId}/similar?limit=12`, authHeaders(context)),
	],
	[
		"core: details-view",
		(context) => new Request(`${context.baseUrl}/v1/metadata/${context.movieId}/details-view`, authHeaders(context, true)),
	],
	["core: seasons list", adminPath("/v1/seasons?limit=24")],
	["core: episodes list", adminPath("/v1/episodes?limit=24")],
	["core: people list", adminPath("/v1/people?limit=24")],
	["core: genres", adminPath("/v1/genres?limit=50")],
	["core: collections", adminPath("/v1/collections?limit=24")],
	["core: companies", adminPath("/v1/companies?limit=24")],
	["core: keywords", adminPath("/v1/keywords?limit=24")],
	["core: providers", adminPath("/v1/providers")],
	["core: media-files", adminPath("/v1/media-files?limit=24")],
	["me: continue-watching", (context) => new Request(`${context.baseUrl}/v1/me/continue-watching?limit=12`, authHeaders(context, true))],
	["me: watched-history", (context) => new Request(`${context.baseUrl}/v1/me/watched-history?limit=50`, authHeaders(context, true))],
	["me: insights", (context) => new Request(`${context.baseUrl}/v1/me/watched-history/insights?range=30d`, authHeaders(context, true))],
	["me: wrapped", (context) => new Request(`${context.baseUrl}/v1/me/watched-history/wrapped?year=2026`, authHeaders(context, true))],
	["me: unread-count", (context) => new Request(`${context.baseUrl}/v1/notifications/unread-count`, authHeaders(context, true))],
	["images: poster w=342", (context) => new Request(`${context.baseUrl}/v1/images/${context.imageId}?w=342`, authHeaders(context))],
];

/** Every supported GET variant worth timing — one line per route × query shape. */
const ROUTE_MATRIX: readonly MatrixEntry[] = [
	// metadata browse variants
	["metadata: type=movie", "/v1/metadata?limit=24&type=movie"],
	["metadata: type=tv_show", "/v1/metadata?limit=24&type=tv_show"],
	["metadata: year 2020-2023", "/v1/metadata?limit=24&yearFrom=2020&yearTo=2023"],
	["metadata: sort title asc", "/v1/metadata?limit=24&sortBy=title&sortOrder=asc"],
	["metadata: sort popularity desc", "/v1/metadata?limit=24&sortBy=popularity&sortOrder=desc"],
	["metadata: sort releaseDate desc", "/v1/metadata?limit=24&sortBy=releaseDate&sortOrder=desc"],
	["metadata: projected 5 fields", "/v1/metadata?limit=24&fields=id,title,type,releaseDate,posterImageId"],
	["metadata: limit=100", "/v1/metadata?limit=100"],
	["metadata: page=3", "/v1/metadata?limit=24&page=3"],
	["metadata: genre filter", "/v1/metadata?limit=24&genreIds={genreId}"],
	["metadata: images options", "/v1/metadata/{movieId}/images/options"],
	["metadata: search limit=20", "/v1/metadata/search/global?q={searchTerm}&limit=20"],
	// detail entities
	["person detail", "/v1/people/{personId}"],
	["genre detail", "/v1/genres/{genreId}"],
	["season detail", "/v1/seasons/{seasonId}"],
	["episode detail", "/v1/episodes/{episodeId}"],
	["library scan-findings", "/v1/libraries/{libraryId}/scan-findings"],
	// paged lists
	["seasons page=2", "/v1/seasons?limit=24&page=2"],
	["episodes page=2", "/v1/episodes?limit=24&page=2"],
	["episodes limit=100", "/v1/episodes?limit=100"],
	["people page=5", "/v1/people?limit=24&page=5"],
	["people limit=100", "/v1/people?limit=100"],
	["collections page=2", "/v1/collections?limit=24&page=2"],
	["keywords limit=100", "/v1/keywords?limit=100"],
	["companies limit=100", "/v1/companies?limit=100"],
	// media-files variants
	["media-files limit=100", "/v1/media-files?limit=100"],
	["media-files by library", "/v1/media-files?limit=24&libraryId={libraryId}"],
	["media-files by metadata", "/v1/media-files?limit=24&metadataId={movieId}"],
	["media-files projected", "/v1/media-files?limit=24&fields=id,fileName,libraryId"],
	// me.* variants
	["me: watched-history page=2", "/v1/me/watched-history?limit=50&page=2", true],
	["me: watched-history limit=200", "/v1/me/watched-history?limit=200", true],
	["me: insights 7d", "/v1/me/watched-history/insights?range=7d", true],
	["me: insights 90d", "/v1/me/watched-history/insights?range=90d", true],
	["me: insights 1y", "/v1/me/watched-history/insights?range=1y", true],
	["me: insights all", "/v1/me/watched-history/insights?range=all", true],
	["me: wrapped 2025", "/v1/me/watched-history/wrapped?year=2025", true],
	["me: watchlist", "/v1/me/watchlist?limit=24", true],
	["me: ratings", "/v1/me/ratings?limit=24", true],
	["me: notifications", "/v1/notifications?limit=20", true],
	["me: playback-progress", "/v1/me/playback-progress/{movieId}", true],
	["me: playback view", "/v1/playback-sessions/view/{mediaFileId}", true],
	["me: watchlist statuses", "/v1/me/watchlist/statuses?ids={movieId},{tvId}", true],
	// admin variants
	["admin: analytics 180d", "/v1/admin/analytics?days=180"],
	["admin: analytics 365d", "/v1/admin/analytics?days=365"],
	["admin: logs limit=500", "/v1/admin/logs?limit=500"],
	["admin: logs search", "/v1/admin/logs?search=worker&limit=100"],
	["admin: logs page=3", "/v1/admin/logs?limit=100&page=3"],
	["admin: logs/files", "/v1/admin/logs/files"],
	["admin: audit p2l20", "/v1/admin/audit?page=2&limit=20"],
	["admin: audit p1l100", "/v1/admin/audit?page=1&limit=100"],
	["admin: users page=2", "/v1/admin/users?page=2&limit=20"],
	["admin: user detail", "/v1/admin/users/{adminUserId}"],
	["admin: user profiles", "/v1/admin/users/{adminUserId}/profiles"],
	["admin: workers/jobs p1", "/v1/admin/workers/jobs?page=1&limit=25"],
	["admin: workers/jobs p2", "/v1/admin/workers/jobs?page=2&limit=25"],
	["admin: workers/jobs p10", "/v1/admin/workers/jobs?page=10&limit=25"],
	["admin: workers/operations p1l20", "/v1/admin/workers/operations?page=1&limit=20"],
	["admin: downloads jobs", "/v1/admin/downloads/jobs?page=1&limit=25"],
	["admin: database backups", "/v1/admin/database/backups"],
	["admin: ffmpeg-capabilities", "/v1/admin/ffmpeg-capabilities"],
	["admin: network remote-access", "/v1/admin/network/remote-access"],
];

const MATRIX_SCENARIOS: ReadonlyArray<readonly [string, RequestBuilder]> = ROUTE_MATRIX.map(
	([name, template, withProfile]) =>
		[
			`matrix: ${name}`,
			(context) => new Request(`${context.baseUrl}${interpolatePath(context, template)}`, authHeaders(context, Boolean(withProfile))),
		] as const,
);

const SCENARIOS: ReadonlyArray<readonly [string, RequestBuilder]> = [...HEADLINE_SCENARIOS, ...MATRIX_SCENARIOS];

// Write scenarios run against the real instance on the BENCH account only, and
// avoid unbounded growth (no history sync): toggles flip back and forth, the
// progress upsert rewrites one hot row, mark-all-read is idempotent.
function writeHeaders(context: BenchContext, requestIndex: number): RequestInit {
	return {
		headers: {
			cookie: context.cookie,
			"x-profile-id": context.profileId,
			"content-type": "application/json",
			...(context.noCache ? { "cache-control": "no-cache" } : {}),
			"x-forwarded-for": subnetIp(85, requestIndex),
		},
	};
}

const WRITE_SCENARIOS: ReadonlyArray<readonly [string, (context: BenchContext, requestIndex: number) => Request]> = [
	[
		"write: watchlist toggle",
		(context, requestIndex) =>
			new Request(`${context.baseUrl}/v1/me/watchlist/toggle`, {
				method: "POST",
				...writeHeaders(context, requestIndex),
				body: JSON.stringify({ metadataId: context.movieId }),
			}),
	],
	[
		"write: playback-progress upsert",
		(context, requestIndex) =>
			new Request(`${context.baseUrl}/v1/me/media-files/${context.mediaFileId}/playback-progress`, {
				method: "PUT",
				...writeHeaders(context, requestIndex),
				body: JSON.stringify({ position: requestIndex % 600 }),
			}),
	],
	[
		"write: notifications mark-all-read",
		(context, requestIndex) =>
			new Request(`${context.baseUrl}/v1/notifications/`, {
				method: "PATCH",
				...writeHeaders(context, requestIndex),
				body: JSON.stringify({ all: true, read: true }),
			}),
	],
];

function runScenario(
	scenario: readonly [string, RequestBuilder],
	concurrency: number,
	context: BenchContext,
	warmupMs: number,
	durationMs: number,
): Promise<HttpScenarioRun> {
	return runHttpScenario({
		concurrency,
		warmupMs,
		durationMs,
		work: async (workerIndex, requestIndex) => {
			try {
				const response = await fetch(scenario[1](context, workerIndex, requestIndex));
				const ok = response.ok;
				await response.arrayBuffer();

				return { ok };
			} catch {
				return { ok: false };
			}
		},
	});
}

export const meta = { description: "HTTP scenarios against a REAL-data server (external --baseUrl, no fixture)" };

const args = suiteArgs();

if (!args.help && args.baseUrl) {
	const target = args.baseUrl;
	task("real-data: scenarios", async () => {
		console.log(`[real-data] targeting ${target} (noCache: ${args.noCache})`);
		const context = await resolveContext({ baseUrl: target, noCache: args.noCache });
		const results: HttpScenarioResult[] = [];
		// --scenario accepts a regex (e.g. "core:|me: watchlist") or a plain substring.
		const scenarioFilter = args.scenario;
		const scenarios = scenarioFilter
			? SCENARIOS.filter((scenario) => {
					try {
						return new RegExp(scenarioFilter, "i").test(scenario[0]);
					} catch {
						return scenario[0].includes(scenarioFilter);
					}
				})
			: SCENARIOS;

		for (const concurrency of args.concurrency) {
			console.log(`\n[real-data] concurrency ${concurrency} (warmup ${args.warmupMs}ms, measure ${args.durationMs}ms)`);
			for (const scenario of scenarios) {
				const run = await runScenario(scenario, concurrency, context, args.warmupMs, args.durationMs);
				const result = httpScenarioResult(scenario[0], concurrency, run, args.durationMs);
				results.push(result);
				const failureNote = result.errorRatePercent > 0 ? `, errors ${result.errorRatePercent.toFixed(1)}%` : "";
				console.log(
					`  ${scenario[0]}: ${result.requestsPerSecond.toFixed(0)} req/s, p50 ${result.stats.p50Ms.toFixed(1)}ms, p95 ${result.stats.p95Ms.toFixed(1)}ms${failureNote}`,
				);
			}

			for (const [name, builder] of WRITE_SCENARIOS) {
				const run = await runHttpScenario({
					concurrency,
					warmupMs: args.warmupMs,
					durationMs: args.durationMs,
					work: async (_workerIndex, requestIndex) => {
						try {
							const response = await fetch(builder(context, requestIndex));
							// 429 is the deployment's limiter posture, not a bench failure —
							// it counts as ok=false in the error rate but must not poison
							// the latency mix as a server-side 5xx would.
							const ok = response.status !== 429 && response.status < 500;
							await response.arrayBuffer();

							return { ok };
						} catch {
							return { ok: false };
						}
					},
				});
				const result = httpScenarioResult(name, concurrency, run, args.durationMs);
				results.push(result);
				const failureNote = result.errorRatePercent > 0 ? `, errors ${result.errorRatePercent.toFixed(1)}%` : "";
				console.log(
					`  ${name}: ${result.requestsPerSecond.toFixed(0)} writes/s, p50 ${result.stats.p50Ms.toFixed(1)}ms, p95 ${result.stats.p95Ms.toFixed(1)}ms${failureNote}`,
				);
			}
		}

		printHttpResults(results);
	});
} else if (!args.help) {
	console.log("[real-data] skipped — pass --baseUrl http://host:port (plus RV_BENCH_COOKIE or RV_BENCH_EMAIL/PASSWORD)");
}

await main(import.meta);
