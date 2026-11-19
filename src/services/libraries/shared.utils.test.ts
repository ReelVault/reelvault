import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PromiseTimeoutError } from "@/utils/promise.utils";
import { mockModuleWithRealExports, restoreModuleMocks } from "../../../tests/helpers/module-mock.helper";
import { describePath } from "./shared.utils";

describe("describePath", () => {
	test("reports an existing directory as existing and a directory", async () => {
		const dir = mkdtempSync(join(tmpdir(), "rv-describe-path-"));
		try {
			expect(await describePath(dir)).toEqual({ exists: true, isDirectory: true });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("reports a path whose stat times out as missing instead of waiting on it", async () => {
		mockModuleWithRealExports("@/utils/file.utils", {
			statWithTimeout: () => Promise.reject(new PromiseTimeoutError("stat timed out")),
		});
		try {
			expect(await describePath(tmpdir())).toEqual({ exists: false, isDirectory: false });
		} finally {
			restoreModuleMocks();
		}
	});
});
