import { afterEach, expect, test } from "bun:test";
import Elysia from "elysia";
import { systemResourcesService } from "@/config/system-resources.service";
import { DomainError } from "@/utils/domain.errors";
import { type MethodStub, stubMethod } from "../../../../tests/helpers/method-stub.helper";
import { domainErrorsMiddleware } from "./domain-errors.middleware";
import { requestDedupMiddleware } from "./request-dedup.middleware";

// Concurrency is driven by gates instead of sleeps: a handler parks on `release`
// until the test has issued the competing request and let pending microtasks run.
function gate() {
	let open!: () => void;
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});

	return { promise, open };
}

// One macrotask turn: every hook of an already-issued request runs on microtasks, so
// after this a follower has either joined the in-flight leader or it has not.
function settle(): Promise<void> {
	return new Promise((resolve) => {
		setImmediate(resolve);
	});
}

const stubs: MethodStub[] = [];

afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

function createApp(handler?: () => string | Promise<string>, options?: { deduplicate?: { enabled?: boolean } }) {
	return new Elysia().use(requestDedupMiddleware).get("/test", handler ?? (() => "ok"), { deduplicate: options?.deduplicate ?? {} });
}

test("concurrent GETs with the same URL and credentials share one execution and one body", async () => {
	const release = gate();
	let calls = 0;
	const app = createApp(async () => {
		calls++;
		await release.promise;

		return `result-${calls}`;
	});

	const req = () => app.handle(new Request("http://localhost/test", { headers: { authorization: "Bearer token-a" } }));
	const leader = req();
	const follower = req();
	await settle();
	release.open();

	const [a, b] = await Promise.all([leader, follower]);
	expect(await a.text()).toBe("result-1");
	expect(await b.text()).toBe("result-1");
	expect(calls).toBe(1);
});

test("does not share a response between different URLs", async () => {
	const release = gate();
	let calls = 0;
	const handler = async (body: string) => {
		calls++;
		await release.promise;

		return body;
	};
	const app = new Elysia()
		.use(requestDedupMiddleware)
		.get("/a", () => handler("a"), { deduplicate: {} })
		.get("/b", () => handler("b"), { deduplicate: {} });

	const a = app.handle(new Request("http://localhost/a"));
	const b = app.handle(new Request("http://localhost/b"));
	await settle();
	release.open();

	expect(await (await a).text()).toBe("a");
	expect(await (await b).text()).toBe("b");
	expect(calls).toBe(2);
});

test("does not share a response between different authorization tokens", async () => {
	const release = gate();
	let calls = 0;
	const app = new Elysia().use(requestDedupMiddleware).get(
		"/test",
		async ({ request }) => {
			calls++;
			await release.promise;

			return request.headers.get("authorization");
		},
		{ deduplicate: {} },
	);

	const a = app.handle(new Request("http://localhost/test", { headers: { authorization: "Bearer token-a" } }));
	const b = app.handle(new Request("http://localhost/test", { headers: { authorization: "Bearer token-b" } }));
	await settle();
	release.open();

	expect(await (await a).text()).toBe("Bearer token-a");
	expect(await (await b).text()).toBe("Bearer token-b");
	expect(calls).toBe(2);
});

test("does not share a response between different API keys", async () => {
	const release = gate();
	let calls = 0;
	const app = new Elysia().use(requestDedupMiddleware).get(
		"/test",
		async ({ request }) => {
			calls++;
			await release.promise;

			return request.headers.get("x-api-key");
		},
		{ deduplicate: {} },
	);

	const a = app.handle(new Request("http://localhost/test", { headers: { "x-api-key": "rv_key-a" } }));
	const b = app.handle(new Request("http://localhost/test", { headers: { "x-api-key": "rv_key-b" } }));
	await settle();
	release.open();

	expect(await (await a).text()).toBe("rv_key-a");
	expect(await (await b).text()).toBe("rv_key-b");
	expect(calls).toBe(2);
});

test("does not share a response between different x-profile-id headers", async () => {
	const release = gate();
	let calls = 0;
	const app = new Elysia().use(requestDedupMiddleware).get(
		"/test",
		async ({ request }) => {
			calls++;
			await release.promise;

			return request.headers.get("x-profile-id");
		},
		{ deduplicate: {} },
	);

	const a = app.handle(new Request("http://localhost/test", { headers: { "x-profile-id": "profile-a" } }));
	const b = app.handle(new Request("http://localhost/test", { headers: { "x-profile-id": "profile-b" } }));
	await settle();
	release.open();

	expect(await (await a).text()).toBe("profile-a");
	expect(await (await b).text()).toBe("profile-b");
	expect(calls).toBe(2);
});

test("POST requests are never shared, even when concurrent with the same URL", async () => {
	const release = gate();
	let calls = 0;
	const app = new Elysia().use(requestDedupMiddleware).post(
		"/test",
		async () => {
			calls++;
			await release.promise;

			return "ok";
		},
		{ deduplicate: {} },
	);

	const first = app.handle(new Request("http://localhost/test", { method: "POST" }));
	const second = app.handle(new Request("http://localhost/test", { method: "POST" }));
	await settle();
	release.open();

	expect((await first).status).toBe(200);
	expect((await second).status).toBe(200);
	expect(calls).toBe(2);
});

test("a request issued after the leader completed runs the handler again", async () => {
	let calls = 0;
	const app = createApp(() => `run-${++calls}`);

	expect(await (await app.handle(new Request("http://localhost/test"))).text()).toBe("run-1");
	expect(await (await app.handle(new Request("http://localhost/test"))).text()).toBe("run-2");
	expect(calls).toBe(2);
});

test("per-route deduplicate enabled: false runs every concurrent request", async () => {
	const release = gate();
	let calls = 0;
	const app = new Elysia().use(requestDedupMiddleware).get(
		"/test",
		async () => {
			calls++;
			await release.promise;

			return "ok";
		},
		{ deduplicate: { enabled: false } },
	);

	const first = app.handle(new Request("http://localhost/test"));
	const second = app.handle(new Request("http://localhost/test"));
	await settle();
	release.open();

	expect((await first).status).toBe(200);
	expect((await second).status).toBe(200);
	expect(calls).toBe(2);
});

test("a failing leader hands its error response to concurrent followers without re-running the handler", async () => {
	const release = gate();
	let calls = 0;
	const app = new Elysia()
		.use(domainErrorsMiddleware)
		.use(requestDedupMiddleware)
		.get(
			"/shared-error",
			async () => {
				calls++;
				await release.promise;
				throw new DomainError("internal", "Simulated failure");
			},
			{ deduplicate: {} },
		);

	const leader = app.handle(new Request("http://localhost/shared-error"));
	const follower = app.handle(new Request("http://localhost/shared-error"));
	await settle();
	release.open();

	const [leaderRes, followerRes] = await Promise.all([leader, follower]);
	expect(leaderRes.status).toBe(500);
	expect(followerRes.status).toBe(500);
	expect(await followerRes.text()).toBe(await leaderRes.text());
	expect(calls).toBe(1);
});

test("a request issued after a failing leader runs the handler again", async () => {
	let calls = 0;
	const app = new Elysia()
		.use(domainErrorsMiddleware)
		.use(requestDedupMiddleware)
		.get(
			"/error-test",
			() => {
				calls++;
				throw new DomainError("internal", "Simulated failure");
			},
			{ deduplicate: {} },
		);

	expect((await app.handle(new Request("http://localhost/error-test"))).status).toBe(500);
	expect((await app.handle(new Request("http://localhost/error-test"))).status).toBe(500);
	expect(calls).toBe(2);
});

test("oversized composed keys are hashed and still deduplicate concurrent requests", async () => {
	const release = gate();
	let calls = 0;
	const app = createApp(async () => {
		calls++;
		await release.promise;

		return "oversized";
	});

	// Composed key (path + auth + cookie) beyond rawKeyMaxLength — must still dedup.
	const giantCookie = `x=${"a".repeat(2200)}`;
	const headers = { authorization: "Bearer token-a", cookie: giantCookie };
	const leader = app.handle(new Request("http://localhost/test", { headers }));
	const follower = app.handle(new Request("http://localhost/test", { headers }));
	await settle();
	release.open();

	expect(await (await leader).text()).toBe("oversized");
	expect(await (await follower).text()).toBe("oversized");
	expect(calls).toBe(1);
});

test("a follower runs the handler itself when the leader does not settle within the wait timeout", async () => {
	stubs.push(stubMethod(systemResourcesService, "scaledTimeoutMs", () => 30));
	const release = gate();
	const bothEntered = gate();
	let calls = 0;
	const app = createApp(async () => {
		const run = ++calls;
		if (run === 2) bothEntered.open();
		await release.promise;

		return `run-${run}`;
	});

	const headers = { authorization: "Bearer slow" };
	const leader = app.handle(new Request("http://localhost/test", { headers }));
	const follower = app.handle(new Request("http://localhost/test", { headers }));
	// The follower only enters the handler after the wait timeout expired on the stuck leader.
	await bothEntered.promise;
	release.open();

	expect(await (await leader).text()).toBe("run-1");
	expect(await (await follower).text()).toBe("run-2");
	expect(calls).toBe(2);
});
