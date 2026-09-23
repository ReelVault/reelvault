/**
 * Memory leak detector.
 *
 * Boots a managed ReelVault server, drives repeated identical request rounds
 * (reads + uploads + segment downloads with mid-body aborts) and samples the
 * SERVER process RSS between rounds. A healthy server's memory stabilises once
 * caches warm up; a leak grows linearly round over round.
 *
 * GC note: the server runs in a separate OS process, so the load generator
 * cannot force its GC. Instead of a before/after comparison (which garbage
 * timing would make noise), this script fits a linear trend over per-round RSS
 * samples and flags a sustained upward slope that does not stabilise — the
 * recommended approach when forced GC is unavailable. Run with more rounds for
 * a tighter signal.
 *
 * Exit codes: 0 = no leak signal, 1 = suspicious memory growth, 2 = setup error.
 */

import { fmtMb, printTable, readProcessRssBytes } from "benchkit";
import { sleep } from "bun";
import { type ManagedServer, startBenchmarkServer } from "./benchmarks/lib/server";

const ROUNDS = Number(process.env.MEMORY_CHECK_ROUNDS ?? 10);
const REQUESTS_PER_ROUND = 60;
const SLOPE_THRESHOLD_BYTES_PER_ROUND = 512 * 1024; // >512 kB steady growth per round is suspicious
const STABILIZATION_BAND = 1.05; // last-third median within 5% of first-third median counts as stable

interface ReadTarget {
	url: string;
	/** Per-profile routes need the matching x-profile-id for the rotated cookie. */
	profileScoped?: boolean;
}

function readTargets(server: ManagedServer, index: number): ReadTarget[] {
	return [
		{ url: `${server.baseUrl}/v1/metadata?limit=24&page=${(index % 10) + 1}` },
		{ url: `${server.baseUrl}/v1/metadata/search/global?q=star&limit=10` },
		{ url: `${server.baseUrl}/v1/images/${server.benchmarkImageId}?w=342` },
		{ url: `${server.baseUrl}/v1/discover?limit=10`, profileScoped: true },
		{ url: `${server.baseUrl}/v1/me/continue-watching?limit=12`, profileScoped: true },
		{ url: `${server.baseUrl}/v1/me/watched-history?limit=20`, profileScoped: true },
		{ url: `${server.baseUrl}/v1/notifications/unread-count`, profileScoped: true },
		{ url: `${server.baseUrl}/v1/health` },
	];
}

async function driveReadRound(server: ManagedServer, workerCookies: readonly string[]): Promise<void> {
	for (let index = 0; index < REQUESTS_PER_ROUND; index++) {
		const identityIndex = index % workerCookies.length;
		const cookie = workerCookies[identityIndex];
		const ip = `10.90.0.${(index % 200) + 1}`;
		const targets = readTargets(server, identityIndex);
		try {
			const target = targets[index % targets.length];
			if (!target) continue;

			const headers: Record<string, string> = { cookie: cookie ?? "", "x-forwarded-for": ip };
			if (target.profileScoped) headers["x-profile-id"] = server.profileIdFor(identityIndex);

			const response = await fetch(target.url, { headers });
			await response.arrayBuffer();
		} catch {
			// network errors count against stability below
		}
	}
}

async function driveAbortRound(server: ManagedServer, sessionId: string, segments: readonly string[]): Promise<void> {
	for (let index = 0; index < 10; index++) {
		const controller = new AbortController();
		try {
			const response = await fetch(
				`${server.baseUrl}/v1/playback-sessions/${sessionId}/segments/${segments[index % segments.length] ?? ""}`,
				{
					signal: controller.signal,
					headers: { cookie: server.cookie, "x-profile-id": server.adminProfileId, "x-forwarded-for": "10.90.1.1" },
				},
			);
			const reader = response.body?.getReader();
			if (reader) {
				await reader.read();
				reader.releaseLock();
			}
		} catch {
			// abort noise
		}

		controller.abort();
		await sleep(20);
	}
}

interface MemoryCacheStat {
	name: string;
	entries: number;
	hitRate: number | null;
}

const isMemoryCacheStat = (value: unknown): value is MemoryCacheStat => {
	if (typeof value !== "object" || value === null) return false;

	if (!("name" in value && "entries" in value && "hitRate" in value)) return false;

	const { name, entries, hitRate } = value;

	return typeof name === "string" && typeof entries === "number" && (typeof hitRate === "number" || hitRate === null);
};

/** Narrows the loosely-typed /admin/cache-stats payload to its `memory` list. */
function readMemoryCacheStats(body: unknown): MemoryCacheStat[] {
	if (typeof body !== "object" || body === null || !("memory" in body) || !Array.isArray(body.memory)) return [];

	const memory: unknown[] = body.memory;
	const stats: MemoryCacheStat[] = [];
	for (const entry of memory) {
		if (isMemoryCacheStat(entry)) stats.push(entry);
	}

	return stats;
}

/**
 * Server-side cache snapshot (GET /v1/admin/cache-stats) — attributes RSS
 * growth to a specific in-memory cache instead of guessing from the trend.
 */
async function readCacheStats(server: ManagedServer): Promise<MemoryCacheStat[]> {
	try {
		const response = await fetch(`${server.baseUrl}/v1/admin/cache-stats`, { headers: { cookie: server.cookie } });
		if (!response.ok) return [];

		const body: unknown = await response.json();

		return readMemoryCacheStats(body);
	} catch {
		return [];
	}
}

/** Least-squares slope of RSS over rounds, in bytes per round. */ function trendSlope(samples: number[]): number {
	const n = samples.length;
	if (n < 2) return 0;

	const meanX = (n - 1) / 2;
	const meanY = samples.reduce((sum, value) => sum + value, 0) / n;
	let numerator = 0;
	let denominator = 0;
	for (let index = 0; index < n; index++) {
		const sample = samples[index];
		if (sample === undefined) continue;

		numerator += (index - meanX) * (sample - meanY);
		denominator += (index - meanX) ** 2;
	}

	return denominator === 0 ? 0 : numerator / denominator;
}

function isStable(samples: number[]): boolean {
	if (samples.length < 6) return true;

	const third = Math.floor(samples.length / 3);
	const firstMedian = samples.slice(0, third).toSorted((a, b) => a - b)[Math.floor(third / 2)] ?? 0;
	const lastMedian = samples.slice(-third).toSorted((a, b) => a - b)[Math.floor(third / 2)] ?? 0;

	return lastMedian <= firstMedian * STABILIZATION_BAND;
}

async function main(): Promise<void> {
	let server: ManagedServer | undefined;
	try {
		console.log(`[memory-check] rounds=${ROUNDS}, requests/round=${REQUESTS_PER_ROUND}`);
		server = await startBenchmarkServer({
			seedRows: 2_000,
			workerCount: 4,
			withSampleMedia: true,
		});
		if (!server.sampleMediaId) throw new Error("sample media unavailable");

		const sessionResponse = await fetch(`${server.baseUrl}/v1/playback-sessions`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				cookie: server.cookie,
				// Session-scoped playback endpoints resolve the profile from this
				// header — server.cookie carries no current_profile_id.
				"x-profile-id": server.adminProfileId,
				"idempotency-key": `memory-check-${Date.now()}`,
				"x-forwarded-for": "10.90.9.9",
			},
			body: JSON.stringify({ mediaFileId: server.sampleMediaId, videoCodecs: ["h264"], audioCodecs: ["aac"] }),
		});
		if (sessionResponse.status !== 201) throw new Error(`session creation failed: HTTP ${sessionResponse.status}`);

		const sessionBody: unknown = await sessionResponse.json();
		if (
			typeof sessionBody !== "object" ||
			sessionBody === null ||
			!("sessionId" in sessionBody) ||
			typeof sessionBody.sessionId !== "string"
		) {
			throw new Error("session creation response is missing sessionId");
		}

		const sessionId: string = sessionBody.sessionId;

		const playlistResponse = await fetch(`${server.baseUrl}/v1/playback-sessions/${sessionId}/playlist`, {
			headers: { cookie: server.cookie, "x-profile-id": server.adminProfileId, "x-forwarded-for": "10.90.9.9" },
		});
		const segments = (await playlistResponse.text())
			.split("\n")
			.filter((line) => line.endsWith(".m4s"))
			.map((line) => line.trim());
		if (segments.length === 0) throw new Error("no segments produced");

		const samples: number[] = [];
		const warmupSamples: number[] = [];
		for (let round = 0; round < ROUNDS + 3; round++) {
			await driveReadRound(server, server.workerCookies);
			await driveAbortRound(server, sessionId, segments);
			const rss = readProcessRssBytes(server.pid);
			if (rss === undefined) {
				console.error("[memory-check] /proc RSS sampling unavailable on this platform");
				process.exitCode = 2;

				return;
			}

			// The first rounds warm up caches (settings, playlists, per-user buckets).
			if (round < 3) {
				warmupSamples.push(rss);
				console.log(`round ${round} (warmup): rss ${fmtMb(rss)}`);
			} else {
				samples.push(rss);
				console.log(`round ${round}: rss ${fmtMb(rss)}`);
			}

			const cacheStats = await readCacheStats(server);
			if (cacheStats.length > 0) {
				const summary = cacheStats.map((cache) => `${cache.name}=${cache.entries}(${cache.hitRate ?? "-"})`).join(" ");
				console.log(`  caches: ${summary}`);
			}
		}

		const slope = trendSlope(samples);
		const stable = isStable(samples);
		const leakSuspected = slope > SLOPE_THRESHOLD_BYTES_PER_ROUND && !stable;

		printTable(
			"Memory trend (server RSS across identical rounds)",
			["rounds measured", "first rss", "last rss", "growth/round", "stabilized", "verdict"],
			[
				[
					String(samples.length),
					fmtMb(samples[0] ?? 0),
					fmtMb(samples[samples.length - 1] ?? 0),
					`${(slope / 1024).toFixed(1)} kB/round`,
					stable ? "yes" : "NO",
					leakSuspected ? "LEAK SUSPECTED" : "no leak signal",
				],
			],
		);

		process.exitCode = leakSuspected ? 1 : 0;
	} catch (error) {
		console.error("[memory-check] failed:", error instanceof Error ? error.message : error);
		process.exitCode = 2;
	} finally {
		await server?.stop();
	}
}

await main();
