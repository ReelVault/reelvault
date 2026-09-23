import { type Fixture, fixture } from "benchkit";
import { type ManagedServer, startBenchmarkServer } from "./server";

export interface CreateServerFixtureOptions {
	seedRows: number;
	keepServer: boolean;
	/** Generate the ffmpeg sample clip and register it in the catalog. */
	withSampleMedia?: boolean | undefined;
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
			keepServer: options.keepServer,
		});
		if (!options.keepServer) onCleanup(() => managed.stop());

		return managed;
	});
}
