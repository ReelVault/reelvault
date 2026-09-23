import { describe, expect, test } from "bun:test";
import { readXmlDocument } from "./xml-document.reader";
import { readXmlObject, readXmlText, readXmlTexts } from "./xml-value.reader";

function parse(input: string): Readonly<Record<string, unknown>> {
	const document = readXmlDocument(input);
	if (!document) throw new Error(`test fixture failed to parse: ${input}`);

	const root = readXmlObject(document, "catalog");
	if (!root) throw new Error("test fixture is missing the catalog root");

	return root;
}

describe("readXmlObject", () => {
	test("returns the element record and undefined for missing or scalar elements", () => {
		const catalog = parse("<catalog><title>Tom</title></catalog>");

		expect(readXmlObject({ values: catalog }, "title")).toBeUndefined();
		expect(readXmlObject({ values: { catalog } }, "catalog")).toBeDefined();
	});
});

describe("readXmlText", () => {
	test("decodes entities and keeps a BOM-prefixed document readable", () => {
		const catalog = parse('\uFEFF<?xml version="1.0"?><catalog><title>Tom &amp; Jerry</title></catalog>');

		expect(readXmlText(catalog, "title")).toBe("Tom & Jerry");
	});

	test("trim-only whitespace collapses to undefined", () => {
		const catalog = parse("<catalog><title>   </title><empty></empty></catalog>");

		expect(readXmlText(catalog, "title")).toBeUndefined();
		expect(readXmlText(catalog, "empty")).toBeUndefined();
	});

	test("scalar values become strings and nested elements fall back to #text", () => {
		const catalog = parse("<catalog><year>2013</year><enabled>true</enabled><plain>text</plain></catalog>");

		expect(readXmlText(catalog, "year")).toBe("2013");
		expect(readXmlText(catalog, "enabled")).toBe("true");
		expect(readXmlText(catalog, "plain")).toBe("text");
	});
});

describe("readXmlTexts", () => {
	test("collects repeated elements", () => {
		const catalog = parse("<catalog><tag>a</tag><tag>b</tag></catalog>");

		expect(readXmlTexts(catalog, "tag")).toEqual(["a", "b"]);
	});

	test("wraps a single element and skips missing ones", () => {
		const catalog = parse("<catalog><tag>only</tag></catalog>");

		expect(readXmlTexts(catalog, "tag")).toEqual(["only"]);
		expect(readXmlTexts(catalog, "missing")).toEqual([]);
	});
});
