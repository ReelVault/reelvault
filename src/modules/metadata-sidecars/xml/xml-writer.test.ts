import { describe, expect, test } from "bun:test";
import { readXmlDocument } from "./xml-document.reader";
import { readXmlObject, readXmlText } from "./xml-value.reader";
import { writeXmlDocument } from "./xml-writer";

describe("writeXmlDocument", () => {
	test("escapes values and produces a readable document", () => {
		const output = writeXmlDocument({ rootName: "catalog", values: { title: "A < B & C" } });
		const document = readXmlDocument(output);
		const catalog = document ? readXmlObject(document, "catalog") : undefined;

		expect(output).toContain("A &lt; B &amp; C");
		expect(output.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBeTrue();
		expect(catalog ? readXmlText(catalog, "title") : undefined).toBe("A < B & C");
	});

	test("nests objects and suppresses empty nodes", () => {
		const output = writeXmlDocument({ rootName: "movie", values: { title: "T", empty: {}, tags: { tag: ["a", "b"] } } });

		expect(output).toContain("<empty/>");
		expect(output).toContain("<tag>a</tag>");
		expect(readXmlDocument(output)).not.toBeNull();
	});
});
