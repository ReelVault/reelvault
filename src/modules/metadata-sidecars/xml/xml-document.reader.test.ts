import { describe, expect, test } from "bun:test";
import { readXmlDocument } from "./xml-document.reader";

describe("readXmlDocument", () => {
	test("parses a normal sidecar document and decodes predefined entities", async () => {
		const document = await readXmlDocument("<movie><title>Hello &amp; World</title></movie>");
		expect(document?.values).toEqual({ movie: { title: "Hello & World" } });
	});

	test("rejects documents declaring a DTD or custom entity", async () => {
		expect(await readXmlDocument(`<!DOCTYPE foo [<!ENTITY x "y">]><foo>&x;</foo>`)).toBeNull();
		expect(await readXmlDocument(`<!ENTITY x "y"><foo>&x;</foo>`)).toBeNull();
	});

	test("rejects malformed XML", async () => {
		expect(await readXmlDocument("<movie><title>oops</movie>")).toBeNull();
	});
});
