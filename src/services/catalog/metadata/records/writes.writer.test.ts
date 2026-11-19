import { afterEach, describe, expect, test } from "bun:test";
import { sidecarSyncService } from "@/modules/metadata-sidecars/sidecar-sync.service";
import { insertMovieMediaFile } from "../../../../../tests/helpers/media.fixture";
import { type MethodStub, stubMethod } from "../../../../../tests/helpers/method-stub.helper";
import { insertMetadata, selectAdminAuditLogs, selectMetadata } from "../../../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../../../tests/helpers/test-database.helper";
import { mergeMetadata, update } from "./writes.writer";

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

describe("metadata update", () => {
	test("null clears an optional field and an absent key leaves it unchanged", async () => {
		await insertMetadata(db.client(), {
			id: "m1",
			stableKey: "m1",
			title: "Alien",
			type: "movie",
			releaseDate: "1979-05-25",
			overview: "In space no one can hear you scream.",
			tagline: "A tagline",
			budget: 11_000_000,
		});
		stubs.push(stubMethod(sidecarSyncService, "scheduleSync", () => undefined));

		await update("m1", { overview: null, budget: null });

		const stored = (await selectMetadata(db.client())).find((row) => row.id === "m1");
		expect(stored?.overview).toBeNull();
		expect(stored?.budget).toBeNull();
		expect(stored?.tagline).toBe("A tagline");
	});
});
