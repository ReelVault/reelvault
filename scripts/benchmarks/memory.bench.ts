import {
	type HttpScenarioResult,
	main,
	printHttpResults,
	printTable,
	type RssSummary,
	runRequestScenario,
	startRssSampler,
	suiteArgs,
	task,
} from "benchkit";
import { authHeaders, workerCookie } from "./lib/identity";
import type { ManagedServer } from "./lib/server";
import { createServerFixture } from "./lib/server-fixture";

/**
 * RSS-under-load suite: replays a realistic read mix and a write mix against
 * the managed server while sampling the server process's resident set size.
 * Catches unbounded-growth regressions (caches, session maps, buffers) that
 * per-request latency suites never surface. The trend detector lives in
 * scripts/memory-check.ts; this suite records the load-bearing numbers
 * (start/peak/end RSS per phase) alongside throughput.
 */

const RSS_SAMPLE_INTERVAL_MS = 500;

type RequestBuilder = (server: ManagedServer, workerIndex: number, requestIndex: number) => Request;

function readHeaders(server: ManagedServer, workerIndex: number, requestIndex: number, withProfile = false): Record<string, string> {
	const identityIndex = (workerIndex * 997 + requestIndex) % Math.max(server.workerCookies.length, 1);

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

const readMix: RequestBuilder = (server, worker, request) => {
	const draw = (request * 2654435761) % 1000;
	let threshold = 0;
	for (const [builder, weight] of READ_MIX) {
		threshold += weight * 1000;
		if (draw < threshold) return builder(server, worker, request);
	}

	return browse(server, worker, request);
};

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

const writeMix: RequestBuilder = (server, worker, request) => {
	const draw = (request * 40503) % 1000;
	let threshold = 0;
	for (const [builder, weight] of WRITE_MIX) {
		threshold += weight * 1000;
		if (draw < threshold) return builder(server, worker, request);
	}

	return progressUpsert(server, worker, request);
};

const toMb = (bytes: number | undefined): string => (bytes === undefined ? "?" : `${(bytes / 1024 / 1024).toFixed(1)}MB`);

function formatRss(summary: RssSummary): string[] {
	return [toMb(summary.startBytes), toMb(summary.peakBytes), toMb(summary.endBytes)];
}

export const meta = { description: "Server RSS under sustained read + write load (leak/growth guard)" };

const args = suiteArgs();

if (!args.help) {
	const serverFixture = createServerFixture({
		seedRows: args.rows,
		workerCount: Math.max(...args.concurrency),
		keepServer: args.keepServer,
	});

	task("memory: RSS under load", async () => {
		const server = await serverFixture();
		const results: HttpScenarioResult[] = [];
		const rssRows: string[][] = [];

		const phases: ReadonlyArray<readonly [string, RequestBuilder]> = [
			["read mix", readMix],
			["write mix", writeMix],
			["read mix (2nd pass)", readMix],
		];

		for (const [phaseName, builder] of phases) {
			for (const concurrency of args.concurrency) {
				let summary: RssSummary = {};
				const stopSampler = startRssSampler(server.pid, RSS_SAMPLE_INTERVAL_MS, (captured) => {
					summary = captured;
				});

				const result = await runRequestScenario({
					name: `c=${concurrency} ${phaseName} (c=${concurrency})`,
					concurrency,
					warmupMs: args.warmupMs,
					durationMs: args.durationMs,
					requestFor: (workerIndex: number, requestIndex: number) => builder(server, workerIndex, requestIndex),
				});
				stopSampler();
				results.push(result);
				rssRows.push([`${phaseName} c=${concurrency}`, `${result.requestsPerSecond.toFixed(0)} req/s`, ...formatRss(summary)]);
				console.log(
					`  ${phaseName} c=${concurrency}: ${result.requestsPerSecond.toFixed(0)} req/s, RSS start/peak/end ${formatRss(summary).join(" / ")}`,
				);
			}
		}

		printTable(`Server RSS per load phase (pid ${server.pid})`, ["phase", "throughput", "start", "peak", "end"], rssRows);
		printHttpResults(results);
	});
}

await main(import.meta);
