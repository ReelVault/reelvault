import { serverConfig } from "@/config/server/server.config";
import { normalizeStringList } from "@/modules/streaming/utils/string-list.utils";
import { DomainError } from "@/utils/domain.errors";
import { detach } from "@/utils/promise.utils";
import { normalizeLower } from "@/utils/type.utils";

interface Entry<T> {
	fingerprint: string;
	promise: Promise<T>;
	/** Set when the creation settles; a pending entry never expires or gets evicted. */
	expiresAt: number | undefined;
}

const SWEEP_INTERVAL_MS = 15_000;
const DEFAULT_MAX_ENTRIES = 1_000;

/**
 * Single-node idempotency registry for session creation. The streaming registry,
 * worker and HLS files are local to this process as well, so this deliberately
 * does not claim to provide cross-node guarantees.
 */
export class PlaybackSessionIdempotencyRegistry<T = unknown> {
	private readonly entries = new Map<string, Entry<T>>();
	private readonly maxEntries: number;
	private lastSweepAt = 0;

	/** `maxEntries` caps settled entries only: a pending creation is never dropped, or a retry would start a second session. */
	constructor(maxEntries = DEFAULT_MAX_ENTRIES) {
		this.maxEntries = maxEntries;
	}

	execute(profileId: string, idempotencyKey: string, body: Record<string, unknown>, create: () => Promise<T>): Promise<T> {
		this.removeExpiredEntriesIfDue();

		const key = `${profileId}:${idempotencyKey}`;
		const fingerprint = fingerprintPlaybackSession(body);
		const existing = this.entries.get(key);
		if (existing) {
			if (existing.fingerprint !== fingerprint) {
				throw new DomainError("conflict", "Idempotency-Key was already used with different playback session settings", {
					code: "stream.idempotency_conflict",
				});
			}

			return existing.promise;
		}

		const { promise, resolve, reject } = Promise.withResolvers<T>();
		const entry: Entry<T> = { fingerprint, promise, expiresAt: undefined };
		this.evictOldestSettledIfFull();
		this.entries.set(key, entry);

		detach(
			(async () => {
				try {
					resolve(await create());
				} catch (error) {
					reject(error);
				} finally {
					entry.expiresAt = Date.now() + serverConfig.stream.completedRequestTtlMs;
					this.removeExpiredEntriesIfDue();
				}
			})(),
		);

		return promise;
	}

	private evictOldestSettledIfFull(): void {
		if (this.entries.size < this.maxEntries) return;

		for (const [key, entry] of this.entries) {
			if (entry.expiresAt === undefined) continue;

			this.entries.delete(key);

			return;
		}
	}

	private removeExpiredEntriesIfDue(): void {
		const now = Date.now();
		if (this.entries.size <= 100 && now - this.lastSweepAt < SWEEP_INTERVAL_MS) return;

		this.lastSweepAt = now;
		for (const [key, entry] of this.entries) {
			if (entry.expiresAt !== undefined && entry.expiresAt <= now) this.entries.delete(key);
		}
	}
}

export function fingerprintPlaybackSession(body: Record<string, unknown>): string {
	const mediaFileId = normalizeString(body.mediaFileId);
	const videoCodecs = normalizeCodecs(body.videoCodecs).join(",");
	const audioCodecs = normalizeCodecs(body.audioCodecs).join(",");
	const hdrTransfers = normalizeCodecs(body.hdrTransfers).join(",");
	const maxBitrate = fingerprintValue(body.maxBitrate);
	const audioStreamIndex = fingerprintValue(body.audioStreamIndex);
	const audioLanguage = normalizeString(body.audioLanguage);
	const subtitleLanguage = normalizeString(body.subtitleLanguage);
	const subtitlesEnabled = fingerprintValue(body.subtitlesEnabled);
	const forcedSubtitlesOnly = fingerprintValue(body.forcedSubtitlesOnly);

	return `${mediaFileId}|${videoCodecs}|${audioCodecs}|${hdrTransfers}|${maxBitrate}|${audioStreamIndex}|${audioLanguage}|${subtitleLanguage}|${subtitlesEnabled}|${forcedSubtitlesOnly}`;
}

/** Stringifies scalar fingerprint fields; non-scalar values collapse to the empty sentinel. */
function fingerprintValue(value: unknown): string {
	if (typeof value === "string") return value;

	if (typeof value === "number" || typeof value === "boolean") return String(value);

	return "";
}

function normalizeCodecs(value: unknown): string[] {
	if (!Array.isArray(value)) return [];

	return normalizeStringList(value);
}

function normalizeString(value: unknown): string {
	return typeof value === "string" ? normalizeLower(value) : "";
}
