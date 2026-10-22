import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	fixture,
	fmtMb,
	fmtMs,
	jsonRequest,
	metric,
	parseSegments,
	printTable,
	Recorder,
	type RssSummary,
	startRssSampler,
	stringField,
	suiteArgs,
	type TaskMetrics,
	task,
} from "benchkit";
import { sleep } from "bun";
import { assertColdCacheStats } from "./lib/cache-integrity.utils";
import { authHeaders } from "./lib/identity.utils";
import { suiteServerFixture } from "./lib/server.fixture";
import type { ManagedServer } from "./lib/server.launcher";

/**
 * Mixed-load scenarios: concurrent virtual users that act like real clients — browsing with think
 * time, watching and seeking a stream, rescanning a library, hammering the admin panel — and report
 * per-operation latency, errors and the server's RSS. Single-endpoint suites need an idle server;
 * these deliberately mix traffic so contention surfaces (synchronous SQLite queries against ffmpeg
 * streams, ingest ffprobe storms and admin writes). Each `--concurrency` level is one run with that
 * many virtual users; compare runs from the same machine only.
 */

export const meta = { description: "Mixed-load actors (browse, streaming, ingest, admin storm, mixed) with per-operation latency and RSS" };

const SCENARIOS = ["browse", "streaming", "ingest", "admin-storm", "mixed"] as const;
type ScenarioName = (typeof SCENARIOS)[number];

const WARMUP_MS = 4_000;
const RSS_SAMPLE_INTERVAL_MS = 2_000;
const INGEST_COPIES = 24;
const INGEST_SCAN_INTERVAL_MS = 10_000;
/** Human-ish pacing between consecutive operations of one virtual user. */
const THINK_TIME_MS = 60;
/** Client IPs 10.95.x.x — this suite's subnet. */
const SUBNET = 95;

const args = suiteArgs();
const serverFixture = suiteServerFixture(args, { withSampleMedia: true });

async function timedFetch(recorder: Recorder, label: string, url: string, headers: Record<string, string>): Promise<void> {
	await recorder.time(label, async () => {
		const response = await fetch(url, { headers });
		await response.arrayBuffer();

		return response.ok;
	});
}

/** A timed JSON request; returns the parsed body (undefined when there is none or it failed). */
async function timedJson(
	recorder: Recorder,
	label: string,
	request: { url: string; method: "POST" | "PATCH" | "DELETE"; headers: Record<string, string>; body?: unknown },
): Promise<unknown> {
	let payload: unknown;
	await recorder.time(label, async () => {
		const response = await fetch(jsonRequest(request.url, request.method, request.headers, request.body));
		// A 204 has no body; a non-JSON body on a success throws and counts as a failure.
		const text = await response.text();
		if (text.length > 0) payload = JSON.parse(text);

		return response.ok;
	});

	return payload;
}

function browseTargets(server: ManagedServer): Array<{ label: string; url: string }> {
	const base = server.baseUrl;

	return [
		{ label: "browse: metadata list", url: `${base}/v1/metadata?limit=24&page=1` },
		{ label: "browse: metadata list p5", url: `${base}/v1/metadata?limit=24&page=5` },
		{ label: "browse: search", url: `${base}/v1/metadata/search/global?q=star&limit=10` },
		{ label: "browse: movie detail", url: `${base}/v1/metadata/${server.benchmarkMovieDetailId}` },
		{ label: "browse: tv detail", url: `${base}/v1/metadata/${server.benchmarkTvDetailId}` },
		{ label: "browse: image", url: `${base}/v1/images/${server.benchmarkImageId}?w=342` },
		{ label: "browse: discover", url: `${base}/v1/discover?limit=10` },
		{ label: "browse: continue-watching", url: `${base}/v1/me/continue-watching?limit=12` },
		{ label: "browse: watched-history", url: `${base}/v1/me/watched-history?limit=20` },
		{ label: "browse: unread-count", url: `${base}/v1/notifications/unread-count` },
		{ label: "browse: health", url: `${base}/v1/health` },
	];
}

/** One virtual user walking the read surface with think time between requests. */
async function browseActor(server: ManagedServer, deadline: number, workerIndex: number, recorder: Recorder): Promise<void> {
	const headers = authHeaders(server, workerIndex, SUBNET, true);
	const targets = browseTargets(server);
	let index = workerIndex;
	while (Date.now() < deadline) {
		const target = targets[index++ % targets.length];
		if (target) await timedFetch(recorder, target.label, target.url, headers);

		await sleep(THINK_TIME_MS + (index % 5) * 20);
	}
}

/**
 * One viewer: create a session on the sample clip, watch segments at real-time pace, heartbeat, seek
 * mid-clip, end the session — and start over until the deadline. Every cycle is the transcode-restart
 * pattern real clients produce.
 */
async function streamingActor(server: ManagedServer, deadline: number, workerIndex: number, recorder: Recorder): Promise<void> {
	const headers = authHeaders(server, workerIndex, SUBNET, true);
	while (Date.now() < deadline) {
		try {
			await streamingCycle(server, headers, deadline, recorder);
		} catch {
			recorder.recordError("stream: cycle failure");
		}

		await sleep(500);
	}
}

async function streamingCycle(server: ManagedServer, headers: Record<string, string>, deadline: number, recorder: Recorder): Promise<void> {
	const sessions = `${server.baseUrl}/v1/playback-sessions`;
	const created = await timedJson(recorder, "stream: create session", {
		url: sessions,
		method: "POST",
		headers: { ...headers, "idempotency-key": `scenario-${Date.now()}-${Math.random()}` },
		body: { mediaFileId: server.sampleMediaId, videoCodecs: ["h264"], audioCodecs: ["aac"] },
	});
	const sessionId = stringField(created, "sessionId");
	if (!sessionId) return;

	try {
		let segments: string[] = [];
		await recorder.time("stream: playlist", async () => {
			const playlist = await fetch(`${sessions}/${sessionId}/playlist`, { headers });
			segments = parseSegments(await playlist.text());

			return playlist.ok;
		});

		for (const segment of segments.slice(0, 10)) {
			if (Date.now() >= deadline) break;

			await timedFetch(recorder, "stream: segment", `${sessions}/${sessionId}/segments/${segment}`, headers);
			await sleep(400);
		}

		await timedJson(recorder, "stream: heartbeat", {
			url: `${sessions}/${sessionId}/heartbeat`,
			method: "POST",
			headers,
			body: { position: 8, isPaused: false },
		});
		await timedJson(recorder, "stream: seek", { url: `${sessions}/${sessionId}/seek`, method: "POST", headers, body: { position: 15 } });
		await timedFetch(recorder, "stream: playlist after seek", `${sessions}/${sessionId}/playlist`, headers);
		await sleep(800);
	} finally {
		// A reaped session (404) is a clean end too — the cycle simply starts over.
		await timedJson(recorder, "stream: end session", { url: `${sessions}/${sessionId}`, method: "DELETE", headers });
	}
}

/**
 * A library of sample-clip copies, created once per server: each scan of it stats every file and
 * runs ffprobe on the changed ones.
 */
const ingestLibraryFixture = fixture("scenarios-ingest-library", async () => {
	const server = await serverFixture();
	const ingestDir = join(server.rootDir, "ingest-library");
	mkdirSync(ingestDir, { recursive: true });
	for (let index = 0; index < INGEST_COPIES; index++) {
		copyFileSync(server.sampleMediaPath, join(ingestDir, `ingest-${String(index).padStart(2, "0")}.mp4`));
	}

	const response = await fetch(`${server.baseUrl}/v1/libraries`, {
		method: "POST",
		headers: { cookie: server.cookie, "content-type": "application/json" },
		body: JSON.stringify({ name: "Scenario Ingest", type: "movies", metadataStorageMode: "database", paths: [{ path: ingestDir }] }),
	});
	const libraryId = stringField(await response.json(), "id");
	if (!libraryId) throw new Error(`[scenarios] creating the ingest library failed: HTTP ${response.status}`);

	return libraryId;
});

/** Triggers a rescan of the ingest library every few seconds until the deadline. */
async function ingestActor(server: ManagedServer, deadline: number, recorder: Recorder): Promise<void> {
	const libraryId = await ingestLibraryFixture();
	while (Date.now() < deadline) {
		await timedJson(recorder, "ingest: trigger scan", {
			url: `${server.baseUrl}/v1/libraries/${libraryId}/scan`,
			method: "POST",
			headers: { cookie: server.cookie },
			body: {},
		});
		await sleep(INGEST_SCAN_INTERVAL_MS);
	}
}

/** Admin writes and heavy admin reads: settings updates, library edits, dashboard, audit, workers. */
async function adminStormActor(server: ManagedServer, deadline: number, recorder: Recorder): Promise<void> {
	const headers = { cookie: server.cookie };
	while (Date.now() < deadline) {
		await timedJson(recorder, "admin: update settings", {
			url: `${server.baseUrl}/v1/admin/settings`,
			method: "PATCH",
			headers,
			body: { "scanning.autoWatcherDelaySeconds": 5 },
		});
		await timedJson(recorder, "admin: library edit", {
			url: `${server.baseUrl}/v1/libraries/${server.benchmarkLibraryId}`,
			method: "PATCH",
			headers,
			body: { name: "Benchmark Movies" },
		});
		await timedFetch(recorder, "admin: dashboard", `${server.baseUrl}/v1/admin/dashboard`, headers);
		await timedFetch(recorder, "admin: audit page", `${server.baseUrl}/v1/admin/audit?page=1&limit=20`, headers);
		await timedFetch(recorder, "admin: workers", `${server.baseUrl}/v1/admin/workers`, headers);
		await sleep(300);
	}
}

async function fetchAdminJson(server: ManagedServer, path: string): Promise<unknown> {
	try {
		const response = await fetch(`${server.baseUrl}${path}`, { headers: { cookie: server.cookie } });

		return response.ok ? await response.json() : { httpStatus: response.status };
	} catch (error) {
		return { error: String(error) };
	}
}

/** Unrecorded reads that fill the response and count caches, so the measured window is steady state. */
async function warmup(server: ManagedServer): Promise<void> {
	const headers = authHeaders(server, 0, SUBNET, true);
	const targets = browseTargets(server);
	const deadline = Date.now() + WARMUP_MS;
	for (let index = 0; Date.now() < deadline; index++) {
		const target = targets[index % targets.length];
		if (!target) continue;

		try {
			await (await fetch(target.url, { headers })).arrayBuffer();
		} catch {
			// A failed warmup read changes nothing that is measured.
		}
	}
}

/** The actors of one scenario for `vusers` virtual users; browsing users fill whatever the others leave. */
function startActors(
	name: ScenarioName,
	server: ManagedServer,
	vusers: number,
	deadline: number,
	recorder: Recorder,
): Array<Promise<void>> {
	const streaming = name === "streaming" || name === "mixed" ? Math.max(1, Math.floor(vusers / 4)) : 0;
	const ingest = name === "ingest" || name === "mixed";
	const adminStorm = name === "admin-storm" || name === "mixed";
	const browsers = Math.max(1, vusers - streaming - Number(ingest) - Number(adminStorm));

	const actors: Array<Promise<void>> = [];
	for (let index = 0; index < browsers; index++) actors.push(browseActor(server, deadline, index, recorder));
	for (let index = 0; index < streaming; index++) actors.push(streamingActor(server, deadline, browsers + index, recorder));
	if (ingest) actors.push(ingestActor(server, deadline, recorder));
	if (adminStorm) actors.push(adminStormActor(server, deadline, recorder));

	return actors;
}

async function runScenario(name: ScenarioName, server: ManagedServer, vusers: number, metrics: TaskMetrics): Promise<unknown> {
	console.log(`\n[scenarios] ${name}: ${vusers} virtual users for ${args.durationMs} ms`);
	const recorder = new Recorder();
	await warmup(server);

	let rss: RssSummary = {};
	const stopSampler = startRssSampler(server.pid, RSS_SAMPLE_INTERVAL_MS, (summary) => {
		rss = summary;
	});
	const cacheStatsBefore = await fetchAdminJson(server, "/v1/admin/cache-stats");
	if (args.noCache) {
		const namedCaches = assertColdCacheStats(cacheStatsBefore, `${name} before measurement`);
		console.log(`  cold-cache integrity: 0 hits, 0 entries across ${namedCaches} named caches`);
	}

	const startedAt = performance.now();
	await Promise.all(startActors(name, server, vusers, Date.now() + args.durationMs, recorder));
	const wallMs = performance.now() - startedAt;
	stopSampler();

	const operations = recorder.summary().toSorted((left, right) => left.label.localeCompare(right.label));
	printTable(
		`${name}, ${vusers} virtual users`,
		["operation", "count", "p50", "p95", "p99", "max", "errors"],
		operations.map((row) => [
			row.label,
			String(row.count),
			fmtMs(row.p50),
			fmtMs(row.p95),
			fmtMs(row.p99),
			fmtMs(row.max),
			String(row.errors),
		]),
	);

	let totalOps = 0;
	let totalErrors = 0;
	for (const row of operations) {
		totalOps += row.count;
		totalErrors += row.errors;
		metrics[`${name} c=${vusers} ${row.label} p95 ms`] = metric(row.p95, false);
	}
	metrics[`${name} c=${vusers} ops/s`] = metric(totalOps / (wallMs / 1000), true);
	console.log(
		`  ${(totalOps / (wallMs / 1000)).toFixed(1)} ops/s, ${totalErrors} errors, RSS ${fmtMb(rss.startBytes ?? 0)} → peak ${fmtMb(rss.peakBytes ?? 0)} → end ${fmtMb(rss.endBytes ?? 0)}`,
	);

	const cacheStatsAfter = await fetchAdminJson(server, "/v1/admin/cache-stats");
	if (args.noCache) {
		const namedCaches = assertColdCacheStats(cacheStatsAfter, `${name} after measurement`);
		console.log(`  cold-cache integrity after measurement: 0 hits, 0 entries across ${namedCaches} named caches`);
	}

	return {
		vusers,
		wallMs,
		totalOps,
		totalErrors,
		operations: recorder.serialize(),
		rss,
		cacheStatsBefore,
		cacheStatsAfter,
	};
}

for (const name of SCENARIOS) {
	task(`scenarios: ${name}`, async () => {
		const server = await serverFixture();
		const metrics: TaskMetrics = {};
		const runs: unknown[] = [];
		for (const vusers of args.concurrency) runs.push(await runScenario(name, server, vusers, metrics));

		return { ok: true, data: { metrics, runs } };
	});
}
