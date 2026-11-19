import { afterEach, beforeEach, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { domainErrorsMiddleware } from "@/api/middleware/domain-errors.middleware";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { sessionLifecycleService } from "@/modules/streaming/sessions/session-lifecycle.service";
import { profilesRepository } from "@/repositories/profiles.repository";
import { pluginAccessBus } from "@/system/extensions/plugin.access";
import { stubSignedInSession } from "../../../../tests/helpers/better-auth-session.helper";
import { type MethodStub, stubMethod } from "../../../../tests/helpers/method-stub.helper";
import { useTestDatabase } from "../../../../tests/helpers/test-database.helper";

const { playbackSessionsRoutes } = await import("./playback-sessions.routes");
const app = new Elysia().use(domainErrorsMiddleware).use(playbackSessionsRoutes);
const { client } = useTestDatabase();

const stubs: MethodStub[] = [];
const unregisterPolicies: Array<() => void> = [];

beforeEach(async () => {
	profilesRepository.invalidateCached("profile-1");
	await client().insert(schema.users).values({ id: "user-1", name: "User", email: "user@example.com", emailVerified: true });
	await client().insert(schema.profiles).values({ id: "profile-1", userId: "user-1", name: "Ada" });
});

afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
	for (const unregister of unregisterPolicies.splice(0)) unregister();
	profilesRepository.invalidateCached("profile-1");
});

test("playlist is refused when the stream-access policy denies the session's media", async () => {
	stubs.push(stubSignedInSession("user-1"));
	// The session is live and owned by profile-1; only the policy refuses it.
	stubs.push(stubMethod(sessionLifecycleService, "getSessionAccess", () => ({ mediaFileId: "media-file-1", profileId: "profile-1" })));
	unregisterPolicies.push(
		pluginAccessBus.register("test-plugin", {
			id: "region-block",
			beforeAccess: () => ({ allowed: false, code: "stream.region_blocked", message: "Not available in your region" }),
		}),
	);

	const response = await app.handle(
		new Request("http://localhost/playback-sessions/session-1/playlist", {
			headers: { authorization: "Bearer test", "x-profile-id": "profile-1" },
		}),
	);

	expect(response.status).toBe(403);
	expect(await response.json()).toMatchObject({ code: "stream.region_blocked" });
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
