import { readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	bench,
	benchmarkAsync,
	fmtMs,
	main,
	printHttpResults,
	printMicroResults,
	printTable,
	runScenarioMatrix,
	suiteArgs,
	summarizeLatencies,
	task,
} from "benchkit";
import { PluginEventBus } from "@/plugins/runtime/plugin.events";
import { serverConfig } from "@/server.config";
import { FileUtils } from "@/utils/file.utils";
import { PromiseUtils } from "@/utils/promise.utils";
import { isRecord } from "@/utils/type.utils";
import { contextHeaders, rotatingIdentity, workerCookie } from "./lib/identity";
import { type NamedScenario, toScenarioEntries } from "./lib/scenarios";
import type { ManagedServer } from "./lib/server";
import { suiteServerFixture } from "./lib/server-fixture";

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

const listRequests: PluginRequestBuilder = (context, worker, request) =>
	new Request(`${context.baseUrl}/v1/plugins/${PLUGIN_ID}/requests?limit=50`, {
		headers: contextHeaders(context, 87, worker, request, true),
	});

const summary: PluginRequestBuilder = (context, worker, request) =>
	new Request(`${context.baseUrl}/v1/plugins/${PLUGIN_ID}/requests/summary`, {
		headers: contextHeaders(context, 87, worker, request, true),
	});

const uiManifest: PluginRequestBuilder = (context, worker, request) =>
	new Request(`${context.baseUrl}/v1/plugins/ui/manifest`, { headers: contextHeaders(context, 87, worker, request, true) });

const uiAsset: PluginRequestBuilder = (context, worker, request) =>
	new Request(`${context.baseUrl}/v1/plugins/ui/${PLUGIN_DIR}/dist/ui/index.js`, {
		headers: contextHeaders(context, 87, worker, request),
	});

const uiAsset304: PluginRequestBuilder = (context, worker, request) =>
	new Request(`${context.baseUrl}/v1/plugins/ui/${PLUGIN_DIR}/dist/ui/index.js`, {
		headers: { ...contextHeaders(context, 87, worker, request), "if-none-match": context.assetEtag },
	});

const unknownPlugin: PluginRequestBuilder = (context, worker, request) =>
	new Request(`${context.baseUrl}/v1/plugins/org.reelvault.nonexistent/requests`, {
		headers: contextHeaders(context, 87, worker, request, true),
	});

const nativeBaseline: PluginRequestBuilder = (context, worker, request) =>
	new Request(`${context.baseUrl}/v1/me/watchlist?limit=24`, { headers: contextHeaders(context, 87, worker, request, true) });

const SCENARIOS: ReadonlyArray<NamedScenario<PluginContext>> = [
	{ name: `GET /v1/plugins/${PLUGIN_DIR}/requests?limit=50`, builder: listRequests },
	{ name: `GET /v1/plugins/${PLUGIN_DIR}/requests/summary`, builder: summary },
	{ name: "GET /v1/plugins/ui/manifest", builder: uiManifest },
	{ name: "GET /v1/plugins/ui/.../index.js (391KB asset)", builder: uiAsset },
	{ name: "GET /v1/plugins/ui/.../index.js (304 revalidate)", builder: uiAsset304 },
	{ name: "GET /v1/plugins/<unknown>/... (404 guard)", builder: unknownPlugin },
	{ name: "GET /v1/me/watchlist?limit=24 (native baseline)", builder: nativeBaseline },
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
	// Ingest and playback emit several events per file; with no plugin
	// subscribed the bus must not build envelopes for nobody.
	const emptyBus = new PluginEventBus();
	bench(
		"PluginEventBus.emit without handlers (500 emits)",
		async () => {
			for (let index = 0; index < 500; index++) {
				await emptyBus.emit("media.file.ready", { libraryId: "lib", mediaFileId: `mf-${index}`, metadataId: "meta" });
			}
		},
		{ warmup: 3, iterations: 20 },
	);

	// The artifact quota total has no size column to read: it stats every stored
	// file. Characterise the miss path (sequential per-write recompute vs the
	// bounded-parallel recompute used once per invalidation).
	task("plugins: artifact quota total cost", async () => {
		const dir = await mkdtemp(join(tmpdir(), "rv-artifact-quota-"));
		try {
			const filePaths = Array.from({ length: 1000 }, (_, index) => join(dir, `sprite-${index}.webp`));
			await Promise.all(filePaths.map((path) => writeFile(path, new Uint8Array(64))));

			const sequential = await benchmarkAsync(
				"quota total: sequential stats (1000 files)",
				async () => {
					let total = 0;
					for (const path of filePaths) total += (await FileUtils.getStats(path))?.size ?? 0;

					return total;
				},
				{ warmup: 1, iterations: 5 },
			);
			const parallel = await benchmarkAsync(
				"quota total: parallel stats (1000 files, cleanup concurrency)",
				async () => {
					const sizes = await PromiseUtils.mapConcurrent(filePaths, serverConfig.plugins.artifacts.cleanupConcurrency, (path) =>
						FileUtils.getStats(path),
					);

					return sizes.reduce((total, stats) => total + (stats?.size ?? 0), 0);
				},
				{ warmup: 1, iterations: 5 },
			);
			printMicroResults([sequential, parallel]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}

		return { ok: true };
	});

	const zipPath = resolvePluginZip();
	if (!zipPath) {
		console.log("[plugins] skipped — org.reelvault.requests zip not found under ../../plugins/dist/plugins (clone the plugins repo)");
	} else {
		const serverFixture = suiteServerFixture(args);

		task("plugins: lifecycle + dispatch", async () => {
			const server = await serverFixture();
			console.log(`[plugins] installing ${zipPath}`);
			await installPlugin(server, zipPath);
			await seedRequests(server, SEED_REQUESTS); // 5 — the plugin caps active requests at 10
			const assetEtag = await captureAssetEtag(server);

			const context: PluginContext = {
				baseUrl: server.baseUrl,
				...rotatingIdentity(server),
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
				scenarios: toScenarioEntries(SCENARIOS, context, { accept: (response) => response.status < 500 }),
				concurrency: args.concurrency,
				warmupMs: args.warmupMs,
				durationMs: args.durationMs,
			});

			printHttpResults(results);
		});
	}
}

await main(import.meta);
