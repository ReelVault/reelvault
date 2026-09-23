import { bench, main, suiteArgs } from "benchkit";
import { fuzzyTitleDistance, generateQueryVariants, isSequelMismatch, pickBestMatch, rankCandidates } from "@/utils/media-match.utils";

export const meta = { description: "Title matching & ranking (rankCandidates, pickBestMatch, fuzzy distance, query variants)" };

interface Candidate {
	title: string;
	originalTitle?: string | undefined;
	originalLanguage?: string | undefined;
	releaseDate?: string | undefined;
	popularity?: number | undefined;
	voteCount?: number | undefined;
}

// A pool larger than the normalize-title cache (2048), so a rotating window is
// genuinely cache-cold; a fixed page measures the realistic repeat-provider case.
const POOL_SIZE = 5000;
const WINDOW = 50;
const VOID_SUFFIXES = ["", " The Sequel", " Part 2", "(Director's Cut)", ": Origins", " 2", " III"];
const YEAR_JITTER = [0, 1, -1, 2, -2];

function buildPool(): Candidate[] {
	// Deterministic mixed pool: exact matches, sequel variants, typos, translations.
	return Array.from({ length: POOL_SIZE }, (_, index) => {
		const suffix = VOID_SUFFIXES[index % VOID_SUFFIXES.length] ?? "";
		const year = 2010 + (index % 15);
		const typo = index % 11 === 0 ? "Oddyssey" : "Odyssey";

		return {
			title: `Benchmark ${typo}${suffix} ${index % 7}`,
			originalTitle: index % 3 === 0 ? `Benchmark Original ${index}` : undefined,
			originalLanguage: index % 2 === 0 ? "en" : "pl",
			releaseDate: `${year + (YEAR_JITTER[index % YEAR_JITTER.length] ?? 0)}-05-15`,
			popularity: (index % 500) / 10,
			voteCount: (index * 37) % 50_000,
		};
	});
}

function buildWindows(pool: Candidate[]): Candidate[][] {
	const windows: Candidate[][] = [];
	for (let start = 0; start + WINDOW <= pool.length; start += WINDOW) {
		windows.push(pool.slice(start, start + WINDOW));
	}

	return windows;
}

const args = suiteArgs();

if (!args.help) {
	const pool = buildPool();
	const windows = buildWindows(pool);
	const repeatedPage = windows[0] ?? [];
	const query = "Benchmark Odyssey 4";

	console.log(`[matching] pool=${pool.length} candidates, window=${WINDOW}, iterations=${args.iterations}`);

	bench(
		`rankCandidates — rotating window (cache-cold)`,
		({ iteration }) => {
			const window = windows[Math.abs(iteration) % windows.length] ?? repeatedPage;

			return rankCandidates(window, query, 2015);
		},
		{ warmup: 10, iterations: args.iterations },
	);
	bench("rankCandidates — repeated page (cache-warm)", () => rankCandidates(repeatedPage, query, 2015), {
		warmup: 10,
		iterations: args.iterations,
	});
	bench("pickBestMatch — repeated page", () => pickBestMatch(repeatedPage, query, 2015), {
		warmup: 10,
		iterations: args.iterations,
	});
	bench(
		"fuzzyTitleDistance — 64 titles",
		() => {
			let sink = 0;
			for (let index = 0; index < 64; index++) sink += fuzzyTitleDistance("odyssey", pool[index]?.title ?? "", 4) ?? 0;

			return sink;
		},
		{ warmup: 5, iterations: args.iterations },
	);
	bench(
		"generateQueryVariants — 100 titles",
		() => {
			let sink = 0;
			for (let index = 0; index < 100; index++) sink += generateQueryVariants(pool[index]?.title ?? "").length;

			return sink;
		},
		{ warmup: 5, iterations: args.iterations },
	);
	bench(
		"isSequelMismatch — 100 pairs",
		() => {
			let sink = 0;
			for (let index = 0; index < 100; index++) {
				sink += isSequelMismatch(`Benchmark Odyssey ${index}`, { title: pool[index]?.title ?? "" }) ? 1 : 0;
			}

			return sink;
		},
		{ warmup: 5, iterations: args.iterations },
	);

	// Realistic provider result-set sizes: a single search returns a handful,
	// query variants merge up to a few hundred.
	for (const size of [10, 50, 200]) {
		const window = pool.slice(0, size);
		bench(`rankCandidates — window=${size}`, () => rankCandidates(window, query, 2015), { warmup: 10, iterations: args.iterations });
		bench(`pickBestMatch — window=${size}`, () => pickBestMatch(window, query, 2015), { warmup: 10, iterations: args.iterations });
	}
}

await main(import.meta);
