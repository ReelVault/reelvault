import { expect, spyOn, test } from "bun:test";
import Elysia from "elysia";
import { systemResourcesService } from "@/system/system-resources.service";
import { InternalError } from "@/utils/errors";
import { domainErrorsMiddleware } from "./domain-errors.middleware";
import { requestDedupMiddleware } from "./request-dedup.middleware";

function createApp(handler?: () => string | Promise<string>, opts?: { deduplicate?: { enabled?: boolean } }) {
	return new Elysia().use(requestDedupMiddleware).get("/test", handler ?? (() => "ok"), { deduplicate: opts?.deduplicate ?? {} });
}

test("deduplicates concurrent GET requests with same URL and auth", async () => {
	let calls = 0;
	const app = createApp(async () => {
		calls++;
		await new Promise((resolve) => {
			setTimeout(resolve, 30);
		});

		return `result-${calls}`;
	});

	const req = new Request("http://localhost/test", {
		headers: { authorization: "Bearer token-a" },
	});

	const [a, b] = await Promise.all([app.handle(new Request(req.url, req)), app.handle(new Request(req.url, req))]);

	const bodyA = await a.text();
	const bodyB = await b.text();

	expect(bodyA).toBe(bodyB);
	expect(calls).toBe(1);
});

test("does not deduplicate different URLs", async () => {
	let calls = 0;
	const app = new Elysia()
		.use(requestDedupMiddleware)
		.get(
			"/a",
			async () => {
				calls++;
				await new Promise((resolve) => {
					setTimeout(resolve, 20);
				});

				return "a";
			},
			{ deduplicate: {} },
		)
		.get(
			"/b",
			async () => {
				calls++;
				await new Promise((resolve) => {
					setTimeout(resolve, 20);
				});

				return "b";
			},
			{ deduplicate: {} },
		);

	const [a, b] = await Promise.all([app.handle(new Request("http://localhost/a")), app.handle(new Request("http://localhost/b"))]);

	expect(calls).toBe(2);
	expect(a.status).toBe(200);
	expect(b.status).toBe(200);
});

test("does not deduplicate different authorization tokens", async () => {
	let calls = 0;
	const app = createApp(async () => {
		calls++;
		await new Promise((resolve) => {
			setTimeout(resolve, 20);
		});

		return "ok";
	});

	const results = await Promise.all([
		app.handle(new Request("http://localhost/test", { headers: { authorization: "Bearer token-a" } })),
		app.handle(new Request("http://localhost/test", { headers: { authorization: "Bearer token-b" } })),
	]);

	expect(calls).toBe(2);
	for (const r of results) expect(r.status).toBe(200);
});

test("does not deduplicate POST requests", async () => {
	let calls = 0;
	const app = new Elysia().use(requestDedupMiddleware).post(
		"/test",
		async () => {
			calls++;
			await new Promise((resolve) => {
				setTimeout(resolve, 20);
			});

			return "ok";
		},
		{ deduplicate: {} },
	);

	const postResults = await Promise.all([
		app.handle(new Request("http://localhost/test", { method: "POST" })),
		app.handle(new Request("http://localhost/test", { method: "POST" })),
	]);

	expect(calls).toBe(2);
	for (const r of postResults) expect(r.status).toBe(200);
});

test("cleans up in-flight tracking after handler completes", async () => {
	const app = createApp(() => "ok");

	await app.handle(new Request("http://localhost/test"));

	// Second request should not share state with first
	const res = await app.handle(new Request("http://localhost/test"));
	expect(res.status).toBe(200);
	expect(await res.text()).toBe("ok");
});

test("disabled per-route skips deduplication", async () => {
	let calls = 0;
	const app = new Elysia().use(requestDedupMiddleware).get(
		"/test",
		async () => {
			calls++;
			await new Promise((resolve) => {
				setTimeout(resolve, 20);
			});

			return "ok";
		},
		{ deduplicate: { enabled: false } },
	);

	const disabledResults = await Promise.all([
		app.handle(new Request("http://localhost/test")),
		app.handle(new Request("http://localhost/test")),
	]);

	expect(calls).toBe(2);
	for (const r of disabledResults) expect(r.status).toBe(200);
});

test("cleans up in-flight tracking when handler throws an error", async () => {
	let calls = 0;
	const app = new Elysia()
		.use(domainErrorsMiddleware)
		.use(requestDedupMiddleware)
		.get(
			"/error-test",
			async () => {
				calls++;
				await new Promise((resolve) => {
					setTimeout(resolve, 20);
				});
				throw new InternalError("Simulated failure");
			},
			{ deduplicate: {} },
		);

	const [resA, resB] = await Promise.all([
		app.handle(new Request("http://localhost/error-test")),
		app.handle(new Request("http://localhost/error-test")),
	]);

	expect(resA.status).toBe(500);
	expect(resB.status).toBe(500);
	expect(calls).toBe(1);

	// Next request must not hang or reuse broken state
	const nextRes = await app.handle(new Request("http://localhost/error-test"));
	expect(nextRes.status).toBe(500);
	expect(calls).toBe(2);
});

test("follower inherits the leader's error response without re-executing the handler", async () => {
	let calls = 0;
	const app = new Elysia()
		.use(domainErrorsMiddleware)
		.use(requestDedupMiddleware)
		.get(
			"/shared-error",
			async () => {
				calls++;
				await new Promise((resolve) => {
					setTimeout(resolve, 20);
				});
				throw new InternalError("Simulated failure");
			},
			{ deduplicate: {} },
		);

	const [resA, resB] = await Promise.all([
		app.handle(new Request("http://localhost/shared-error")),
		app.handle(new Request("http://localhost/shared-error")),
	]);

	expect(resA.status).toBe(500);
	expect(resB.status).toBe(500);
	expect(await resB.text()).toBe(await resA.text());
	expect(calls).toBe(1);
});

test("deduplicates oversized keys via the hash fallback", async () => {
	let calls = 0;
	const app = createApp(async () => {
		calls++;
		await new Promise((resolve) => {
			setTimeout(resolve, 30);
		});

		return `oversized-${calls}`;
	});

	// Composed key (path + auth + cookie) beyond rawKeyMaxLength — must still dedup.
	const giantCookie = `x=${"a".repeat(2200)}`;
	const [a, b] = await Promise.all([
		app.handle(new Request("http://localhost/test", { headers: { authorization: "Bearer token-a", cookie: giantCookie } })),
		app.handle(new Request("http://localhost/test", { headers: { authorization: "Bearer token-a", cookie: giantCookie } })),
	]);

	expect(await a.text()).toBe(await b.text());
	expect(calls).toBe(1);
});

test("does not deduplicate different x-profile-id headers", async () => {
	let calls = 0;
	const app = createApp(async () => {
		calls++;
		await new Promise((resolve) => {
			setTimeout(resolve, 30);
		});

		return `profile-${calls}`;
	});

	const [a, b] = await Promise.all([
		app.handle(new Request("http://localhost/test", { headers: { "x-profile-id": "profile-a" } })),
		app.handle(new Request("http://localhost/test", { headers: { "x-profile-id": "profile-b" } })),
	]);

	expect(calls).toBe(2);
	// Both executions ran; responses may share the counter shape but must not be shared state.
	expect(a.status).toBe(200);
	expect(b.status).toBe(200);
});

test("follower re-executes when the leader does not settle within the wait timeout", async () => {
	// waitTimeoutMs is a server.config getter scaled by CPU speed — stub the
	// scaler instead of assigning the readonly property.
	const spy = spyOn(systemResourcesService, "scaledTimeoutMs").mockReturnValue(30);
	let calls = 0;
	try {
		const app = createApp(async () => {
			calls++;
			await new Promise((resolve) => {
				setTimeout(resolve, 150);
			});

			return "slow-leader";
		});

		const results = await Promise.all([
			app.handle(new Request("http://localhost/test", { headers: { authorization: "Bearer slow" } })),
			app.handle(new Request("http://localhost/test", { headers: { authorization: "Bearer slow" } })),
		]);

		// The follower must not wait for the stuck leader: it executes normally.
		expect(calls).toBe(2);
		for (const r of results) expect(r.status).toBe(200);
	} finally {
		spy.mockRestore();
	}
});
