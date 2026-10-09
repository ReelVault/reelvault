import { expect, test } from "bun:test";
import { createTestClient, jsonResponse } from "../helpers/sdk-client";

test("media client lists the markers one page at a time", async () => {
	const requests: string[] = [];
	const client = createTestClient(
		(url) => {
			requests.push(url);

			return jsonResponse({ data: [], page: 2, limit: 50, total: 120, totalPages: 3 });
		},
		{ enableRetry: false },
	);

	const result = await client.media.getAllMarkers({ type: "intro", page: 2, limit: 50 });

	expect(result).toMatchObject({ page: 2, total: 120, totalPages: 3 });
	expect(requests).toEqual(["https://reelvault.test/v1/media-files/markers?type=intro&page=2&limit=50"]);
});
