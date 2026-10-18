import { describe, expect, it } from "bun:test";
import { appendCspSources } from "./csp.utils";

describe("appendCspSources", () => {
	it("returns the policy unchanged when no sources are declared", () => {
		expect(appendCspSources("default-src 'self'", {})).toBe("default-src 'self'");
		expect(appendCspSources("default-src 'self'", { "img-src": [] })).toBe("default-src 'self'");
	});

	it("appends sources to an existing directive", () => {
		expect(appendCspSources("img-src 'self' data:; media-src 'self'", { "img-src": ["https://a.example.com"] })).toBe(
			"img-src 'self' data: https://a.example.com; media-src 'self'",
		);
	});

	it("adds a directive the policy does not define yet", () => {
		expect(appendCspSources("default-src 'self'; img-src 'self'", { "frame-src": ["https://player.example.com"] })).toBe(
			"default-src 'self'; img-src 'self'; frame-src https://player.example.com",
		);
	});
});
