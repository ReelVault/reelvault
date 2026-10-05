import { expect, test } from "bun:test";
import { createTestClient, jsonResponse } from "../helpers/sdk-client";

test("media and people clients expose all related API routes", async () => {
	const requests: string[] = [];
	const client = createTestClient(
		(url, init) => {
			requests.push(`${init?.method ?? "GET"} ${url}`);
			const isBulkRefresh = url.endsWith("/media-files/refresh");

			return jsonResponse({
				success: true,
				operationId: isBulkRefresh ? "operation-bulk" : "operation-single",
				status: "pending",
			});
		},
		{ enableRetry: false },
	);

	await expect(client.media.refresh("file-1")).resolves.toMatchObject({ operationId: "operation-single", status: "pending" });
	await expect(client.media.refreshAll()).resolves.toMatchObject({ operationId: "operation-bulk", status: "pending" });
	expect(requests).toEqual([
		"POST https://reelvault.test/v1/media-files/file-1/refresh",
		"POST https://reelvault.test/v1/media-files/refresh",
	]);
});
