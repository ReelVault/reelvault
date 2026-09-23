import { afterEach, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { systemSettingsStore } from "@/config/system-settings.store";
import { domainErrorsMiddleware } from "@/middleware/domain-errors.middleware";
import { serverConfig } from "@/server.config";

process.env.BETTER_AUTH_SECRET ??= "test-secret-with-at-least-32-characters";

const [{ adminSettingsRoutes }, { auth }, { systemSettingsService }, { adminAuditService }, { databaseFactory }] = await Promise.all([
	import("./admin-settings.routes"),
	import("@/integrations/better-auth/better-auth.config"),
	import("@/application/admin/system-settings.service"),
	import("@/application/admin/admin-audit.service"),
	import("@/database/database"),
]);

// The runtime migrator owns this table in production; this suite runs against a
// bare per-process test DB, so create the one table it exercises.
databaseFactory.sqlite.run(`CREATE TABLE IF NOT EXISTS "system_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"created_at" integer NOT NULL,
	"updated_at" integer NOT NULL
)`);

adminAuditService.record = async () => {
	// intentionally empty
};

const app = new Elysia().use(domainErrorsMiddleware).use(adminSettingsRoutes);

const originalGetSession = auth.api.getSession;
const originalUserHasPermission = auth.api.userHasPermission;

afterEach(() => {
	auth.api.getSession = originalGetSession;
	auth.api.userHasPermission = originalUserHasPermission;
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
	auth.api.getSession = (async () =>
		({
			user: {
				id: "admin-1",
				name: "Admin",
				email: "admin@example.com",
				emailVerified: true,
				createdAt: new Date(),
				updatedAt: new Date(),
				role: "admin",
				banned: false,
			},
			session: { id: "session-1" },
		}) as unknown) as typeof auth.api.getSession;
	auth.api.userHasPermission = (async () => ({ success: true })) as typeof auth.api.userHasPermission;

	const response = await app.handle(
		new Request("http://localhost/settings", {
			headers: { authorization: "Bearer admin" },
		}),
	);

	expect(response.status).toBe(200);
	const data = await response.json();
	expect(data.streaming).toBeDefined();
	expect(data.scanning).toBeDefined();
	expect(data.images).toBeDefined();
	expect(data.workers).toBeDefined();
	expect(data.playback_defaults).toBeDefined();
	expect(data.system).toBeDefined();
});

test("admin settings PATCH updates values in real time", async () => {
	auth.api.getSession = (async () =>
		({
			user: {
				id: "admin-1",
				name: "Admin",
				email: "admin@example.com",
				emailVerified: true,
				createdAt: new Date(),
				updatedAt: new Date(),
				role: "admin",
				banned: false,
			},
			session: { id: "session-1" },
		}) as unknown) as typeof auth.api.getSession;
	auth.api.userHasPermission = (async () => ({ success: true })) as typeof auth.api.userHasPermission;

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
});

test("serverConfig.paths dynamically reflects runtime setting updates for transcodes, downloads, backups", async () => {
	auth.api.getSession = (async () =>
		({
			user: {
				id: "admin-1",
				name: "Admin",
				email: "admin@example.com",
				emailVerified: true,
				createdAt: new Date(),
				updatedAt: new Date(),
				role: "admin",
				banned: false,
			},
			session: { id: "session-1" },
		}) as unknown) as typeof auth.api.getSession;
	auth.api.userHasPermission = (async () => ({ success: true })) as typeof auth.api.userHasPermission;

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
