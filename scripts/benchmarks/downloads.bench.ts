import { fmtMb, fmtMs, main, printTable, suiteArgs, summarizeLatencies, task } from "benchkit";
import { sleep } from "bun";

import { authHeaders } from "./lib/identity";
import type { ManagedServer } from "./lib/server";
import { suiteServerFixture } from "./lib/server-fixture";

/**
 * Downloads suite. Zero coverage before this existed: enqueue → ffmpeg
 * (stream-copy for "original") → completed file serving. One active download
 * per profile is enforced server-side, so concurrency comes from distinct
 * worker identities rather than parallel jobs on one identity.
 */

interface DownloadCycle {
	prepareMs: number;
	completeMs: number;
	totalBytes: number;
	fileMs: number;
	failed: boolean;
}

async function runDownloadCycle(server: ManagedServer, workerIndex: number): Promise<DownloadCycle> {
	const headers = authHeaders(server, workerIndex, 84, true);
	let failed = false;

	const prepareStartedAt = performance.now();
	const prepare = await fetch(`${server.baseUrl}/v1/downloads/prepare`, {
		method: "POST",
		headers: { ...headers, "content-type": "application/json" },
		body: JSON.stringify({ mediaFileId: server.sampleMediaId, quality: "original" }),
	});
	if (!prepare.ok) {
		failed = true;
		console.error(`[downloads] prepare failed: HTTP ${prepare.status} ${await prepare.text()}`);

		return { prepareMs: performance.now() - prepareStartedAt, completeMs: 0, totalBytes: 0, fileMs: 0, failed };
	}

	const job: unknown = await prepare.json();
	if (typeof job !== "object" || job === null || !("id" in job) || typeof job.id !== "string") {
		failed = true;

		return { prepareMs: performance.now() - prepareStartedAt, completeMs: 0, totalBytes: 0, fileMs: 0, failed };
	}

	const jobId = job.id;

	// Poll status until the processing worker finishes (stream copy is fast).
	const completeStartedAt = performance.now();
	let completed = false;
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		await sleep(200);
		const status = await fetch(`${server.baseUrl}/v1/downloads/${jobId}/status`, { headers });
		if (!status.ok) continue;

		const payload: unknown = await status.json();
		if (typeof payload === "object" && payload !== null && "status" in payload && payload.status === "completed") {
			completed = true;
			break;
		}

		if (
			typeof payload === "object" &&
			payload !== null &&
			"status" in payload &&
			typeof payload.status === "string" &&
			["failed", "cancelled"].includes(payload.status)
		) {
			break;
		}
	}

	const completeMs = completed ? performance.now() - completeStartedAt : 0;
	if (!completed) failed = true;

	// Serve the completed file once (throughput for one full-body GET).
	let totalBytes = 0;
	let fileMs = 0;
	const fileStartedAt = performance.now();
	const file = await fetch(`${server.baseUrl}/v1/downloads/${jobId}/file`, { headers });
	if (file.ok) {
		totalBytes = (await file.arrayBuffer()).byteLength;
		fileMs = performance.now() - fileStartedAt;
	} else {
		failed = true;
	}

	return { prepareMs: performance.now() - prepareStartedAt - completeMs - fileMs, completeMs, totalBytes, fileMs, failed };
}

export const meta = { description: "Downloads (prepare → ffmpeg stream-copy → completed-file serving)" };

const args = suiteArgs();

if (!args.help) {
	const serverFixture = suiteServerFixture(args, {
		workerCount: Math.max(1, Math.min(4, Math.max(...args.concurrency))),
		withSampleMedia: true,
	});

	task("downloads: phases", async () => {
		const concurrencyLevels = [1, Math.min(4, Math.max(...args.concurrency))];
		const server = await serverFixture();
		if (!server.sampleMediaId) {
			console.error("Sample media unavailable — cannot run the downloads benchmark");
			process.exitCode = 1;

			return;
		}

		const managed = server;
		const cycles = Math.max(2, Math.min(6, Math.floor(args.durationMs / 2000)));
		for (const concurrency of concurrencyLevels) {
			const startedAt = performance.now();
			const results = await Promise.all(
				Array.from({ length: concurrency }, (_, workerIndex) =>
					(async () => {
						const runs: DownloadCycle[] = [];
						for (let index = 0; index < cycles; index++) {
							runs.push(await runDownloadCycle(managed, workerIndex));
						}

						return runs;
					})(),
				),
			);
			const flat = results.flat();
			const failures = flat.filter((cycle) => cycle.failed).length;
			const completes = flat.map((cycle) => cycle.completeMs).filter((ms) => ms > 0);
			const files = flat.map((cycle) => cycle.fileMs).filter((ms) => ms > 0);
			const bytes = flat.reduce((sum, cycle) => sum + cycle.totalBytes, 0);
			const wallMs = performance.now() - startedAt;
			const completeStats = summarizeLatencies(completes.length > 0 ? completes : [0]);
			const fileStats = summarizeLatencies(files.length > 0 ? files : [0]);

			printTable(
				`Download cycle c=${concurrency} (${cycles} per identity)`,
				["jobs/s", "prepare→completed p50", "p95", "file GET p50", "MB/s served", "failures"],
				[
					[
						(flat.length / (wallMs / 1000)).toFixed(2),
						fmtMs(completeStats.p50Ms),
						fmtMs(completeStats.p95Ms),
						fmtMs(fileStats.p50Ms),
						fmtMb(bytes / (wallMs / 1000)),
						String(failures),
					],
				],
			);
		}
	});
}

await main(import.meta);
