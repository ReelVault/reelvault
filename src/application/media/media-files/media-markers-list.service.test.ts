import { afterEach, describe, expect, test } from "bun:test";
import { mediaMarkersRepository } from "@/database/repositories/media-markers.repository";
import { stubMethod } from "../../../../tests/helpers/method-stub";
import { mediaService } from "./media-files.service";

const stubs: Array<{ restore(): void }> = [];

afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

describe("MediaFilesService.listAllMarkers", () => {
	test("returns one page with the total and the page count", async () => {
		const findPage = stubMethod(mediaMarkersRepository, "findPage", () => Promise.resolve({ rows: [], total: 5 }));
		stubs.push(findPage);

		const result = await mediaService.listAllMarkers({ page: 2, limit: 2 });

		expect(result).toMatchObject({ data: [], total: 5, totalPages: 3, page: 2, limit: 2 });
		expect(findPage.calls[0]?.[0]).toMatchObject({ limit: 2, offset: 2 });
	});
});
