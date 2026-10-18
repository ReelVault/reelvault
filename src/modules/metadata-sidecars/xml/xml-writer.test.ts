import { describe, expect, test } from "bun:test";
import { writeXmlDocument } from "./xml.writer";
import { readXmlDocument } from "./xml-document.reader";
import { readXmlChildObject, readXmlObject, readXmlText, readXmlTexts } from "./xml-value.reader";

describe("writeXmlDocument", () => {
	test("escapes values and produces a readable document", async () => {
		const output = await writeXmlDocument({ rootName: "catalog", values: { title: "A < B & C" } });
		const document = await readXmlDocument(output);
		const catalog = document ? readXmlObject(document, "catalog") : undefined;

		expect(output).toContain("A &lt; B &amp; C");
		expect(output.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBeTrue();
		expect(catalog ? readXmlText(catalog, "title") : undefined).toBe("A < B & C");
	});

	test("nests objects as repeated child elements and writes empty objects self-closed", async () => {
		const output = await writeXmlDocument({ rootName: "movie", values: { title: "T", empty: {}, tags: { tag: ["a", "b"] } } });

		expect(output).toContain("<empty/>");
		expect(output).toContain("<tag>a</tag>");
		expect(output).toContain("<tag>b</tag>");

		const document = await readXmlDocument(output);
		const movie = document ? readXmlObject(document, "movie") : undefined;
		const tags = movie ? readXmlChildObject(movie, "tags") : undefined;
		expect(tags ? readXmlTexts(tags, "tag") : undefined).toEqual(["a", "b"]);
	});
});
