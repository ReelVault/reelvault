import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAY, MINUTE } from "@/config/server/server.constants";
import { DatabaseFactory, databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { recordInterruptedSession } from "@/modules/streaming/runtime/interrupted-session.recorder";
import { interruptedPlaybackSessionRepository } from "@/repositories/interrupted-playback-session.repository";
import { watchedHistoryRepository } from "@/repositories/watched-history.repository";
import { removeTreeSync } from "@/utils/directory.utils";
import { seedTitle } from "../helpers/media.fixture";

// Fixed, so the timestamps the rows store (second precision) can be written as literals.
const NOW = Date.parse("2026-01-15T12:00:00.123Z");
const HOUR = 60 * MINUTE;

const tempDirs: string[] = [];
const spies: Array<{ mockRestore(): void }> = [];
let factory: DatabaseFactory;

beforeEach(() => {
	const tempDir = mkdtempSync(join(tmpdir(), "rv-interrupted-"));
	tempDirs.push(tempDir);
	factory = new DatabaseFactory(join(tempDir, "test.sqlite"));
	factory.migrate();
	spies.push(spyOn(databaseFactory, "getClient").mockImplementation((options) => factory.getClient(options)));
});

afterEach(() => {
	for (const spy of spies.splice(0)) spy.mockRestore();
	for (const dir of tempDirs.splice(0)) removeTreeSync(dir);
});

function interruptedRow(id: string, playedSeconds: number, endedAtMs: number) {
	return {
		id,
		profileId: "profile-1",
		mediaFileId: "mf-1",
		startedAt: new Date(endedAtMs - playedSeconds * 1000),
		endedAt: new Date(endedAtMs),
		playedSeconds,
		furthestPositionSeconds: playedSeconds,
		durationSeconds: 3_600,
		reason: "client-stop",
	};
}

describe("interrupted playback sessions", () => {
	test("the recorder keeps only sessions that played and stopped short of the completion line", async () => {
		await seedTitle(factory.getClient());
		const session = { profileId: "profile-1", mediaFileId: "mf-1", reason: "client-stop", startedAt: NOW - HOUR, durationSeconds: 3_600 };

		await recordInterruptedSession({ ...session, playedSeconds: 120.4, furthestPositionSeconds: 130 }, new Date(NOW));
		// Never started playing: no media time, nothing to count.
		await recordInterruptedSession({ ...session, playedSeconds: 0, furthestPositionSeconds: 0 }, new Date(NOW));
		// Reached 91.7 % of the title: watched history holds this play, so it is not interrupted.
		await recordInterruptedSession({ ...session, playedSeconds: 3_000, furthestPositionSeconds: 3_300 }, new Date(NOW));

		const rows = await factory
			.getClient()
			.select({
				playedSeconds: schema.interruptedPlaybackSessions.playedSeconds,
				furthestPositionSeconds: schema.interruptedPlaybackSessions.furthestPositionSeconds,
				durationSeconds: schema.interruptedPlaybackSessions.durationSeconds,
				reason: schema.interruptedPlaybackSessions.reason,
			})
			.from(schema.interruptedPlaybackSessions);
		expect(rows).toEqual([{ playedSeconds: 120, furthestPositionSeconds: 130, durationSeconds: 3_600, reason: "client-stop" }]);
	});

	test("the admin analytics count interrupted sessions above the minimum next to finished titles", async () => {
		await seedTitle(factory.getClient());
		const client = factory.getClient();
		await client.insert(schema.watchedHistory).values({
			id: "wh-1",
			profileId: "profile-1",
			mediaFileId: "mf-1",
			durationWatched: 3_000,
			isFullWatch: true,
			watchedAt: new Date(NOW - HOUR),
		});
		await client
			.insert(schema.interruptedPlaybackSessions)
			.values([
				interruptedRow("ip-short", 45, NOW - 2 * HOUR),
				interruptedRow("ip-long", 300, NOW - 3 * HOUR),
				interruptedRow("ip-old", 600, NOW - 30 * DAY),
			]);
		const since = new Date(NOW - 7 * DAY);

		const withMinimum = await watchedHistoryRepository.findGlobalAnalytics({ since, minInterruptedSeconds: 60 });
		expect(withMinimum).toMatchObject({ totalPlays: 2, completedPlays: 1, totalMinutes: 55, activeUsers: 1 });
		expect(withMinimum.recentPlays.map((play) => ({ id: play.id, isFullWatch: play.isFullWatch }))).toEqual([
			{ id: "wh-1", isFullWatch: true },
			{ id: "ip-long", isFullWatch: false },
		]);
		expect(withMinimum.recentPlays[0]?.watchedAt).toEqual(new Date("2026-01-15T11:00:00.000Z"));
		expect(withMinimum.leaderboard[0]?.lastWatchedAt).toEqual(new Date("2026-01-15T11:00:00.000Z"));

		const withoutMinimum = await watchedHistoryRepository.findGlobalAnalytics({ since, minInterruptedSeconds: 0 });
		expect(withoutMinimum).toMatchObject({ totalPlays: 3, completedPlays: 1 });

		const top = await watchedHistoryRepository.findTopPlayedMedia({ since, minInterruptedSeconds: 60, limit: 10 });
		expect(top).toEqual([
			expect.objectContaining({ id: "meta-1", title: "Heat", watchCount: 2, totalDurationWatched: 3_300, isCompleted: true }),
		]);
	});

	test("pruneOlderThan deletes interrupted sessions that ended before the cutoff", async () => {
		await seedTitle(factory.getClient());
		await factory
			.getClient()
			.insert(schema.interruptedPlaybackSessions)
			.values([interruptedRow("old", 120, NOW - 400 * DAY), interruptedRow("fresh", 120, NOW - 5 * DAY)]);

		const deleted = await interruptedPlaybackSessionRepository.pruneOlderThan(new Date(NOW - 365 * DAY));

		expect(deleted).toBe(1);
		const remaining = await factory
			.getClient()
			.select({ id: schema.interruptedPlaybackSessions.id })
			.from(schema.interruptedPlaybackSessions);
		expect(remaining.map((row) => row.id)).toEqual(["fresh"]);
	});
});
