import { describe, expect, test } from "bun:test";
import { type ImageQuery, ReelVaultClient } from "@reelvault/sdk";

describe("SDK images resource", () => {
	test("serializes the shared image optimization query for downloads and URLs", async () => {
		const requests: string[] = [];
		const client = new ReelVaultClient({
			baseUrl: "https://reelvault.test",
			fetcher: (url) => {
				requests.push(url);

				return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/webp" } }));
			},
		});
		const query = { width: 640, height: 360, quality: 60 } satisfies ImageQuery;

		const image = await client.images.getById("image-1", query);

		expect(await image.arrayBuffer()).toEqual(new Uint8Array([1, 2, 3]).buffer);
		expect(requests).toEqual(["https://reelvault.test/v1/images/image-1?width=640&height=360&quality=60"]);
		expect(client.images.getUrlById("image-1", query)).toBe(requests[0]!);
	});
});
