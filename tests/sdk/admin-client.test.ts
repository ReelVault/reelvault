import { expect, test } from "bun:test";
import { ReelVaultClient } from "@sdk/client";

test("admin client reads plugin diagnostics through the versioned API", async () => {
	const requestedUrls: string[] = [];
	const client = new ReelVaultClient({
		baseUrl: "https://reelvault.test/v1",
		enableRetry: false,
		fetcher: (url) => {
			requestedUrls.push(String(url));

			return Promise.resolve(
				new Response(
					JSON.stringify([
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
					]),
					{ headers: { "content-type": "application/json" } },
				),
			);
		},
	});

	await expect(client.admin.getPlugins()).resolves.toMatchObject([{ id: "org.example.catalog", failurePhase: "config" }]);
	expect(requestedUrls).toEqual(["https://reelvault.test/v1/admin/plugins"]);
});

test("admin client handles download jobs overview and deletion", async () => {
	const requests: Array<{ url: string; method: string }> = [];
	const client = new ReelVaultClient({
		baseUrl: "https://reelvault.test/v1",
		enableRetry: false,
		fetcher: (url, init) => {
			requests.push({ url: String(url), method: init?.method ?? "GET" });
			if (init?.method === "DELETE") {
				return Promise.resolve(new Response(JSON.stringify({ success: true }), { headers: { "content-type": "application/json" } }));
			}

			return Promise.resolve(
				new Response(
					JSON.stringify({
						jobs: [
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
					}),
					{ headers: { "content-type": "application/json" } },
				),
			);
		},
	});

	const response = await client.admin.getDownloadJobs();
	expect(response.jobs).toHaveLength(1);
	expect(response.jobs[0]?.id).toBe("job-1");
	expect(response.jobs[0]?.profileId).toBe("profile-1");

	const deleteResult = await client.admin.deleteDownloadJob("job-1");
	expect(deleteResult.success).toBe(true);

	expect(requests).toEqual([
		{ url: "https://reelvault.test/v1/admin/downloads/jobs", method: "GET" },
		{ url: "https://reelvault.test/v1/admin/downloads/jobs/job-1", method: "DELETE" },
	]);
});
