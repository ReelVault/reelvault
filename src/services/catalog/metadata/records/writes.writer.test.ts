import { afterEach, describe, expect, test } from "bun:test";
import { sidecarSyncService } from "@/modules/metadata-sidecars/sidecar-sync.service";
import { insertMovieMediaFile } from "../../../../../tests/helpers/media.fixture";
import { type MethodStub, stubMethod } from "../../../../../tests/helpers/method-stub.helper";
import { insertMetadata, selectAdminAuditLogs, selectMetadata } from "../../../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../../../tests/helpers/test-database.helper";
import { mergeMetadata } from "./writes.writer";

const db = useTestDatabase();
const stubs: MethodStub[] = [];

afterEach(() => {
	for (const stub of stubs.splice(0).toReversed()) stub.restore();
});

describe("metadata merge audit", () => {
	test("records the target as it is after the merge, with the media it received", async () => {
		await insertMetadata(db.client(), { id: "target", stableKey: "target", title: "target", type: "movie", releaseDate: "2020-01-01" });
		await insertMovieMediaFile(db.client(), "/media/source.mkv", "source");
		stubs.push(stubMethod(sidecarSyncService, "scheduleSync", () => undefined));

		await mergeMetadata("target", "source");

		const mergeAudit = (await selectAdminAuditLogs(db.client())).find((row) => row.resourceType === "metadata_merge");
		const storedTarget = (await selectMetadata(db.client())).find((row) => row.id === "target");
		const auditedAfter = JSON.parse(mergeAudit?.afterJson ?? "null");

		expect(storedTarget?.latestMediaCreatedAt).not.toBeNull();
		expect(auditedAfter?.latestMediaCreatedAt).toBe(storedTarget?.latestMediaCreatedAt?.toISOString());
	});
});
