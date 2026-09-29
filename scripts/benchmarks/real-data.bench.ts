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

	console.log(
		`[real-data] profile ok, library ${context.libraryId ? "ok" : "?"}, movie ${context.movieId ? "ok" : "?"}, tv ${context.tvId ? "ok" : "?"}, image ${context.imageId ? "ok" : "?"}, total ${context.totalMetadata}`,
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

const SCENARIOS: ReadonlyArray<readonly [string, RequestBuilder]> = [
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
	["core: media-files", adminPath("/v1/media-files?limit=24")],
	["me: continue-watching", (context) => new Request(`${context.baseUrl}/v1/me/continue-watching?limit=12`, authHeaders(context, true))],
	["me: watched-history", (context) => new Request(`${context.baseUrl}/v1/me/watched-history?limit=50`, authHeaders(context, true))],
	["me: insights", (context) => new Request(`${context.baseUrl}/v1/me/watched-history/insights?range=30d`, authHeaders(context, true))],
	["me: wrapped", (context) => new Request(`${context.baseUrl}/v1/me/watched-history/wrapped?year=2026`, authHeaders(context, true))],
	["me: unread-count", (context) => new Request(`${context.baseUrl}/v1/notifications/unread-count`, authHeaders(context, true))],
	["images: poster w=342", (context) => new Request(`${context.baseUrl}/v1/images/${context.imageId}?w=342`, authHeaders(context))],
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
		const scenarios = args.scenario ? SCENARIOS.filter((scenario) => scenario[0].includes(args.scenario ?? "")) : SCENARIOS;

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
		}

		printHttpResults(results);
	});
} else if (!args.help) {
	console.log("[real-data] skipped — pass --baseUrl http://host:port (plus RV_BENCH_COOKIE or RV_BENCH_EMAIL/PASSWORD)");
}

await main(import.meta);
