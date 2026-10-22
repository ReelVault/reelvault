import {
	fmtMb,
	growthVerdict,
	type HttpScenarioResult,
	identityIndexFor,
	metric,
	parseSegments,
	printHttpResults,
	printTable,
	type RssSummary,
	readProcessRssBytes,
	runRequestScenario,
	startProcessSampler,
	suiteArgs,
	type TaskMetrics,
	task,
	weightedMix,
} from "benchkit";
import { sleep } from "bun";
import { adminHeaders, authHeaders, workerCookie } from "./lib/identity.utils";
import { createPlaybackSession } from "./lib/playback.utils";
import { suiteServerFixture } from "./lib/server.fixture";
import type { ManagedServer } from "./lib/server.launcher";

/**
 * Server memory under load, in two tasks:
 *  - `RSS under load` replays a read mix and a write mix while sampling the server's resident set
 *    size and CPU time, and records start/peak/end RSS per phase alongside throughput;
 *  - `leak trend` drives identical rounds (reads plus segment downloads aborted mid-body) and fits a
 *    line through the RSS after each round. The server runs in its own process, so its GC cannot be
 *    forced: a steady upward slope that never levels off is the leak signal, not a before/after delta.
 * Both catch unbounded growth (caches, session maps, buffers) that latency suites never surface.
 */

const RSS_SAMPLE_INTERVAL_MS = 500;
/** Rounds whose RSS is discarded while caches (settings, playlists, per-user buckets) fill up. */
const LEAK_WARMUP_ROUNDS = 3;
const LEAK_ROUNDS = 12;
const LEAK_REQUESTS_PER_ROUND = 60;
const LEAK_ABORTS_PER_ROUND = 10;
/** More than 512 kB of steady growth per round is suspicious. */
const LEAK_SLOPE_BYTES_PER_ROUND = 512 * 1024;

type RequestBuilder = (server: ManagedServer, workerIndex: number, requestIndex: number) => Request;

function readHeaders(server: ManagedServer, workerIndex: number, requestIndex: number, withProfile = false): Record<string, string> {
	const identityIndex = identityIndexFor(workerIndex, requestIndex, server.workerCookies.length);

	return authHeaders(server, identityIndex, 90, withProfile);
}

const browse: RequestBuilder = (server, worker, request) =>
	new Request(`${server.baseUrl}/v1/metadata?limit=24&page=${(request % 20) + 1}`, {
		headers: readHeaders(server, worker, request),
	});

const search: RequestBuilder = (server, worker, request) =>
	new Request(`${server.baseUrl}/v1/metadata/search/global?q=${request % 2 === 0 ? "star" : "benchmark"}&limit=10`, {
		headers: readHeaders(server, worker, request),
	});

const continueWatching: RequestBuilder = (server, worker, request) =>
	new Request(`${server.baseUrl}/v1/me/continue-watching?limit=12`, { headers: readHeaders(server, worker, request, true) });

const movieDetail: RequestBuilder = (server, worker, request) =>
	new Request(`${server.baseUrl}/v1/metadata/meta-0000001`, { headers: readHeaders(server, worker, request) });

const discover: RequestBuilder = (server, worker, request) =>
	new Request(`${server.baseUrl}/v1/discover?limit=10`, { headers: readHeaders(server, worker, request, true) });

const statuses: RequestBuilder = (server, worker, request) =>
	new Request(`${server.baseUrl}/v1/me/watchlist/statuses?ids=meta-0000001,meta-0000000,meta-0000010,meta-0000020`, {
		headers: readHeaders(server, worker, request, true),
	});

const READ_MIX: ReadonlyArray<readonly [RequestBuilder, number]> = [
	[browse, 0.4],
	[search, 0.2],
	[continueWatching, 0.1],
	[movieDetail, 0.1],
	[discover, 0.1],
	[statuses, 0.1],
];

const pickRead = weightedMix(READ_MIX);
const readMix: RequestBuilder = (server, worker, request) => pickRead(request)(server, worker, request);

const progressUpsert: RequestBuilder = (server, worker, request) =>
	new Request(`${server.baseUrl}/v1/me/media-files/mf-meta-0000001/playback-progress`, {
		method: "PUT",
		headers: { ...readHeaders(server, worker, request, true), "content-type": "application/json" },
		body: JSON.stringify({ position: request % 600 }),
	});

const watchlistToggle: RequestBuilder = (server, worker, request) => {
	const metadataId = `meta-${String((worker * 131 + (request >> 1) * 7) % Math.max(server.seededRows, 1)).padStart(7, "0")}`;
	const even = request % 2 === 0;
	// Toggle pairs must land on ONE identity (POST and DELETE from the same
	// profile) — unlike the read mix, headers here pin the worker's identity.
	const headers = {
		cookie: workerCookie(server, worker),
		"x-profile-id": server.profileIdFor(worker),
		"x-forwarded-for": `10.90.255.${(worker % 250) + 1}`,
		...(even ? { "content-type": "application/json" } : {}),
	};
	return new Request(`${server.baseUrl}/v1/me/watchlist${even ? "" : `/${metadataId}`}`, {
		method: even ? "POST" : "DELETE",
		headers,
		...(even ? { body: JSON.stringify({ metadataId }) } : {}),
	});
};

const WRITE_MIX: ReadonlyArray<readonly [RequestBuilder, number]> = [
	[progressUpsert, 0.6],
	[watchlistToggle, 0.4],
];

const pickWrite = weightedMix(WRITE_MIX, 40503);
const writeMix: RequestBuilder = (server, worker, request) => pickWrite(request)(server, worker, request);

const toMb = (bytes: number | undefined): string => (bytes === undefined ? "?" : fmtMb(bytes));

function formatRss(summary: RssSummary): string[] {
	return [toMb(summary.startBytes), toMb(summary.peakBytes), toMb(summary.endBytes)];
}

export const meta = {
	description: "Server RSS and CPU under sustained read + write load, and the RSS trend across identical rounds (leak guard)",
};

const args = suiteArgs();

// The leak trend streams the sample clip; both tasks share one server.
const serverFixture = suiteServerFixture(args, { withSampleMedia: true });

task("memory: RSS under load", async () => {
	const server = await serverFixture();
	const results: HttpScenarioResult[] = [];
	const rssRows: string[][] = [];
	const metrics: TaskMetrics = {};

	const phases: ReadonlyArray<readonly [string, RequestBuilder]> = [
		["read mix", readMix],
		["write mix", writeMix],
		["read mix (2nd pass)", readMix],
	];

	for (const [phaseName, builder] of phases) {
		for (const concurrency of args.concurrency) {
			const stopSampler = startProcessSampler(server.pid, RSS_SAMPLE_INTERVAL_MS);

			const result = await runRequestScenario({
				name: `c=${concurrency} ${phaseName}`,
				concurrency,
				warmupMs: args.warmupMs,
				durationMs: args.durationMs,
				requestFor: (workerIndex: number, requestIndex: number) => builder(server, workerIndex, requestIndex),
			});
			const { rss: summary, cpu } = stopSampler();
			results.push(result);

			const phaseKey = `c=${concurrency} ${phaseName}`;
			metrics[`${phaseKey} req/s`] = metric(result.requestsPerSecond, true);
			if (summary.peakBytes !== undefined) metrics[`${phaseKey} rss peak MB`] = metric(summary.peakBytes / 1024 / 1024, false);
			if (cpu.deltaMs !== undefined) {
				metrics[`${phaseKey} cpu ms`] = metric(cpu.deltaMs, false);
				metrics[`${phaseKey} cpu µs/req`] = metric((cpu.deltaMs * 1000) / Math.max(result.stats.count, 1), false);
			}

			rssRows.push([`${phaseName} c=${concurrency}`, `${result.requestsPerSecond.toFixed(0)} req/s`, ...formatRss(summary)]);
			console.log(
				`  ${phaseName} c=${concurrency}: ${result.requestsPerSecond.toFixed(0)} req/s, RSS start/peak/end ${formatRss(summary).join(" / ")}, CPU ${cpu.deltaMs?.toFixed(0) ?? "?"}ms`,
			);
		}
	}

	printTable(`Server RSS per load phase (pid ${server.pid})`, ["phase", "throughput", "start", "peak", "end"], rssRows);
	printHttpResults(results);

	return { ok: true, data: { metrics } };
});

/** One round of reads, sequential so every round does the same work. */
async function readRound(server: ManagedServer): Promise<void> {
	for (let index = 0; index < LEAK_REQUESTS_PER_ROUND; index++) {
		try {
			const response = await fetch(readMix(server, 0, index));
			await response.arrayBuffer();
		} catch {
			// A failed read does not change the trend; the RSS samples are the measurement.
		}
	}
}

/** Segment downloads abandoned after the first chunk — the client-disconnect path of the streaming code. */
async function abortRound(server: ManagedServer, sessionId: string, segments: readonly string[]): Promise<void> {
	const headers = adminHeaders(server, "10.90.1.1");
	for (let index = 0; index < LEAK_ABORTS_PER_ROUND; index++) {
		const controller = new AbortController();
		try {
			const segment = segments[index % segments.length] ?? "";
			const response = await fetch(`${server.baseUrl}/v1/playback-sessions/${sessionId}/segments/${segment}`, {
				signal: controller.signal,
				headers,
			});
			const reader = response.body?.getReader();
			await reader?.read();
			reader?.releaseLock();
		} catch {
			// The abort itself is the point.
		}

		controller.abort();
		await sleep(20);
	}
}

task("memory: leak trend", async () => {
	const server = await serverFixture();
	const headers = { ...adminHeaders(server, "10.90.9.9"), "idempotency-key": `memory-leak-${Date.now()}` };
	const sessionId = await createPlaybackSession(server, headers);
	const playlist = await fetch(`${server.baseUrl}/v1/playback-sessions/${sessionId}/playlist`, { headers });
	const segments = parseSegments(await playlist.text());
	if (segments.length === 0) throw new Error("[memory] the sample clip produced no segments");

	const samples: number[] = [];
	for (let round = 0; round < LEAK_WARMUP_ROUNDS + LEAK_ROUNDS; round++) {
		await readRound(server);
		await abortRound(server, sessionId, segments);
		const rss = readProcessRssBytes(server.pid);
		if (rss === undefined) throw new Error("[memory] RSS sampling needs /proc (Linux)");

		const warmup = round < LEAK_WARMUP_ROUNDS;
		if (!warmup) samples.push(rss);
		console.log(`  round ${round}${warmup ? " (warmup)" : ""}: rss ${fmtMb(rss)}`);
	}

	const { slope, levelled, growing } = growthVerdict(samples, LEAK_SLOPE_BYTES_PER_ROUND);
	printTable(
		"Memory trend (server RSS after identical rounds)",
		["rounds", "first rss", "last rss", "growth/round", "levelled off", "verdict"],
		[
			[
				String(samples.length),
				fmtMb(samples[0] ?? 0),
				fmtMb(samples.at(-1) ?? 0),
				`${(slope / 1024).toFixed(1)} kB`,
				levelled ? "yes" : "NO",
				growing ? "LEAK SUSPECTED" : "no leak signal",
			],
		],
	);

	return { ok: !growing, data: { metrics: { "rss growth kB/round": metric(slope / 1024, false) } } };
});
