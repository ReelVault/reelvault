import { afterEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { DatabaseFactory } from "@/database/database";
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
		const path = `/tmp/reelvault-audit-${process.pid}-${crypto.randomUUID()}.sqlite`;
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

	test("inserts and retrieves resourceName and summary fields", async () => {
		const path = `/tmp/reelvault-audit-${process.pid}-${crypto.randomUUID()}.sqlite`;
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
		const path = `/tmp/reelvault-audit-${process.pid}-${crypto.randomUUID()}.sqlite`;
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

	test("filters by ipAddress and requestId", async () => {
		const path = `/tmp/reelvault-audit-${process.pid}-${crypto.randomUUID()}.sqlite`;
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
});
