import { expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { write } from "bun";
import { removeTree } from "@/utils/directory.utils";
import { findIgnoredLocalAssets } from "./ignored-assets.diagnostics";

// Which file names count as unsupported artwork is owned by
// local-artwork-selector.test.ts. What is unique here is the walk: a file in a
// nested folder is found too.
test("ignored asset diagnostics walks nested folders", async () => {
	const root = await mkdtemp(join(tmpdir(), "reelvault-assets-"));
	await mkdir(join(root, "nested"));
	await Promise.all([
		write(join(root, "logo.png"), ""),
		write(join(root, "poster.jpg"), ""),
		write(join(root, "nested", "banner.jpg"), ""),
	]);
	try {
		const ignored = await findIgnoredLocalAssets(root);

		expect(ignored).toContainEqual({
			path: join(root, "nested", "banner.jpg"),
			fileName: "banner.jpg",
			reason: "unsupported-artwork-type",
		});
	} finally {
		await removeTree(root);
	}
});
