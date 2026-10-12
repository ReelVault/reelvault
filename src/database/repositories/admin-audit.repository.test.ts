import { afterEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { eq, sql } from "drizzle-orm";
import { DatabaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import { AdminAuditRepository, getClientIp, redactAuditValue, serializeAuditValue } from "./admin-audit.repository";

const databasePaths: string[] = [];

afterEach(async () => {
	await Promise.all(databasePaths.splice(0).map(async (path) => await unlink(path).catch(() => undefined)));
});

describe("admin audit redaction", () => {
	test("redacts credentials recursively before serialization", () => {
		const value = {
			name: "Admin",
			pin: "1234",
			nested: { accessToken: "secret-token" },
			items: [{ password: "secret-password" }],
		};

		expect(redactAuditValue(value)).toEqual({
			name: "Admin",
			pin: "[REDACTED]",
			nested: { accessToken: "[REDACTED]" },
			items: [{ password: "[REDACTED]" }],
		});
		expect(JSON.parse(serializeAuditValue(value) ?? "null")).toMatchObject({ pin: "[REDACTED]" });
	});

	test("preserves dates and request metadata", () => {
		const createdAt = new Date("2026-01-02T03:04:05.000Z");
		const serialized = JSON.parse(serializeAuditValue({ createdAt }) ?? "null");
		const headers = new Headers({ "x-reelvault-client-ip": "192.0.2.10", "user-agent": "audit-test" });

		expect(serialized.createdAt).toBe(createdAt.toISOString());
		expect(getClientIp(headers)).toBe("192.0.2.10");
	});

	test("ignores client-controlled forwarding headers", () => {
		expect(getClientIp(new Headers({ "x-forwarded-for": "192.0.2.10, 198.51.100.4" }))).toBeNull();
		expect(getClientIp(new Headers({ "x-real-ip": "192.0.2.20" }))).toBeNull();
	});

	test("rolls back the audit entry with the surrounding transaction", async () => {
		const path = `${tmpdir()}/reelvault-audit-${process.pid}-${crypto.randomUUID()}.sqlite`;
		databasePaths.push(path, `${path}-shm`, `${path}-wal`);
		const factory = new DatabaseFactory(path);
		factory.getClient().run(
			sql.raw(`
				CREATE TABLE admin_audit_logs (
					id TEXT PRIMARY KEY,
					actor_user_id TEXT,
					action TEXT NOT NULL,
					resource_type TEXT NOT NULL,
					resource_id TEXT,
					resource_name TEXT,
					summary TEXT,
					before_json TEXT,
					after_json TEXT,
					request_id TEXT,
					ip_address TEXT,
					user_agent TEXT,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL
				)
			`),
		);
		const repository = new AdminAuditRepository(factory);

		await expect(
			factory.transaction(async (tx) => {
				await repository.insert({ action: "update", resourceType: "profile", resourceId: "profile-1" }, tx);
				throw new Error("rollback audit");
			}),
		).rejects.toThrow("rollback audit");

		expect(factory.getClient().all(sql.raw("SELECT id FROM admin_audit_logs"))).toEqual([]);
		factory.shutdown();
	});
});

describe("admin audit redaction", () => {
	test("inserts and retrieves resourceName and summary fields", async () => {
		const path = `${tmpdir()}/reelvault-audit-${process.pid}-${crypto.randomUUID()}.sqlite`;
		databasePaths.push(path, `${path}-shm`, `${path}-wal`);
		const factory = new DatabaseFactory(path);
		factory.getClient().run(
			sql.raw(`
				CREATE TABLE admin_audit_logs (
					id TEXT PRIMARY KEY,
					actor_user_id TEXT,
					action TEXT NOT NULL,
					resource_type TEXT NOT NULL,
					resource_id TEXT,
					resource_name TEXT,
					summary TEXT,
					before_json TEXT,
					after_json TEXT,
					request_id TEXT,
					ip_address TEXT,
					user_agent TEXT,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL
				)
			`),
		);
		const repository = new AdminAuditRepository(factory);

		await repository.insert({
			action: "create",
			resourceType: "library",
			resourceId: "lib-1",
			resourceName: "/movies",
			summary: "Created library /movies",
		});

		const { data } = await repository.findMany({ page: 1, limit: 10 });
		expect(data).toHaveLength(1);
		expect(data[0]?.resourceName).toBe("/movies");
		expect(data[0]?.summary).toBe("Created library /movies");
		factory.shutdown();
	});

	test("filters by date range with from and to", async () => {
		const path = `${tmpdir()}/reelvault-audit-${process.pid}-${crypto.randomUUID()}.sqlite`;
		databasePaths.push(path, `${path}-shm`, `${path}-wal`);
		const factory = new DatabaseFactory(path);
		factory.getClient().run(
			sql.raw(`
				CREATE TABLE admin_audit_logs (
					id TEXT PRIMARY KEY,
					actor_user_id TEXT,
					action TEXT NOT NULL,
					resource_type TEXT NOT NULL,
					resource_id TEXT,
					resource_name TEXT,
					summary TEXT,
					before_json TEXT,
					after_json TEXT,
					request_id TEXT,
					ip_address TEXT,
					user_agent TEXT,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL
				)
			`),
		);
		const repository = new AdminAuditRepository(factory);

		await repository.insert({ action: "create", resourceType: "library" });
		await repository.insert({ action: "update", resourceType: "user" });

		const all = await repository.findMany({ page: 1, limit: 10 });
		expect(all.data).toHaveLength(2);

		const filtered = await repository.findMany({ page: 1, limit: 10, resourceType: "library" });
		expect(filtered.data).toHaveLength(1);
		expect(filtered.data[0]?.resourceType).toBe("library");
		factory.shutdown();
	});
});

describe("admin audit redaction", () => {
	test("filters by ipAddress and requestId", async () => {
		const path = `${tmpdir()}/reelvault-audit-${process.pid}-${crypto.randomUUID()}.sqlite`;
		databasePaths.push(path, `${path}-shm`, `${path}-wal`);
		const factory = new DatabaseFactory(path);
		factory.getClient().run(
			sql.raw(`
				CREATE TABLE admin_audit_logs (
					id TEXT PRIMARY KEY,
					actor_user_id TEXT,
					action TEXT NOT NULL,
					resource_type TEXT NOT NULL,
					resource_id TEXT,
					resource_name TEXT,
					summary TEXT,
					before_json TEXT,
					after_json TEXT,
					request_id TEXT,
					ip_address TEXT,
					user_agent TEXT,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL
				)
			`),
		);
		const repository = new AdminAuditRepository(factory);

		await repository.insert({
			action: "create",
			resourceType: "library",
			context: { headers: new Headers({ "x-reelvault-client-ip": "10.0.0.1", "x-request-id": "req-abc" }) },
		});
		await repository.insert({
			action: "update",
			resourceType: "user",
			context: { headers: new Headers({ "x-reelvault-client-ip": "10.0.0.2" }) },
		});

		const byIp = await repository.findMany({ page: 1, limit: 10, ipAddress: "10.0.0.1" });
		expect(byIp.data).toHaveLength(1);
		expect(byIp.data[0]?.ipAddress).toBe("10.0.0.1");

		const byReq = await repository.findMany({ page: 1, limit: 10, requestId: "req-abc" });
		expect(byReq.data).toHaveLength(1);
		expect(byReq.data[0]?.requestId).toBe("req-abc");
		factory.shutdown();
	});

	test("searches by resource id and summary, treating % as literal text", async () => {
		const path = `${tmpdir()}/reelvault-audit-${process.pid}-${crypto.randomUUID()}.sqlite`;
		databasePaths.push(path, `${path}-shm`, `${path}-wal`);
		const factory = new DatabaseFactory(path);
		factory.getClient().run(
			sql.raw(`
				CREATE TABLE admin_audit_logs (
					id TEXT PRIMARY KEY,
					actor_user_id TEXT,
					action TEXT NOT NULL,
					resource_type TEXT NOT NULL,
					resource_id TEXT,
					resource_name TEXT,
					summary TEXT,
					before_json TEXT,
					after_json TEXT,
					request_id TEXT,
					ip_address TEXT,
					user_agent TEXT,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL
				)
			`),
		);
		const repository = new AdminAuditRepository(factory);

		await repository.insert({ action: "update", resourceType: "library", resourceId: "lib-kids", summary: "Renamed library" });
		await repository.insert({ action: "delete", resourceType: "metadata", resourceId: "meta-42", summary: "Removed 100% of the cache" });
		await repository.insert({ action: "create", resourceType: "user", resourceId: "user-7", summary: "Created account" });

		const byResourceId = await repository.findMany({ page: 1, limit: 10, q: "LIB-KIDS" });
		expect(byResourceId.data.map((entry) => entry.resourceId)).toEqual(["lib-kids"]);

		const bySummary = await repository.findMany({ page: 1, limit: 10, q: "cache" });
		expect(bySummary.total).toBe(1);

		// A bare percent sign must not match every row.
		const literalPercent = await repository.findMany({ page: 1, limit: 10, q: "%" });
		expect(literalPercent.total).toBe(1);
		factory.shutdown();
	});
});

describe("admin audit redaction", () => {
	test("summarizes activity per administrator with names, filters and unattributed entries", async () => {
		const path = `${tmpdir()}/reelvault-audit-${process.pid}-${crypto.randomUUID()}.sqlite`;
		databasePaths.push(path, `${path}-shm`, `${path}-wal`);
		const factory = new DatabaseFactory(path);
		factory.getClient().run(
			sql.raw(`
				CREATE TABLE admin_audit_logs (
					id TEXT PRIMARY KEY,
					actor_user_id TEXT,
					action TEXT NOT NULL,
					resource_type TEXT NOT NULL,
					resource_id TEXT,
					resource_name TEXT,
					summary TEXT,
					before_json TEXT,
					after_json TEXT,
					request_id TEXT,
					ip_address TEXT,
					user_agent TEXT,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL
				)
			`),
		);
		factory.getClient().run(sql.raw("CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL)"));
		factory.getClient().run(sql.raw("INSERT INTO users (id, name) VALUES ('admin-1', 'Ada'), ('admin-2', 'Bob')"));
		const repository = new AdminAuditRepository(factory);

		await repository.insert({ action: "create", resourceType: "library", context: { actorUserId: "admin-1" } });
		await repository.insert({ action: "update", resourceType: "library", context: { actorUserId: "admin-1" } });
		await repository.insert({ action: "update", resourceType: "user", context: { actorUserId: "admin-1" } });
		await repository.insert({ action: "delete", resourceType: "user", context: { actorUserId: "admin-2" } });
		await repository.insert({ action: "update", resourceType: "user", context: { actorUserId: "admin-2" } });
		await repository.insert({ action: "update", resourceType: "system" });

		const summary = await repository.summarizeByActor({}, 10);
		expect(summary.total).toBe(6);
		expect(summary.actors.map((actor) => actor.actorUserId)).toEqual(["admin-1", "admin-2", null]);
		expect(summary.actors[0]).toMatchObject({ name: "Ada", total: 3, creates: 1, updates: 2, deletes: 0 });
		expect(summary.actors[1]).toMatchObject({ name: "Bob", total: 2, creates: 0, updates: 1, deletes: 1 });
		expect(summary.actors[2]).toMatchObject({ name: null, total: 1, updates: 1 });

		const updatesOnly = await repository.summarizeByActor({ action: "update" }, 10);
		expect(updatesOnly.total).toBe(4);
		expect(updatesOnly.actors.map((actor) => actor.actorUserId)).toEqual(["admin-1", null, "admin-2"]);

		const capped = await repository.summarizeByActor({}, 1);
		expect(capped.actors).toHaveLength(1);
		expect(capped.total).toBe(6);
		factory.shutdown();
	});
});

describe("admin audit redaction", () => {
	test("lists the resource types and administrators the filter dropdowns offer", async () => {
		const path = `${tmpdir()}/reelvault-audit-${process.pid}-${crypto.randomUUID()}.sqlite`;
		databasePaths.push(path, `${path}-shm`, `${path}-wal`);
		const factory = new DatabaseFactory(path);
		factory.getClient().run(
			sql.raw(`
				CREATE TABLE admin_audit_logs (
					id TEXT PRIMARY KEY,
					actor_user_id TEXT,
					action TEXT NOT NULL,
					resource_type TEXT NOT NULL,
					resource_id TEXT,
					resource_name TEXT,
					summary TEXT,
					before_json TEXT,
					after_json TEXT,
					request_id TEXT,
					ip_address TEXT,
					user_agent TEXT,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL
				)
			`),
		);
		factory.getClient().run(sql.raw("CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL)"));
		factory.getClient().run(sql.raw("INSERT INTO users (id, name) VALUES ('admin-1', 'Ada'), ('admin-2', 'Bob')"));
		const repository = new AdminAuditRepository(factory);

		await repository.insert({ action: "update", resourceType: "metadata", context: { actorUserId: "admin-2" } });
		await repository.insert({ action: "create", resourceType: "library", context: { actorUserId: "admin-1" } });
		await repository.insert({ action: "update", resourceType: "library", context: { actorUserId: "admin-1" } });
		await repository.insert({ action: "delete", resourceType: "library", context: { actorUserId: "removed-admin" } });
		await repository.insert({ action: "update", resourceType: "plugin" });

		const options = await repository.findFilterOptions(10);
		expect(options.resourceTypes).toEqual(["library", "metadata", "plugin"]);
		expect(options.actors).toEqual([
			{ actorUserId: "admin-1", name: "Ada" },
			{ actorUserId: "admin-2", name: "Bob" },
			{ actorUserId: "removed-admin", name: null },
		]);
		expect((await repository.findFilterOptions(2)).resourceTypes).toEqual(["library", "metadata"]);
		factory.shutdown();
	});

	test("prunes audit rows older than the cutoff", async () => {
		const path = `${tmpdir()}/reelvault-audit-${process.pid}-${crypto.randomUUID()}.sqlite`;
		databasePaths.push(path, `${path}-shm`, `${path}-wal`);
		const factory = new DatabaseFactory(path);
		factory.getClient().run(
			sql.raw(`
				CREATE TABLE admin_audit_logs (
					id TEXT PRIMARY KEY,
					actor_user_id TEXT,
					action TEXT NOT NULL,
					resource_type TEXT NOT NULL,
					resource_id TEXT,
					resource_name TEXT,
					summary TEXT,
					before_json TEXT,
					after_json TEXT,
					request_id TEXT,
					ip_address TEXT,
					user_agent TEXT,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL
				)
			`),
		);
		const repository = new AdminAuditRepository(factory);

		await repository.insert({ action: "create", resourceType: "library" });
		await repository.insert({ action: "update", resourceType: "user" });

		const now = Date.now();
		const client = factory.getClient();
		await client
			.update(schema.adminAuditLogs)
			.set({ createdAt: new Date(now - 10 * 86_400_000) })
			.where(eq(schema.adminAuditLogs.resourceType, "library"));
		await client
			.update(schema.adminAuditLogs)
			.set({ createdAt: new Date(now) })
			.where(eq(schema.adminAuditLogs.resourceType, "user"));

		expect(await repository.pruneOlderThan(new Date(now - 86_400_000))).toBe(1);

		const remaining = await client.select({ resourceType: schema.adminAuditLogs.resourceType }).from(schema.adminAuditLogs);
		expect(remaining).toEqual([{ resourceType: "user" }]);
		factory.shutdown();
	});
});
