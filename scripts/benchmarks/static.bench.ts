import {
	type HttpScenarioResult,
	type HttpScenarioRun,
	httpScenarioResult,
	main,
	printHttpResults,
	runHttpScenario,
	suiteArgs,
	task,
} from "benchkit";

import { createServerFixture } from "./lib/server-fixture";

interface StaticScenarioContext {
	baseUrl: string;
	/** ETag captured once from the asset response so the revalidation scenario can send If-None-Match. */
	assetEtag: string;
}

type RequestBuilder = (context: StaticScenarioContext, workerIndex: number, requestIndex: number) => Request;

const indexEntry: RequestBuilder = (context) => new Request(`${context.baseUrl}/`);

const immutableAsset: RequestBuilder = (context) => new Request(`${context.baseUrl}/assets/app.js`);

const assetRevalidation: RequestBuilder = (context) =>
	new Request(`${context.baseUrl}/assets/app.js`, { headers: { "if-none-match": context.assetEtag } });

const assetRange: RequestBuilder = (context) => new Request(`${context.baseUrl}/assets/app.js`, { headers: { range: "bytes=0-4095" } });

interface ScenarioDefinition {
	name: string;
	builder: RequestBuilder;
	/** Statuses counted as a successful request. Range accepts 200 too: the
	 * pre-Range baseline serves the full file, the post-Range server answers 206. */
	acceptedStatuses: readonly number[];
}

const SCENARIOS: readonly ScenarioDefinition[] = [
	{ name: "GET / (index.html entry + meta injection)", builder: indexEntry, acceptedStatuses: [200] },
	{ name: "GET /assets/app.js (immutable asset, 64 KiB)", builder: immutableAsset, acceptedStatuses: [200] },
	{ name: "GET /assets/app.js If-None-Match (304)", builder: assetRevalidation, acceptedStatuses: [304] },
	{ name: "GET /assets/app.js Range bytes=0-4095", builder: assetRange, acceptedStatuses: [200, 206] },
];

function runScenario(
	scenario: ScenarioDefinition,
	concurrency: number,
	context: StaticScenarioContext,
	warmupMs: number,
	durationMs: number,
): Promise<HttpScenarioRun> {
	return runHttpScenario({
		concurrency,
		warmupMs,
		durationMs,
		work: async (workerIndex, requestIndex) => {
			try {
				const response = await fetch(scenario.builder(context, workerIndex, requestIndex));
				const ok = scenario.acceptedStatuses.includes(response.status);
				await response.arrayBuffer();

				return { ok };
			} catch {
				return { ok: false };
			}
		},
	});
}

export const meta = { description: "Static web UI serving (SPA entry, immutable asset, revalidation, range)" };

const args = suiteArgs();

if (!args.help) {
	const serverFixture = createServerFixture({
		seedRows: args.rows,
		workerCount: Math.max(...args.concurrency),
		withWebDist: true,
		keepServer: args.keepServer,
	});

	task("static: scenarios", async () => {
		const managed = await serverFixture();
		const context: StaticScenarioContext = { baseUrl: managed.baseUrl, assetEtag: "" };

		// Capture the asset's ETag once; the weak etag (mtime-size) is stable for
		// the lifetime of the staged dist.
		const assetResponse = await fetch(`${context.baseUrl}/assets/app.js`);
		context.assetEtag = assetResponse.headers.get("etag") ?? "";
		await assetResponse.arrayBuffer();
		if (!context.assetEtag) throw new Error("Asset response carried no ETag — static serving is broken");

		const results: HttpScenarioResult[] = [];
		const scenarios = args.scenario ? SCENARIOS.filter((scenario) => scenario.name.includes(args.scenario ?? "")) : SCENARIOS;

		for (const concurrency of args.concurrency) {
			console.log(`\n[static] concurrency ${concurrency} (warmup ${args.warmupMs}ms, measure ${args.durationMs}ms)`);
			for (const scenario of scenarios) {
				const run = await runScenario(scenario, concurrency, context, args.warmupMs, args.durationMs);
				const result = httpScenarioResult(scenario.name, concurrency, run, args.durationMs);
				results.push(result);
				const failureNote = result.errorRatePercent > 0 ? `, errors ${result.errorRatePercent.toFixed(1)}%` : "";
				console.log(
					`  ${scenario.name}: ${result.requestsPerSecond.toFixed(0)} req/s, p95 ${result.stats.p95Ms.toFixed(1)}ms${failureNote}`,
				);
			}
		}

		printHttpResults(results);
	});
}

await main(import.meta);
