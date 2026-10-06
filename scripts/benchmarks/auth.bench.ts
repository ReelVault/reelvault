import { main, printHttpResults, runScenarioMatrix, suiteArgs, task } from "benchkit";
import { subnetIp, workerCookie } from "./lib/identity";
import { BENCH_USER, type ManagedServer } from "./lib/server";
import { suiteServerFixture } from "./lib/server-fixture";

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
	requestFor: (server: ManagedServer, workerIndex: number, requestIndex: number) => Request;
}

const publicHealth: AuthScenario = {
	name: "GET /v1/health (public, no auth)",
	requestFor: (server) => new Request(`${server.baseUrl}/v1/health`),
};

const authedRead: AuthScenario = {
	name: "GET /v1/me/watchlist?limit=1 (authed derive)",
	requestFor: (server, workerIndex) =>
		new Request(`${server.baseUrl}/v1/me/watchlist?limit=1`, {
			headers: {
				cookie: workerCookie(server, workerIndex),
				"x-profile-id": server.profileIdFor(workerIndex),
				"x-forwarded-for": subnetIp(81, workerIndex),
			},
		}),
};

const login: AuthScenario = {
	name: "POST /v1/auth/login (password verify + session insert)",
	requestFor: (server, workerIndex) =>
		new Request(`${server.baseUrl}/v1/auth/login`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-forwarded-for": subnetIp(81, workerIndex),
			},
			body: JSON.stringify({ email: BENCH_USER.email, password: BENCH_USER.password }),
		}),
};

const SCENARIOS: readonly AuthScenario[] = [publicHealth, authedRead, login];

const args = suiteArgs();

if (!args.help) {
	const serverFixture = suiteServerFixture(args);

	task("auth: scenarios", async () => {
		const server = await serverFixture();
		console.log("[auth] server ready");

		const results = await runScenarioMatrix({
			suite: "auth",
			unit: "req/s",
			latency: "p50",
			latencyDigits: 2,
			scenarios: SCENARIOS.map((scenario) => ({
				name: scenario.name,
				requestFor: (workerIndex: number, requestIndex: number) => scenario.requestFor(server, workerIndex, requestIndex),
			})),
			concurrency: args.concurrency,
			warmupMs: args.warmupMs,
			durationMs: args.durationMs,
		});

		printHttpResults(results);
		console.log("\nSession-validation cost = (authed GET − public GET) per request, per concurrency row.");
	});
}

await main(import.meta);
