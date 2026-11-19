import { afterEach, beforeEach, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { domainErrorsMiddleware } from "@/api/middleware/domain-errors.middleware";
import { serverConfig } from "@/config/server/server.config";
import { systemSettingsStore } from "@/config/system-settings.store";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { stubSignedInSession } from "../../../../tests/helpers/better-auth-session.helper";
import type { MethodStub } from "../../../../tests/helpers/method-stub.helper";
import { useTestDatabase } from "../../../../tests/helpers/test-database.helper";

const [{ adminSettingsRoutes }, { systemSettingsService }] = await Promise.all([
	import("./admin-settings.routes"),
	import("@/services/admin/system-settings.service"),
]);

useTestDatabase();

beforeEach(async () => {
	// The audit row written by a PATCH references the acting administrator.
	await databaseFactory
		.getClient()
		.insert(schema.users)
		.values({ id: "admin-1", name: "Admin", email: "admin@example.com", emailVerified: true });
});

const app = new Elysia().use(domainErrorsMiddleware).use(adminSettingsRoutes);

const stubs: MethodStub[] = [];

afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
	// PATCH tests write runtime settings (e.g. ffmpeg.hwaccel=nvenc) into the
	// shared store — leaking them changes transcode behaviour for every later
	// test file in the same run.
	systemSettingsStore.clearRuntimeValues();
});

test("admin settings endpoint rejects unauthenticated requests", async () => {
	const response = await app.handle(new Request("http://localhost/settings"));
	expect(response.status).toBe(401);
});

test("admin settings endpoint returns grouped settings for authorized admin", async () => {
	stubs.push(stubSignedInSession("admin-1", "admin"));

	const response = await app.handle(
		new Request("http://localhost/settings", {
			headers: { authorization: "Bearer admin" },
		}),
	);

	expect(response.status).toBe(200);
	const data = await response.json();
	expect(data.streaming).toContainEqual(expect.objectContaining({ key: "stream.maxSessions", value: 5, isCustom: false }));
});

test("admin settings PATCH applies and stores the new values", async () => {
	stubs.push(stubSignedInSession("admin-1", "admin"));

	const response = await app.handle(
		new Request("http://localhost/settings", {
			method: "PATCH",
			headers: {
				authorization: "Bearer admin",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				"stream.maxSessions": 8,
				"ffmpeg.hwaccel": "nvenc",
			}),
		}),
	);

	expect(response.status).toBe(200);
	expect(systemSettingsService.get("stream.maxSessions")).toBe(8);
	expect(systemSettingsService.get("ffmpeg.hwaccel")).toBe("nvenc");

	const stored = await databaseFactory.getClient().select().from(schema.systemSettings).all();
	expect(stored).toContainEqual(expect.objectContaining({ key: "stream.maxSessions", value: "8", lastModifiedBy: "admin-1" }));
});

test("serverConfig.paths dynamically reflects runtime setting updates for transcodes, downloads, backups", async () => {
	stubs.push(stubSignedInSession("admin-1", "admin"));

	const response = await app.handle(
		new Request("http://localhost/settings", {
			method: "PATCH",
			headers: {
				authorization: "Bearer admin",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				"paths.transcodes": "/custom/path/transcodes",
				"paths.downloads": "/custom/path/downloads",
				"paths.backups": "/custom/path/backups",
			}),
		}),
	);

	expect(response.status).toBe(200);
	expect(systemSettingsService.get("paths.transcodes")).toBe("/custom/path/transcodes");
	expect(systemSettingsService.get("paths.downloads")).toBe("/custom/path/downloads");
	expect(systemSettingsService.get("paths.backups")).toBe("/custom/path/backups");

	expect(serverConfig.paths.transcodes).toBe("/custom/path/transcodes");
	expect(serverConfig.paths.downloads).toBe("/custom/path/downloads");
	expect(serverConfig.paths.backups).toBe("/custom/path/backups");
});
