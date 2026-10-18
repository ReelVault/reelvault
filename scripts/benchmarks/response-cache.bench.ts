import { main, metric, runLoadWindow, suiteArgs, type TaskMetrics, task } from "benchkit";
import { Elysia } from "elysia";
import { responseCacheMiddleware } from "@/app/http/middleware/response-cache.middleware";

export const meta = { description: "Cache-hit path in-process (app.handle, no sockets): response cache and encoding negotiation" };

const args = suiteArgs(); // one memoized parse per process — never raw-parse here

/** A 24-item catalog page — the browse shape the response cache serves most often. */
const CATALOG_PAGE = {
	data: Array.from({ length: 24 }, (_, index) => ({
		id: `title-${index}`,
		title: `Title ${index}`,
		overview: "A synopsis long enough to make the page compressible. ".repeat(4),
		releaseDate: "2001-01-01",
		genres: ["Drama", "Thriller"],
	})),
};

/** The list browsers send; it exercises the multi-token encoding negotiation. */
const BROWSER_ACCEPT_ENCODING = "gzip, deflate, br, zstd";

if (!args.help) {
	task("response-cache: in-process cache hit", async () => {
		const app = new Elysia().use(responseCacheMiddleware).get("/catalog", () => CATALOG_PAGE, {
			cache: { maxAge: 60, private: true },
		});
		await app.handle(new Request("http://localhost/catalog"));

		const metrics: TaskMetrics = {};
		for (const concurrency of args.concurrency) {
			const run = await runLoadWindow({
				concurrency,
				warmupMs: args.warmupMs,
				durationMs: args.durationMs,
				work: async () => {
					const response = await app.handle(
						new Request("http://localhost/catalog", { headers: { "accept-encoding": BROWSER_ACCEPT_ENCODING } }),
					);
					await response.arrayBuffer();

					return { ok: response.status === 200 };
				},
			});
			metrics[`response-cache hit c=${concurrency} req/s`] = metric(run.successes / (args.durationMs / 1000), true);
		}

		return { ok: true, data: { metrics } };
	});
}

await main(import.meta);
