import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "@/utils/file.utils";
import { ReelVaultFormatAdapter } from "./reelvault-format.adapter";

const snapshot = {
	reelvaultSchemaVersion: 1,
	title: "A < B",
	identifiers: { imdb: "tt1905041" },
	providerIds: {},
	genres: [],
	keywords: [],
	productionCompanies: [],
	cast: [],
	crew: [],
	ratings: [],
};

test("ReelVault adapter writes its own NFO without changing a foreign movie.nfo", async () => {
	const directory = await mkdtemp(join(tmpdir(), "reelvault-format-"));
	const foreignPath = join(directory, "movie.nfo");
	const documentPath = join(directory, "movie.reelvault.nfo");
	await writeFile(foreignPath, "foreign");
	try {
		const adapter = new ReelVaultFormatAdapter();
		await adapter.write({ documentPath, document: snapshot });
		expect(await readFile(foreignPath, "utf8")).toBe("foreign");
		expect(await adapter.read({ documentPath })).toMatchObject({
			mediaKind: "movie",
			title: "A < B",
			identifiers: { imdb: "tt1905041" },
		});
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});
