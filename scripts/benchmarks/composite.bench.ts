import { main, printHttpResults, runScenarioMatrix, suiteArgs, task } from "benchkit";
import { subnetIp, workerCookie } from "./lib/identity";
import type { ManagedServer } from "./lib/server";
import { createServerFixture } from "./lib/server-fixture";

/**
 * Frontend page-open SEQUENCES, measured as one sample per page visit — the
 * number the user feels, not per-request cost. "today" scenarios replay the
 * request fan-out the shipped clients make; "(1.2)" scenarios call the
 * composite endpoints landing with the 1.2 server line and read as 404s until
 * that ships (their error rate IS the before/after signal).
 */

interface CompositeContext {
	baseUrl: string;
	adminCookie: string;
	cookieFor: (workerIndex: number, requestIndex: number) => string;
	profileIdFor: (workerIndex: number, requestIndex: number) => string;
	movieId: string;
	tvId: string;
	mediaFileId: string;
	statusesBatch: string;
}

type SequenceBuilder = (context: CompositeContext, workerIndex: number, requestIndex: number) => Request[];

function headers(context: CompositeContext, workerIndex: number, requestIndex: number, withProfile = false): Record<string, string> {
	const cookie = context.cookieFor(workerIndex, requestIndex);
	return {
		cookie,
		...(withProfile ? { "x-profile-id": context.profileIdFor(workerIndex, requestIndex) } : {}),
		"x-forwarded-for": subnetIp(84, workerIndex),
	};
}

/** Issues the sequence in parallel (the browser fires these in one batch) and drains every body. */
async function runSequence(requests: Request[]): Promise<boolean> {
	const responses = await Promise.all(
		requests.map(async (request) => {
			try {
				return await fetch(request);
			} catch {
				return null;
			}
		}),
	);
	let ok = responses.length > 0;
	for (const response of responses) {
		if (!response) {
			ok = false;
			continue;
		}

		await response.arrayBuffer();
		if (!response.ok) ok = false;
	}

	return ok;
}

const dashboardOpen: SequenceBuilder = (context, workerIndex, requestIndex) => [
	new Request(`${context.baseUrl}/v1/discover?limit=10`, { headers: headers(context, workerIndex, requestIndex, true) }),
	new Request(`${context.baseUrl}/v1/me/continue-watching?limit=12`, { headers: headers(context, workerIndex, requestIndex, true) }),
	new Request(`${context.baseUrl}/v1/metadata?limit=10&sortBy=popularity&sortOrder=desc`, {
		headers: headers(context, workerIndex, requestIndex),
	}),
	new Request(`${context.baseUrl}/v1/me/watchlist/statuses?ids=${context.statusesBatch}`, {
		headers: headers(context, workerIndex, requestIndex, true),
	}),
];

const heroRotation: SequenceBuilder = (context, workerIndex, requestIndex) => [
	new Request(`${context.baseUrl}/v1/me/playback-suggestions/${context.movieId}`, {
		headers: headers(context, workerIndex, requestIndex, true),
	}),
	new Request(`${context.baseUrl}/v1/me/watchlist/statuses?ids=${context.movieId}`, {
		headers: headers(context, workerIndex, requestIndex, true),
	}),
];

const detailsOpenSeries: SequenceBuilder = (context, workerIndex, requestIndex) => [
	new Request(`${context.baseUrl}/v1/metadata/${context.tvId}/details-view`, {
		headers: headers(context, workerIndex, requestIndex, true),
	}),
	new Request(`${context.baseUrl}/v1/metadata/${context.tvId}/similar?limit=12`, { headers: headers(context, workerIndex, requestIndex) }),
];

const playerOpen: SequenceBuilder = (context, workerIndex, requestIndex) => [
	new Request(`${context.baseUrl}/v1/playback-sessions/view/${context.mediaFileId}`, {
		headers: headers(context, workerIndex, requestIndex, true),
	}),
	new Request(`${context.baseUrl}/v1/me/playback-progress/${context.movieId}`, {
		headers: headers(context, workerIndex, requestIndex, true),
	}),
	new Request(`${context.baseUrl}/v1/media-files/${context.mediaFileId}/markers`, {
		headers: headers(context, workerIndex, requestIndex, true),
	}),
	new Request(`${context.baseUrl}/v1/subtitles?mediaFileId=${context.mediaFileId}&limit=100`, {
		headers: headers(context, workerIndex, requestIndex, true),
	}),
	new Request(`${context.baseUrl}/v1/seasons?metadataId=${context.tvId}&limit=24`, {
		headers: headers(context, workerIndex, requestIndex),
	}),
	new Request(`${context.baseUrl}/v1/episodes?metadataId=${context.tvId}&limit=50`, {
		headers: headers(context, workerIndex, requestIndex),
	}),
];

/** Watchlist page today: list ids, then hydrate cards with a second request (the waterfall the 1.2 view kills). */
const watchlistHydrateToday: SequenceBuilder = (context, workerIndex, requestIndex) => [
	new Request(`${context.baseUrl}/v1/me/watchlist?limit=24`, { headers: headers(context, workerIndex, requestIndex, true) }),
	new Request(`${context.baseUrl}/v1/metadata?metadataIds=${context.statusesBatch}&fields=id,title,type,releaseDate,posterImageId`, {
		headers: headers(context, workerIndex, requestIndex, true),
	}),
];

// S7 ships as hydrate=true on the existing list route — a dedicated /view
// path would be swallowed by GET /me/watchlist/:metadataId.
const watchlistHydrate12: SequenceBuilder = (context, workerIndex, requestIndex) => [
	new Request(`${context.baseUrl}/v1/me/watchlist?limit=24&hydrate=true`, { headers: headers(context, workerIndex, requestIndex, true) }),
];

const batchSuggestions12: SequenceBuilder = (context, workerIndex, requestIndex) => [
	new Request(`${context.baseUrl}/v1/me/playback-suggestions?metadataIds=${context.statusesBatch}`, {
		headers: headers(context, workerIndex, requestIndex, true),
	}),
];

const adminDashboardView12: SequenceBuilder = (context) => [
	// adminOnly route — the admin identity the admin layout authenticates as.
	new Request(`${context.baseUrl}/v1/admin/dashboard-view`, {
		headers: { cookie: context.adminCookie, "x-forwarded-for": "10.84.255.1" },
	}),
];

interface SequenceScenario {
	name: string;
	builder: SequenceBuilder;
}

const SCENARIOS: readonly SequenceScenario[] = [
	{ name: "SEQ dashboard-open (today: discover+cw+popular+statuses)", builder: dashboardOpen },
	{ name: "SEQ hero-rotation (today: suggestion+status)", builder: heroRotation },
	{ name: "SEQ details-open series (today: view+similar)", builder: detailsOpenSeries },
	{ name: "SEQ player-open (today: view+progress+markers+subs+seasons+episodes)", builder: playerOpen },
	{ name: "SEQ watchlist-hydrate (today: list→metadata waterfall)", builder: watchlistHydrateToday },
	{ name: "SEQ watchlist-hydrate (1.2, single request)", builder: watchlistHydrate12 },
	{ name: "SEQ batch-suggestions (1.2)", builder: batchSuggestions12 },
	{ name: "SEQ admin-dashboard-view (1.2)", builder: adminDashboardView12 },
];

export const meta = { description: "Frontend page-open request sequences (dashboard, hero, details, player, watchlist) + 1.2 composites" };

const args = suiteArgs();

if (!args.help) {
	const serverFixture = createServerFixture({
		seedRows: args.rows,
		workerCount: Math.max(...args.concurrency),
		keepServer: args.keepServer,
	});

	task("composite: sequences", async () => {
		const server: ManagedServer = await serverFixture();
		// The statuses batch mirrors what the website cards request on first paint.
		const context: CompositeContext = {
			baseUrl: server.baseUrl,
			adminCookie: server.cookie,
			cookieFor: (workerIndex, requestIndex) => workerCookie(server, workerIndex * 997 + requestIndex),
			profileIdFor: (workerIndex, requestIndex) =>
				server.profileIdFor((workerIndex * 997 + requestIndex) % Math.max(server.workerCookies.length, 1)),
			movieId: server.benchmarkMovieDetailId,
			tvId: server.benchmarkTvDetailId,
			mediaFileId: server.benchmarkMediaFileId,
			statusesBatch: [server.benchmarkMovieDetailId, server.benchmarkTvDetailId, "meta-0000010", "meta-0000020", "meta-0000030"].join(","),
		};

		const results = await runScenarioMatrix({
			suite: "composite",
			unit: "visits/s",
			scenarios: SCENARIOS.map((scenario) => ({
				name: scenario.name,
				work: async (workerIndex: number, requestIndex: number) => ({
					ok: await runSequence(scenario.builder(context, workerIndex, requestIndex)),
				}),
			})),
			concurrency: args.concurrency,
			warmupMs: args.warmupMs,
			durationMs: args.durationMs,
		});

		printHttpResults(results);
	});
}

await main(import.meta);
