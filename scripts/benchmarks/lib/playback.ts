import { parseSegments } from "benchkit";
import type { ManagedServer } from "./server";

/** Reads `sessionId` off an unknown JSON payload without casts. */
export function sessionIdFrom(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || !("sessionId" in value)) return undefined;

	const sessionId: unknown = value.sessionId;

	return typeof sessionId === "string" ? sessionId : undefined;
}

/** Segment file names from an HLS media playlist (.m4s / .ts lines). */
export function parseSegmentNames(playlist: string): string[] {
	return parseSegments(playlist);
}

/**
 * Creates a playback session on the sample clip. Callers own the identity
 * headers (cookie, x-profile-id, idempotency-key, x-forwarded-for) so each
 * suite keeps its own subnet and key scheme.
 */
export async function createPlaybackSession(server: ManagedServer, headers: Record<string, string>): Promise<string> {
	const response = await fetch(`${server.baseUrl}/v1/playback-sessions`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify({ mediaFileId: server.sampleMediaId, videoCodecs: ["h264"], audioCodecs: ["aac"] }),
	});
	if (!response.ok) {
		throw new Error(`Playback session creation failed: HTTP ${response.status} ${await response.text()}`);
	}

	const sessionId = sessionIdFrom(await response.json());
	if (!sessionId) throw new Error("Playback session response is missing sessionId");

	return sessionId;
}

/** Ends a playback session; the response status is the caller's concern. */
export async function deletePlaybackSession(server: ManagedServer, sessionId: string, headers: Record<string, string>): Promise<void> {
	await fetch(`${server.baseUrl}/v1/playback-sessions/${sessionId}`, { method: "DELETE", headers });
}
