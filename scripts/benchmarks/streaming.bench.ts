import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	benchmarkAsync,
	fmtMb,
	fmtMs,
	type HttpScenarioResult,
	main,
	printHttpResults,
	printMicroResults,
	printTable,
	readProcessRssBytes,
	runLoadWindow,
	suiteArgs,
	summarizeLatencies,
	task,
} from "benchkit";
import { sleep } from "bun";
import { parseHlsBuffer } from "@/modules/streaming/buffer/hls-buffer.utils";
import { playlistFileCache } from "@/modules/streaming/playlist/playlist.cache";
import { removeTree } from "@/utils/directory.utils";
import { FileUtils } from "@/utils/file.utils";
import { authHeaders, subnetIp } from "./lib/identity.utils";
import { createPlaybackSession, deletePlaybackSession, parseSegmentNames } from "./lib/playback.utils";
import { toScenarioResult } from "./lib/scenario-result.mapper";
import { suiteServerFixture } from "./lib/server.fixture";
import type { ManagedServer } from "./lib/server.launcher";

async function fetchPlaylistSegments(server: ManagedServer, sessionId: string): Promise<string[]> {
	const response = await fetch(`${server.baseUrl}/v1/playback-sessions/${sessionId}/playlist`, {
		headers: { cookie: server.cookie, "x-profile-id": server.adminProfileId, "x-forwarded-for": "10.77.9.9" },
	});
	if (!response.ok) throw new Error(`Playlist fetch failed: HTTP ${response.status} ${await response.text()}`);

	const segments = parseSegmentNames(await response.text());
	if (segments.length === 0) throw new Error("Playlist contained no media segments");

	return segments;
}

interface ThroughputRun {
	name: string;
	totalBytes: number;
	elapsedMs: number;
	latencies: number[];
	non2xx: number;
}

async function runThroughput(
	server: ManagedServer,
	sessionId: string,
	segments: readonly string[],
	load: { concurrency: number; warmupMs: number; durationMs: number; rangeHeader?: string | undefined },
): Promise<ThroughputRun> {
	const { concurrency, warmupMs, durationMs, rangeHeader } = load;
	const run = await runLoadWindow({
		concurrency,
		warmupMs,
		durationMs,
		// Total bytes drive MB/s over the measure window only — the original
		// loop accumulated ok-bytes from the very start (warmup included).
		accumulateFromStart: true,
		work: async (workerIndex, requestIndex) => {
			// Stride segments across workers: worker w takes w, w+c, w+2c, ...
			const segment = segments[(workerIndex + requestIndex * concurrency) % segments.length] ?? "";
			try {
				const response = await fetch(`${server.baseUrl}/v1/playback-sessions/${sessionId}/segments/${segment}`, {
					headers: {
						cookie: server.cookie,
						"x-profile-id": server.adminProfileId,
						"x-forwarded-for": subnetIp(78, workerIndex),
						// A seek re-download is a byte-range request; measures the 206 path.
						...(rangeHeader ? { range: rangeHeader } : {}),
					},
				});
				const ok = response.ok;
				const bytes = await response.arrayBuffer();

				return { ok, metrics: ok ? { bytes: bytes.byteLength } : undefined };
			} catch {
				return { ok: false };
			}
		},
	});

	return {
		name: `HLS segments${rangeHeader ? " Range" : ""} c=${concurrency}`,
		totalBytes: run.metrics.bytes ?? 0,
		elapsedMs: durationMs,
		latencies: run.latencies,
		non2xx: run.failures,
	};
}

const ABORT_ROUNDS = 20;

// Control-plane cycle: create → playlist (first byte) → heartbeat → seek → end.
// Concurrency 10 needs the default session caps (5 total / 3 per user) raised —
// the phase PATCHes stream.maxSessions before measuring.
const CONTROL_PLANE_CONCURRENCIES = [1, 10] as const;
const CONTROL_PLANE_SEEK_POSITION = 10;
/** SessionCreationGuard cooldown is 500ms per profile — pace above it. */
const CONTROL_PLANE_CREATE_COOLDOWN_MS = 550;

interface ControlPlaneLedger {
	latencies: Map<string, number[]>;
	errors: Map<string, number>;
}

function newLedger(): ControlPlaneLedger {
	return { latencies: new Map(), errors: new Map() };
}

function recordOp(ledger: ControlPlaneLedger, label: string, elapsedMs: number, ok: boolean): void {
	const list = ledger.latencies.get(label) ?? [];
	list.push(elapsedMs);
	ledger.latencies.set(label, list);
	if (!ok) ledger.errors.set(label, (ledger.errors.get(label) ?? 0) + 1);
}

async function timeOp(ledger: ControlPlaneLedger, label: string, run: () => Promise<Response>): Promise<Response | undefined> {
	const startedAt = performance.now();
	let ok = false;
	try {
		const response = await run();
		ok = response.ok;

		return response.ok ? response : undefined;
	} finally {
		recordOp(ledger, label, performance.now() - startedAt, ok);
	}
}

function controlPlaneHeaders(server: ManagedServer, workerIndex: number): Record<string, string> {
	// One identity per worker: SessionCreationGuard enforces a 500ms create
	// cooldown per profile, so a single profile would reject nearly every create.
	const identityIndex = workerIndex % Math.max(server.workerCookies.length, 1);

	return authHeaders(server, identityIndex, 79, true);
}

/** One create→playlist→heartbeat→seek→end cycle; every step timed into the ledger. */
async function controlPlaneCycle(server: ManagedServer, ledger: ControlPlaneLedger, workerIndex: number, cycle: number): Promise<void> {
	if (!server.sampleMediaId) return;

	const headers = controlPlaneHeaders(server, workerIndex);
	const createResponse = await timeOp(ledger, "create session", () =>
		fetch(`${server.baseUrl}/v1/playback-sessions`, {
			method: "POST",
			headers: {
				...headers,
				"content-type": "application/json",
				"idempotency-key": `benchmark-control-plane-${workerIndex}-${cycle}-${Date.now()}`,
			},
			body: JSON.stringify({ mediaFileId: server.sampleMediaId, videoCodecs: ["h264"], audioCodecs: ["aac"] }),
		}),
	);
	if (!createResponse) return;

	const created: unknown = await createResponse.json();
	if (typeof created !== "object" || created === null || !("sessionId" in created) || typeof created.sessionId !== "string") return;

	const sessionId = created.sessionId;

	try {
		await timeOp(ledger, "playlist (first byte)", async () => {
			const response = await fetch(`${server.baseUrl}/v1/playback-sessions/${sessionId}/playlist`, { headers });
			await response.text();

			return response;
		});
		await timeOp(ledger, "heartbeat", () =>
			fetch(`${server.baseUrl}/v1/playback-sessions/${sessionId}/heartbeat`, {
				method: "POST",
				headers: { ...headers, "content-type": "application/json" },
				body: JSON.stringify({ position: 1, isPaused: false }),
			}),
		);
		await timeOp(ledger, "seek", () =>
			fetch(`${server.baseUrl}/v1/playback-sessions/${sessionId}/seek`, {
				method: "POST",
				headers: { ...headers, "content-type": "application/json" },
				body: JSON.stringify({ position: CONTROL_PLANE_SEEK_POSITION }),
			}),
		);
	} finally {
		// 204 with an empty body — response.ok is the only success signal.
		await timeOp(ledger, "end session", () => fetch(`${server.baseUrl}/v1/playback-sessions/${sessionId}`, { method: "DELETE", headers }));
	}
}

interface SessionStartupSample {
	label: string;
	mode: string;
	createMs: number;
	playlistMs: number;
	segmentMs: number;
	bytes: number;
	ok: boolean;
}

const TRANSCODE_CAPS = { videoCodecs: ["h264"], audioCodecs: ["aac"], maxBitrate: 500 } as const;
const DIRECT_CAPS = { videoCodecs: ["h264"], audioCodecs: ["aac"] } as const;

interface CreatedSession {
	sessionId: string;
	headers: Record<string, string>;
	createMs: number;
	mode: string;
}

interface FirstSegmentSample {
	playlistMs: number;
	segmentMs: number;
	bytes: number;
	ok: boolean;
}

async function createSession(
	server: ManagedServer,
	workerIndex: number,
	label: string,
	capabilities: { videoCodecs: readonly string[]; audioCodecs: readonly string[]; maxBitrate?: number | undefined },
): Promise<CreatedSession> {
	if (!server.sampleMediaId) throw new Error("Sample media unavailable");

	const headers = controlPlaneHeaders(server, workerIndex);
	const createStartedAt = performance.now();
	const createResponse = await fetch(`${server.baseUrl}/v1/playback-sessions`, {
		method: "POST",
		headers: {
			...headers,
			"content-type": "application/json",
			"idempotency-key": `benchmark-startup-${label}-${workerIndex}-${Date.now()}`,
		},
		body: JSON.stringify({ mediaFileId: server.sampleMediaId, ...capabilities }),
	});
	const createMs = performance.now() - createStartedAt;
	if (!createResponse.ok) {
		throw new Error(`Startup session creation failed: HTTP ${createResponse.status} ${await createResponse.text()}`);
	}

	const created: unknown = await createResponse.json();
	if (typeof created !== "object" || created === null || !("sessionId" in created) || typeof created.sessionId !== "string") {
		throw new Error("Startup session response is missing sessionId");
	}

	return {
		sessionId: created.sessionId,
		headers,
		createMs,
		mode: "mode" in created && typeof created.mode === "string" ? created.mode : "unknown",
	};
}

async function waitForFirstSegment(server: ManagedServer, session: CreatedSession, label: string): Promise<FirstSegmentSample> {
	const playlistStartedAt = performance.now();
	let segments: string[] = [];
	while (performance.now() - playlistStartedAt < 30_000) {
		const response = await fetch(`${server.baseUrl}/v1/playback-sessions/${session.sessionId}/playlist`, { headers: session.headers });
		if (response.ok) {
			segments = parseSegmentNames(await response.text());
			if (segments.length > 0) break;
		}
		await sleep(50);
	}
	const playlistMs = performance.now() - playlistStartedAt;
	const firstSegment = segments[0];
	if (!firstSegment) throw new Error(`Startup playlist for ${label} produced no segments`);

	const segmentStartedAt = performance.now();
	const segmentResponse = await fetch(`${server.baseUrl}/v1/playback-sessions/${session.sessionId}/segments/${firstSegment}`, {
		headers: session.headers,
	});
	const bytes = (await segmentResponse.arrayBuffer()).byteLength;

	return { playlistMs, segmentMs: performance.now() - segmentStartedAt, bytes, ok: segmentResponse.ok };
}

async function deleteSession(server: ManagedServer, session: CreatedSession): Promise<void> {
	await fetch(`${server.baseUrl}/v1/playback-sessions/${session.sessionId}`, { method: "DELETE", headers: session.headers });
}

/** One create → playlist (first segment available) → first segment fetch cycle. */
async function measureSessionStartup(
	server: ManagedServer,
	workerIndex: number,
	label: string,
	capabilities: { videoCodecs: readonly string[]; audioCodecs: readonly string[]; maxBitrate?: number | undefined },
): Promise<SessionStartupSample> {
	// Keep every create above the per-profile cooldown even when the run seeds
	// fewer identities than this task's six samples.
	await sleep(CONTROL_PLANE_CREATE_COOLDOWN_MS);
	const session = await createSession(server, workerIndex, label, capabilities);
	try {
		const first = await waitForFirstSegment(server, session, label);

		return { label, mode: session.mode, createMs: session.createMs, ...first };
	} finally {
		await deleteSession(server, session);
	}
}

async function runStartupComparison(server: ManagedServer): Promise<void> {
	const rows: SessionStartupSample[] = [];
	let workerIndex = 0;
	for (const [label, capabilities] of [
		["direct-stream", DIRECT_CAPS],
		["software transcode", TRANSCODE_CAPS],
	] as const) {
		for (let round = 0; round < 3; round++) {
			rows.push(await measureSessionStartup(server, workerIndex++, label, capabilities));
		}
	}

	printTable(
		"Startup: first segment (3 runs each, lower is better)",
		["request", "decision", "create", "playlist", "first segment", "bytes", "ok"],
		rows.map((row) => [
			row.label,
			row.mode,
			fmtMs(row.createMs),
			fmtMs(row.playlistMs),
			fmtMs(row.segmentMs),
			String(row.bytes),
			row.ok ? "yes" : "no",
		]),
	);
}

async function raiseSessionCaps(server: ManagedServer): Promise<void> {
	const response = await fetch(`${server.baseUrl}/v1/admin/settings`, {
		method: "PATCH",
		headers: { "content-type": "application/json", cookie: server.cookie, "x-forwarded-for": "10.79.0.1" },
		body: JSON.stringify({ "stream.maxSessions": 32, "stream.maxSessionsPerUser": 32 }),
	});
	if (!response.ok) throw new Error(`Failed to raise session caps: HTTP ${response.status}`);
}

async function runConcurrentStartup(server: ManagedServer): Promise<void> {
	await raiseSessionCaps(server);
	const rows: Array<[string, string, string, string, string]> = [];
	let workerBase = 10;
	for (const concurrency of [1, 2, 4]) {
		const firstWorker = workerBase;
		workerBase += concurrency;
		const sessions = await Promise.all(
			Array.from({ length: concurrency }, (_, index) =>
				createSession(server, firstWorker + index, `concurrent-${concurrency}`, TRANSCODE_CAPS),
			),
		);
		const samples = await Promise.all(
			sessions.map(async (session) => {
				try {
					return await waitForFirstSegment(server, session, `concurrent-${concurrency}`);
				} finally {
					await deleteSession(server, session);
				}
			}),
		);
		const playlistMs = Math.max(...samples.map((sample) => sample.playlistMs));
		const segmentMs = Math.max(...samples.map((sample) => sample.segmentMs));
		const bytes = samples.reduce((total, sample) => total + sample.bytes, 0);

		rows.push([String(concurrency), sessions[0]?.mode ?? "unknown", fmtMs(playlistMs), fmtMs(segmentMs), fmtMb(bytes)]);
		// Release is asynchronous on the server; let the reservations clear before
		// the next concurrency level starts.
		await sleep(200);
	}

	printTable(
		"Concurrent software transcodes (first segment, lower is better)",
		["sessions", "decision", "max playlist", "max first segment", "total bytes"],
		rows,
	);
}

async function runControlPlane(server: ManagedServer, durationMs: number): Promise<void> {
	await raiseSessionCaps(server);

	for (const concurrency of CONTROL_PLANE_CONCURRENCIES) {
		// One unmeasured cycle: cold ffmpeg spawn and cold caches must not skew p50.
		await controlPlaneCycle(server, newLedger(), 0, -1);

		const ledger = newLedger();
		const deadline = performance.now() + durationMs;
		await Promise.all(
			Array.from({ length: concurrency }, (_, workerIndex) =>
				(async () => {
					let cycle = 0;
					while (performance.now() < deadline) {
						await controlPlaneCycle(server, ledger, workerIndex, cycle++);
						// Stay above the 500ms per-profile creation cooldown — hammering
						// creates would only collect 429s.
						await sleep(CONTROL_PLANE_CREATE_COOLDOWN_MS);
					}
				})(),
			),
		);

		const rows = [...ledger.latencies.entries()].map(([label, samples]) => {
			const stats = summarizeLatencies(samples);

			return [
				label,
				String(stats.count),
				fmtMs(stats.p50Ms),
				fmtMs(stats.p95Ms),
				fmtMs(stats.p99Ms),
				String(ledger.errors.get(label) ?? 0),
			];
		});
		printTable(`Control plane c=${concurrency}`, ["op", "count", "p50", "p95", "p99", "errors"], rows);
	}
}

async function runAbortedDownloads(server: ManagedServer, sessionId: string, segments: readonly string[]): Promise<void> {
	const rssBefore = readProcessRssBytes(server.pid);
	const samples: number[] = [];

	for (let round = 0; round < ABORT_ROUNDS; round++) {
		const controller = new AbortController();
		const segment = segments[round % segments.length] ?? "";
		const response = await fetch(`${server.baseUrl}/v1/playback-sessions/${sessionId}/segments/${segment}`, {
			signal: controller.signal,
			headers: { cookie: server.cookie, "x-profile-id": server.adminProfileId, "x-forwarded-for": "10.78.0.1" },
		});
		const reader = response.body?.getReader();
		if (reader) {
			await reader.read();
			reader.releaseLock();
		}

		controller.abort();
		await sleep(50);

		if (round % 5 === 4) {
			const rss = readProcessRssBytes(server.pid);
			if (rss !== undefined) samples.push(rss);
		}
	}

	const segment = segments[0] ?? "";
	const recovery = await fetch(`${server.baseUrl}/v1/playback-sessions/${sessionId}/segments/${segment}`, {
		headers: { cookie: server.cookie, "x-profile-id": server.adminProfileId, "x-forwarded-for": "10.78.0.2" },
	});
	await recovery.arrayBuffer();

	const rssAfter = readProcessRssBytes(server.pid);
	const firstSample = samples.at(0);
	const lastSample = samples.at(-1);
	let rssSamplesStable = "n/a";
	if (firstSample !== undefined && lastSample !== undefined) {
		rssSamplesStable = lastSample > firstSample * 1.5 ? "NO (grew >50%)" : "yes";
	}

	printTable(
		"Aborted downloads (client disconnects mid-body)",
		["rounds", "rss before", "rss after", "delta", "recovery", "rss samples stable"],
		[
			[
				String(ABORT_ROUNDS),
				rssBefore === undefined ? "n/a" : fmtMb(rssBefore),
				rssAfter === undefined ? "n/a" : fmtMb(rssAfter),
				rssBefore === undefined || rssAfter === undefined ? "n/a" : fmtMb(rssAfter - rssBefore),
				recovery.ok ? "ok" : `HTTP ${recovery.status}`,
				rssSamplesStable,
			],
		],
	);
}

export const meta = { description: "HLS streaming engine (playback session, playlist, segment throughput MB/s, aborts)" };

const args = suiteArgs();

if (!args.help) {
	const serverFixture = suiteServerFixture(args, { withSampleMedia: true });

	// Playback start polls the growing playlist every 20 ms until the cushion
	// exists. This characterises one poll tick on an unchanged playlist: raw
	// read+parse (the pre-cache waiter) vs the shared cache hit.
	task("streaming: playlist waiter poll cost", async () => {
		const dir = await mkdtemp(join(tmpdir(), "reelvault-playlist-poll-"));
		try {
			const playlistPath = join(dir, "playlist.m3u8");
			const lines = ["#EXTM3U", "#EXT-X-PLAYLIST-TYPE:EVENT"];
			for (let index = 0; index < 20; index++) lines.push("#EXTINF:4.0,", `seg_${index}.m4s`);
			await writeFile(playlistPath, lines.join("\n"));

			const sessionId = `bench-waiter-${Date.now()}`;
			await playlistFileCache.read(sessionId, playlistPath, 4);

			const raw = await benchmarkAsync("raw read+parse per tick", async () => parseHlsBuffer(await FileUtils.get(playlistPath).text(), 4), {
				warmup: 5,
				iterations: 50,
			});
			const cached = await benchmarkAsync("cache hit per tick", async () => playlistFileCache.read(sessionId, playlistPath, 4), {
				warmup: 5,
				iterations: 50,
			});
			printMicroResults([raw, cached]);
		} finally {
			await removeTree(dir);
		}

		return { ok: true };
	});

	task("streaming: startup (direct vs software transcode)", async () => {
		const server = await serverFixture();
		if (!server.sampleMediaId) {
			console.error("Sample media unavailable — cannot measure playback startup");
			process.exitCode = 1;

			return { ok: false };
		}

		await runStartupComparison(server);
		await runConcurrentStartup(server);

		return { ok: true };
	});

	type ThroughputServer = Parameters<typeof runThroughput>[0];
	type ThroughputSegments = Parameters<typeof runThroughput>[2];
	type ThroughputLoad = Parameters<typeof runThroughput>[3];

	/** Runs one throughput load, prints its table, and returns the scenario result with the bytes it moved. */
	async function reportThroughput(
		server: ThroughputServer,
		sessionId: string,
		segments: ThroughputSegments,
		load: ThroughputLoad,
		report: { title: string; rateLabel: string },
	): Promise<{ result: HttpScenarioResult; bytes: number }> {
		const run = await runThroughput(server, sessionId, segments, load);
		const stats = summarizeLatencies(run.latencies);
		const okCount = run.latencies.length - run.non2xx;
		printTable(
			report.title,
			["MB/s", report.rateLabel, "p50", "p95", "p99", "non-2xx"],
			[
				[
					(run.totalBytes / (run.elapsedMs / 1000) / 1024 / 1024).toFixed(2),
					(run.latencies.length / (run.elapsedMs / 1000)).toFixed(1),
					fmtMs(stats.p50Ms),
					fmtMs(stats.p95Ms),
					fmtMs(stats.p99Ms),
					String(run.non2xx),
				],
			],
		);

		const result = toScenarioResult({
			name: run.name,
			stats,
			throughputCount: okCount,
			elapsedMs: run.elapsedMs,
			errorCount: run.non2xx,
			total: run.latencies.length,
		});

		return { result, bytes: run.totalBytes };
	}

	task("streaming: phases", async () => {
		if (args.baseUrl) {
			console.error("The streaming benchmark requires a managed server (do not pass --url)");
			process.exitCode = 1;

			return;
		}

		const server = await serverFixture();
		if (!server.sampleMediaId) {
			console.error("Sample media unavailable — cannot run the streaming benchmark");
			process.exitCode = 1;

			return;
		}

		console.log(`[streaming] sample clip: ${server.sampleMediaPath}`);
		const sessionId = await createPlaybackSession(server, {
			cookie: server.cookie,
			"idempotency-key": `benchmark-stream-${Date.now()}`,
			"x-profile-id": server.adminProfileId,
			"x-forwarded-for": "10.77.9.9",
		});
		console.log(`[streaming] session ${sessionId} created, waiting for HLS output...`);
		const segments = await fetchPlaylistSegments(server, sessionId);
		console.log(`[streaming] ${segments.length} segments available`);

		const results: HttpScenarioResult[] = [];
		let totalBytes = 0;
		for (const concurrency of args.concurrency) {
			console.log(`[streaming] throughput at concurrency ${concurrency}...`);
			const load = { concurrency, warmupMs: args.warmupMs, durationMs: args.durationMs };
			const full = await reportThroughput(server, sessionId, segments, load, {
				title: `Throughput c=${concurrency}`,
				rateLabel: "segments/s",
			});

			// Seek path: a 256 KiB window from the middle of a segment — what a
			// player re-downloads after a seek when byte-range support exists.
			const range = await reportThroughput(
				server,
				sessionId,
				segments,
				{ ...load, rangeHeader: "bytes=131072-393215" },
				{ title: `Throughput Range 256KiB c=${concurrency}`, rateLabel: "req/s" },
			);
			results.push(full.result, range.result);
			totalBytes += full.bytes + range.bytes;
		}

		await runAbortedDownloads(server, sessionId, segments);
		await runControlPlane(server, args.durationMs);
		printHttpResults(results);
		console.log(`[streaming] total transferred: ${fmtMb(totalBytes)}`);

		await deletePlaybackSession(server, sessionId, {
			cookie: server.cookie,
			"x-profile-id": server.adminProfileId,
			"x-forwarded-for": "10.77.9.9",
		});
	});
}

await main(import.meta);
