import { describe, expect, it } from "bun:test";
import { schemaDeclaresProperty } from "../../../../tests/helpers/schema-contract";
import { mediaFilesRoutes } from "./media-files.routes";

describe("Media Files Routes", () => {
	it("compiles and mounts the markers routes", () => {
		const routes = mediaFilesRoutes.routes;
		const paths = routes.map((r) => `${r.method} ${r.path}`);

		expect(paths.some((p) => p.includes("GET") && p.includes("/markers"))).toBe(true);
		expect(paths.some((p) => p.includes("POST") && p.includes("/markers"))).toBe(true);
		expect(paths.some((p) => p.includes("DELETE") && p.includes("/markers"))).toBe(true);
		expect(paths.some((p) => p.includes("POST") && p.includes("/scan"))).toBe(true);
		expect(paths.some((p) => p.includes("POST") && p.includes("/reassign"))).toBe(true);
		expect(paths.some((p) => p.includes("GET") && p.includes("/audit"))).toBe(true);
	});

	it("declares the library relation in the paginated list response model", () => {
		const listModel = mediaFilesRoutes.models["media-files.paginated.schema"];

		expect(listModel).toBeDefined();
		expect(schemaDeclaresProperty(listModel?.schema, "library")).toBe(true);
		expect(schemaDeclaresProperty(listModel?.schema, "audioStreams")).toBe(true);
	});
});
