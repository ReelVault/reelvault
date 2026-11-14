import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { betterAuthApi } from "@/integrations/better-auth/better-auth.api";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { realtimeService } from "@/modules/realtime/realtime.service";
import { type MethodStub, stubMethod } from "../../../tests/helpers/method-stub.helper";
import {
	insertProfiles,
	insertSessions,
	insertUsers,
	selectProfilePreferenceOverrides,
	selectProfiles,
	selectSessions,
	selectUsers,
} from "../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { adminUsersService } from "./admin-users.service";

const { client } = useTestDatabase();
const stubs: MethodStub[] = [];
const ARGON2ID_PREFIX = /^\$argon2id\$/;

afterEach(() => {
	for (const stub of stubs.splice(0).toReversed()) stub.restore();
});

beforeEach(async () => {
	await insertUsers(client(), [
		{ id: "admin-1", name: "Admin", email: "admin@example.com", emailVerified: true, role: "admin" },
		{ id: "user-1", name: "User", email: "user@example.com", emailVerified: true },
		{ id: "blocked-1", name: "Blocked", email: "blocked@example.com", emailVerified: true, banned: true, banReason: "spam" },
	]);
});

describe("admin users", () => {
	test("refuses to delete the acting administrator", async () => {
		await expect(adminUsersService.delete("admin-1", { actorUserId: "admin-1", headers: new Headers() })).rejects.toMatchObject({
			category: "forbidden",
			code: "admin.self_delete_forbidden",
		});

		expect((await selectUsers(client())).map((user) => user.id)).toContain("admin-1");
	});

	test("refuses to remove the acting administrator's own role", async () => {
		await expect(
			adminUsersService.update("admin-1", { role: "user" }, { actorUserId: "admin-1", headers: new Headers() }),
		).rejects.toMatchObject({ category: "forbidden", code: "admin.self_demotion_forbidden" });

		const admin = (await selectUsers(client())).find((user) => user.id === "admin-1");
		expect(admin?.role).toBe("admin");
	});

	test("refuses to ban the acting administrator", async () => {
		await expect(
			adminUsersService.update("admin-1", { banned: true }, { actorUserId: "admin-1", headers: new Headers() }),
		).rejects.toMatchObject({ category: "forbidden", code: "admin.self_demotion_forbidden" });
	});

	test("protects the last administrator from demotion", async () => {
		await expect(
			adminUsersService.update("admin-1", { role: "user" }, { actorUserId: "user-1", headers: new Headers() }),
		).rejects.toMatchObject({ category: "conflict", code: "admin.last_admin_protected" });
	});

	test("protects the last administrator from deletion", async () => {
		await expect(adminUsersService.delete("admin-1", { actorUserId: "user-1", headers: new Headers() })).rejects.toMatchObject({
			category: "conflict",
			code: "admin.last_admin_protected",
		});
	});

	test("refuses a new user whose email already exists", async () => {
		await expect(
			adminUsersService.create(
				{ name: "Duplicate", email: "admin@example.com", password: "password-123", role: "user" },
				{ headers: new Headers() },
			),
		).rejects.toMatchObject({ category: "conflict", code: "admin.user_email_conflict" });
	});

	test("paginates the administration list", async () => {
		const page = await adminUsersService.getAll({ page: 1, limit: 2 });

		expect(page.total).toBe(3);
		expect(page.data).toHaveLength(2);
	});

	test("filters the administration list to blocked users", async () => {
		const page = await adminUsersService.getAll({ status: "blocked" });

		expect(page.total).toBe(1);
		expect(page.data[0]?.id).toBe("blocked-1");
		expect(page.data[0]?.banned).toBe(true);
	});

	test("returns a user with session activity", async () => {
		await insertSessions(client(), {
			id: "session-1",
			userId: "admin-1",
			token: "session-token",
			expiresAt: new Date(Date.now() + 60 * 60_000),
		});

		const user = await adminUsersService.getById("admin-1");

		expect(user).toMatchObject({ id: "admin-1", email: "admin@example.com", role: "admin", activeSessionCount: 1 });
	});

	test("returns the user and an empty profile list when no profile exists", async () => {
		const result = await adminUsersService.getByIdWithProfiles("user-1");

		expect(result.user).toMatchObject({
			id: "user-1",
			email: "user@example.com",
			role: "user",
			banExpires: null,
			activeSessionCount: 0,
			lastActiveAt: null,
		});
		expect(result.profiles).toEqual([]);
	});

	test("returns the activity of a user with an active session", async () => {
		await insertSessions(client(), {
			id: "session-1",
			userId: "user-1",
			token: "session-token",
			updatedAt: new Date("2026-01-02T03:04:05Z"),
			expiresAt: new Date(Date.now() + 60 * 60_000),
		});

		const user = await adminUsersService.getById("user-1");

		expect(user).toMatchObject({ activeSessionCount: 1, lastActiveAt: "2026-01-02T03:04:05.000Z" });
	});

	test("reports no activity for a user without sessions", async () => {
		const user = await adminUsersService.getById("user-1");

		expect(user).toMatchObject({ activeSessionCount: 0, lastActiveAt: null });
	});

	test("reports a missing user as not found", async () => {
		await expect(adminUsersService.getById("missing")).rejects.toMatchObject({
			category: "not_found",
			code: "entity.not_found",
		});
	});
});

describe("admin user mutations", () => {
	test("promotes a user through the auth adapter and returns the stored role", async () => {
		stubs.push(
			stubMethod(betterAuthApi, "setRole", async ({ userId, role }: { userId: string; role: "admin" | "user" }) => {
				await client().update(schema.users).set({ role }).where(eq(schema.users.id, userId));
			}),
		);

		const updated = await adminUsersService.update("user-1", { role: "admin" }, { actorUserId: "admin-1", headers: new Headers() });

		expect(updated.role).toBe("admin");
	});

	test("bans a user and records the reason", async () => {
		stubs.push(stubMethod(realtimeService, "disconnectUser", () => undefined));
		stubs.push(
			stubMethod(betterAuthApi, "banUser", async ({ userId, banReason }: { userId: string; banReason?: string | undefined }) => {
				await client()
					.update(schema.users)
					.set({ banned: true, banReason: banReason ?? null })
					.where(eq(schema.users.id, userId));
			}),
		);

		const updated = await adminUsersService.update(
			"user-1",
			{ banned: true, banReason: "spam" },
			{ actorUserId: "admin-1", headers: new Headers() },
		);

		expect(updated).toMatchObject({ banned: true, banReason: "spam" });
	});

	test("unbans a previously blocked user", async () => {
		stubs.push(
			stubMethod(betterAuthApi, "unbanUser", async ({ userId }: { userId: string }) => {
				await client().update(schema.users).set({ banned: false }).where(eq(schema.users.id, userId));
			}),
		);

		const updated = await adminUsersService.update("blocked-1", { banned: false }, { actorUserId: "admin-1", headers: new Headers() });

		expect(updated.banned).toBe(false);
	});

	test("deletes another user through the auth adapter", async () => {
		stubs.push(
			stubMethod(betterAuthApi, "removeUser", async ({ userId }: { userId: string }) => {
				await client().delete(schema.users).where(eq(schema.users.id, userId));
			}),
		);

		const result = await adminUsersService.delete("blocked-1", { actorUserId: "admin-1", headers: new Headers() });

		expect(result).toEqual({ success: true });
		expect((await selectUsers(client())).map((user) => user.id)).not.toContain("blocked-1");
	});

	test("sets a password and revokes every session of the user", async () => {
		await insertSessions(client(), {
			id: "session-1",
			userId: "user-1",
			token: "session-token",
			expiresAt: new Date(Date.now() + 60 * 60_000),
		});
		stubs.push(stubMethod(realtimeService, "disconnectUser", () => undefined));
		stubs.push(stubMethod(betterAuthApi, "setUserPassword", () => Promise.resolve()));

		const result = await adminUsersService.setPassword("user-1", { newPassword: "new-password-123" }, { headers: new Headers() });

		expect(result).toEqual({ success: true });
		expect(await selectSessions(client())).toEqual([]);
	});

	test("creates a user through the auth adapter and reads the stored row", async () => {
		stubs.push(
			stubMethod(betterAuthApi, "createUser", async (input: { name: string; email: string; role?: "admin" | "user" | undefined }) => {
				await insertUsers(client(), {
					id: "created-1",
					name: input.name,
					email: input.email,
					emailVerified: true,
					role: input.role,
				});

				return { user: { id: "created-1" } };
			}),
		);

		const created = await adminUsersService.create(
			{ name: "Created", email: "created@example.com", password: "password-123" },
			{ headers: new Headers() },
		);

		expect(created).toMatchObject({ id: "created-1", name: "Created", email: "created@example.com", role: "user" });
		expect((await selectUsers(client())).find((user) => user.id === "created-1")?.role).toBe("user");
	});
});

describe("admin user validation", () => {
	test("reports a missing user when setting a password", async () => {
		await expect(
			adminUsersService.setPassword("missing", { newPassword: "new-password-123" }, { headers: new Headers() }),
		).rejects.toMatchObject({ category: "not_found", code: "entity.not_found" });
	});

	test("requires headers to update a user", async () => {
		await expect(adminUsersService.update("user-1", { role: "admin" })).rejects.toMatchObject({
			category: "internal",
			code: "internal",
		});
	});

	test("requires headers to delete a user", async () => {
		await expect(adminUsersService.delete("user-1")).rejects.toMatchObject({
			category: "internal",
			code: "internal",
		});
	});
});

describe("admin user list activity", () => {
	test("includes the active session count of each listed user", async () => {
		await insertSessions(client(), {
			id: "session-1",
			userId: "user-1",
			token: "session-token",
			expiresAt: new Date(Date.now() + 60 * 60_000),
		});

		const page = await adminUsersService.getAll({ status: "active" });

		const user = page.data.find((item) => item.id === "user-1");
		expect(user).toMatchObject({ id: "user-1", activeSessionCount: 1 });
	});
});

describe("admin user sessions", () => {
	test("lists active sessions with ISO timestamps", async () => {
		await insertSessions(client(), {
			id: "session-1",
			userId: "user-1",
			token: "token-1",
			ipAddress: "10.0.0.5",
			userAgent: "Test Browser",
			createdAt: new Date("2026-01-02T03:04:05Z"),
			updatedAt: new Date("2026-01-02T04:05:06Z"),
			expiresAt: new Date("2027-01-02T03:04:05Z"),
		});

		const page = await adminUsersService.getSessions("user-1", { page: 1, limit: 10 });

		expect(page.data).toEqual([
			{
				id: "session-1",
				ipAddress: "10.0.0.5",
				userAgent: "Test Browser",
				createdAt: "2026-01-02T03:04:05.000Z",
				updatedAt: "2026-01-02T04:05:06.000Z",
				expiresAt: "2027-01-02T03:04:05.000Z",
			},
		]);
	});

	test("drops expired sessions from the list", async () => {
		// A distinct user keeps the page-count cache from the previous test out of this one.
		await insertUsers(client(), {
			id: "expired-user",
			name: "Expired",
			email: "expired@example.com",
			emailVerified: true,
		});
		await insertSessions(client(), {
			id: "session-expired",
			userId: "expired-user",
			token: "token-expired",
			expiresAt: new Date("2020-01-01T00:00:00Z"),
		});

		const page = await adminUsersService.getSessions("expired-user", { page: 1, limit: 10 });

		expect(page.total).toBe(0);
		expect(page.data).toEqual([]);
	});

	test("reports a missing user when listing sessions", async () => {
		await expect(adminUsersService.getSessions("missing", { page: 1, limit: 10 })).rejects.toMatchObject({
			category: "not_found",
			code: "entity.not_found",
		});
	});

	test("revokes one session of the user", async () => {
		await insertSessions(client(), {
			id: "session-1",
			userId: "user-1",
			token: "token-1",
			expiresAt: new Date("2027-01-01T00:00:00Z"),
		});

		const result = await adminUsersService.revokeSession("user-1", "session-1", { headers: new Headers() });

		expect(result).toEqual({ success: true });
		expect(await selectSessions(client())).toEqual([]);
	});

	test("refuses to revoke a session owned by another user", async () => {
		await insertSessions(client(), {
			id: "session-1",
			userId: "user-1",
			token: "token-1",
			expiresAt: new Date("2027-01-01T00:00:00Z"),
		});

		await expect(adminUsersService.revokeSession("blocked-1", "session-1", { headers: new Headers() })).rejects.toMatchObject({
			category: "not_found",
			code: "entity.not_found",
		});
	});

	test("revokes every session of the listed users", async () => {
		await insertSessions(client(), [
			{ id: "session-1", userId: "user-1", token: "token-1", expiresAt: new Date("2027-01-01T00:00:00Z") },
			{ id: "session-2", userId: "user-1", token: "token-2", expiresAt: new Date("2027-01-02T00:00:00Z") },
			{ id: "session-3", userId: "blocked-1", token: "token-3", expiresAt: new Date("2027-01-03T00:00:00Z") },
		]);

		const result = await adminUsersService.revokeSessionsForUsers(["user-1"], { headers: new Headers() });

		expect(result).toEqual({ revokedSessions: 2 });
		expect((await selectSessions(client())).map((session) => session.id)).toEqual(["session-3"]);
	});
});

describe("admin user profiles", () => {
	test("creates a profile and stores a hashed PIN", async () => {
		const profile = await adminUsersService.createProfile(
			"user-1",
			{ name: "Kids", pin: "1234", avatarUrl: "https://example.com/kids.png" },
			{ headers: new Headers() },
		);

		expect(profile).toMatchObject({ userId: "user-1", name: "Kids", avatarUrl: "https://example.com/kids.png", hasPin: true });
		const stored = (await selectProfiles(client()))[0];
		expect(stored?.pin).toMatch(ARGON2ID_PREFIX);
	});

	test("creates a profile without a PIN", async () => {
		const profile = await adminUsersService.createProfile("user-1", { name: "Guest" }, { headers: new Headers() });

		expect(profile).toMatchObject({ name: "Guest", avatarUrl: null, hasPin: false });
		expect((await selectProfiles(client()))[0]?.pin).toBeNull();
	});

	test("refuses a duplicate profile name", async () => {
		await insertProfiles(client(), { id: "profile-1", userId: "user-1", name: "Main" });

		await expect(adminUsersService.createProfile("user-1", { name: "Main" }, { headers: new Headers() })).rejects.toMatchObject({
			category: "conflict",
			code: "profile.name_conflict",
		});
	});

	test("reports a missing user when creating a profile", async () => {
		await expect(adminUsersService.createProfile("missing", { name: "Main" }, { headers: new Headers() })).rejects.toMatchObject({
			category: "not_found",
			code: "entity.not_found",
		});
	});

	test("lists profiles for an existing user", async () => {
		await insertProfiles(client(), { id: "profile-1", userId: "user-1", name: "Main", avatarUrl: "https://example.com/main.png" });

		const profiles = await adminUsersService.getProfiles("user-1");

		expect(profiles).toHaveLength(1);
		expect(profiles[0]).toMatchObject({ id: "profile-1", userId: "user-1", name: "Main", hasPin: false });
	});

	test("reports a missing user when listing profiles", async () => {
		await expect(adminUsersService.getProfiles("missing")).rejects.toMatchObject({
			category: "not_found",
			code: "entity.not_found",
		});
	});

	test("returns mapped profiles beside the user", async () => {
		await insertProfiles(client(), {
			id: "profile-1",
			userId: "user-1",
			name: "Main",
			avatarUrl: "https://example.com/main.png",
			pin: "$argon2id$stored",
		});

		const result = await adminUsersService.getByIdWithProfiles("user-1");

		expect(result.profiles).toMatchObject([
			{ id: "profile-1", userId: "user-1", name: "Main", avatarUrl: "https://example.com/main.png", hasPin: true },
		]);
	});

	test("deletes an owned profile", async () => {
		await insertProfiles(client(), { id: "profile-1", userId: "user-1", name: "Main" });

		const result = await adminUsersService.deleteProfile("user-1", "profile-1", { headers: new Headers() });

		expect(result).toEqual({ success: true });
		expect(await selectProfiles(client())).toEqual([]);
	});

	test("refuses to delete another user's profile", async () => {
		await insertProfiles(client(), { id: "profile-1", userId: "user-1", name: "Main" });

		await expect(adminUsersService.deleteProfile("blocked-1", "profile-1", { headers: new Headers() })).rejects.toMatchObject({
			category: "not_found",
			code: "entity.not_found",
		});
		expect(await selectProfiles(client())).toHaveLength(1);
	});
});

describe("admin profile updates", () => {
	test("renames an owned profile", async () => {
		await insertProfiles(client(), { id: "profile-1", userId: "user-1", name: "Main" });

		const updated = await adminUsersService.updateProfile("user-1", "profile-1", { name: "Cinema" }, { headers: new Headers() });

		expect(updated).toMatchObject({ id: "profile-1", name: "Cinema" });
		expect((await selectProfiles(client()))[0]?.name).toBe("Cinema");
	});

	test("refuses a rename to a taken profile name", async () => {
		await insertProfiles(client(), [
			{ id: "profile-1", userId: "user-1", name: "Main" },
			{ id: "profile-2", userId: "user-1", name: "Kids" },
		]);

		await expect(
			adminUsersService.updateProfile("user-1", "profile-1", { name: "Kids" }, { headers: new Headers() }),
		).rejects.toMatchObject({ category: "conflict", code: "profile.name_conflict" });
	});

	test("hashes a new PIN and clears it when emptied", async () => {
		await insertProfiles(client(), { id: "profile-1", userId: "user-1", name: "Main" });

		const withPin = await adminUsersService.updateProfile("user-1", "profile-1", { pin: "4321" }, { headers: new Headers() });
		expect(withPin.hasPin).toBe(true);
		expect((await selectProfiles(client()))[0]?.pin).toMatch(ARGON2ID_PREFIX);

		const cleared = await adminUsersService.updateProfile("user-1", "profile-1", { pin: "" }, { headers: new Headers() });
		expect(cleared.hasPin).toBe(false);
		expect((await selectProfiles(client()))[0]?.pin).toBeNull();
	});

	test("updates the avatar and clears it", async () => {
		await insertProfiles(client(), { id: "profile-1", userId: "user-1", name: "Main" });

		const updated = await adminUsersService.updateProfile(
			"user-1",
			"profile-1",
			{ avatarUrl: "https://example.com/main.png" },
			{ headers: new Headers() },
		);
		expect(updated.avatarUrl).toBe("https://example.com/main.png");

		const cleared = await adminUsersService.updateProfile("user-1", "profile-1", { avatarUrl: null }, { headers: new Headers() });
		expect(cleared.avatarUrl).toBeNull();
	});

	test("keeps the profile and its PIN when no field changes", async () => {
		await insertProfiles(client(), [
			{ id: "profile-1", userId: "user-1", name: "Main", pin: "$argon2id$stored" },
			{ id: "profile-2", userId: "user-1", name: "Kids" },
		]);

		const updated = await adminUsersService.updateProfile("user-1", "profile-1", {}, { headers: new Headers() });

		expect(updated).toMatchObject({ id: "profile-1", name: "Main", hasPin: true });
	});
});

describe("admin profile preferences", () => {
	test("applies preference overrides for an owned profile", async () => {
		await insertProfiles(client(), { id: "profile-1", userId: "user-1", name: "Main" });

		const preferences = await adminUsersService.updateProfilePreferences(
			"user-1",
			"profile-1",
			{ continueWatchingMinutes: 42, autoplay: true },
			{ headers: new Headers() },
		);

		expect(preferences).toMatchObject({ profileId: "profile-1", continueWatchingMinutes: 42, autoplay: true });
		const stored = await selectProfilePreferenceOverrides(client());
		expect(Object.fromEntries(stored.map((row) => [row.key, row.value]))).toEqual({
			continueWatchingMinutes: "42",
			autoplay: "true",
		});
	});

	test("returns the stored preferences of an owned profile", async () => {
		await insertProfiles(client(), { id: "profile-1", userId: "user-1", name: "Main" });
		await adminUsersService.updateProfilePreferences("user-1", "profile-1", { continueWatchingMinutes: 42 }, { headers: new Headers() });

		const preferences = await adminUsersService.getProfilePreferences("user-1", "profile-1");

		expect(preferences).toMatchObject({ profileId: "profile-1", continueWatchingMinutes: 42 });
	});

	test("removes the overrides on reset", async () => {
		await insertProfiles(client(), { id: "profile-1", userId: "user-1", name: "Main" });
		await adminUsersService.updateProfilePreferences("user-1", "profile-1", { continueWatchingMinutes: 42 }, { headers: new Headers() });

		const preferences = await adminUsersService.resetProfilePreferences("user-1", "profile-1", { headers: new Headers() });

		expect(preferences.profileId).toBe("profile-1");
		expect(await selectProfilePreferenceOverrides(client())).toEqual([]);
	});

	test("refuses preferences for another user's profile", async () => {
		await insertProfiles(client(), { id: "profile-1", userId: "user-1", name: "Main" });

		await expect(
			adminUsersService.updateProfilePreferences("blocked-1", "profile-1", { continueWatchingMinutes: 42 }, { headers: new Headers() }),
		).rejects.toMatchObject({ category: "not_found", code: "entity.not_found" });
	});
});

describe("admin user page size", () => {
	test("uses a default page size of 25 users", async () => {
		const extraUsers = Array.from({ length: 26 }, (_, index) => ({
			id: `extra-${index}`,
			name: `Extra ${index}`,
			email: `extra-${index}@example.com`,
			emailVerified: true,
		}));
		await insertUsers(client(), extraUsers);

		const page = await adminUsersService.getAll({});

		expect(page.total).toBe(29);
		expect(page.limit).toBe(25);
		expect(page.data).toHaveLength(25);
	});
});

describe("last administrator boundary", () => {
	test("allows demoting an administrator when another remains", async () => {
		await insertUsers(client(), {
			id: "admin-2",
			name: "Second Admin",
			email: "admin-2@example.com",
			emailVerified: true,
			role: "admin",
		});
		stubs.push(
			stubMethod(betterAuthApi, "setRole", async ({ userId, role }: { userId: string; role: "admin" | "user" }) => {
				await client().update(schema.users).set({ role }).where(eq(schema.users.id, userId));
			}),
		);

		const updated = await adminUsersService.update("admin-1", { role: "user" }, { actorUserId: "admin-2", headers: new Headers() });

		expect(updated.role).toBe("user");
	});

	test("keeps the last administrator on a role no-op update", async () => {
		const updated = await adminUsersService.update("admin-1", { role: "admin" }, { actorUserId: "user-1", headers: new Headers() });

		expect(updated.role).toBe("admin");
	});
});
