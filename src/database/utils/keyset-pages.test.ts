import { describe, expect, test } from "bun:test";
import { collectKeysetPages } from "./keyset-pages";

describe("collectKeysetPages", () => {
	test("fetches full pages until a short page and advances the cursor", async () => {
		const rows = Array.from({ length: 5 }, (_, index) => ({ id: `id-${index}` }));
		const cursors: Array<string | undefined> = [];
		const pages: string[][] = [];

		const total = await collectKeysetPages({
			pageSize: 2,
			fetchPage: (cursor) => {
				cursors.push(cursor);
				const start = cursor ? rows.findIndex((row) => row.id === cursor) + 1 : 0;

				return Promise.resolve(rows.slice(start, start + 2));
			},
			onPage: (page) => {
				pages.push(page.map((row) => row.id));
			},
		});

		expect(total).toBe(5);
		expect(cursors).toEqual([undefined, "id-1", "id-3"]);
		expect(pages).toEqual([["id-0", "id-1"], ["id-2", "id-3"], ["id-4"]]);
	});

	test("stops on an empty first page without calling onPage", async () => {
		let called = false;

		const total = await collectKeysetPages({
			pageSize: 10,
			fetchPage: () => Promise.resolve([]),
			onPage: () => {
				called = true;
			},
		});

		expect(total).toBe(0);
		expect(called).toBe(false);
	});

	test("runs beforePage before every fetch and betweenPages only between pages", async () => {
		const rows = Array.from({ length: 3 }, (_, index) => ({ id: `id-${index}` }));
		const events: string[] = [];

		await collectKeysetPages({
			pageSize: 2,
			beforePage: () => {
				events.push("before");
			},
			fetchPage: (cursor) => {
				events.push(`fetch:${cursor ?? "start"}`);
				const start = cursor ? rows.findIndex((row) => row.id === cursor) + 1 : 0;

				return Promise.resolve(rows.slice(start, start + 2));
			},
			onPage: () => {
				events.push("page");
			},
			betweenPages: () => {
				events.push("between");
			},
		});

		expect(events).toEqual(["before", "fetch:start", "page", "between", "before", "fetch:id-1", "page"]);
	});

	test("stops when a full page carries no id", async () => {
		const pages: Array<Array<{ id: string }>> = [];

		const total = await collectKeysetPages({
			pageSize: 1,
			fetchPage: () => Promise.resolve([{ id: "" }]),
			onPage: (page) => {
				pages.push(page);
			},
		});

		expect(total).toBe(1);
		expect(pages).toHaveLength(1);
	});

	test("uses the last string as the cursor for id-list pages", async () => {
		const pages = [["a", "b"], ["c", "d"], ["e"]];
		const cursors: Array<string | undefined> = [];
		const seen: string[][] = [];

		const total = await collectKeysetPages({
			pageSize: 2,
			fetchPage: (cursor) => {
				cursors.push(cursor);
				const index = cursor ? pages.findIndex((page) => page.at(-1) === cursor) + 1 : 0;

				return Promise.resolve(pages[index] ?? []);
			},
			onPage: (page) => {
				seen.push(page);
			},
		});

		expect(total).toBe(5);
		expect(cursors).toEqual([undefined, "b", "d"]);
		expect(seen).toEqual([["a", "b"], ["c", "d"], ["e"]]);
	});
});
