import { pluginAccessBus } from "@/plugins/runtime/plugin.access";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "@/utils/errors";
import type { SessionAccessInfo } from "../runtime/session-state/session-store";

type StreamAccessChecker = (input: {
	userId: string;
	profileId: string;
	mediaFileId: string;
}) => Promise<{ code: string; message: string } | null | undefined>;

function defaultStreamAccessCheck(input: {
	userId: string;
	profileId: string;
	mediaFileId: string;
}): Promise<{ code: string; message: string } | null | undefined> {
	return pluginAccessBus.check({
		userId: input.userId,
		profileId: input.profileId,
		resource: "stream",
		action: "play",
		mediaFileId: input.mediaFileId,
	});
}

export async function assertActiveStreamAccess({
	userId,
	profileId,
	mediaFileId,
	check = defaultStreamAccessCheck,
}: {
	userId?: string | undefined;
	profileId?: string | undefined;
	mediaFileId: string;
	check?: StreamAccessChecker | undefined;
}): Promise<void> {
	if (!userId) throw new UnauthorizedError("Session expired or invalid");

	if (!profileId) throw new ForbiddenError("An active profile is required to stream media");

	const decision = await check({ userId, profileId, mediaFileId });
	if (decision) {
		// Surface the structured denial code so clients can translate it (docs:
		// access-control), with the human message as the error text.
		throw new ForbiddenError(decision.message, { code: decision.code });
	}
}

/**
 * Any admin-issued termination reason (`admin.terminated`, `admin-stop`, …) is
 * a deliberate kill. Every guard must agree on that, otherwise a session killed
 * with a loose reason can be recreated moments later.
 */
export function isAdminTerminationReason(reason: string): boolean {
	return reason.startsWith("admin");
}

export function resolveSessionAccess(
	sessionId: string,
	getSessionAccess: (id: string) => SessionAccessInfo | undefined,
	getTerminatedSession: (id: string) => { reason: string } | undefined,
): SessionAccessInfo {
	const session = getSessionAccess(sessionId);
	if (!session) {
		const terminated = getTerminatedSession(sessionId);
		// A deliberate admin kill gets a distinct code so the client can show the
		// terminated UI instead of silently reconnecting.
		if (terminated && isAdminTerminationReason(terminated.reason)) {
			throw new ForbiddenError("Playback session was terminated", { code: "stream.session_terminated" });
		}

		// A session released by inactivity or a client release must NOT look alive:
		// returning its terminated access let heartbeat answer `state:"active"` for
		// up to 5 minutes, defeating the client's recovery path. A 404 is correct.
		throw new NotFoundError(`Playback session not found: ${sessionId}`);
	}

	return session;
}

export function assertSessionOwnership(session: SessionAccessInfo, profileId?: string): void {
	if (session.profileId !== profileId) throw new ForbiddenError("Playback session belongs to another profile");
}
