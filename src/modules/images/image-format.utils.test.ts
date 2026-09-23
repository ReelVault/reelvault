import { describe, expect, test } from "bun:test";
import { detectImageFormat } from "./image-format.utils";

describe("detectImageFormat", () => {
	test("recognizes jpeg by its start-of-image marker", () => {
		expect(detectImageFormat(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))).toBe("jpeg");
	});

	test("recognizes png by its 8-byte signature", () => {
		expect(detectImageFormat(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]))).toBe("png");
	});

	test("recognizes webp inside a RIFF container", () => {
		const webp = Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.alloc(4), Buffer.from("WEBP", "ascii"), Buffer.alloc(4)]);
		expect(detectImageFormat(webp)).toBe("webp");
	});

	test("recognizes gif and avif", () => {
		expect(detectImageFormat(Buffer.concat([Buffer.from("GIF89a", "ascii"), Buffer.alloc(8)]))).toBe("gif");
		const avif = Buffer.concat([Buffer.alloc(4), Buffer.from("ftyp", "ascii"), Buffer.from("avif", "ascii")]);
		expect(detectImageFormat(avif)).toBe("avif");
	});

	test("rejects svg markup, plaintext and empty payloads", () => {
		expect(detectImageFormat(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', "utf8"))).toBeUndefined();
		expect(detectImageFormat(Buffer.from("hello world", "utf8"))).toBeUndefined();
		expect(detectImageFormat(Buffer.alloc(0))).toBeUndefined();
	});
});
