import { describe, expect, test } from "bun:test";
import type { Subtitle } from "@sdk/common";
import type { SubtitleEntity } from "@sdk/common/subtitle.types";
import { NotFoundError } from "@/utils/errors";
import type { SubtitleContent } from "./subtitle-content.resolver";
import { SubtitlesService } from "./subtitles.service";

const ROW: SubtitleEntity = {
	id: "sub-1",
	mediaFileId: "file-1",
	language: "pl",
	label: "Polski",
	format: "vtt",
	type: "external",
	filePath: "/data/subtitles/movie.pl.vtt",
	streamIndex: null,
	isDefault: true,
	isForced: false,
	isHearingImpaired: false,
	createdAt: new Date("2026-08-01T10:00:00.000Z"),
	updatedAt: new Date("2026-08-01T10:00:00.000Z"),
};

interface HarnessOverrides {
	rows?: Array<Partial<SubtitleEntity> & Pick<SubtitleEntity, "id" | "mediaFileId">>;
	resolveContent?: SubtitleContent;
	downloadedId?: string;
}

function createService(overrides: HarnessOverrides = {}) {
	const rows = new Map<string, SubtitleEntity>();
	for (const row of overrides.rows ?? [{ ...ROW }]) {
		rows.set(row.id, { ...ROW, ...row });
	}

	const events: string[] = [];
	const providerCalls = { status: 0, search: 0 };
	const content: SubtitleContent = overrides.resolveContent ?? { contentType: "text/vtt", file: new Blob(["WEBVTT"]) };
	const service = new SubtitlesService({
		findPage: () => Promise.resolve({ page: 1, limit: 20, total: rows.size, totalPages: 1, data: [...rows.values()] }),
		findByMediaFileId: (mediaFileId) => Promise.resolve([...rows.values()].filter((row) => row.mediaFileId === mediaFileId)),
		findById: (id) => Promise.resolve(rows.get(id)),
		createRow: (_body, type) => {
			events.push(`create:${type}`);

			return Promise.resolve({ ...ROW, id: "sub-new" });
		},
		updateRow: (id) => {
			events.push(`update:${id}`);

			return Promise.resolve({ ...ROW, id });
		},
		deleteRow: (id) => {
			events.push(`deleteRow:${id}`);

			return Promise.resolve(rows.get(id) ?? null);
		},
		getProviderStatus: () => {
			providerCalls.status++;

			return [];
		},
		searchProviders: () => {
			providerCalls.search++;

			return Promise.resolve([]);
		},
		downloadSubtitle: () => {
			events.push("download");

			return Promise.resolve(overrides.downloadedId ?? "sub-1");
		},
		infoCache: {
			getOrSet: (id) => {
				events.push(`cacheGet:${id}`);

				return Promise.resolve({ type: "external", mediaFileId: "file-1", streamIndex: null, format: "vtt" });
			},
			invalidate: (id) => {
				events.push(`cacheInvalidate:${id}`);
			},
		},
		contentResolver: {
			resolve: (id, info) => {
				events.push(`resolve:${id}:${info.type}`);

				return Promise.resolve(content);
			},
		},
		fileCleaner: {
			deleteArtifacts: (id, subtitle) => {
				events.push(`clean:${id}:${subtitle.type}`);

				return Promise.resolve();
			},
		},
		waitForInFlightExtraction: (id) => {
			events.push(`waitFor:${id}`);

			return Promise.resolve();
		},
	});

	return { service, events, providerCalls, content };
}

const PUBLIC_ROW: Subtitle = {
	id: "sub-1",
	mediaFileId: "file-1",
	language: "pl",
	label: "Polski",
	format: "vtt",
	type: "external",
	streamIndex: null,
	isDefault: true,
	isForced: false,
	isHearingImpaired: false,
	createdAt: "2026-08-01T10:00:00.000Z",
	updatedAt: "2026-08-01T10:00:00.000Z",
};

describe("SubtitlesService", () => {
	test("getAll returns the paginated rows mapped to the public contract", async () => {
		const { service } = createService();

		const result = await service.getAll();

		expect(result.total).toBe(1);
		expect(result.data).toEqual([PUBLIC_ROW]);
	});

	test("getByMediaFileId filters rows by the media file and maps them", async () => {
		const { service } = createService({ rows: [{ ...ROW }, { id: "sub-2", mediaFileId: "file-2" }] });

		const result = await service.getByMediaFileId("file-2");

		expect(result.map((item) => item.id)).toEqual(["sub-2"]);
	});

	test("getById throws not found for a missing subtitle", () => {
		const { service } = createService();

		expect(service.getById("missing")).rejects.toBeInstanceOf(NotFoundError);
	});

	test("create resolves the subtitle type from the request source", async () => {
		const { service, events } = createService();

		const result = await service.create({ mediaFileId: "file-1", streamIndex: 3, language: "pl", format: "subrip" });

		expect(result.id).toBe("sub-new");
		expect(events).toEqual(["create:embedded"]);
	});

	test("update invalidates the content cache before reading the row", async () => {
		const { service, events } = createService();

		const result = await service.update("sub-1", { language: "en" });

		expect(result.id).toBe("sub-1");
		expect(events).toEqual(["cacheInvalidate:sub-1", "update:sub-1"]);
	});

	test("getContent resolves through the info cache and the content resolver", async () => {
		const { service, events, content } = createService();

		const result = await service.getContent("sub-1");

		expect(result).toBe(content);
		expect(events).toEqual(["cacheGet:sub-1", "resolve:sub-1:external"]);
	});

	test("delete invalidates the cache, waits for in-flight extraction, then deletes and cleans", async () => {
		const { service, events } = createService();

		await expect(service.delete("sub-1")).resolves.toEqual({ success: true });
		expect(events).toEqual(["cacheInvalidate:sub-1", "waitFor:sub-1", "deleteRow:sub-1", "clean:sub-1:external"]);
	});

	test("delete throws not found when the row is gone but still coordinates first", () => {
		const { service, events } = createService({ rows: [] });

		expect(service.delete("sub-1")).rejects.toBeInstanceOf(NotFoundError);
		expect(events).toEqual(["cacheInvalidate:sub-1", "waitFor:sub-1", "deleteRow:sub-1"]);
	});

	test("downloadFromProvider returns the downloaded subtitle mapped to the public contract", async () => {
		const { service, events } = createService({ downloadedId: "sub-1" });

		const result = await service.downloadFromProvider("provider-1", { mediaFileId: "file-1", subtitleId: "p-sub-1" });

		expect(result).toEqual(PUBLIC_ROW);
		expect(events).toEqual(["download"]);
	});

	test("downloadFromProvider throws not found when the download has no subtitle row", () => {
		const { service } = createService({ downloadedId: "gone" });

		expect(service.downloadFromProvider("provider-1", { mediaFileId: "file-1", subtitleId: "p-sub-1" })).rejects.toBeInstanceOf(
			NotFoundError,
		);
	});

	test("provider status and search delegate to the plugins layer", async () => {
		const { service, providerCalls } = createService();

		await service.getProviders();
		await service.searchProviders({ mediaFileId: "file-1" });

		expect(providerCalls).toEqual({ status: 1, search: 1 });
	});
});
