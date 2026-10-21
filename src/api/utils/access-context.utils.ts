import { assertSessionAccess } from "@/modules/streaming/sessions/session-access.guard";
import { assertActiveStreamAccess } from "@/modules/streaming/sessions/stream-access.guard";
import { assertProfileId, DomainError } from "@/utils/domain.errors";
import { mapConcurrent } from "@/utils/promise.utils";

/** How many access checks run at once. The check asks the plugin policy, so it is I/O bound. */
const ACCESS_CHECK_CONCURRENCY = 16;

interface RouteAccessContext {
	user?: { id: string } | null | undefined;
	profile?: { id: string } | null | undefined;
}

/** The active profile id for a `profileRequired` route; the guard already rejected a missing profile. */
export function requireProfileId(profile: { id: string } | null | undefined): string {
	const profileId = profile?.id;
	assertProfileId(profileId);

	return profileId;
}

/** Route guard for a media file: pulls the actor ids from the request context once. */
export async function assertRouteMediaAccess(context: RouteAccessContext, mediaFileId: string): Promise<void> {
	await assertActiveStreamAccess({ userId: context.user?.id, profileId: context.profile?.id, mediaFileId });
}

/**
 * Route guard for many media files. The checks are independent, so they run
 * with a bounded concurrency instead of one after another — a bulk request
 * carries up to 500 ids. The refusal that is reported is the first one in the
 * order the ids were given, so the answer does not depend on how the checks
 * interleaved.
 */
export async function assertRouteMediaAccessMany(context: RouteAccessContext, mediaFileIds: Iterable<string>): Promise<void> {
	const ids = [...new Set(mediaFileIds)];
	const failures = new Map<string, unknown>();

	await mapConcurrent(ids, ACCESS_CHECK_CONCURRENCY, async (mediaFileId) => {
		try {
			await assertRouteMediaAccess(context, mediaFileId);
		} catch (error) {
			failures.set(mediaFileId, error);
		}
	});

	for (const mediaFileId of ids) {
		const failure = failures.get(mediaFileId);
		if (failure === undefined) continue;
		throw failure instanceof Error ? failure : new DomainError("forbidden", "Media access denied", { cause: failure });
	}
}

/** Route guard for a playback session: ownership plus the plugin stream-access policy. */
export async function assertRouteSessionAccess(context: RouteAccessContext, sessionId: string): Promise<void> {
	await assertSessionAccess(sessionId, context.user?.id, context.profile?.id);
}
