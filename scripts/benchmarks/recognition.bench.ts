/**
 * Recognition strategy benchmark.
 *
 * The scanner runs `recognitionService.recognize` once per discovered file, so
 * its per-file cost multiplies across a whole library. This measures each
 * library layout (movies/series, categorized/basic) warm and cold — cold means
 * a corpus larger than the parse memo cache, so every name is parsed fresh.
 *
 * Usage: bun run scripts/benchmark.ts recognition [--iterations 200] [--rows 20000]
 */

import { bench, group, main, suiteArgs } from "benchkit";
import { recognitionService } from "@/modules/recognition/recognition.service";

export const meta = { description: "Recognition strategies per library layout (movies/series, categorized/basic, cold/warm)" };

/** Names parsed per timed operation (keeps the batch above timer resolution). */
const WINDOW = 200;
const STRUCTURES = [
	{
		name: "movies-categorized",
		build: (index: number) => {
			const year = 2000 + (index % 25);

			return `/media/movies/Some Movie ${index} (${year})/Some.Movie.${index}.${year}.1080p.BluRay.x264.mkv`;
		},
	},
	{
		name: "movies-basic",
		build: (index: number) => `/media/films/Some.Movie.${index}.${2000 + (index % 25)}.1080p.BluRay.x264.mkv`,
	},
	{
		name: "series-categorized",
		build: (index: number) => {
			const season = 1 + (index % 5);
			const episode = 1 + (index % 9);

			return `/media/tv/Some Show ${index}/Season 0${season}/Some.Show.S0${season}E0${episode}.1080p.WEB-DL.mkv`;
		},
	},
	{
		name: "series-basic",
		build: (index: number) => {
			const season = 1 + (index % 5);
			const episode = 1 + (index % 9);

			return `/media/films/Some.Show.S0${season}E0${episode}.720p.HDTV.mkv`;
		},
	},
] as const;

const args = suiteArgs();

if (!args.help) {
	console.log(`[recognition] corpus=${args.rows} paths, window=${WINDOW}, iterations=${args.iterations}`);

	group("Results (lower is better)", () => {
		for (const structure of STRUCTURES) {
			// Warm window (same 200 paths every iteration) and cold window (rotating
			// through the full corpus, evicting the parse cache).
			const warmPaths = Array.from({ length: WINDOW }, (_, index) => structure.build(index));
			bench(
				`recognize — ${structure.name} (warm)`,
				() => {
					for (const path of warmPaths) recognitionService.recognize(path);
				},
				{ warmup: 5, iterations: args.iterations },
			);

			const coldPaths = Array.from({ length: args.rows }, (_, index) => structure.build(index));
			const coldWindows = Math.max(1, Math.floor(coldPaths.length / WINDOW));
			bench(
				`recognize — ${structure.name} (cold, rotating)`,
				({ iteration }) => {
					const start = (Math.abs(iteration) % coldWindows) * WINDOW;
					for (let index = 0; index < WINDOW; index++) {
						const path = coldPaths[start + index];
						if (path) recognitionService.recognize(path);
					}
				},
				{ warmup: 5, iterations: args.iterations },
			);
		}
	});
}

await main(import.meta);
