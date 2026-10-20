import { assertSessionAccess } from "@/modules/streaming/sessions/session-access.guard";
import { assertActiveStreamAccess } from "@/modules/streaming/sessions/stream-access.guard";
import { DomainError } from "@/utils/domain.errors";

interface RouteAccessContext {
	user?: { id: string } | null | undefined;
	profile?: { id: string } | null | undefined;
}

/** The active profile id for a `profileRequired` route; the guard already rejected a missing profile. */
export function requireProfileId(profile: { id: string } | null | undefined): string {
	if (!profile) {
		throw new DomainError("unauthorized", "This route requires an active profile", { code: "auth.profile_required" });
	}

	return profile.id;
}

/** Route guard for a media file: pulls the actor ids from the request context once. */
export async function assertRouteMediaAccess(context: RouteAccessContext, mediaFileId: string): Promise<void> {
	await assertActiveStreamAccess({ userId: context.user?.id, profileId: context.profile?.id, mediaFileId });
}

/** Route guard for a playback session: ownership plus the plugin stream-access policy. */
export async function assertRouteSessionAccess(context: RouteAccessContext, sessionId: string): Promise<void> {
	await assertSessionAccess(sessionId, context.user?.id, context.profile?.id);
}
