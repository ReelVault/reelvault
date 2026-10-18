import { describe, expect, test } from "bun:test";
import { readXmlDocument } from "./xml-document.reader";
import { readXmlObject, readXmlText, readXmlTexts } from "./xml-value.reader";

async function parse(input: string): Promise<Readonly<Record<string, unknown>>> {
	const document = await readXmlDocument(input);
	if (!document) throw new Error(`test fixture failed to parse: ${input}`);

	const root = readXmlObject(document, "catalog");
	if (!root) throw new Error("test fixture is missing the catalog root");

	return root;
}

describe("readXmlObject", () => {
	test("returns the element record for a nested element and undefined for missing or scalar ones", async () => {
		const catalog = await parse("<catalog><fanart><thumb>poster.jpg</thumb></fanart><title>Tom</title></catalog>");

		expect(readXmlObject({ values: catalog }, "fanart")).toEqual({ thumb: "poster.jpg" });
		expect(readXmlObject({ values: catalog }, "title")).toBeUndefined();
		expect(readXmlObject({ values: catalog }, "missing")).toBeUndefined();
	});
});

describe("readXmlText", () => {
	test("decodes entities and keeps a BOM-prefixed document readable", async () => {
		const catalog = await parse('﻿<?xml version="1.0"?><catalog><title>Tom &amp; Jerry</title></catalog>');

		expect(readXmlText(catalog, "title")).toBe("Tom & Jerry");
	});

	test("trim-only whitespace collapses to undefined", async () => {
		const catalog = await parse("<catalog><title>   </title><empty></empty></catalog>");

		expect(readXmlText(catalog, "title")).toBeUndefined();
		expect(readXmlText(catalog, "empty")).toBeUndefined();
	});

	test("scalar values become strings and elements with attributes fall back to #text", async () => {
		const catalog = await parse('<catalog><year>2013</year><enabled>true</enabled><rating max="10">7.5</rating></catalog>');

		expect(readXmlText(catalog, "year")).toBe("2013");
		expect(readXmlText(catalog, "enabled")).toBe("true");
		expect(readXmlText(catalog, "rating")).toBe("7.5");
	});
});

describe("readXmlTexts", () => {
	test("collects repeated elements", async () => {
		const catalog = await parse("<catalog><tag>a</tag><tag>b</tag></catalog>");

		expect(readXmlTexts(catalog, "tag")).toEqual(["a", "b"]);
	});

	test("wraps a single element and skips missing ones", async () => {
		const catalog = await parse("<catalog><tag>only</tag></catalog>");

		expect(readXmlTexts(catalog, "tag")).toEqual(["only"]);
		expect(readXmlTexts(catalog, "missing")).toEqual([]);
	});
});
