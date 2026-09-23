import { expect, test } from "bun:test";
import { ReelVaultClient } from "@sdk/client";

test("media and people clients expose all related API routes", async () => {
	const requests: string[] = [];
	const client = new ReelVaultClient({
		baseUrl: "https://reelvault.test/v1",
		enableRetry: false,
		fetcher: (url, init) => {
			requests.push(`${init?.method ?? "GET"} ${String(url)}`);
			const isBulkRefresh = String(url).endsWith("/media-files/refresh");

			return Promise.resolve(
				json({
					success: true,
					operationId: isBulkRefresh ? "operation-bulk" : "operation-single",
					status: "pending",
				}),
			);
		},
	});

	await expect(client.media.refresh("file-1")).resolves.toMatchObject({ operationId: "operation-single", status: "pending" });
	await expect(client.media.refreshAll()).resolves.toMatchObject({ operationId: "operation-bulk", status: "pending" });
	expect(requests).toEqual([
		"POST https://reelvault.test/v1/media-files/file-1/refresh",
		"POST https://reelvault.test/v1/media-files/refresh",
	]);
});

function json(value: unknown): Response {
	return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}
