import { expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { insertWorkerJobs, insertWorkerOperations } from "../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { readCompletedOperationResult } from "./result.reader";

const db = useTestDatabase();

test("a damaged worker result reads as no result instead of throwing", async () => {
	const client = db.client();
	const now = new Date();
	await insertWorkerOperations(client, {
		id: "op-damaged-result",
		type: "media-file-audit",
		status: "completed",
		createdAt: now,
		updatedAt: now,
	});
	await insertWorkerJobs(client, {
		id: "job-damaged-result",
		workerId: "media-file-audit",
		operationId: "op-damaged-result",
		data: "{}",
		status: "completed",
		result: "not-json",
		runAt: now,
		createdAt: now,
		updatedAt: now,
	});

	expect(await readCompletedOperationResult("op-damaged-result", Type.Object({}))).toBeNull();
});
