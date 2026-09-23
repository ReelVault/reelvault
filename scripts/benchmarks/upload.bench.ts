import {
	DEFAULT_UPLOAD_SIZE_MB,
	fmtMb,
	type HttpScenarioResult,
	main,
	printHttpResults,
	printTable,
	runLoadWindow,
	suiteArgs,
	summarizeLatencies,
	task,
} from "benchkit";
import sharp from "sharp";
import { subnetIp } from "./lib/identity";
import type { ManagedServer } from "./lib/server";
import { createServerFixture } from "./lib/server-fixture";

const ROUTE_FILE_MAX_MB = 18;

/** Builds a real high-entropy JPEG image with Gaussian noise so the server's
 * image pipeline performs genuine decode, resize, and WebP re-encoding work. */
async function createBenchmarkImage(sizeMb: number): Promise<File> {
	const clampedMb = Math.max(0.5, Math.min(sizeMb, ROUTE_FILE_MAX_MB));
	const dimension = Math.min(3000, Math.max(800, Math.floor(Math.sqrt((clampedMb * 1024 * 1024) / 1.2))));
	const buffer = await sharp({
		create: {
			width: dimension,
			height: dimension,
			channels: 3,
			background: { r: 255, g: 255, b: 255, alpha: 1 },
			noise: { type: "gaussian", mean: 128, sigma: 40 },
		},
	})
		.jpeg({ quality: 85 })
		.toBuffer();

	return new File([buffer], "benchmark-upload.jpg", { type: "image/jpeg" });
}

async function runUploads(
	server: ManagedServer,
	image: File,
	concurrency: number,
	warmupMs: number,
	durationMs: number,
): Promise<{ latencies: number[]; non2xx: number; requests: number; uploadedBytes: number }> {
	const run = await runLoadWindow({
		concurrency,
		warmupMs,
		durationMs,
		work: async (workerIndex) => {
			const form = new FormData();
			form.set("type", workerIndex % 2 === 0 ? "poster" : "backdrop");
			form.set("file", image, `benchmark-${workerIndex}.jpg`);
			try {
				const response = await fetch(`${server.baseUrl}/v1/metadata/meta-0000000/images/upload`, {
					method: "POST",
					headers: { cookie: server.cookie, "x-forwarded-for": subnetIp(79, workerIndex) },
					body: form,
				});
				const ok = response.ok;
				await response.arrayBuffer();

				return { ok, metrics: { uploadedBytes: image.size } };
			} catch {
				return { ok: false, metrics: { uploadedBytes: image.size } };
			}
		},
	});

	return { latencies: run.latencies, non2xx: run.failures, requests: run.requests, uploadedBytes: run.metrics.uploadedBytes ?? 0 };
}

export const meta = { description: "Image upload pipeline (multipart ingest & Sharp optimization under concurrency)" };

const args = suiteArgs();

if (!args.help) {
	const serverFixture = createServerFixture({
		seedRows: args.rows,
		workerCount: Math.max(...args.concurrency),
		keepServer: args.keepServer,
	});

	task("upload: pipeline", async () => {
		let server: ManagedServer | undefined;
		try {
			const image = await createBenchmarkImage(args.sizeMb || DEFAULT_UPLOAD_SIZE_MB);
			console.log(`[upload] payload: ${fmtMb(image.size)} JPEG (high-entropy)`);

			server = await serverFixture();

			const results: HttpScenarioResult[] = [];
			let totalUploaded = 0;
			for (const concurrency of args.concurrency) {
				console.log(`[upload] concurrency ${concurrency} (warmup ${args.warmupMs}ms, measure ${args.durationMs}ms)`);
				const run = await runUploads(server, image, concurrency, args.warmupMs, args.durationMs);
				totalUploaded += run.uploadedBytes;
				const stats = summarizeLatencies(run.latencies);
				results.push({
					name: `image upload c=${concurrency}`,
					stats,
					requestsPerSecond: run.requests / (args.durationMs / 1000),
					errorRatePercent: run.requests > 0 ? (run.non2xx / run.requests) * 100 : 0,
				});
				printTable(
					`Upload c=${concurrency}`,
					["req/s", "MB/s in", "p50", "p95", "p99", "max", "non-2xx"],
					[
						[
							(run.requests / (args.durationMs / 1000)).toFixed(2),
							(run.uploadedBytes / (args.durationMs / 1000) / 1024 / 1024).toFixed(2),
							`${stats.p50Ms.toFixed(0)}ms`,
							`${stats.p95Ms.toFixed(0)}ms`,
							`${stats.p99Ms.toFixed(0)}ms`,
							`${stats.maxMs.toFixed(0)}ms`,
							String(run.non2xx),
						],
					],
				);
			}

			console.log(`[upload] total uploaded: ${fmtMb(totalUploaded)}`);
			printHttpResults(results);
		} finally {
			if (!args.keepServer) {
				await server?.stop();
			}
		}
	});
}

await main(import.meta);
