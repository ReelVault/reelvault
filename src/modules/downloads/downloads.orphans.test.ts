import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { systemSettingsStore } from "@/config/system-settings.store";
import { downloadsRepository } from "@/database/repositories/downloads.repository";
import { stubMethod } from "../../../tests/helpers/method-stub";
import { downloadsService } from "./downloads.service";

/** Files of downloads that no longer exist are swept away; everything else in the folder is left alone. */
let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "rv-download-orphans-"));
	systemSettingsStore.setRuntimeValue("paths.downloads", root);
});

afterEach(() => {
	systemSettingsStore.clearRuntimeValues();
	rmSync(root, { recursive: true, force: true });
});

describe("DownloadsService.sweepOrphanArtifacts", () => {
	test("removes the artifacts of deleted downloads and keeps the rest", async () => {
		const kept = crypto.randomUUID();
		const orphan = crypto.randomUUID();
		mkdirSync(join(root, kept));
		writeFileSync(join(root, kept, "video.mp4"), "kept");
		mkdirSync(join(root, orphan));
		writeFileSync(join(root, orphan, "video.mp4"), "orphan");
		mkdirSync(join(root, "not-a-download"));
		const restore = stubMethod(downloadsRepository, "findExistingIds", () => Promise.resolve(new Set([kept])));
		try {
			expect(await downloadsService.sweepOrphanArtifacts()).toEqual({ removed: 1 });

			expect(existsSync(join(root, kept, "video.mp4"))).toBe(true);
			expect(existsSync(join(root, orphan))).toBe(false);
			expect(existsSync(join(root, "not-a-download"))).toBe(true);
		} finally {
			restore.restore();
		}
	});
});
