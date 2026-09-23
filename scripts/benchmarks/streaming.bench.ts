import {
	fmtMb,
	fmtMs,
	type HttpScenarioResult,
	main,
	parseSegments,
	printHttpResults,
	printTable,
	readProcessRssBytes,
	runLoadWindow,
	suiteArgs,
	summarizeLatencies,
	task,
} from "benchkit";
import { sleep } from "bun";
import { subnetIp } from "./lib/identity";
import type { ManagedServer } from "./lib/server";
import { createServerFixture } from "./lib/server-fixture";

async function createPlaybackSession(server: ManagedServer): Promise<string> {
	const response = await fetch(`${server.baseUrl}/v1/playback-sessions`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			cookie: server.cookie,
			"idempotency-key": `benchmark-stream-${Date.now()}`,
			"x-profile-id": server.adminProfileId,
			"x-forwarded-for": "10.77.9.9",
		},
		body: JSON.stringify({ mediaFileId: server.sampleMediaId, videoCodecs: ["h264"], audioCodecs: ["aac"] }),
	});
	if (response.status !== 201) {
		throw new Error(`Playback session creation failed: HTTP ${response.status} ${await response.text()}`);
	}

	const body: unknown = await response.json();
	if (typeof body !== "object" || body === null || !("sessionId" in body) || typeof body.sessionId !== "string") {
		throw new Error("Playback session response is missing sessionId");
	}

	return body.sessionId;
}

async function fetchPlaylistSegments(server: ManagedServer, sessionId: string): Promise<string[]> {
	const response = await fetch(`${server.baseUrl}/v1/playback-sessions/${sessionId}/playlist`, {
		headers: { cookie: server.cookie, "x-profile-id": server.adminProfileId, "x-forwarded-for": "10.77.9.9" },
	});
	if (!response.ok) throw new Error(`Playlist fetch failed: HTTP ${response.status} ${await response.text()}`);

	const segments = parseSegments(await response.text());
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
	concurrency: number,
	warmupMs: number,
	durationMs: number,
): Promise<ThroughputRun> {
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
		name: `HLS segments c=${concurrency}`,
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
	const cookie = server.workerCookies[identityIndex] ?? server.cookie;

	return {
		cookie,
		"x-profile-id": server.profileIdFor(identityIndex),
		"x-forwarded-for": subnetIp(79, identityIndex),
	};
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

async function runControlPlane(server: ManagedServer, durationMs: number): Promise<void> {
	const settingsResponse = await fetch(`${server.baseUrl}/v1/admin/settings`, {
		method: "PATCH",
		headers: { "content-type": "application/json", cookie: server.cookie, "x-forwarded-for": "10.79.0.1" },
		body: JSON.stringify({ "stream.maxSessions": 32, "stream.maxSessionsPerUser": 32 }),
	});
	if (!settingsResponse.ok) {
		throw new Error(`Failed to raise session caps for control-plane phase: HTTP ${settingsResponse.status}`);
	}

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
				rssBefore !== undefined ? fmtMb(rssBefore) : "n/a",
				rssAfter !== undefined ? fmtMb(rssAfter) : "n/a",
				rssBefore !== undefined && rssAfter !== undefined ? fmtMb(rssAfter - rssBefore) : "n/a",
				recovery.ok ? "ok" : `HTTP ${recovery.status}`,
				rssSamplesStable,
			],
		],
	);
}

export const meta = { description: "HLS streaming engine (playback session, playlist, segment throughput MB/s, aborts)" };

const args = suiteArgs();

if (!args.help) {
	const serverFixture = createServerFixture({
		seedRows: args.rows,
		workerCount: Math.max(...args.concurrency),
		withSampleMedia: true,
		keepServer: args.keepServer,
	});

	task("streaming: phases", async () => {
		let server: ManagedServer | undefined;
		try {
			if (args.baseUrl) {
				console.error("The streaming benchmark requires a managed server (do not pass --url)");
				process.exitCode = 1;

				return;
			}

			server = await serverFixture();
			if (!server.sampleMediaId) {
				console.error("Sample media unavailable — cannot run the streaming benchmark");
				process.exitCode = 1;

				return;
			}

			console.log(`[streaming] sample clip: ${server.sampleMediaPath}`);
			const sessionId = await createPlaybackSession(server);
			console.log(`[streaming] session ${sessionId} created, waiting for HLS output...`);
			const segments = await fetchPlaylistSegments(server, sessionId);
			console.log(`[streaming] ${segments.length} segments available`);

			const results: HttpScenarioResult[] = [];
			let totalBytes = 0;
			for (const concurrency of args.concurrency) {
				console.log(`[streaming] throughput at concurrency ${concurrency}...`);
				const run = await runThroughput(server, sessionId, segments, concurrency, args.warmupMs, args.durationMs);
				totalBytes += run.totalBytes;
				const stats = summarizeLatencies(run.latencies);
				const okCount = run.latencies.length - run.non2xx;
				results.push({
					name: run.name,
					stats,
					requestsPerSecond: okCount / (run.elapsedMs / 1000),
					errorRatePercent: run.latencies.length > 0 ? (run.non2xx / run.latencies.length) * 100 : 0,
				});
				printTable(
					`Throughput c=${concurrency}`,
					["MB/s", "segments/s", "p50", "p95", "p99", "non-2xx"],
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
			}

			await runAbortedDownloads(server, sessionId, segments);
			await runControlPlane(server, args.durationMs);
			printHttpResults(results);
			console.log(`[streaming] total transferred: ${fmtMb(totalBytes)}`);

			await fetch(`${server.baseUrl}/v1/playback-sessions/${sessionId}`, {
				method: "DELETE",
				headers: { cookie: server.cookie, "x-profile-id": server.adminProfileId, "x-forwarded-for": "10.77.9.9" },
			});
		} finally {
			if (!args.keepServer) {
				await server?.stop();
			}
		}
	});
}

await main(import.meta);
