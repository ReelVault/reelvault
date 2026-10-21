import { afterEach, describe, expect, test } from "bun:test";
import { adminAuditRepository } from "@/repositories/admin-audit.repository";
import { type MethodStub, stubMethod } from "../../../tests/helpers/method-stub.helper";
import { insertAdminAuditLogs, insertUsers } from "../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { AUDIT_EXPORT_MAX_ENTRIES, adminAuditService } from "./admin-audit.service";

// Audit rows are real rows. The export cap check is the one place that stubs the repository:
// reaching it with real rows would take ten thousand inserts.
const db = useTestDatabase();
const stubs: MethodStub[] = [];

afterEach(() => {
	for (const stub of stubs.splice(0).toReversed()) stub.restore();
});

async function seedAudit(): Promise<void> {
	const client = db.client();
	await insertUsers(client, { id: "admin-1", name: "Admin", email: "admin@example.com", emailVerified: true, role: "admin" });
	await insertAdminAuditLogs(client, [
		{
			id: "a1",
			actorUserId: "admin-1",
			action: "update",
			resourceType: "library",
			resourceId: "lib-1",
			resourceName: "Movies",
			summary: "Renamed, then moved",
			beforeJson: '{"name":"Old, name"}',
			afterJson: '{"name":"Movies"}',
			requestId: "req-1",
			ipAddress: "10.0.0.1",
			userAgent: "audit-test",
			createdAt: new Date("2026-10-09T10:00:00Z"),
		},
		{
			id: "a2",
			actorUserId: "admin-1",
			action: "update",
			resourceType: "plugin",
			resourceId: "org.example.a",
			resourceName: "Plugin",
			summary: "Enabled",
			createdAt: new Date("2026-10-09T11:00:00Z"),
		},
	]);
}

describe("AdminAuditService.record", () => {
	test("resolves the caller context into the stored columns", async () => {
		await seedAudit();

		await adminAuditService.record({
			action: "update",
			resourceType: "library",
			resourceId: "lib-2",
			context: {
				actorUserId: "admin-1",
				headers: new Headers({
					"x-reelvault-client-ip": "10.0.0.9",
					"x-request-id": "req-9",
					"user-agent": "audit-test",
				}),
			},
		});

		const { data } = await adminAuditRepository.findMany({ page: 1, limit: 10, resourceType: "library" });
		const recorded = data.find((entry) => entry.resourceId === "lib-2");
		expect(recorded).toMatchObject({
			actorUserId: "admin-1",
			requestId: "req-9",
			ipAddress: "10.0.0.9",
			userAgent: "audit-test",
		});
	});

	test("keeps an explicit request id over the one the request carried", async () => {
		await seedAudit();

		await adminAuditService.record({
			action: "update",
			resourceType: "library",
			resourceId: "lib-3",
			context: { requestId: "req-explicit", headers: new Headers({ "x-request-id": "req-header" }) },
		});

		const { data } = await adminAuditRepository.findMany({ page: 1, limit: 10, resourceType: "library" });
		expect(data.find((entry) => entry.resourceId === "lib-3")?.requestId).toBe("req-explicit");
	});
});

describe("AdminAuditService.exportEntries", () => {
	test("CSV export keeps only the matching entries, quotes cells with separators and carries the snapshots as JSON text", async () => {
		await seedAudit();

		const exported = await adminAuditService.exportEntries({ resourceType: "library", q: "lib", format: "csv" });
		const [header, line, ...rest] = exported.body.trimEnd().split("\n");

		expect(header).toBe(
			"id,createdAt,actorUserId,action,resourceType,resourceId,resourceName,summary,requestId,ipAddress,userAgent,before,after",
		);
		expect(line).toBe(
			'a1,2026-10-09T10:00:00.000Z,admin-1,update,library,lib-1,Movies,"Renamed, then moved",req-1,10.0.0.1,audit-test,"{""name"":""Old, name""}","{""name"":""Movies""}"',
		);
		expect(rest).toEqual([]);
		expect(exported.filename.startsWith("audit-")).toBe(true);
		expect(exported.filename.endsWith(".csv")).toBe(true);
	});

	test("refuses an export past the cap instead of cutting it short", async () => {
		const row = {
			id: "a0",
			actorUserId: "admin-1",
			action: "update",
			resourceType: "library",
			resourceId: "lib-1",
			resourceName: null,
			summary: "x",
			beforeJson: null,
			afterJson: null,
			requestId: null,
			ipAddress: null,
			userAgent: null,
			createdAt: new Date("2026-10-09T10:00:00Z"),
		};
		const rows = Array.from({ length: AUDIT_EXPORT_MAX_ENTRIES + 1 }, (_, index) => ({ ...row, id: `a${index}` }));
		stubs.push(stubMethod(adminAuditRepository, "findMany", () => Promise.resolve({ data: rows, total: rows.length })));

		await expect(adminAuditService.exportEntries({ format: "csv" })).rejects.toMatchObject({
			code: "admin.audit.export_too_large",
			params: { limit: AUDIT_EXPORT_MAX_ENTRIES },
		});
	});
});
