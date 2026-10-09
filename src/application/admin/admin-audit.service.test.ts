import { afterEach, describe, expect, test } from "bun:test";
import { adminAuditRepository } from "@/database/repositories/admin-audit.repository";
import { stubMethod } from "../../../tests/helpers/method-stub";
import { AUDIT_EXPORT_MAX_ENTRIES, adminAuditService } from "./admin-audit.service";

const stubs: Array<{ restore(): void }> = [];

afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

function row(id: string) {
	return {
		id,
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
	};
}

describe("AdminAuditService.exportEntries", () => {
	test("CSV export quotes cells with separators and carries the snapshots as JSON text", async () => {
		const findMany = stubMethod(adminAuditRepository, "findMany", () => Promise.resolve({ data: [row("a1")], total: 1 }));
		stubs.push(findMany);

		const exported = await adminAuditService.exportEntries({ resourceType: "library", q: "lib", format: "csv" });
		const [header, line] = exported.body.trimEnd().split("\n");

		expect(findMany.calls).toEqual([[expect.objectContaining({ resourceType: "library", q: "lib", page: 1 })]]);
		expect(header).toBe(
			"id,createdAt,actorUserId,action,resourceType,resourceId,resourceName,summary,requestId,ipAddress,userAgent,before,after",
		);
		expect(line).toBe(
			'a1,2026-10-09T10:00:00.000Z,admin-1,update,library,lib-1,Movies,"Renamed, then moved",req-1,10.0.0.1,audit-test,"{""name"":""Old, name""}","{""name"":""Movies""}"',
		);
		expect(exported.filename.startsWith("audit-")).toBe(true);
		expect(exported.filename.endsWith(".csv")).toBe(true);
	});

	test("JSON Lines export writes one parsed entry per line", async () => {
		stubs.push(stubMethod(adminAuditRepository, "findMany", () => Promise.resolve({ data: [row("a1"), row("a2")], total: 2 })));

		const exported = await adminAuditService.exportEntries({ format: "jsonl" });
		const entries = exported.body
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line) as { id: string; before: unknown });

		expect(entries.map((entry) => entry.id)).toEqual(["a1", "a2"]);
		expect(entries[0]?.before).toEqual({ name: "Old, name" });
		expect(exported.contentType).toBe("application/x-ndjson; charset=utf-8");
	});

	test("refuses an export past the cap instead of cutting it short", async () => {
		const rows = Array.from({ length: AUDIT_EXPORT_MAX_ENTRIES + 1 }, (_, index) => row(`a${index}`));
		stubs.push(stubMethod(adminAuditRepository, "findMany", () => Promise.resolve({ data: rows, total: rows.length })));

		await expect(adminAuditService.exportEntries({ format: "csv" })).rejects.toMatchObject({
			code: "admin.audit.export_too_large",
			params: { limit: AUDIT_EXPORT_MAX_ENTRIES },
		});
	});
});

describe("AdminAuditService.getSummary", () => {
	test("maps the aggregate to the API shape and caps how many administrators are listed", async () => {
		const summarize = stubMethod(adminAuditRepository, "summarizeByActor", () =>
			Promise.resolve({
				total: 3,
				actors: [
					{
						actorUserId: "admin-1",
						name: "Ada",
						total: 3,
						creates: 1,
						updates: 2,
						deletes: 0,
						lastAt: new Date("2026-10-09T10:00:00Z"),
					},
				],
			}),
		);
		stubs.push(summarize);

		const summary = await adminAuditService.getSummary({ action: "update", limit: 500 });

		expect(summarize.calls).toEqual([[{ action: "update" }, 50]]);
		expect(summary).toEqual({
			total: 3,
			actors: [
				{
					actorUserId: "admin-1",
					name: "Ada",
					total: 3,
					creates: 1,
					updates: 2,
					deletes: 0,
					lastAt: "2026-10-09T10:00:00.000Z",
				},
			],
		});
	});
});
