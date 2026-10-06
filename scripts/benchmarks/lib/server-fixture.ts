import { type BenchmarkArgs, type Fixture, fixture } from "benchkit";
import { type ManagedServer, startBenchmarkServer } from "./server";

export interface CreateServerFixtureOptions {
	seedRows: number;
	keepServer: boolean;
	/** Generate the ffmpeg sample clip and register it in the catalog. */
	withSampleMedia?: boolean | undefined;
	/** Stage a minimal web dist and serve it (static-serving suites). */
	withWebDist?: boolean | undefined;
	/** Simulated client identities to seed (worker cookies rotate over these). */
	workerCount?: number | undefined;
}

/**
 * The shared managed-server fixture: keepServer and stop() are handled inside,
 * so a suite needs exactly one line to get an isolated seeded server.
 */
export function createServerFixture(options: CreateServerFixtureOptions): Fixture<ManagedServer> {
	return fixture("server", async ({ onCleanup }) => {
		const managed = await startBenchmarkServer({
			seedRows: options.seedRows,
			workerCount: options.workerCount,
			withSampleMedia: options.withSampleMedia,
			withWebDist: options.withWebDist,
			keepServer: options.keepServer,
		});
		if (!options.keepServer) onCleanup(() => managed.stop());

		return managed;
	});
}

/** The standard suite fixture: seed rows, one identity per worker, caller-owned flags. */
export function suiteServerFixture(args: BenchmarkArgs, overrides: Partial<CreateServerFixtureOptions> = {}): Fixture<ManagedServer> {
	return createServerFixture({
		seedRows: args.rows,
		workerCount: Math.max(...args.concurrency),
		keepServer: args.keepServer,
		...overrides,
	});
}
