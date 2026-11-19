export interface RecordedFetch {
	url: string;
	headers: Headers;
	method: string;
	body: BodyInit | null | undefined;
	tls: unknown;
}

function requestUrl(input: RequestInfo | URL): string {
	if (input instanceof URL) return input.href;
	if (typeof input === "string") return input;

	return input.url;
}

/**
 * Replaces global fetch with an offline stub that records every call and answers
 * it with `handler`. The caller restores `globalThis.fetch` in its afterEach.
 */
export function stubFetch(handler: (url: string) => Response = () => new Response("ok")): RecordedFetch[] {
	const calls: RecordedFetch[] = [];
	globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
		const url = requestUrl(input);
		calls.push({
			url,
			headers: new Headers(init?.headers),
			method: init?.method ?? "GET",
			body: init?.body,
			tls: (init as { tls?: unknown } | undefined)?.tls,
		});

		return Promise.resolve(handler(url));
	}) as typeof fetch;

	return calls;
}
