import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { useTestDatabase } from "../../tests/helpers/test-database.helper";
import { AdminAuditRepository, redactAuditValue, serializeAuditValue } from "./admin-audit.repository";

useTestDatabase();

async function seedAdministrators(): Promise<void> {
	await databaseFactory
		.getClient()
		.insert(schema.users)
		.values([
			{ id: "admin-1", name: "Ada", email: "ada@example.com", emailVerified: true },
			{ id: "admin-2", name: "Bob", email: "bob@example.com", emailVerified: true },
		]);
}

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

	test("serializes dates as ISO strings", () => {
		const createdAt = new Date("2026-01-02T03:04:05.000Z");
		const serialized = JSON.parse(serializeAuditValue({ createdAt }) ?? "null");

		expect(serialized.createdAt).toBe("2026-01-02T03:04:05.000Z");
	});
});

describe("admin audit records", () => {
	test("rolls back the audit entry with the surrounding transaction", async () => {
		const auditFailure = new Error("rollback audit");
		const repository = new AdminAuditRepository();

		await expect(
			databaseFactory.transaction(async (tx) => {
				await repository.insert({ action: "update", resourceType: "profile", resourceId: "profile-1" }, tx);
				throw auditFailure;
			}),
		).rejects.toBe(auditFailure);

		expect(await databaseFactory.getClient().select({ id: schema.adminAuditLogs.id }).from(schema.adminAuditLogs)).toEqual([]);
	});

	test("inserts and retrieves resourceName and summary fields", async () => {
		const repository = new AdminAuditRepository();
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
	});

	test("filters by resource type", async () => {
		const repository = new AdminAuditRepository();
		await repository.insert({ action: "create", resourceType: "library" });
		await repository.insert({ action: "update", resourceType: "user" });

		const filtered = await repository.findMany({ page: 1, limit: 10, resourceType: "library" });
		expect(filtered.data.map((entry) => entry.resourceType)).toEqual(["library"]);
	});

	test("filters by a from and to date range", async () => {
		const repository = new AdminAuditRepository();
		await repository.insert({ action: "create", resourceType: "library" });
		await repository.insert({ action: "update", resourceType: "user" });
		const client = databaseFactory.getClient();
		await client
			.update(schema.adminAuditLogs)
			.set({ createdAt: new Date("2026-01-10T00:00:00Z") })
			.where(eq(schema.adminAuditLogs.resourceType, "library"));
		await client
			.update(schema.adminAuditLogs)
			.set({ createdAt: new Date("2026-03-10T00:00:00Z") })
			.where(eq(schema.adminAuditLogs.resourceType, "user"));

		const inRange = await repository.findMany({ page: 1, limit: 10, from: "2026-02-01T00:00:00Z", to: "2026-04-01T00:00:00Z" });
		expect(inRange.data.map((entry) => entry.resourceType)).toEqual(["user"]);
	});

	test("filters by ipAddress and requestId", async () => {
		const repository = new AdminAuditRepository();
		await repository.insert({
			action: "create",
			resourceType: "library",
			ipAddress: "10.0.0.1",
			requestId: "req-abc",
		});
		await repository.insert({
			action: "update",
			resourceType: "user",
			ipAddress: "10.0.0.2",
		});

		const byIp = await repository.findMany({ page: 1, limit: 10, ipAddress: "10.0.0.1" });
		expect(byIp.data).toHaveLength(1);
		expect(byIp.data[0]?.ipAddress).toBe("10.0.0.1");

		const byReq = await repository.findMany({ page: 1, limit: 10, requestId: "req-abc" });
		expect(byReq.data).toHaveLength(1);
		expect(byReq.data[0]?.requestId).toBe("req-abc");
	});

	test("searches by resource id and summary, treating % as literal text", async () => {
		const repository = new AdminAuditRepository();
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
	});
});

describe("admin audit activity", () => {
	test("summarizes activity per administrator with names, filters and unattributed entries", async () => {
		await seedAdministrators();
		const repository = new AdminAuditRepository();
		await repository.insert({ action: "create", resourceType: "library", actorUserId: "admin-1" });
		await repository.insert({ action: "update", resourceType: "library", actorUserId: "admin-1" });
		await repository.insert({ action: "update", resourceType: "user", actorUserId: "admin-1" });
		await repository.insert({ action: "delete", resourceType: "user", actorUserId: "admin-2" });
		await repository.insert({ action: "update", resourceType: "user", actorUserId: "admin-2" });
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
	});

	test("lists the resource types and administrators the filter dropdowns offer", async () => {
		await seedAdministrators();
		const repository = new AdminAuditRepository();
		await repository.insert({ action: "update", resourceType: "metadata", actorUserId: "admin-2" });
		await repository.insert({ action: "create", resourceType: "library", actorUserId: "admin-1" });
		await repository.insert({ action: "update", resourceType: "library", actorUserId: "admin-1" });
		await repository.insert({ action: "update", resourceType: "plugin" });

		const options = await repository.findFilterOptions(10);
		expect(options.resourceTypes).toEqual(["library", "metadata", "plugin"]);
		expect(options.actors).toEqual([
			{ actorUserId: "admin-1", name: "Ada" },
			{ actorUserId: "admin-2", name: "Bob" },
		]);
		expect((await repository.findFilterOptions(2)).resourceTypes).toEqual(["library", "metadata"]);
	});

	test("prunes audit rows older than the cutoff", async () => {
		const repository = new AdminAuditRepository();
		await repository.insert({ action: "create", resourceType: "library" });
		await repository.insert({ action: "update", resourceType: "user" });

		const now = Date.now();
		const client = databaseFactory.getClient();
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
	});
});
