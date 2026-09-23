import { describe, expect, test } from "bun:test";
import { BaseResource } from "@sdk/client/core/base-resource";
import { NetworkError, ReelVaultError } from "@sdk/client/core/errors";
import type { ResourceConfig } from "@sdk/client/core/types";

class TestResource extends BaseResource {
	execute<T>(options: RequestInit): Promise<T> {
		return this.request<T>("/transport", options);
	}

	post<T>(body: unknown): Promise<T> {
		return this._post<T>("/transport", { body });
	}
}

function createResource(fetcher: ResourceConfig["fetcher"], overrides: Partial<ResourceConfig> = {}): TestResource {
	return new TestResource({
		baseUrl: "https://reelvault.test",
		fetcher,
		defaultHeaders: {},
		requestInterceptors: [],
		responseInterceptors: [],
		enableRetry: true,
		maxRetries: 1,
		timeout: 20,
		credentials: "same-origin",
		...overrides,
	});
}

describe("SDK client transport", () => {
	test("preserves a caller abort instead of reporting a timeout", async () => {
		const controller = new AbortController();
		const abortReason = new Error("caller cancelled request");
		controller.abort(abortReason);
		const resource = createResource(async (_url, options) => {
			return await new Promise<Response>((_resolve, reject) => {
				options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
			});
		});

		await expect(resource.execute({ method: "GET", signal: controller.signal })).rejects.toBe(abortReason);
	});

	test("parses empty, textual, and binary successful responses", async () => {
		const responses = [
			new Response(null, { status: 200 }),
			new Response("ready", { headers: { "content-type": "text/plain" } }),
			new Response(new Uint8Array([1, 2]), { headers: { "content-type": "application/octet-stream" } }),
		];
		const resource = createResource(async () => responses.shift() ?? new Response(null, { status: 500 }));

		await expect(resource.execute<undefined>({ method: "GET" })).resolves.toBeUndefined();
		await expect(resource.execute<string>({ method: "GET" })).resolves.toBe("ready");
		const binary = await resource.execute<Blob>({ method: "GET" });
		expect([...new Uint8Array(await binary.arrayBuffer())]).toEqual([1, 2]);
	});

	test("does not retry a non-idempotent request without an idempotency key", async () => {
		let attempts = 0;
		const resource = createResource(() => {
			attempts++;

			return Promise.resolve(
				new Response(JSON.stringify({ message: "unavailable" }), { status: 503, headers: { "content-type": "application/json" } }),
			);
		});

		await expect(resource.execute({ method: "POST", body: "{}" })).rejects.toBeInstanceOf(ReelVaultError);
		expect(attempts).toBe(1);
	});

	test("serializes false, zero, and null request bodies", async () => {
		const bodies: Array<RequestInit["body"]> = [];
		const resource = createResource((_url, options) => {
			bodies.push(options.body);

			return Promise.resolve(new Response(JSON.stringify({ success: true }), { headers: { "content-type": "application/json" } }));
		});

		await resource.post(false);
		await resource.post(0);
		await resource.post(null);

		expect(bodies).toEqual(["false", "0", "null"]);
	});

	test("passes multipart bodies through without forcing JSON headers", async () => {
		let received: RequestInit | undefined;
		const resource = createResource((_url, options) => {
			received = options;

			return Promise.resolve(new Response(JSON.stringify({ success: true }), { headers: { "content-type": "application/json" } }));
		});
		const body = new FormData();
		body.set("type", "poster");
		body.set("file", new Blob(["image"]), "poster.png");

		await resource.post(body);

		expect(received?.body).toBe(body);
		expect(new Headers(received?.headers).has("content-type")).toBe(false);
	});

	test("does not deduplicate concurrent GET requests made with different access tokens", async () => {
		let requests = 0;
		const resource = createResource(async () => {
			requests++;
			await new Promise((resolve) => {
				setTimeout(resolve, 5);
			});

			return new Response(JSON.stringify({ request: requests }), { headers: { "content-type": "application/json" } });
		});

		resource.setAccessToken("token-a");
		const first = resource.execute({ method: "GET" });
		resource.setAccessToken("token-b");
		const second = resource.execute({ method: "GET" });
		await Promise.all([first, second]);

		expect(requests).toBe(2);
	});

	test("includes request metadata and params in API errors and wraps only network failures", async () => {
		const resource = createResource(() => {
			return Promise.resolve(
				new Response(JSON.stringify({ statusCode: 404, code: "library_not_found", params: { libraryId: "lib-1" } }), {
					status: 404,
					headers: { "content-type": "application/json", "x-request-id": "request-123" },
				}),
			);
		});

		await expect(resource.execute({ method: "GET" })).rejects.toMatchObject({
			status: 404,
			code: "library_not_found",
			params: { libraryId: "lib-1" },
			requestId: "request-123",
		});

		const broken = createResource(
			() => {
				throw new Error("offline");
			},
			{ enableRetry: false },
		);
		await expect(broken.execute({ method: "GET" })).rejects.toBeInstanceOf(NetworkError);
	});
});
