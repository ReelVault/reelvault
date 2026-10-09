import { expect, test } from "bun:test";
import { createTestClient, jsonResponse } from "../helpers/sdk-client";

test("notifications client removes one notification or a batch from the caller's list", async () => {
	const requests: Array<{ url: string; method: string; body?: string | undefined }> = [];
	const client = createTestClient(
		(url, init) => {
			requests.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });

			return jsonResponse({ deleted: 1 });
		},
		{ enableRetry: false },
	);

	expect(await client.notifications.delete("n-1")).toEqual({ deleted: 1 });
	expect(await client.notifications.deleteMany(["n-2", "n-3"])).toEqual({ deleted: 1 });

	expect(requests).toEqual([
		{ url: "https://reelvault.test/v1/notifications/n-1", method: "DELETE" },
		{ url: "https://reelvault.test/v1/notifications/delete", method: "POST", body: JSON.stringify({ ids: ["n-2", "n-3"] }) },
	]);
});
