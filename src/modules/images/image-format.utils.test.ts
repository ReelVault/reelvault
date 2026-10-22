import { describe, expect, test } from "bun:test";
import { detectImageFormat } from "./image-format.utils";

describe("detectImageFormat", () => {
	test.each([
		{ format: "jpeg", bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]) },
		{ format: "png", bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]) },
		{
			format: "webp",
			bytes: Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.alloc(4), Buffer.from("WEBP", "ascii"), Buffer.alloc(4)]),
		},
		{ format: "gif", bytes: Buffer.concat([Buffer.from("GIF89a", "ascii"), Buffer.alloc(8)]) },
		{ format: "avif", bytes: Buffer.concat([Buffer.alloc(4), Buffer.from("ftyp", "ascii"), Buffer.from("avif", "ascii")]) },
	])("recognizes $format by its magic bytes", ({ format, bytes }) => {
		expect(detectImageFormat(bytes)).toBe(format);
	});

	test.each([
		{ kind: "svg markup", bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', "utf8") },
		{ kind: "plain text", bytes: Buffer.from("hello world", "utf8") },
		{
			kind: "a RIFF container that is not WebP",
			bytes: Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.alloc(4), Buffer.from("WAVE", "ascii")]),
		},
		{ kind: "an empty payload", bytes: Buffer.alloc(0) },
	])("does not recognize $kind as an image", ({ bytes }) => {
		expect(detectImageFormat(bytes)).toBeUndefined();
	});
});
