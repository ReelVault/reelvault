import { main, printHttpResults, runScenarioMatrix, suiteArgs, task } from "benchkit";

import { suiteServerFixture } from "./lib/server-fixture";

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

export const meta = { description: "Static web UI serving (SPA entry, immutable asset, revalidation, range)" };

const args = suiteArgs();

if (!args.help) {
	const serverFixture = suiteServerFixture(args, { withWebDist: true });

	task("static: scenarios", async () => {
		const managed = await serverFixture();
		const context: StaticScenarioContext = { baseUrl: managed.baseUrl, assetEtag: "" };

		// Capture the asset's ETag once; the weak etag (mtime-size) is stable for
		// the lifetime of the staged dist.
		const assetResponse = await fetch(`${context.baseUrl}/assets/app.js`);
		context.assetEtag = assetResponse.headers.get("etag") ?? "";
		await assetResponse.arrayBuffer();
		if (!context.assetEtag) throw new Error("Asset response carried no ETag — static serving is broken");

		const scenarios = args.scenario ? SCENARIOS.filter((scenario) => scenario.name.includes(args.scenario ?? "")) : SCENARIOS;
		const results = await runScenarioMatrix({
			suite: "static",
			unit: "req/s",
			scenarios: scenarios.map((scenario) => ({
				name: scenario.name,
				requestFor: (workerIndex: number, requestIndex: number) => scenario.builder(context, workerIndex, requestIndex),
				accept: (response: Response) => scenario.acceptedStatuses.includes(response.status),
			})),
			concurrency: args.concurrency,
			warmupMs: args.warmupMs,
			durationMs: args.durationMs,
		});

		printHttpResults(results);
	});
}

await main(import.meta);
