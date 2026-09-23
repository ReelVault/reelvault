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
import { subnetIp, workerCookie } from "./lib/identity";
import { BENCH_USER, type ManagedServer } from "./lib/server";
import { createServerFixture } from "./lib/server-fixture";

export const meta = { description: "Auth & session validation (public vs authed derive delta, login throughput)" };

/**
 * Auth & session-validation suite. Session validation rides along in every
 * authenticated request but was never isolated: these scenarios pin down
 *
 *  - the per-request auth derive cost, as (authed GET − public GET) delta,
 *  - login endpoint throughput, dominated by better-auth's password hashing
 *    plus a session insert (the managed server's route multiplier lifts the
 *    5 req/min production login limit).
 */

interface AuthScenario {
	name: string;
	run: (server: ManagedServer, workerIndex: number, requestIndex: number) => Promise<Response>;
}

const publicHealth: AuthScenario = {
	name: "GET /v1/health (public, no auth)",
	run: (server) => fetch(`${server.baseUrl}/v1/health`),
};

const authedRead: AuthScenario = {
	name: "GET /v1/me/watchlist?limit=1 (authed derive)",
	run: (server, workerIndex) =>
		fetch(`${server.baseUrl}/v1/me/watchlist?limit=1`, {
			headers: {
				cookie: workerCookie(server, workerIndex),
				"x-profile-id": server.profileIdFor(workerIndex),
				"x-forwarded-for": subnetIp(81, workerIndex),
			},
		}),
};

const login: AuthScenario = {
	name: "POST /v1/auth/login (password verify + session insert)",
	run: (server, workerIndex) =>
		fetch(`${server.baseUrl}/v1/auth/login`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-forwarded-for": subnetIp(81, workerIndex),
			},
			body: JSON.stringify({ email: BENCH_USER.email, password: BENCH_USER.password }),
		}),
};

const SCENARIOS: readonly AuthScenario[] = [publicHealth, authedRead, login];

function runScenario(
	server: ManagedServer,
	scenario: AuthScenario,
	concurrency: number,
	warmupMs: number,
	durationMs: number,
): Promise<HttpScenarioRun> {
	return runHttpScenario({
		concurrency,
		warmupMs,
		durationMs,
		work: async (workerIndex, requestIndex) => {
			try {
				const response = await scenario.run(server, workerIndex, requestIndex);
				const ok = response.ok;
				await response.arrayBuffer();

				return { ok };
			} catch {
				return { ok: false };
			}
		},
	});
}

const args = suiteArgs();

if (!args.help) {
	const serverFixture = createServerFixture({
		seedRows: args.rows,
		workerCount: Math.max(...args.concurrency),
		keepServer: args.keepServer,
	});

	task("auth: scenarios", async () => {
		const server = await serverFixture();
		console.log("[auth] server ready");

		const results: HttpScenarioResult[] = [];
		for (const concurrency of args.concurrency) {
			console.log(`\n[auth] concurrency ${concurrency} (warmup ${args.warmupMs}ms, measure ${args.durationMs}ms)`);
			for (const scenario of SCENARIOS) {
				const run = await runScenario(server, scenario, concurrency, args.warmupMs, args.durationMs);
				const result = httpScenarioResult(scenario.name, concurrency, run, args.durationMs);
				results.push(result);
				const failureNote = result.errorRatePercent > 0 ? `, errors ${result.errorRatePercent.toFixed(1)}%` : "";
				console.log(
					`  ${scenario.name}: ${result.requestsPerSecond.toFixed(0)} req/s, p50 ${result.stats.p50Ms.toFixed(2)}ms${failureNote}`,
				);
			}
		}

		printHttpResults(results);
		console.log("\nSession-validation cost = (authed GET − public GET) per request, per concurrency row.");
	});
}

await main(import.meta);
