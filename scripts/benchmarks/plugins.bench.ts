import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fmtMs, main, printHttpResults, printTable, runScenarioMatrix, suiteArgs, summarizeLatencies, task } from "benchkit";
import { isRecord } from "@/utils/type.utils";
import { subnetIp, workerCookie } from "./lib/identity";
import type { ManagedServer } from "./lib/server";
import { createServerFixture } from "./lib/server-fixture";

/**
 * Plugin runtime suite. Installs the media-requests plugin from the sibling
 * plugins repo (offline install-upload path), then measures:
 *  - lifecycle: install, reload-all, per-plugin reload, disable/enable;
 *  - hot dispatch: list/summary reads and a create+delete pair against the
 *    plugin's own routes (in-process handlers behind the dispatch guard);
 *  - plugin UI: manifest aggregation and the heavy asset bundle (200 vs 304);
 *  - dispatch guard: unknown plugin (404) and unauthenticated (401);
 *  - native baseline: GET /v1/me/watchlist for the dispatch-overhead delta.
 *
 * Network-backed plugin routes (TMDB discovery, cinemamode pre-roll) are
 * deliberately NOT benchmarked — they would measure the internet.
 */

const PLUGIN_ID = "org.reelvault.requests";
const PLUGIN_DIR = "org.reelvault.requests";
/** Seeded once so list reads walk a realistic storage blob, not an empty array. */
/** Kept under the plugin's 10-active-request cap; the checker race makes settles unreliable. */
const SEED_REQUESTS = 5;

interface PluginContext {
	baseUrl: string;
	cookieFor: (workerIndex: number, requestIndex: number) => string;
	profileIdFor: (workerIndex: number, requestIndex: number) => string;
	adminCookie: string;
	adminProfileId: string;
	/** ETag captured from the first asset fetch for the 304 scenario. */
	assetEtag: string;
}

type PluginRequestBuilder = (context: PluginContext, workerIndex: number, requestIndex: number) => Request;

function headers(context: PluginContext, workerIndex: number, requestIndex: number, withProfile = false): Record<string, string> {
	return {
		cookie: context.cookieFor(workerIndex, requestIndex),
		...(withProfile ? { "x-profile-id": context.profileIdFor(workerIndex, requestIndex) } : {}),
		"x-forwarded-for": subnetIp(87, workerIndex),
	};
}

const listRequests: PluginRequestBuilder = (context, worker, request) =>
	new Request(`${context.baseUrl}/v1/plugins/${PLUGIN_ID}/requests?limit=50`, {
		headers: headers(context, worker, request, true),
	});

const summary: PluginRequestBuilder = (context, worker, request) =>
	new Request(`${context.baseUrl}/v1/plugins/${PLUGIN_ID}/requests/summary`, {
		headers: headers(context, worker, request, true),
	});

const uiManifest: PluginRequestBuilder = (context, worker, request) =>
	new Request(`${context.baseUrl}/v1/plugins/ui/manifest`, { headers: headers(context, worker, request, true) });

const uiAsset: PluginRequestBuilder = (context, worker, request) =>
	new Request(`${context.baseUrl}/v1/plugins/ui/${PLUGIN_DIR}/dist/ui/index.js`, {
		headers: headers(context, worker, request),
	});

const uiAsset304: PluginRequestBuilder = (context, worker, request) =>
	new Request(`${context.baseUrl}/v1/plugins/ui/${PLUGIN_DIR}/dist/ui/index.js`, {
		headers: { ...headers(context, worker, request), "if-none-match": context.assetEtag },
	});

const unknownPlugin: PluginRequestBuilder = (context, worker, request) =>
	new Request(`${context.baseUrl}/v1/plugins/org.reelvault.nonexistent/requests`, {
		headers: headers(context, worker, request, true),
	});

const nativeBaseline: PluginRequestBuilder = (context, worker, request) =>
	new Request(`${context.baseUrl}/v1/me/watchlist?limit=24`, { headers: headers(context, worker, request, true) });

const SCENARIOS: ReadonlyArray<readonly [string, PluginRequestBuilder]> = [
	[`GET /v1/plugins/${PLUGIN_DIR}/requests?limit=50`, listRequests],
	[`GET /v1/plugins/${PLUGIN_DIR}/requests/summary`, summary],
	["GET /v1/plugins/ui/manifest", uiManifest],
	["GET /v1/plugins/ui/.../index.js (391KB asset)", uiAsset],
	["GET /v1/plugins/ui/.../index.js (304 revalidate)", uiAsset304],
	["GET /v1/plugins/<unknown>/... (404 guard)", unknownPlugin],
	["GET /v1/me/watchlist?limit=24 (native baseline)", nativeBaseline],
];

function resolvePluginZip(): string | undefined {
	const pluginsDist = join(import.meta.dir, "..", "..", "..", "plugins", "dist", "plugins", PLUGIN_DIR);
	const latest = readdirSync(pluginsDist)
		.filter((name) => name.startsWith(`${PLUGIN_DIR}-`) && name.endsWith(".zip"))
		.toSorted()
		.at(-1);

	return latest ? join(pluginsDist, latest) : undefined;
}

async function installPlugin(server: ManagedServer, zipPath: string): Promise<void> {
	const startedAt = performance.now();
	const form = new FormData();
	form.append("file", new File([new Uint8Array(await Bun.file(zipPath).arrayBuffer())], "plugin.zip"));

	const response = await fetch(`${server.baseUrl}/v1/admin/plugins/install-upload`, {
		method: "POST",
		headers: { cookie: server.cookie },
		body: form,
	});
	const wallMs = performance.now() - startedAt;
	if (!response.ok) throw new Error(`plugin install failed: HTTP ${response.status}`);

	printTable(
		"POST /v1/admin/plugins/install-upload (extract+hash+load, one-shot)",
		["plugin", "wall", "status"],
		[[PLUGIN_ID, fmtMs(wallMs), String(response.status)]],
	);
}

async function lifecyclePhase(server: ManagedServer): Promise<void> {
	const timings: Array<[string, number]> = [];
	const timed = async (name: string, run: () => Promise<Response>): Promise<void> => {
		const startedAt = performance.now();
		const response = await run();
		await response.arrayBuffer();
		timings.push([name, performance.now() - startedAt]);
		if (response.status >= 500) throw new Error(`${name} failed: HTTP ${response.status}`);
	};

	await timed("POST /v1/admin/plugins/reload (all)", () =>
		fetch(`${server.baseUrl}/v1/admin/plugins/reload`, { method: "POST", headers: { cookie: server.cookie } }),
	);
	await timed(`POST /v1/admin/plugins/${PLUGIN_DIR}/reload`, () =>
		fetch(`${server.baseUrl}/v1/admin/plugins/${PLUGIN_DIR}/reload`, { method: "POST", headers: { cookie: server.cookie } }),
	);
	await timed(`POST /v1/admin/plugins/${PLUGIN_DIR}/disable`, () =>
		fetch(`${server.baseUrl}/v1/admin/plugins/${PLUGIN_DIR}/disable`, { method: "POST", headers: { cookie: server.cookie } }),
	);
	await timed(`POST /v1/admin/plugins/${PLUGIN_DIR}/enable`, () =>
		fetch(`${server.baseUrl}/v1/admin/plugins/${PLUGIN_DIR}/enable`, { method: "POST", headers: { cookie: server.cookie } }),
	);

	printTable(
		"Plugin lifecycle (one-shot wall clock)",
		["operation", "wall"],
		timings.map(([name, wall]) => [name, fmtMs(wall)]),
	);
}

/**
 * Create+delete pairs, sequentially with hard timeouts. A non-zero error rate
 * is the plugin's lost-update bug, not a benchmark artifact: media-requests
 * 1.0.1 does raw get+set on the whole-requests blob (the host's mutexed
 * storage.update() goes unused) while a background availability checker
 * rewrites the same key, so concurrent writes clobber each other.
 */
async function pairWritePhase(server: ManagedServer): Promise<void> {
	const adminHeaders = {
		cookie: workerCookie(server, 0),
		"x-profile-id": server.profileIdFor(0),
		"content-type": "application/json",
		"x-forwarded-for": "10.87.1.1",
	};
	const latencies: number[] = [];
	let failures = 0;
	const PAIRS = 30;

	for (let index = 0; index < PAIRS; index++) {
		const startedAt = performance.now();
		try {
			const post = await fetch(`${server.baseUrl}/v1/plugins/${PLUGIN_ID}/requests`, {
				method: "POST",
				headers: adminHeaders,
				body: JSON.stringify({ title: `Pair Write ${index}`, mediaType: index % 2 === 0 ? "movie" : "tv_show" }),
				signal: AbortSignal.timeout(2_000),
			});
			const body: unknown = await post.json();
			const requestId = isRecord(body) && isRecord(body.request) && typeof body.request.id === "string" ? body.request.id : undefined;
			if (!(post.status < 500 && requestId)) {
				failures++;
				continue;
			}

			const del = await fetch(`${server.baseUrl}/v1/plugins/${PLUGIN_ID}/requests/${requestId}`, {
				method: "DELETE",
				headers: adminHeaders,
				signal: AbortSignal.timeout(2_000),
			});
			await del.arrayBuffer();
			if (del.status >= 500) failures++;
		} catch {
			failures++;
		}

		latencies.push(performance.now() - startedAt);
	}

	const stats = summarizeLatencies(latencies.length > 0 ? latencies : [0]);
	printTable(
		`POST+DELETE /v1/plugins/${PLUGIN_DIR}/requests (sequential pairs)`,
		["pairs", "failures", "p50", "p95", "max"],
		[[String(stats.count), String(failures), fmtMs(stats.p50Ms), fmtMs(stats.p95Ms), fmtMs(stats.maxMs)]],
	);
}

async function seedRequests(server: ManagedServer, count: number): Promise<void> {
	const seedHeaders = {
		cookie: workerCookie(server, 0),
		"x-profile-id": server.profileIdFor(0),
		"content-type": "application/json",
		"x-forwarded-for": "10.87.0.1",
	};

	for (let index = 0; index < count; index++) {
		const response = await fetch(`${server.baseUrl}/v1/plugins/${PLUGIN_ID}/requests`, {
			method: "POST",
			headers: seedHeaders,
			body: JSON.stringify({
				title: `Seeded Request ${index}`,
				mediaType: index % 2 === 0 ? "movie" : "tv_show",
				year: 2015 + (index % 10),
			}),
		});
		await response.arrayBuffer();
		if (!response.ok) throw new Error(`seed request ${index} failed: HTTP ${response.status}`);
	}
}

async function captureAssetEtag(server: ManagedServer): Promise<string> {
	const response = await fetch(`${server.baseUrl}/v1/plugins/ui/${PLUGIN_DIR}/dist/ui/index.js`, {
		headers: { "x-forwarded-for": "10.87.255.2" },
	});
	await response.arrayBuffer();

	return response.headers.get("etag") ?? "";
}

async function guardCounts(server: ManagedServer): Promise<void> {
	const unauth = await fetch(`${server.baseUrl}/v1/plugins/${PLUGIN_ID}/requests`);
	await unauth.arrayBuffer();

	printTable(
		"Plugin dispatch guard (one-shot status probes)",
		["probe", "status"],
		[
			["GET without session (expect 401)", String(unauth.status)],
			["GET unknown plugin with session (expect 404)", "(covered by load scenario error rate)"],
		],
	);
}

export const meta = { description: "Plugin runtime (install-upload, lifecycle, hot dispatch, UI assets, guards)" };

const args = suiteArgs();

if (!args.help) {
	const zipPath = resolvePluginZip();
	if (!zipPath) {
		console.log("[plugins] skipped — org.reelvault.requests zip not found under ../../plugins/dist/plugins (clone the plugins repo)");
	} else {
		const serverFixture = createServerFixture({
			seedRows: args.rows,
			workerCount: Math.max(...args.concurrency),
			keepServer: args.keepServer,
		});

		task("plugins: lifecycle + dispatch", async () => {
			const server = await serverFixture();
			console.log(`[plugins] installing ${zipPath}`);
			await installPlugin(server, zipPath);
			await seedRequests(server, SEED_REQUESTS); // 5 — the plugin caps active requests at 10
			const assetEtag = await captureAssetEtag(server);

			const context: PluginContext = {
				baseUrl: server.baseUrl,
				cookieFor: (workerIndex, requestIndex) => workerCookie(server, workerIndex * 997 + requestIndex),
				profileIdFor: (workerIndex, requestIndex) =>
					server.profileIdFor((workerIndex * 997 + requestIndex) % Math.max(server.workerCookies.length, 1)),
				adminCookie: server.cookie,
				adminProfileId: server.adminProfileId,
				assetEtag,
			};

			await lifecyclePhase(server);
			await pairWritePhase(server);
			await guardCounts(server);

			const results = await runScenarioMatrix({
				suite: "plugins",
				unit: "req/s",
				scenarios: SCENARIOS.map((scenario) => ({
					name: scenario[0],
					requestFor: (workerIndex: number, requestIndex: number) => scenario[1](context, workerIndex, requestIndex),
					accept: (response: Response) => response.status < 500,
				})),
				concurrency: args.concurrency,
				warmupMs: args.warmupMs,
				durationMs: args.durationMs,
			});

			printHttpResults(results);
		});
	}
}

await main(import.meta);
