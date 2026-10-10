import { describe, expect, test } from "bun:test";
import { liveSessionsRepository } from "@/database/repositories/live-sessions.repository";
import { endedSessionHistory } from "@/modules/streaming/runtime/ended-session-history";
import { stubMethod } from "../../../tests/helpers/method-stub";
import { adminLiveSessionsService } from "./admin-live-sessions.service";

/** The admin's list of recently ended sessions: the newest endings first, each with its title, profile and length. */
describe("adminLiveSessionsService.getEndedSessions", () => {
	test("lists the newest endings with their title, profile and length, up to the limit", async () => {
		const restoreMedia = stubMethod(liveSessionsRepository, "findMediaSummaries", () =>
			Promise.resolve([{ mediaFileId: "ended-file-1", title: "Ended Title" }]),
		);
		const restoreProfiles = stubMethod(liveSessionsRepository, "findProfilesWithUsers", () =>
			Promise.resolve([{ profileId: "ended-profile-1", profileName: "Ann" }]),
		);
		const startedAt = Date.now() - 120_000;
		endedSessionHistory.record({
			sessionId: "ended-older",
			mediaFileId: "ended-file-1",
			profileId: "ended-profile-1",
			reason: "client-stop",
			startedAt,
			endedAt: startedAt + 30_000,
		});
		endedSessionHistory.record({
			sessionId: "ended-newer",
			mediaFileId: "ended-file-1",
			profileId: "ended-profile-1",
			reason: "inactivity-timeout",
			startedAt,
			endedAt: startedAt + 90_000,
		});
		try {
			const page = await adminLiveSessionsService.getEndedSessions(1);

			expect(page.data).toEqual([
				expect.objectContaining({ sessionId: "ended-newer", title: "Ended Title", profileName: "Ann", durationSeconds: 90 }),
			]);
		} finally {
			restoreMedia.restore();
			restoreProfiles.restore();
		}
	});
});
