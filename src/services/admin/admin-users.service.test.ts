import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { betterAuthApi } from "@/integrations/better-auth/better-auth.api";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { realtimeService } from "@/modules/realtime/realtime.service";
import { type MethodStub, stubMethod } from "../../../tests/helpers/method-stub.helper";
import { insertSessions, insertUsers, selectSessions, selectUsers } from "../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { adminUsersService } from "./admin-users.service";

const { client } = useTestDatabase();
const stubs: MethodStub[] = [];

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

		expect(result.user).toMatchObject({ id: "user-1", email: "user@example.com", role: "user" });
		expect(result.profiles).toEqual([]);
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
			stubMethod(betterAuthApi, "createUser", async () => {
				await insertUsers(client(), {
					id: "created-1",
					name: "Created",
					email: "created@example.com",
					emailVerified: true,
				});

				return { user: { id: "created-1" } };
			}),
		);

		const created = await adminUsersService.create(
			{ name: "Created", email: "created@example.com", password: "password-123", role: "user" },
			{ headers: new Headers() },
		);

		expect(created).toMatchObject({ id: "created-1", email: "created@example.com", role: "user" });
	});
});
