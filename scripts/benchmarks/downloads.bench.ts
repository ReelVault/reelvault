import { fmtMb, fmtMs, main, printTable, suiteArgs, summarizeLatencies, task } from "benchkit";
import { sleep } from "bun";

import type { ManagedServer } from "./lib/server";
import { createServerFixture } from "./lib/server-fixture";

/**
 * Downloads suite. Zero coverage before this existed: enqueue → ffmpeg
 * (stream-copy for "original") → completed file serving. One active download
 * per profile is enforced server-side, so concurrency comes from distinct
 * worker identities rather than parallel jobs on one identity.
 */

function headersFor(server: ManagedServer, workerIndex: number): Record<string, string> {
	return {
		cookie: server.workerCookies[workerIndex % server.workerCookies.length] ?? server.cookie,
		"x-profile-id": server.profileIdFor(workerIndex),
		"x-forwarded-for": `10.84.${Math.floor(workerIndex / 250) % 250}.${(workerIndex % 250) + 1}`,
	};
}

interface DownloadCycle {
	prepareMs: number;
	completeMs: number;
	totalBytes: number;
	fileMs: number;
	failed: boolean;
}

async function runDownloadCycle(server: ManagedServer, workerIndex: number): Promise<DownloadCycle> {
	const headers = headersFor(server, workerIndex);
	const failed = { failed: false };

	const prepareStartedAt = performance.now();
	const prepare = await fetch(`${server.baseUrl}/v1/downloads/prepare`, {
		method: "POST",
		headers: { ...headers, "content-type": "application/json" },
		body: JSON.stringify({ mediaFileId: server.sampleMediaId, quality: "original" }),
	});
	if (!prepare.ok) {
		failed.failed = true;
		console.error(`[downloads] prepare failed: HTTP ${prepare.status} ${await prepare.text()}`);

		return { prepareMs: performance.now() - prepareStartedAt, completeMs: 0, totalBytes: 0, fileMs: 0, ...failed };
	}

	const job: unknown = await prepare.json();
	if (typeof job !== "object" || job === null || !("id" in job) || typeof job.id !== "string") {
		failed.failed = true;

		return { prepareMs: performance.now() - prepareStartedAt, completeMs: 0, totalBytes: 0, fileMs: 0, ...failed };
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
	if (!completed) failed.failed = true;

	// Serve the completed file once (throughput for one full-body GET).
	let totalBytes = 0;
	let fileMs = 0;
	const fileStartedAt = performance.now();
	const file = await fetch(`${server.baseUrl}/v1/downloads/${jobId}/file`, { headers });
	if (file.ok) {
		totalBytes = (await file.arrayBuffer()).byteLength;
		fileMs = performance.now() - fileStartedAt;
	} else {
		failed.failed = true;
	}

	return { prepareMs: performance.now() - prepareStartedAt - completeMs - fileMs, completeMs, totalBytes, fileMs, ...failed };
}

export const meta = { description: "Downloads (prepare → ffmpeg stream-copy → completed-file serving)" };

const args = suiteArgs();

if (!args.help) {
	const serverFixture = createServerFixture({
		seedRows: args.rows,
		workerCount: Math.max(1, Math.min(4, Math.max(...args.concurrency))),
		withSampleMedia: true,
		keepServer: args.keepServer,
	});

	task("downloads: phases", async () => {
		let server: ManagedServer | undefined;
		try {
			const concurrencyLevels = [1, Math.min(4, Math.max(...args.concurrency))];
			server = await serverFixture();
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
		} finally {
			if (!args.keepServer) {
				await server?.stop();
			}
		}
	});
}

await main(import.meta);
