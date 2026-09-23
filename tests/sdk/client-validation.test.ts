import { describe, expect, test } from "bun:test";
import type { ResourceConfig } from "@reelvault/sdk/client";
import { assertValidPath, BaseResource, ReelVaultValidationError } from "@reelvault/sdk/client";

// The SDK client is a thin transport: payload validation lives on the server
// contract. Only path interpolation is guarded client-side.

class TestResource extends BaseResource {
	post<T>(body: unknown): Promise<T> {
		return this._post<T>("/transport", { body });
	}
}

function createResource(overrides: Partial<ResourceConfig> = {}): TestResource {
	return new TestResource({
		baseUrl: "https://reelvault.test",
		fetcher: async () => new Response(JSON.stringify({ success: true }), { headers: { "content-type": "application/json" } }),
		defaultHeaders: {},
		requestInterceptors: [],
		responseInterceptors: [],
		enableRetry: false,
		maxRetries: 0,
		timeout: 1000,
		credentials: "same-origin",
		...overrides,
	});
}

describe("SDK client path validation", () => {
	test("rejects a path interpolated with a missing parameter", () => {
		expect(() => assertValidPath(`/media-files/undefined/markers`)).toThrow(ReelVaultValidationError);
		expect(() => assertValidPath(`/media-files/null/markers`)).toThrow(ReelVaultValidationError);
	});

	test("accepts concrete paths", () => {
		expect(() => assertValidPath("/media-files/file-123/markers")).not.toThrow();
	});
});

describe("SDK client transport", () => {
	test("forwards raw bodies without pre-send validation", async () => {
		let sent: string | undefined;
		const resource = createResource({
			fetcher: (_url, options) => {
				sent = options.body as string;

				return Promise.resolve(new Response(JSON.stringify({ success: true }), { headers: { "content-type": "application/json" } }));
			},
		});

		// Invalid payloads are forwarded as-is — the server contract rejects them.
		await resource.post({ name: "x", email: "not-an-email" });

		expect(JSON.parse(sent as string)).toEqual({ name: "x", email: "not-an-email" });
	});
});
