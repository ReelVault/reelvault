import { fmtMb, fmtMs, main, printTable, suiteArgs, summarizeLatencies, task } from "benchkit";
import { sleep } from "bun";
import { isRecord } from "@/utils/type.utils";

import type { ManagedServer } from "./lib/server";
import { createServerFixture } from "./lib/server-fixture";

/**
 * Trickplay suite. Zero coverage before this existed: generation is one of the
 * heaviest ffmpeg paths in the server (frame extraction → WebP sprite sheets +
 * WebVTT), yet nothing measured it. Two phases:
 *  1. one generation end-to-end on the sample clip (admin trigger → artifacts
 *     on disk), reported as wall clock;
 *  2. artifact serving throughput (GET the sprite/VTT bytes in a loop).
 */

interface ArtifactInfo {
	id: string;
	contentType?: string | undefined;
	sizeBytes?: number | undefined;
}

function adminHeaders(server: ManagedServer): Record<string, string> {
	return { cookie: server.cookie, "x-profile-id": server.adminProfileId, "x-forwarded-for": "10.83.0.1" };
}

async function listArtifacts(server: ManagedServer): Promise<ArtifactInfo[]> {
	const mediaFileId = server.sampleMediaId;
	if (!mediaFileId) throw new Error("Sample media id missing for trickplay artifacts");

	const response = await fetch(`${server.baseUrl}/v1/media-files/${mediaFileId}/artifacts`, {
		headers: adminHeaders(server),
	});
	if (!response.ok) throw new Error(`Artifact list failed: HTTP ${response.status} ${await response.text()}`);

	const payload: unknown = await response.json();
	if (!Array.isArray(payload)) return [];

	return payload.filter((item): item is ArtifactInfo => isRecord(item) && typeof item.id === "string");
}

export const meta = { description: "Trickplay (ffmpeg sprite/VTT generation e2e, artifact serving)" };

const args = suiteArgs();

if (!args.help) {
	const serverFixture = createServerFixture({
		seedRows: args.rows,
		withSampleMedia: true,
		keepServer: args.keepServer,
	});

	task("trickplay: phases", async () => {
		let server: ManagedServer | undefined;
		try {
			server = await serverFixture();
			if (!server.sampleMediaId) {
				console.error("Sample media unavailable — cannot run the trickplay benchmark");
				process.exitCode = 1;

				return;
			}

			const headers = adminHeaders(server);

			// ─── Phase 1: end-to-end generation wall clock ───
			console.log("[trickplay] triggering generation on the sample clip...");
			const triggerStartedAt = performance.now();
			const trigger = await fetch(`${server.baseUrl}/v1/admin/trickplay/generate/${server.sampleMediaId}`, {
				method: "POST",
				headers: { ...headers, "content-type": "application/json" },
				body: JSON.stringify({}),
			});
			if (!trigger.ok && trigger.status !== 202) {
				throw new Error(`Trickplay trigger failed: HTTP ${trigger.status} ${await trigger.text()}`);
			}

			const artifacts: ArtifactInfo[] = [];
			const deadline = Date.now() + 120_000;
			while (Date.now() < deadline) {
				await sleep(500);
				const found = await listArtifacts(server);
				if (found.length > 0) {
					artifacts.push(...found);
					break;
				}
			}

			const generationMs = performance.now() - triggerStartedAt;
			if (artifacts.length === 0) {
				console.error("[trickplay] no artifacts appeared within 120s — generation failed (check workers)");
				process.exitCode = 1;

				return;
			}

			printTable(
				"Trickplay generation (sample clip, end-to-end)",
				["wall clock", "artifacts", "total bytes"],
				[[fmtMs(generationMs), String(artifacts.length), fmtMb(artifacts.reduce((sum, artifact) => sum + (artifact.sizeBytes ?? 0), 0))]],
			);

			// ─── Phase 2: artifact serving throughput ───
			const servingLatencies: number[] = [];
			let servedBytes = 0;
			let servedErrors = 0;
			const servedAt = performance.now();
			const servingDeadline = servedAt + Math.min(args.durationMs, 8000);
			let index = 0;
			while (performance.now() < servingDeadline) {
				const artifact = artifacts[index % artifacts.length];
				index++;
				if (!artifact) break;

				const requestStartedAt = performance.now();
				try {
					const response = await fetch(`${server.baseUrl}/v1/media-files/${server.sampleMediaId}/artifacts/${artifact.id}`, {
						headers,
					});
					if (response.ok) servedBytes += (await response.arrayBuffer()).byteLength;
					else servedErrors++;
				} catch {
					servedErrors++;
				}

				servingLatencies.push(performance.now() - requestStartedAt);
			}

			const servingMs = performance.now() - servedAt;
			const stats = summarizeLatencies(servingLatencies);
			printTable(
				"Trickplay artifact serving",
				["req/s", "MB/s", "p50", "p95", "errors"],
				[
					[
						(servingLatencies.length / (servingMs / 1000)).toFixed(1),
						(servedBytes / (servingMs / 1000) / 1024 / 1024).toFixed(2),
						fmtMs(stats.p50Ms),
						fmtMs(stats.p95Ms),
						String(servedErrors),
					],
				],
			);
		} finally {
			if (!args.keepServer) {
				await server?.stop();
			}
		}
	});
}

await main(import.meta);
