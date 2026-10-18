import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { removeTree } from "@/utils/directory.utils";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { sidecarAssetsService } from "./sidecar-assets.service";

const db = useTestDatabase();

async function createLibrary(name: string, paths: string[]): Promise<string> {
	const client = db.client();
	const [library] = await client.insert(schema.libraries).values({ name, type: "movies" }).returning({ id: schema.libraries.id });
	if (!library) throw new Error("Expected the insert to return a library");

	for (const [index, path] of paths.entries()) {
		await client.insert(schema.libraryPaths).values({ libraryId: library.id, stableKey: `${name}-${index}`, path });
	}

	return library.id;
}

describe("sidecarAssetsService", () => {
	test("lists the unsupported artwork under every library path", async () => {
		const firstRoot = await mkdtemp(join(tmpdir(), "reelvault-assets-"));
		const secondRoot = await mkdtemp(join(tmpdir(), "reelvault-assets-"));
		try {
			await writeFile(join(firstRoot, "logo.png"), "");
			await writeFile(join(firstRoot, "poster.jpg"), "");
			await mkdir(join(secondRoot, "nested"));
			await writeFile(join(secondRoot, "nested", "banner.jpg"), "");
			const libraryId = await createLibrary("assets-two-roots", [firstRoot, secondRoot]);

			const assets = await sidecarAssetsService.getIgnoredAssets(libraryId);

			expect(assets).toHaveLength(2);
			expect(assets).toContainEqual({ path: join(firstRoot, "logo.png"), fileName: "logo.png", reason: "unsupported-artwork-type" });
			expect(assets).toContainEqual({
				path: join(secondRoot, "nested", "banner.jpg"),
				fileName: "banner.jpg",
				reason: "unsupported-artwork-type",
			});
		} finally {
			await removeTree(firstRoot);
			await removeTree(secondRoot);
		}
	});

	test("serves repeated refreshes from the TTL cache instead of walking again", async () => {
		const root = await mkdtemp(join(tmpdir(), "reelvault-assets-"));
		try {
			await writeFile(join(root, "logo.png"), "");
			const libraryId = await createLibrary("assets-cached", [root]);

			const first = await sidecarAssetsService.getIgnoredAssets(libraryId);
			await writeFile(join(root, "banner.jpg"), "");
			const second = await sidecarAssetsService.getIgnoredAssets(libraryId);

			expect(first).toHaveLength(1);
			expect(second).toEqual(first);
		} finally {
			await removeTree(root);
		}
	});
});
