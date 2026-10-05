import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fmtMs, main, printHttpResults, printTable, runScenarioMatrix, suiteArgs, summarizeLatencies, task } from "benchkit";
import { $ } from "bun";

import { adminHeaders } from "./lib/identity";
import type { ManagedServer } from "./lib/server";
import { createServerFixture } from "./lib/server-fixture";

/**
 * Subtitles suite. Zero coverage before this existed. Fixtures:
 *  - an external .vtt under $ROOT_DIR/subtitles (the only owned content path),
 *    registered as an `external` subtitle row → /content is a plain file read;
 *  - an mp4 muxed with a mov_text track + an `embedded` row with streamIndex 2
 *    → /content spawns ffmpeg extraction on the first hit and serves the
 *    cached .vtt afterwards.
 */

interface SubtitleFixture {
	externalId: string;
	embeddedId: string;
}

async function createSubtitleRow(server: ManagedServer, body: Record<string, unknown>): Promise<string> {
	const response = await fetch(`${server.baseUrl}/v1/subtitles`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...adminHeaders(server, "10.82.0.1"),
		},
		body: JSON.stringify(body),
	});
	if (!response.ok) throw new Error(`Subtitle row creation failed: HTTP ${response.status} ${await response.text()}`);

	const payload: unknown = await response.json();
	if (typeof payload !== "object" || payload === null || !("id" in payload) || typeof payload.id !== "string") {
		throw new Error("Subtitle row response is missing id");
	}

	return payload.id;
}

async function prepareFixtures(server: ManagedServer): Promise<SubtitleFixture> {
	const mediaFileId = server.sampleMediaId;
	if (!mediaFileId) throw new Error("Sample media id missing for subtitle fixtures");

	const subtitlesDir = join(server.rootDir, "subtitles");
	mkdirSync(subtitlesDir, { recursive: true });

	const vttPath = join(subtitlesDir, "bench-external.vtt");
	writeFileSync(vttPath, "WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nBenchmark subtitle line.\n");

	const externalId = await createSubtitleRow(server, {
		mediaFileId,
		language: "en",
		format: "vtt",
		type: "external",
		sourcePath: vttPath,
	});

	// Mux a real text subtitle stream (input-per-type stream order: 0=video, 1=audio, 2=subtitle)
	// and point the sample media_files row at it, so the embedded extraction
	// path runs ffmpeg against a file that actually carries the stream.
	const embeddedDir = join(server.rootDir, "bench-embedded");
	mkdirSync(embeddedDir, { recursive: true });
	const srtPath = join(embeddedDir, "track.srt");
	writeFileSync(srtPath, "1\n00:00:00,000 --> 00:00:05,000\nBenchmark embedded line.\n");
	const embeddedVideoPath = join(embeddedDir, "embedded-subs.mp4");
	await $`ffmpeg -hide_banner -loglevel error -y -f lavfi -i testsrc=size=320x180:rate=12 -f lavfi -i sine=frequency=1000:sample_rate=44100 -i ${srtPath} -map 0:v -map 1:a -map 2:s -t 5 -c:v libx264 -pix_fmt yuv420p -c:a aac -c:s mov_text ${embeddedVideoPath}`;

	const database = new Database(join(server.rootDir, "reelvault.sqlite"));
	database.run("UPDATE media_files SET file_path = ? WHERE id = ?", [embeddedVideoPath, mediaFileId]);
	database.close();

	const embeddedId = await createSubtitleRow(server, {
		mediaFileId,
		language: "en",
		format: "srt",
		type: "embedded",
		streamIndex: 2,
	});

	return { externalId, embeddedId };
}

async function timedSequence(name: string, operation: () => Promise<void>, iterations: number): Promise<void> {
	const latencies: number[] = [];
	for (let index = 0; index < iterations; index++) {
		const startedAt = performance.now();
		await operation();
		latencies.push(performance.now() - startedAt);
	}

	const stats = summarizeLatencies(latencies);
	printTable(name, ["count", "p50", "p95", "max"], [[String(stats.count), fmtMs(stats.p50Ms), fmtMs(stats.p95Ms), fmtMs(stats.maxMs)]]);
}

export const meta = { description: "Subtitles (list/info cache, external content stream, embedded ffmpeg extraction)" };

const args = suiteArgs();

if (!args.help) {
	const serverFixture = createServerFixture({
		seedRows: args.rows,
		workerCount: Math.max(...args.concurrency),
		withSampleMedia: true,
		keepServer: args.keepServer,
	});

	task("subtitles: phases", async () => {
		const server = await serverFixture();
		if (!server.sampleMediaId) {
			console.error("Sample media unavailable — cannot run the subtitles benchmark");
			process.exitCode = 1;

			return;
		}

		const fixtures = await prepareFixtures(server);
		const headers = adminHeaders(server, "10.82.0.2");

		const scenarios: Array<{ name: string; url: string }> = [
			{
				name: "GET /v1/subtitles?mediaFileId= (list)",
				url: `${server.baseUrl}/v1/subtitles?mediaFileId=${server.sampleMediaId}&limit=10`,
			},
			{ name: "GET /v1/subtitles/:id/content (external file)", url: `${server.baseUrl}/v1/subtitles/${fixtures.externalId}/content` },
		];
		const results = await runScenarioMatrix({
			suite: "subtitles",
			unit: "req/s",
			scenarios: scenarios.map((scenario) => ({
				name: scenario.name,
				requestFor: () => new Request(scenario.url, { headers }),
			})),
			concurrency: args.concurrency,
			warmupMs: args.warmupMs,
			durationMs: args.durationMs,
		});

		printHttpResults(results);

		// Embedded extraction: the first /content hit spawns ffmpeg into a cold
		// cache (shows up as max), the rest measure the warm cached-.vtt read.
		const embeddedContentUrl = `${server.baseUrl}/v1/subtitles/${fixtures.embeddedId}/content`;
		await timedSequence(
			"Embedded /content — extraction then warm reads",
			async () => {
				const response = await fetch(embeddedContentUrl, { headers });
				await response.arrayBuffer();
			},
			5,
		);
	});
}

await main(import.meta);
