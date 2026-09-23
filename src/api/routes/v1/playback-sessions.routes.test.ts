import { afterEach, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { domainErrorsMiddleware } from "@/middleware/domain-errors.middleware";

process.env.BETTER_AUTH_SECRET ??= "test-secret-with-at-least-32-characters";
const [{ playbackSessionsRoutes }, { auth }] = await Promise.all([
	import("./playback-sessions.routes"),
	import("@/integrations/better-auth/better-auth.config"),
]);
const app = new Elysia().use(domainErrorsMiddleware).use(playbackSessionsRoutes);

const originalGetSession = auth.api.getSession;
afterEach(() => {
	auth.api.getSession = originalGetSession;
});

test("playback session routes compile with distinct playlist and segment resources", () => {
	expect(() => playbackSessionsRoutes.compile()).not.toThrow();
});

test("playback session creation rejects a body without mediaFileId", async () => {
	const response = await app.handle(
		new Request("http://localhost/playback-sessions", {
			method: "POST",
			headers: { "content-type": "application/json", "idempotency-key": "test-idempotency-key" },
			body: JSON.stringify({}),
		}),
	);

	expect(response.status).toBe(400);
	expect(((await response.json()) as { code: string }).code).toBe("validation.invalid_request");
});

test("playback session creation rejects a missing idempotency key", async () => {
	const response = await app.handle(
		new Request("http://localhost/playback-sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ mediaFileId: "file-1" }),
		}),
	);

	expect(response.status).toBe(400);
	expect(((await response.json()) as { code: string }).code).toBe("validation.invalid_request");
});
