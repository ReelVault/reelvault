/**
 * Mixed-load scenario runner.
 *
 * Boots a managed ReelVault server (seeded catalog + per-profile state + a
 * generated sample clip) and drives concurrent actors that mimic real usage
 * patterns, then reports per-operation latency percentiles, error rates, server
 * RSS trend and admin cache stats. Unlike the single-endpoint benchmark suites
 * (which demand an idle machine), this orchestrator deliberately MIXES traffic
 * so contention interactions surface: sync SQLite queries vs streaming ffmpeg
 * vs ingest ffprobe vs admin writes.
 *
 * Numbers are machine-specific — desktop results do NOT transfer to production
 * hardware. Compare runs from the same box only; the findings (which ops
 * degrade under which load) are what transfer.
 *
 * Usage:
 *   bun run scenarios [--scenario browse|streaming|ingest|admin-storm|mixed|all]
 *                     [--duration 60] [--vusers 8] [--seed-rows 5000]
 *                     [--out benchmark-results]
 *
 * Exit codes: 0 = completed, 2 = setup error.
 */

import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fmtMb, fmtMs, parseSegments, printTable, Recorder, type RssSummary, startRssSampler } from "benchkit";
import { sleep } from "bun";
import { type ManagedServer, startBenchmarkServer } from "./benchmarks/lib/server";

const SCENARIOS = ["browse", "streaming", "ingest", "admin-storm", "mixed", "all"] as const;
type ScenarioName = (typeof SCENARIOS)[number];
const SINGLE_SCENARIOS: readonly ScenarioName[] = SCENARIOS.filter((name) => name !== "all");

function isScenarioName(value: string): value is ScenarioName {
	return SINGLE_SCENARIOS.some((name) => name === value) || value === "all";
}

const DEFAULT_DURATION_SEC = 60;
const DEFAULT_VUSERS = 8;
const DEFAULT_SEED_ROWS = 5_000;
const WARMUP_MS = 4_000;
const RSS_SAMPLE_INTERVAL_MS = 2_000;
const INGEST_COPIES = 24;
const INGEST_SCAN_INTERVAL_MS = 10_000;
/** Human-ish pacing between consecutive ops of one virtual user. */
const THINK_TIME_MS = 60;

interface CliOptions {
	scenario: ScenarioName;
	durationSec: number;
	vusers: number;
	seedRows: number;
	outDir: string;
}

function parseArgs(): CliOptions {
	const argv = process.argv.slice(2);
	const flagValue = (flag: string): string | undefined => {
		const index = argv.indexOf(flag);

		return index !== -1 ? (argv[index + 1] ?? undefined) : undefined;
	};

	const scenarioInput = flagValue("--scenario") ?? "browse";
	if (!isScenarioName(scenarioInput)) {
		console.error(`Unknown scenario "${scenarioInput}". Options: ${SCENARIOS.join(", ")}`);
		process.exit(2);
	}

	return {
		scenario: scenarioInput,
		durationSec: Number(flagValue("--duration") ?? DEFAULT_DURATION_SEC),
		vusers: Number(flagValue("--vusers") ?? DEFAULT_VUSERS),
		seedRows: Number(flagValue("--seed-rows") ?? DEFAULT_SEED_ROWS),
		outDir: flagValue("--out") ?? "benchmark-results",
	};
}

interface Identity {
	cookie: string;
	profileId: string;
	ip: string;
}

function identityFor(server: ManagedServer, workerIndex: number): Identity {
	const slot = workerIndex % server.workerCookies.length;

	return {
		cookie: server.workerCookies[slot] ?? server.cookie,
		profileId: server.profileIdFor(slot),
		ip: server.ipFor(slot),
	};
}

async function timedFetch(recorder: Recorder, label: string, url: string, headers: Record<string, string>): Promise<void> {
	const startedAt = performance.now();
	let ok = false;
	try {
		const response = await fetch(url, { headers });
		ok = response.ok;
		await response.arrayBuffer();
	} catch {
		ok = false;
	}

	recorder.record(label, performance.now() - startedAt, ok);
}

/** Reads `sessionId` off an unknown JSON payload without casts (same pattern as firstArrayItemId in lib/server). */
function sessionIdFrom(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || !("sessionId" in value)) return undefined;

	const sessionId: unknown = value.sessionId;

	return typeof sessionId === "string" ? sessionId : undefined;
}

/** Reads `id` off an unknown JSON payload without casts. */
function idFrom(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || !("id" in value)) return undefined;

	const id: unknown = value.id;

	return typeof id === "string" ? id : undefined;
}

async function requestJson(
	recorder: Recorder,
	label: string,
	url: string,
	method: "POST" | "PATCH" | "DELETE",
	headers: Record<string, string>,
	body?: unknown,
): Promise<unknown> {
	const startedAt = performance.now();
	let ok = false;
	let payload: unknown;
	try {
		// Conditional spread: RequestInit.body doesn't accept explicit undefined
		// under exactOptionalPropertyTypes.
		const response = await fetch(url, {
			method,
			headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		ok = response.ok;
		// 204 and other body-less successes have no JSON to parse; a non-JSON body
		// on an ok response still rejects into the outer catch and counts as a failure.
		const text = await response.text();
		if (text.length > 0) payload = JSON.parse(text);
	} catch {
		ok = false;
	}

	recorder.record(label, performance.now() - startedAt, ok);

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

/** One virtual user walking the read surface with human-ish pacing. */
async function browseActor(server: ManagedServer, deadline: number, workerIndex: number, recorder: Recorder): Promise<void> {
	const identity = identityFor(server, workerIndex);
	const headers = { cookie: identity.cookie, "x-profile-id": identity.profileId, "x-forwarded-for": identity.ip };
	const targets = browseTargets(server);
	let index = workerIndex;
	while (Date.now() < deadline) {
		const target = targets[index++ % targets.length] ?? targets[0];
		if (target) await timedFetch(recorder, target.label, target.url, headers);

		await sleep(THINK_TIME_MS + (index % 5) * 20);
	}
}

/**
 * One streaming client: create a session on the sample clip, watch segments
 * with real-time pacing + a heartbeat, seek mid-clip, then end the session.
 * Loops until the deadline — each iteration is a fresh watch/seek cycle, which
 * is exactly the transcode-restart pattern real clients produce.
 */
async function streamingActor(server: ManagedServer, deadline: number, workerIndex: number, recorder: Recorder): Promise<void> {
	const identity = identityFor(server, workerIndex);
	const headers = { cookie: identity.cookie, "x-profile-id": identity.profileId, "x-forwarded-for": identity.ip };

	while (Date.now() < deadline) {
		if (!server.sampleMediaId) {
			await sleep(1_000);
			continue;
		}

		try {
			await streamingCycle(server, headers, deadline, recorder);
		} catch {
			recorder.recordError("stream: cycle failure");
		}

		await sleep(500);
	}
}

async function streamingCycle(server: ManagedServer, headers: Record<string, string>, deadline: number, recorder: Recorder): Promise<void> {
	if (!server.sampleMediaId) return;

	const created = await requestJson(
		recorder,
		"stream: create session",
		`${server.baseUrl}/v1/playback-sessions`,
		"POST",
		{
			...headers,
			"idempotency-key": `scenario-${Date.now()}-${Math.random()}`,
		},
		{ mediaFileId: server.sampleMediaId, videoCodecs: ["h264"], audioCodecs: ["aac"] },
	);
	const sessionId = sessionIdFrom(created);
	if (!sessionId) return;

	try {
		await timedFetch(recorder, "stream: playlist", `${server.baseUrl}/v1/playback-sessions/${sessionId}/playlist`, headers);
		const playlistResponse = await fetch(`${server.baseUrl}/v1/playback-sessions/${sessionId}/playlist`, { headers });
		const segments = parseSegments(await playlistResponse.text());

		const watchCount = Math.min(segments.length, 10);
		for (let index = 0; index < watchCount && Date.now() < deadline; index++) {
			const segment = segments[index] ?? "";
			if (!segment) continue;

			await timedFetch(recorder, "stream: segment", `${server.baseUrl}/v1/playback-sessions/${sessionId}/segments/${segment}`, headers);
			await sleep(400);
		}

		await requestJson(recorder, "stream: heartbeat", `${server.baseUrl}/v1/playback-sessions/${sessionId}/heartbeat`, "POST", headers, {
			position: 8,
			isPaused: false,
		});
		await requestJson(recorder, "stream: seek", `${server.baseUrl}/v1/playback-sessions/${sessionId}/seek`, "POST", headers, {
			position: 15,
		});
		await timedFetch(recorder, "stream: playlist after seek", `${server.baseUrl}/v1/playback-sessions/${sessionId}/playlist`, headers);
		await sleep(800);
	} finally {
		// A reaped session (404) is a clean end too — the cycle simply starts over.
		await requestJson(recorder, "stream: end session", `${server.baseUrl}/v1/playback-sessions/${sessionId}`, "DELETE", headers);
	}
}

/** Copies the generated sample clip N times so a scan has real files to ingest (ffprobe per file). */
function seedIngestFiles(server: ManagedServer, ingestDir: string): boolean {
	if (!server.sampleMediaPath) return false;

	mkdirSync(ingestDir, { recursive: true });
	for (let index = 0; index < INGEST_COPIES; index++) {
		copyFileSync(server.sampleMediaPath, join(ingestDir, `ingest-${String(index).padStart(2, "0")}.mp4`));
	}

	return true;
}

async function resolveFirstLibraryId(server: ManagedServer): Promise<string | undefined> {
	const response = await fetch(`${server.baseUrl}/v1/libraries?limit=1`, { headers: { cookie: server.cookie } });
	if (!response.ok) return undefined;

	const body: unknown = await response.json();
	if (typeof body !== "object" || body === null || !("data" in body)) return undefined;

	const data: unknown = body.data;
	if (!Array.isArray(data) || data.length === 0) return undefined;

	return idFrom(data[0]);
}

/** Registers the ingest library once and triggers periodic scans until the deadline. */
async function ingestActor(server: ManagedServer, deadline: number, recorder: Recorder): Promise<void> {
	const ingestDir = join(server.rootDir, "ingest-library");
	if (!seedIngestFiles(server, ingestDir)) {
		console.warn("[ingest] sample media unavailable — scenario degrades to browse-only");

		return;
	}

	const created = await requestJson(
		recorder,
		"ingest: create library",
		`${server.baseUrl}/v1/libraries`,
		"POST",
		{
			cookie: server.cookie,
		},
		{ name: "Scenario Ingest", type: "movies", metadataStorageMode: "database", paths: [{ path: ingestDir }] },
	);
	const libraryId = idFrom(created) ?? (await resolveFirstLibraryId(server));
	if (!libraryId) return;

	while (Date.now() < deadline) {
		// Each trigger re-scans the ingest dir: stat sweep + ffprobe storm server-side.
		await requestJson(
			recorder,
			"ingest: trigger scan",
			`${server.baseUrl}/v1/libraries/${libraryId}/scan`,
			"POST",
			{ cookie: server.cookie },
			{},
		);
		await sleep(INGEST_SCAN_INTERVAL_MS);
	}
}

/** Admin write/read storm: settings updates, library edits, heavy admin dashboards. */
async function adminStormActor(server: ManagedServer, deadline: number, recorder: Recorder): Promise<void> {
	const headers = { cookie: server.cookie };
	const libraryId = await resolveFirstLibraryId(server);

	while (Date.now() < deadline) {
		await requestJson(recorder, "admin: update settings", `${server.baseUrl}/v1/admin/settings`, "PATCH", headers, {
			"scanning.autoWatcherDelaySeconds": 5,
		});
		if (libraryId) {
			await requestJson(recorder, "admin: library edit", `${server.baseUrl}/v1/libraries/${libraryId}`, "PATCH", headers, {
				name: "Benchmark Movies",
			});
		}

		await timedFetch(recorder, "admin: dashboard", `${server.baseUrl}/v1/admin/dashboard`, headers);
		await timedFetch(recorder, "admin: audit page", `${server.baseUrl}/v1/admin/audit?page=1&limit=20`, headers);
		await timedFetch(recorder, "admin: workers", `${server.baseUrl}/v1/admin/workers`, headers);
		await sleep(300);
	}
}

async function fetchAdminJson(server: ManagedServer, path: string): Promise<unknown> {
	try {
		const response = await fetch(`${server.baseUrl}${path}`, { headers: { cookie: server.cookie } });
		if (!response.ok) return { httpStatus: response.status };

		return await response.json();
	} catch (error) {
		return { error: String(error) };
	}
}

/** Unrecorded traffic that fills response/count caches so the recorded window measures steady state. */
async function warmup(server: ManagedServer): Promise<void> {
	const identity = identityFor(server, 0);
	const headers = { cookie: identity.cookie, "x-profile-id": identity.profileId, "x-forwarded-for": identity.ip };
	const targets = browseTargets(server);
	const deadline = Date.now() + WARMUP_MS;
	let index = 0;
	while (Date.now() < deadline) {
		const target = targets[index++ % targets.length] ?? targets[0];
		if (target) {
			try {
				const response = await fetch(target.url, { headers });
				await response.arrayBuffer();
			} catch {
				// warmup failures are non-fatal
			}
		}
	}
}

/** How many non-browse actors the scenario runs; browse actors fill the rest. */
function extraActorCount(name: ScenarioName, vusers: number): number {
	if (name === "streaming") return Math.max(1, Math.floor(vusers / 4));

	if (name === "ingest" || name === "admin-storm") return 1;

	if (name === "mixed") return 3;

	return 0;
}

async function runScenario(name: ScenarioName, server: ManagedServer, options: CliOptions): Promise<void> {
	console.log(`\n=== scenario: ${name} (${options.durationSec}s, ${options.vusers} vusers) ===`);
	const recorder = new Recorder();

	await warmup(server);

	let rssSummary: RssSummary = {};
	const stopSampler = startRssSampler(server.pid, RSS_SAMPLE_INTERVAL_MS, (summary) => {
		rssSummary = summary;
	});
	const cacheStatsBefore = await fetchAdminJson(server, "/v1/admin/cache-stats");
	const resourcesBefore = await fetchAdminJson(server, "/v1/admin/resources");

	const deadline = Date.now() + options.durationSec * 1_000;
	const actors: Array<Promise<void>> = [];
	const extra = extraActorCount(name, options.vusers);
	const browseCount = Math.max(1, options.vusers - extra);

	for (let index = 0; index < browseCount; index++) actors.push(browseActor(server, deadline, index, recorder));

	if (name === "streaming" || name === "mixed") {
		actors.push(streamingActor(server, deadline, browseCount, recorder));
	}

	if (name === "ingest" || name === "mixed") actors.push(ingestActor(server, deadline, recorder));

	if (name === "admin-storm" || name === "mixed") actors.push(adminStormActor(server, deadline, recorder));

	const startedAt = performance.now();
	await Promise.all(actors);
	const wallMs = performance.now() - startedAt;
	stopSampler();

	const cacheStatsAfter = await fetchAdminJson(server, "/v1/admin/cache-stats");
	const resourcesAfter = await fetchAdminJson(server, "/v1/admin/resources");

	const summary = recorder.summary().toSorted((left, right) => left.label.localeCompare(right.label));
	printTable(
		`ops — ${name}`,
		["operation", "count", "p50", "p95", "p99", "max", "errors"],
		summary.map((row) => [
			row.label,
			String(row.count),
			fmtMs(row.p50),
			fmtMs(row.p95),
			fmtMs(row.p99),
			fmtMs(row.max),
			String(row.errors),
		]),
	);

	const totalOps = summary.reduce((total, row) => total + row.count, 0);
	const totalErrors = summary.reduce((total, row) => total + row.errors, 0);
	console.log(
		`wall ${(wallMs / 1_000).toFixed(1)}s | ops ${totalOps} (${(totalOps / (wallMs / 1_000)).toFixed(1)}/s) | errors ${totalErrors} | ` +
			`rss ${rssSummary.startBytes ? fmtMb(rssSummary.startBytes) : "?"} → peak ${rssSummary.peakBytes ? fmtMb(rssSummary.peakBytes) : "?"} → end ${rssSummary.endBytes ? fmtMb(rssSummary.endBytes) : "?"}`,
	);

	mkdirSync(options.outDir, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const artifact = join(options.outDir, `scenario-${name}-${stamp}.json`);
	writeFileSync(
		artifact,
		JSON.stringify(
			{
				meta: {
					scenario: name,
					timestamp: new Date().toISOString(),
					durationSec: options.durationSec,
					vusers: options.vusers,
					seedRows: server.seededRows,
					wallMs,
					totalOps,
					totalErrors,
				},
				ops: recorder.serialize(),
				rss: rssSummary,
				cacheStatsBefore,
				cacheStatsAfter,
				resourcesBefore,
				resourcesAfter,
			},
			null,
			2,
		),
	);
	console.log(`artifact: ${artifact}`);
}

async function main(): Promise<void> {
	const options = parseArgs();
	const needsMedia =
		options.scenario === "streaming" || options.scenario === "ingest" || options.scenario === "mixed" || options.scenario === "all";

	console.log(`[scenarios] booting managed server (seedRows=${options.seedRows}, vusers=${options.vusers})...`);
	const server = await startBenchmarkServer({
		seedRows: options.seedRows,
		workerCount: options.vusers,
		withSampleMedia: needsMedia,
	});

	try {
		const names = options.scenario === "all" ? SINGLE_SCENARIOS : [options.scenario];
		for (const name of names) {
			await runScenario(name, server, options);
		}
	} finally {
		await server.stop();
	}
}

await main();
