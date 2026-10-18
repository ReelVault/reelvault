import { expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { write } from "bun";
import { removeTree } from "@/utils/directory.utils";
import { findIgnoredLocalAssets } from "./ignored-assets.diagnostics";

test("ignored asset diagnostics reports logos and banners only", async () => {
	const root = await mkdtemp(join(tmpdir(), "reelvault-assets-"));
	await mkdir(join(root, "nested"));
	await Promise.all([
		write(join(root, "logo.png"), ""),
		write(join(root, "poster.jpg"), ""),
		write(join(root, "nested", "banner.jpg"), ""),
	]);
	try {
		expect(await findIgnoredLocalAssets(root)).toEqual([
			{ path: join(root, "logo.png"), fileName: "logo.png", reason: "unsupported-artwork-type" },
			{ path: join(root, "nested", "banner.jpg"), fileName: "banner.jpg", reason: "unsupported-artwork-type" },
		]);
	} finally {
		await removeTree(root);
	}
});
