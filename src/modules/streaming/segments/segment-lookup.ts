import type { BunFile } from "bun";
import { serverConfig } from "@/server.config";
import { isMissingFile, NotFoundError, RequestTimeoutError } from "@/utils/errors";
import { FileUtils } from "@/utils/file.utils";
import { PromiseUtils } from "@/utils/promise.utils";

const POLL_INTERVAL_MS = 200;

export interface SegmentWaitContext {
	segment: string;
	filePath: string;
	signal?: AbortSignal | undefined;
	/** Live check — the "seeking" state can change while we wait. */
	isSeeking: () => boolean;
	/** Segment just before the active transcode window — not generated yet. */
	isNearActiveWindow: boolean;
}

interface LookupDependencies {
	exists: (path: string) => Promise<boolean>;
	waitForFile: (path: string, timeoutMs: number, pollMs: number, signal?: AbortSignal) => void | Promise<void>;
	readFile: (path: string) => BunFile;
	initialWaitMs?: number;
	seekWaitMs?: number;
}

const defaultDependencies: LookupDependencies = {
	exists: (path) => FileUtils.exists(path),
	waitForFile: (path, timeoutMs, pollMs, signal) => PromiseUtils.waitForFile(path, timeoutMs, pollMs, signal),
	readFile: (path) => FileUtils.get(path),
};

/**
 * Layered wait for a segment file: exists → short wait → wait during seek →
 * implicit-seek decision (undefined). Returns the file or an "implicit seek
 * required" signal; domain errors are thrown per the serving policy.
 */
export class SegmentLookup {
	private readonly dependencies: LookupDependencies;

	constructor(dependencies: Partial<LookupDependencies> = {}) {
		this.dependencies = { ...defaultDependencies, ...dependencies };
	}

	async find(context: SegmentWaitContext): Promise<BunFile | undefined> {
		const { filePath, segment, signal } = context;

		if (await this.dependencies.exists(filePath)) {
			return this.read(filePath);
		}

		const initialWaitMs = this.dependencies.initialWaitMs ?? serverConfig.stream.initialSegmentTimeoutMs;
		try {
			await this.dependencies.waitForFile(filePath, initialWaitMs, POLL_INTERVAL_MS, signal);

			return this.read(filePath);
		} catch (error) {
			if (signal?.aborted) throw error;
		}

		if (segment === "init.mp4") throw new NotFoundError("fMP4 init segment was not generated in time", { code: "init_segment_not_found" });

		if (context.isSeeking()) {
			const seekWaitMs = this.dependencies.seekWaitMs ?? serverConfig.stream.seekSegmentTimeoutMs;
			try {
				await this.dependencies.waitForFile(filePath, seekWaitMs, POLL_INTERVAL_MS, signal);

				return this.read(filePath);
			} catch (error) {
				if (signal?.aborted) throw error;

				throw new NotFoundError(`Segment not found after ongoing seek: ${segment}`);
			}
		}

		if (context.isNearActiveWindow) {
			throw new NotFoundError(`Segment not yet generated: ${segment}`);
		}

		return undefined;
	}

	async readAfterSeek(context: SegmentWaitContext, timeoutMs: number): Promise<BunFile> {
		const { filePath, segment, signal } = context;
		try {
			await this.dependencies.waitForFile(filePath, timeoutMs, POLL_INTERVAL_MS, signal);

			return this.read(filePath);
		} catch (error) {
			if (signal?.aborted) throw error;

			throw new NotFoundError(`Segment not found after seek: ${segment}`);
		}
	}

	private read(filePath: string): BunFile {
		try {
			return this.dependencies.readFile(filePath);
		} catch (error) {
			if (isMissingFile(error)) {
				throw new RequestTimeoutError("Segment was removed by a seek restart — retry shortly");
			}

			throw error;
		}
	}
}
