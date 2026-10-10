import { afterEach, expect, test } from "bun:test";
import { librariesRepository } from "@/database/repositories/libraries.repository";
import { scanFindingsRepository } from "@/database/repositories/scan-findings.repository";
import { stubMethod } from "../../../tests/helpers/method-stub";
import { librariesService } from "./libraries.service";

const stubs: Array<{ restore(): void }> = [];

afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

function stubLibraryExists(): void {
	stubs.push(stubMethod(librariesRepository, "findByIdForRead", () => Promise.resolve({ id: "lib-1" })));
}

test("getScanFindings lists the requested status and returns the counts of both", async () => {
	stubLibraryExists();
	const list = stubMethod(scanFindingsRepository, "list", () =>
		Promise.resolve([{ filePath: "/media/a.mkv", fileName: "a.mkv", reason: "type_mismatch" }]),
	);
	stubs.push(list);
	stubs.push(stubMethod(scanFindingsRepository, "countByStatus", () => Promise.resolve({ active: 1, ignored: 2 })));

	const response = await librariesService.getScanFindings("lib-1", "ignored");

	expect(list.calls).toEqual([["lib-1", "ignored"]]);
	expect(response).toEqual({
		data: [{ filePath: "/media/a.mkv", fileName: "a.mkv", reason: "type_mismatch" }],
		counts: { active: 1, ignored: 2 },
	});
});

test("getScanFindings defaults to the active findings", async () => {
	stubLibraryExists();
	const list = stubMethod(scanFindingsRepository, "list", () => Promise.resolve([]));
	stubs.push(list);
	stubs.push(stubMethod(scanFindingsRepository, "countByStatus", () => Promise.resolve({ active: 0, ignored: 0 })));

	await librariesService.getScanFindings("lib-1");

	expect(list.calls).toEqual([["lib-1", "active"]]);
});

test("setScanFindingIgnored ignores or restores a finding and reports a missing one", async () => {
	stubLibraryExists();
	let found = true;
	stubs.push(stubMethod(scanFindingsRepository, "setIgnored", () => Promise.resolve(found)));

	expect(await librariesService.setScanFindingIgnored("lib-1", "/media/a.mkv", true)).toEqual({
		filePath: "/media/a.mkv",
		ignored: true,
	});
	expect(await librariesService.setScanFindingIgnored("lib-1", "/media/a.mkv", false)).toEqual({
		filePath: "/media/a.mkv",
		ignored: false,
	});

	found = false;
	await expect(librariesService.setScanFindingIgnored("lib-1", "/media/missing.mkv", true)).rejects.toMatchObject({
		code: "entity.not_found",
	});
});
