import { expect, test } from "bun:test";
import { createTestClient, jsonResponse } from "../helpers/sdk-client";

test("admin client reads plugin diagnostics through the versioned API", async () => {
	const requestedUrls: string[] = [];
	const client = createTestClient(
		(url) => {
			requestedUrls.push(url);

			return jsonResponse([
				{
					id: "org.example.catalog",
					name: "Catalog",
					version: "1.0.0",
					state: "failed",
					providers: 0,
					subtitleProviders: 0,
					jobs: 0,
					failurePhase: "config",
				},
			]);
		},
		{ enableRetry: false },
	);

	await expect(client.admin.getPlugins()).resolves.toMatchObject([{ id: "org.example.catalog", failurePhase: "config" }]);
	expect(requestedUrls).toEqual(["https://reelvault.test/v1/admin/plugins"]);
});

test("admin client pauses and resumes schedules, retries failed jobs and reads the watchdog", async () => {
	const requests: Array<{ url: string; method: string; body?: string | undefined }> = [];
	const client = createTestClient(
		(url, init) => {
			requests.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
			if (url.endsWith("/enabled")) return jsonResponse({ workerId: "library-scan", enabled: false, nextRunAt: null });
			if (url.endsWith("/retry")) return jsonResponse({ success: true, jobId: "job-2" });

			return jsonResponse({
				running: true,
				consecutiveFailures: 0,
				restarts: 0,
				elapsedSinceLastPollMs: 120,
				lastPollAt: "2026-10-09T10:00:00.000Z",
				recoveredJobs: 2,
			});
		},
		{ enableRetry: false },
	);

	expect(await client.admin.setWorkerScheduleEnabled("library-scan", false)).toEqual({
		workerId: "library-scan",
		enabled: false,
		nextRunAt: null,
	});
	expect(await client.admin.retryWorkerJob("job-1")).toEqual({ success: true, jobId: "job-2" });
	expect((await client.admin.getWorkerWatchdog()).recoveredJobs).toBe(2);

	expect(requests).toEqual([
		{ url: "https://reelvault.test/v1/admin/workers/library-scan/enabled", method: "PUT", body: JSON.stringify({ enabled: false }) },
		{ url: "https://reelvault.test/v1/admin/workers/jobs/job-1/retry", method: "POST" },
		{ url: "https://reelvault.test/v1/admin/workers/watchdog", method: "GET" },
	]);
});

test("admin client queues a trickplay regeneration and reads its report", async () => {
	const requests: Array<{ url: string; method: string; body?: string | undefined }> = [];
	const client = createTestClient(
		(url, init) => {
			requests.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
			if (url.endsWith("/regenerate")) {
				return jsonResponse({ operationId: "op-1", matching: 3, enqueued: 2, remaining: 1 });
			}

			return jsonResponse({
				operationId: "op-1",
				total: 2,
				generated: 1,
				skippedStorageBudget: 1,
				skippedOther: 0,
				failed: 0,
				cancelled: 0,
				unfinished: 0,
			});
		},
		{ enableRetry: false },
	);

	expect(await client.admin.regenerateTrickplay({ scope: "library", id: "lib-movies", force: true })).toEqual({
		operationId: "op-1",
		matching: 3,
		enqueued: 2,
		remaining: 1,
	});
	expect((await client.admin.getTrickplayRegenerationReport("op-1")).skippedStorageBudget).toBe(1);

	expect(requests).toEqual([
		{
			url: "https://reelvault.test/v1/admin/trickplay/regenerate",
			method: "POST",
			body: JSON.stringify({ scope: "library", id: "lib-movies", force: true }),
		},
		{ url: "https://reelvault.test/v1/admin/trickplay/operations/op-1/report", method: "GET" },
	]);
});

test("admin client handles download jobs overview and deletion", async () => {
	const requests: Array<{ url: string; method: string }> = [];
	const client = createTestClient(
		(url, init) => {
			requests.push({ url, method: init?.method ?? "GET" });
			if (init?.method === "DELETE") {
				return jsonResponse({ success: true });
			}

			return jsonResponse({
				page: 1,
				limit: 50,
				total: 1,
				totalPages: 1,
				counts: { pending: 0, processing: 0, completed: 1, failed: 0, cancelled: 0 },
				data: [
					{
						id: "job-1",
						profileId: "profile-1",
						mediaFileId: "media-1",
						quality: "720p-mobile",
						status: "completed",
						progressPercent: 100,
						sizeBytes: 1048576,
						fileName: "test.mp4",
						downloadUrl: "/v1/downloads/job-1/file",
						errorText: null,
						createdAt: "2026-09-11T00:00:00.000Z",
						updatedAt: "2026-09-11T00:01:00.000Z",
					},
				],
			});
		},
		{ enableRetry: false },
	);

	const response = await client.admin.getDownloadJobs({ page: 1, status: "completed" });
	expect(response.data).toHaveLength(1);
	expect(response.data[0]?.id).toBe("job-1");
	expect(response.data[0]?.profileId).toBe("profile-1");
	expect(response.counts.completed).toBe(1);

	const deleteResult = await client.admin.deleteDownloadJob("job-1");
	expect(deleteResult.success).toBe(true);

	expect(requests).toEqual([
		{ url: "https://reelvault.test/v1/admin/downloads/jobs?page=1&status=completed", method: "GET" },
		{ url: "https://reelvault.test/v1/admin/downloads/jobs/job-1", method: "DELETE" },
	]);
});
