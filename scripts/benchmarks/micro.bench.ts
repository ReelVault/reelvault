/**
 * A/B micro-benchmarks: current implementation vs plausible alternatives.
 *
 * Each pair prints ns/op per variant and a winner. Results here only INFORM
 * changes — swapping an implementation still requires a full verify + an HTTP
 * benchmark before/after (AGENTS: always record before/after, even for "worse").
 */

import { brotliCompress, constants, gzip } from "node:zlib";
import { bench, compare, group, main, measureAsync, printMicroResults, suiteArgs, task } from "benchkit";
import { hash as bunHash, CryptoHasher } from "bun";
import { getPathname } from "@/utils/http.utils";
import { boundedLevenshtein } from "@/utils/media-match.utils";

export const meta = {
	description: "A/B implementation pairs (cache keys, LRU touch, parsers, hashing, compression) — informs, never auto-adopts",
};

const args = suiteArgs();

// ─── Variant implementations ────────────────────────────────────────────────

const SEGMENT_NAME_PATTERN = /seg_(\d+)\.m4s/;

function parseSegmentNameRegex(segmentName: string, segmentDuration: number): { startTime: number; index: number } {
	const match = segmentName.match(SEGMENT_NAME_PATTERN);
	if (!match) return { startTime: 0, index: 0 };

	const index = Number.parseInt(match[1] ?? "0", 10);

	return { index, startTime: index * segmentDuration };
}

function parseSegmentNameSlice(segmentName: string, segmentDuration: number): { startTime: number; index: number } {
	// seg_N.m4s is a server-generated fixed format — no regex needed.
	const index = Number.parseInt(segmentName.slice(4, -4), 10);
	if (Number.isNaN(index)) return { startTime: 0, index: 0 };

	return { index, startTime: index * segmentDuration };
}

function parseColonSplit(value: string): number {
	const parts = value.split(":");
	let total = 0;
	for (const part of parts) {
		const parsed = Number.parseFloat(part);
		if (Number.isNaN(parsed)) return Number.NaN;

		total = total * 60 + parsed;
	}

	return total;
}

function parseColonCharCode(value: string): number {
	// Manual scan: same result as split+parseFloat, without allocating the array.
	let total = 0;
	let start = 0;
	for (let index = 0; index <= value.length; index++) {
		if (index === value.length || value.charCodeAt(index) === 58) {
			const part = Number.parseFloat(value.slice(start, index));
			if (Number.isNaN(part)) return Number.NaN;

			total = total * 60 + part;
			start = index + 1;
		}
	}

	return total;
}

const DIACRITICS_PATTERN = /\p{M}/gu;

function stripDiacriticsNfd(value: string): string {
	return value.normalize("NFD").replace(DIACRITICS_PATTERN, "");
}

// Single pass over a fixed replacement table (Polish + common Latin-1 accents).
const ACCENT_MAP: Record<string, string> = {
	ą: "a",
	ć: "c",
	ę: "e",
	ł: "l",
	ń: "n",
	ó: "o",
	ś: "s",
	ź: "z",
	ż: "z",
	Ą: "A",
	Ć: "C",
	Ę: "E",
	Ł: "L",
	Ń: "N",
	Ó: "O",
	Ś: "S",
	Ź: "Z",
	Ż: "Z",
	ä: "a",
	ö: "o",
	ü: "u",
	ß: "ss",
	é: "e",
	è: "e",
	ê: "e",
	á: "a",
	í: "i",
	ú: "u",
	ñ: "n",
};

function stripDiacriticsMap(value: string): string {
	let result = "";
	for (const char of value) result += ACCENT_MAP[char] ?? char;

	return result;
}

function djb2(value: string): string {
	let hash = 5381;
	for (let i = 0; i < value.length; i++) hash = ((hash * 33) ^ value.charCodeAt(i)) >>> 0;

	return hash.toString(16);
}

function getUrlSample(requestIndex: number): string {
	return `http://127.0.0.1:18472/v1/metadata?limit=24&page=${requestIndex}&fields=id,title${requestIndex % 2 ? "&sort=added" : ""}`;
}

async function compress(input: Buffer, encoding: "br4" | "br2" | "gzip1"): Promise<Buffer> {
	if (encoding === "br4") {
		return await new Promise<Buffer>((resolve, reject) => {
			brotliCompress(input, { params: { [constants.BROTLI_PARAM_QUALITY]: 4, [constants.BROTLI_PARAM_LGWIN]: 18 } }, (error, result) => {
				if (error) {
					reject(error);
				} else {
					resolve(result);
				}
			});
		});
	}

	if (encoding === "br2") {
		return await new Promise<Buffer>((resolve, reject) => {
			brotliCompress(input, { params: { [constants.BROTLI_PARAM_QUALITY]: 2, [constants.BROTLI_PARAM_LGWIN]: 18 } }, (error, result) => {
				if (error) {
					reject(error);
				} else {
					resolve(result);
				}
			});
		});
	}

	return await new Promise<Buffer>((resolve, reject) => {
		gzip(input, { level: 1 }, (error, result) => {
			if (error) {
				reject(error);
			} else {
				resolve(result);
			}
		});
	});
}

function buildCatalogPayload(rows: number): string {
	const items = Array.from({ length: rows }, (_, index) => ({
		id: `meta-${String(index).padStart(7, "0")}`,
		title: `Benchmark Title ${index}`,
		type: index % 8 === 0 ? "tv_show" : "movie",
		releaseDate: `202${index % 5}-0${(index % 9) + 1}-15`,
		overview: "Benchmark overview text for load testing with a realistic length sentence.",
		popularity: (index % 1000) / 10,
	}));

	return JSON.stringify({ page: 1, limit: rows, total: rows, totalPages: 1, data: items });
}

/** Encodes adjacent non-space code-unit pairs; mirrors the production bigram helper. */
function codeInto(value: string, out: number[]): void {
	out.length = 0;
	let prev = -1;
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code === 32) continue;

		if (prev >= 0) out.push(prev * 65536 + code);

		prev = code;
	}

	// Mirror toBigrams' single-char fallback with a distinct marker code.
	if (out.length === 0 && prev >= 0) out.push(-1 - prev);
}

function tokensSplit(value: string): Set<string> {
	const set = new Set<string>();
	for (const token of value.split(" ")) if (token) set.add(token);

	return set;
}

function tokensScan(value: string): Set<string> {
	const set = new Set<string>();
	let start = 0;
	for (let i = 0; i <= value.length; i++) {
		if (i === value.length || value.charCodeAt(i) === 32) {
			if (i > start) set.add(value.slice(start, i));

			start = i + 1;
		}
	}

	return set;
}

function overlapWith(build: (value: string) => Set<string>, a: string, b: string): number {
	const ta = build(a);
	const tb = build(b);
	if (ta.size === 0 || tb.size === 0) return 0;

	let intersection = 0;
	for (const token of ta) if (tb.has(token)) intersection++;

	return (2 * intersection) / (ta.size + tb.size);
}

if (!args.help) {
	console.log(`[micro] A/B implementation comparisons (${args.iterations} iterations per variant)...\n`);

	// Representative inputs.
	const segmentNames = Array.from({ length: 256 }, (_, i) => `seg_${100000 + i}.m4s`);
	const timeStrings = ["00:12:34.567", "01:02:03", "00:00:09.500", "02:45:12.123"];
	const titleSamples = [
		"Żółw Łukasz i Święta Graal",
		"The Quick and the Dead: Director's Cut",
		"Östliche Züge fahren übermäßig schnell",
		"Stranger Things 4: The整 Season",
		"Amélie Poulain: Édition Spéciale",
	];

	compare("Cache key: bunHash(str).toString(16) vs raw string key (dedup, filterSignature)", {
		variants: [
			{
				name: "bunHash -> hex key",
				fn: () => {
					let sink = "";
					for (let i = 0; i < 32; i++) sink = bunHash(`${getUrlSample(i)}:cookie:profile`).toString(16);

					return sink;
				},
			},
			{
				name: "raw string key",
				fn: () => {
					let sink = "";
					for (let i = 0; i < 32; i++) sink = `${getUrlSample(i)}:cookie:profile`;

					return sink;
				},
			},
		],
		// Value-changing alternative: the produced keys differ by design.
		batch: 8,
	});

	compare("MemoryCache hit path: LRU touch (delete+set per get) vs plain Map get", {
		variants: (() => {
			// Both caches pre-built — only the HIT path is measured.
			const touched = new Map<string, { value: number }>();
			const plain = new Map<string, { value: number }>();
			for (let i = 0; i < 64; i++) {
				touched.set(`k${i}`, { value: i });
				plain.set(`k${i}`, { value: i });
			}

			return [
				{
					name: "Map delete+set touch",
					fn: () => {
						let hits = 0;
						for (let r = 0; r < 16; r++) {
							for (let i = 0; i < 64; i++) {
								const key = `k${i}`;
								const entry = touched.get(key);
								if (entry) {
									hits++;
									touched.delete(key);
									touched.set(key, entry);
								}
							}
						}

						return hits;
					},
				},
				{
					name: "plain Map get",
					fn: () => {
						let hits = 0;
						for (let r = 0; r < 16; r++) {
							for (let i = 0; i < 64; i++) {
								if (plain.get(`k${i}`)) hits++;
							}
						}

						return hits;
					},
				},
			];
		})(),
		iterations: 50,
		batch: 4,
		equal: (a, b) => a === b,
	});

	compare("parseSegmentName: regex match vs slice+parseInt (per segment request)", {
		variants: [
			{
				name: "regex match",
				fn: () => {
					let sink = 0;
					for (const name of segmentNames) sink += parseSegmentNameRegex(name, 4).startTime;

					return sink;
				},
			},
			{
				name: "slice+parseInt",
				fn: () => {
					let sink = 0;
					for (const name of segmentNames) sink += parseSegmentNameSlice(name, 4).startTime;

					return sink;
				},
			},
		],
		batch: 4,
		equal: (a, b) => a === b,
	});

	compare("parseColonSeparatedSeconds: split+parseFloat vs charCode parser (H:MM:SS.mmm)", {
		variants: [
			{
				name: "split+parseFloat",
				fn: () => {
					let sink = 0;
					for (const value of timeStrings) sink += parseColonSplit(value);

					return sink;
				},
			},
			{
				name: "charCode manual",
				fn: () => {
					let sink = 0;
					for (const value of timeStrings) sink += parseColonCharCode(value);

					return sink;
				},
			},
		],
		batch: 64,
		equal: (a, b) => a === b,
	});

	compare("stripDiacritics: NFD + /\\p{M}/gu vs single-pass accent map (search path)", {
		variants: [
			{
				name: "NFD + \\p{M}",
				fn: () => {
					let sink = "";
					for (const title of titleSamples) sink = stripDiacriticsNfd(title);

					return sink;
				},
			},
			{
				name: "single-pass map",
				fn: () => {
					let sink = "";
					for (const title of titleSamples) sink = stripDiacriticsMap(title);

					return sink;
				},
			},
		],
		batch: 32,
		equal: (a, b) => a === b,
	});

	compare("ETag/dedup hash: bunHash vs djb2 vs SHA-256 (bun:crypto)", {
		variants: [
			{
				name: "bunHash (wyhash)",
				fn: () => {
					let sink = "";
					for (let i = 0; i < 16; i++) sink = bunHash(getUrlSample(i)).toString(16);

					return sink;
				},
			},
			{
				name: "djb2 manual",
				fn: () => {
					let sink = "";
					for (let i = 0; i < 16; i++) sink = djb2(getUrlSample(i));

					return sink;
				},
			},
			{
				name: "SHA-256 (CryptoHasher)",
				fn: () => {
					let sink = "";
					for (let i = 0; i < 16; i++) {
						const hasher = new CryptoHasher("sha256");
						hasher.update(getUrlSample(i));
						sink = hasher.digest("hex");
					}

					return sink;
				},
			},
		],
		// Value-changing alternative: every hash produces different digests.
		batch: 16,
	});

	compare("getPathname: slice parser vs new URL().pathname (hot request path)", {
		variants: [
			{
				name: "slice parser",
				fn: () => {
					let sink = "";
					for (let i = 0; i < 64; i++) sink = getPathname(getUrlSample(i));

					return sink;
				},
			},
			{
				name: "new URL().pathname",
				fn: () => {
					let sink = "";
					for (let i = 0; i < 64; i++) sink = new URL(getUrlSample(i)).pathname;

					return sink;
				},
			},
		],
		batch: 8,
		equal: (a, b) => a === b,
	});

	// ─── Matching: bounded edit distance (per pair, in the ranking hot path) ──
	const levenshteinSamples = Array.from({ length: 64 }, (_, i) => ({
		a: `benchmark title number ${i}`,
		b: `benchmark tittle number ${i + 1}`,
	}));
	group("Matching (sync, per call)", () => {
		bench(
			"boundedLevenshtein x64 pairs",
			() => {
				let sink = 0;
				for (const { a, b } of levenshteinSamples) sink += boundedLevenshtein(a, b, 4) ?? 0;

				return sink;
			},
			{ iterations: args.iterations },
		);
	});

	// ─── Matching primitives (title bigram Dice & token overlap) ─────────────
	const matchPairs = Array.from({ length: 32 }, (_, i) => ({
		a: `benchmark odyssey ${i % 7}${i % 3 === 0 ? " the sequel" : ""}`,
		b: `benchmark oddyssey ${i % 7}${i % 3 === 1 ? " part 2" : ""}`,
	}));
	const whitespaceAll = /\s+/g;
	const bigramsString = (value: string): string[] => {
		const collapsed = value.replace(whitespaceAll, "");
		if (collapsed.length < 2) return collapsed ? [collapsed] : [];

		const out: string[] = [];
		for (let i = 0; i < collapsed.length - 1; i++) out.push(collapsed.slice(i, i + 2));

		return out;
	};
	const diceString = (a: string, b: string): number => {
		const ba = bigramsString(a);
		const bb = bigramsString(b);
		if (ba.length === 0 || bb.length === 0) return 0;

		const remaining = new Map<string, number>();
		for (const g of bb) remaining.set(g, (remaining.get(g) ?? 0) + 1);

		let matches = 0;
		for (const g of ba) {
			const c = remaining.get(g) ?? 0;
			if (c > 0) {
				matches++;
				remaining.set(g, c - 1);
			}
		}

		return (2 * matches) / (ba.length + bb.length);
	};

	const codesA: number[] = [];
	const codesB: number[] = [];
	const freqScratch = new Map<number, number>();
	const diceNumeric = (a: string, b: string): number => {
		codeInto(a, codesA);
		codeInto(b, codesB);
		if (codesA.length === 0 || codesB.length === 0) return 0;

		freqScratch.clear();
		for (const g of codesB) freqScratch.set(g, (freqScratch.get(g) ?? 0) + 1);

		let matches = 0;
		for (const g of codesA) {
			const c = freqScratch.get(g) ?? 0;
			if (c > 0) {
				matches++;
				freqScratch.set(g, c - 1);
			}
		}

		return (2 * matches) / (codesA.length + codesB.length);
	};

	compare("Title bigram Dice: string bigrams+Map vs numeric codes+reused Map", {
		variants: [
			{
				name: "string bigrams",
				fn: () => {
					let sink = 0;
					for (const { a, b } of matchPairs) sink += diceString(a, b);

					return sink;
				},
			},
			{
				name: "numeric codes (reused)",
				fn: () => {
					let sink = 0;
					for (const { a, b } of matchPairs) sink += diceNumeric(a, b);

					return sink;
				},
			},
		],
		batch: 8,
		equal: (a, b) => a === b,
	});

	const HASH_SIZE = 256;
	const HASH_MASK = HASH_SIZE - 1;
	const hashKeys = new Int32Array(HASH_SIZE);
	const hashCounts = new Int32Array(HASH_SIZE);
	const hashUsed = new Uint8Array(HASH_SIZE);
	const hashIndex = (code: number): number => (Math.imul(code, 2654435761) >>> 0) & HASH_MASK;
	const hashInsert = (code: number): void => {
		let i = hashIndex(code);
		for (;;) {
			if ((hashUsed[i] ?? 0) === 0) {
				hashUsed[i] = 1;
				hashKeys[i] = code;
				hashCounts[i] = 1;

				return;
			}

			if ((hashKeys[i] ?? 0) === code) {
				hashCounts[i] = (hashCounts[i] ?? 0) + 1;

				return;
			}

			i = (i + 1) & HASH_MASK;
		}
	};
	const hashConsume = (code: number): boolean => {
		let i = hashIndex(code);
		for (;;) {
			if ((hashUsed[i] ?? 0) === 0) return false;

			if ((hashKeys[i] ?? 0) === code) {
				const count = hashCounts[i] ?? 0;
				if (count <= 0) return false;

				hashCounts[i] = count - 1;

				return true;
			}

			i = (i + 1) & HASH_MASK;
		}
	};
	const diceOpenAddressed = (a: string, b: string): number => {
		codeInto(a, codesA);
		codeInto(b, codesB);
		if (codesA.length === 0 || codesB.length === 0) return 0;

		hashUsed.fill(0);
		for (const code of codesB) hashInsert(code);

		let matches = 0;
		for (const code of codesA) if (hashConsume(code)) matches++;

		return (2 * matches) / (codesA.length + codesB.length);
	};

	compare("Title bigram Dice: reused Map vs open-addressing Int32Array", {
		variants: [
			{
				name: "reused Map<number>",
				fn: () => {
					let sink = 0;
					for (const { a, b } of matchPairs) sink += diceNumeric(a, b);

					return sink;
				},
			},
			{
				name: "open-addressing Int32Array",
				fn: () => {
					let sink = 0;
					for (const { a, b } of matchPairs) sink += diceOpenAddressed(a, b);

					return sink;
				},
			},
		],
		batch: 8,
		equal: (a, b) => a === b,
	});

	compare("Title token overlap: split(' ')+Set vs manual scan+Set", {
		variants: [
			{
				name: "split(' ')",
				fn: () => {
					let sink = 0;
					for (const { a, b } of matchPairs) sink += overlapWith(tokensSplit, a, b);

					return sink;
				},
			},
			{
				name: "manual scan",
				fn: () => {
					let sink = 0;
					for (const { a, b } of matchPairs) sink += overlapWith(tokensScan, a, b);

					return sink;
				},
			},
		],
		batch: 8,
		equal: (a, b) => a === b,
	});

	// ─── Compression A/B (async) — kept as a task: the small-payload measures
	// run in parallel (Promise.all), which bench units cannot express. ───────
	task("micro: compression (per compress call)", async () => {
		const payload = Buffer.from(buildCatalogPayload(24));
		console.log(`\n[micro] compression A/B on a realistic 24-item catalog payload (${(payload.length / 1024).toFixed(1)} KB raw)...\n`);
		const br4 = await compress(payload, "br4");
		const br2 = await compress(payload, "br2");
		const gz1 = await compress(payload, "gzip1");
		console.log(
			`  sizes: br-q4 ${(br4.length / 1024).toFixed(1)}KB, br-q2 ${(br2.length / 1024).toFixed(1)}KB, gzip-1 ${(gz1.length / 1024).toFixed(1)}KB\n`,
		);

		const compressionResults = [
			await measureAsync("brotli quality 4 (current)", () => compress(payload, "br4"), { iterations: args.iterations }),
			await measureAsync("brotli quality 2", () => compress(payload, "br2"), { iterations: args.iterations }),
			await measureAsync("gzip level 1 (current)", () => compress(payload, "gzip1"), { iterations: args.iterations }),
		];

		// ─── Large-payload compression A/B (details-view class, ~200 KB) ───────
		// The small 24-item payload above barely crosses the 1 KB compression
		// threshold; detail-page aggregations produce 100 KB+ JSON where the
		// per-request compress cost is the dominant CPU term.
		const largeItems = Array.from({ length: 400 }, (_item, index) => ({
			id: `meta-${String(index).padStart(7, "0")}`,
			title: `Benchmark Title ${index}`,
			type: index % 8 === 0 ? "tv_show" : "movie",
			releaseDate: `202${index % 5}-0${(index % 9) + 1}-15`,
			overview: "Benchmark overview text for load testing with a realistic length sentence.".repeat(4),
			popularity: (index % 1000) / 10,
			genres: ["Action", "Adventure", "Sci-Fi", "Drama"],
			cast: Array.from({ length: 12 }, (_person, castIndex) => ({
				name: `Person ${index}-${castIndex}`,
				character: `Character ${castIndex}`,
			})),
			episodes:
				index % 8 === 0
					? Array.from({ length: 24 }, (_episode, episodeIndex) => ({
							id: `ep-${index}-${episodeIndex}`,
							title: `Episode ${episodeIndex}`,
							overview: "Episode overview text long enough to resemble a real payload entry.",
						}))
					: undefined,
			mediaFiles: Array.from({ length: 3 }, (_, fileIndex) => ({ id: `mf-${index}-${fileIndex}`, durationSeconds: 3600 + fileIndex })),
		}));
		const largePayload = Buffer.from(JSON.stringify({ data: largeItems }));
		console.log(`\n[micro] compression A/B on a large details-view-class payload (${(largePayload.length / 1024).toFixed(0)} KB raw)...\n`);
		const largeBr4 = await compress(largePayload, "br4");
		const largeBr2 = await compress(largePayload, "br2");
		const largeGz1 = await compress(largePayload, "gzip1");
		console.log(
			`  sizes: br-q4 ${(largeBr4.length / 1024).toFixed(0)}KB, br-q2 ${(largeBr2.length / 1024).toFixed(0)}KB, gzip-1 ${(largeGz1.length / 1024).toFixed(0)}KB\n`,
		);

		compressionResults.push(
			...(await Promise.all([
				measureAsync("large payload: brotli q4 (current)", () => compress(largePayload, "br4"), {
					iterations: Math.max(10, Math.floor(args.iterations / 5)),
				}),
				measureAsync("large payload: brotli q2", () => compress(largePayload, "br2"), {
					iterations: Math.max(10, Math.floor(args.iterations / 5)),
				}),
				measureAsync("large payload: gzip level 1", () => compress(largePayload, "gzip1"), {
					iterations: Math.max(10, Math.floor(args.iterations / 5)),
				}),
			])),
		);

		printMicroResults(compressionResults, "Compression (async, per compress call)");
		console.log("\n[micro] done — adopt a winner only with a full verify + HTTP before/after.");
	});
}

await main(import.meta);
