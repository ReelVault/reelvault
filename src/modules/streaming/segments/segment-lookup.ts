import type { BunFile } from "bun";
import { serverConfig } from "@/server.config";
import { isMissingFile, NotFoundError, RequestTimeoutError } from "@/utils/errors";
import { FileUtils } from "@/utils/file.utils";
import { PromiseUtils } from "@/utils/promise.utils";
import { INIT_SEGMENT_FILE_NAME } from "../utils/segment-name.utils";

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
		const initialFile = await this.waitThenRead(filePath, initialWaitMs, signal);
		if (initialFile) return initialFile;

		if (segment === INIT_SEGMENT_FILE_NAME)
			throw new NotFoundError("fMP4 init segment was not generated in time", { code: "init_segment_not_found" });

		if (context.isSeeking()) {
			const seekWaitMs = this.dependencies.seekWaitMs ?? serverConfig.stream.seekSegmentTimeoutMs;
			const seekFile = await this.waitThenRead(filePath, seekWaitMs, signal);
			if (seekFile) return seekFile;

			throw new NotFoundError(`Segment not found after ongoing seek: ${segment}`);
		}

		if (context.isNearActiveWindow) {
			throw new NotFoundError(`Segment not yet generated: ${segment}`);
		}

		return undefined;
	}

	async readAfterSeek(context: SegmentWaitContext, timeoutMs: number): Promise<BunFile> {
		const { filePath, segment, signal } = context;
		const seekFile = await this.waitThenRead(filePath, timeoutMs, signal);
		if (seekFile) return seekFile;

		throw new NotFoundError(`Segment not found after seek: ${segment}`);
	}

	/** Waits for the file and reads it; aborts rethrow, other wait failures return undefined for the caller to map. */
	private async waitThenRead(filePath: string, timeoutMs: number, signal?: AbortSignal): Promise<BunFile | undefined> {
		try {
			await this.dependencies.waitForFile(filePath, timeoutMs, POLL_INTERVAL_MS, signal);

			return this.read(filePath);
		} catch (error) {
			if (signal?.aborted) throw error;

			return undefined;
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
