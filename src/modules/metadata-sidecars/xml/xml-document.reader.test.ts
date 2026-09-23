import { describe, expect, test } from "bun:test";
import { readXmlDocument } from "./xml-document.reader";

describe("readXmlDocument", () => {
	test("parses a normal sidecar document with predefined entities", () => {
		const document = readXmlDocument("<movie><title>Hello &amp; World</title></movie>");
		expect(document).not.toBeNull();
		expect(document?.values).toBeDefined();
	});

	test("rejects documents declaring a DTD or custom entity", () => {
		expect(readXmlDocument(`<!DOCTYPE foo [<!ENTITY x "y">]><foo>&x;</foo>`)).toBeNull();
		expect(readXmlDocument(`<!ENTITY x "y"><foo>&x;</foo>`)).toBeNull();
	});

	test("rejects malformed XML", () => {
		expect(readXmlDocument("<movie><title>oops</movie>")).toBeNull();
	});
});
