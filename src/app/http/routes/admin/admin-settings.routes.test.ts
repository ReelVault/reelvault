import { afterEach, beforeEach, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { domainErrorsMiddleware } from "@/app/http/middleware/domain-errors.middleware";
import { serverConfig } from "@/config/server/server.config";
import { systemSettingsStore } from "@/config/system-settings.store";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { useTestDatabase } from "../../../../../tests/helpers/test-database.helper";

const [{ adminSettingsRoutes }, { auth }, { systemSettingsService }] = await Promise.all([
	import("./admin-settings.routes"),
	import("@/integrations/better-auth/better-auth.config"),
	import("@/app/admin/system-settings.service"),
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
	expect(data.streaming).toContainEqual(expect.objectContaining({ key: "stream.maxSessions", value: 5, isCustom: false }));
});

test("admin settings PATCH applies and stores the new values", async () => {
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

	const stored = await databaseFactory.getClient().select().from(schema.systemSettings).all();
	expect(stored).toContainEqual(expect.objectContaining({ key: "stream.maxSessions", value: "8", lastModifiedBy: "admin-1" }));
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
