import { expect, test } from "bun:test";
import { Elysia } from "elysia";
import { domainErrorsMiddleware } from "@/api/middleware/domain-errors.middleware";

const { playbackSessionsRoutes } = await import("./playback-sessions.routes");
const app = new Elysia().use(domainErrorsMiddleware).use(playbackSessionsRoutes);

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
