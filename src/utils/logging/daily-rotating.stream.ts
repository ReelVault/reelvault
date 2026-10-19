import fs from "node:fs";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { formatDateOnly } from "@/utils/time.utils";
import { archiveExistingFile, archiveTarget, currentLogDate } from "./file-archive.utils";

type LogDateProvider = () => string;

export class DailyRotatingStream extends Writable {
	private stream: fs.WriteStream;
	private currentDate: string;
	private nextRolloverAt: number;
	private rotationWaiters: Array<(error?: Error | null) => void> = [];
	/** Resolves once every line handed to the file stream has reached the file, not just its buffer. */
	flush(): Promise<void> {
		return new Promise((resolve) => {
			this.stream.write(Buffer.alloc(0), () => resolve());
		});
	}

	private rotationInFlight = false;
	private readonly activePath: string;
	private readonly dateProvider: LogDateProvider;
	private readonly usesWallClock: boolean;

	constructor(activePath: string, dateProvider: LogDateProvider = currentLogDate) {
		super();
		this.activePath = activePath;
		this.dateProvider = dateProvider;
		fs.mkdirSync(dirname(activePath), { recursive: true });
		this.usesWallClock = dateProvider === currentLogDate;
		this.currentDate = dateProvider();
		this.nextRolloverAt = this.usesWallClock ? nextDayBoundaryMs(this.currentDate) : 0;

		this.archiveStaleFile();

		this.stream = this.openStream();
	}

	override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		this.writeWithRotation(chunk, encoding, callback);
	}

	/**
	 * Pino writes one line per call. Lines queue here while the file stream is
	 * behind (its `drain` wait), and Node hands the whole backlog to `_writev`.
	 * Writing it as one buffer keeps the backlog from growing without bound —
	 * one write per line costs a threadpool round trip each and cannot keep up
	 * at request-log volume. Rotation is checked once per batch.
	 */
	override _writev(chunks: Array<{ chunk: Buffer | string; encoding: BufferEncoding }>, callback: (error?: Error | null) => void): void {
		const buffers = chunks.map(({ chunk, encoding }) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)));
		this.writeWithRotation(Buffer.concat(buffers), "utf8", callback);
	}

	private writeToStream(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		if (this.stream.write(chunk, encoding)) {
			callback();
		} else {
			this.stream.once("drain", () => callback());
		}
	}

	private writeWithRotation(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		if (Date.now() < this.nextRolloverAt) {
			this.writeToStream(chunk, encoding, callback);

			return;
		}

		this.rotateIfNeeded((rotateError) => {
			if (rotateError) {
				callback(rotateError);

				return;
			}

			this.writeToStream(chunk, encoding, callback);
		});
	}

	override _final(callback: (error?: Error | null) => void): void {
		this.stream.end(() => callback());
	}

	private openStream(): fs.WriteStream {
		const stream = fs.createWriteStream(this.activePath, { flags: "a" });
		stream.on("error", (error) => this.destroy(error));

		return stream;
	}

	private archiveStaleFile(): void {
		try {
			const existing = fs.statSync(this.activePath, { throwIfNoEntry: false });
			if (!existing) return;

			const fileDate = currentLogDateFromTimestamp(existing.mtimeMs);
			if (fileDate === this.currentDate) return;

			const directory = join(dirname(this.activePath), fileDate);
			let target = archiveTarget(directory, this.activePath, 0);
			let attempt = 1;
			while (fs.existsSync(target)) {
				target = archiveTarget(directory, this.activePath, attempt);
				attempt += 1;
			}

			fs.mkdirSync(directory, { recursive: true });
			fs.renameSync(this.activePath, target);
		} catch {
			// best-effort — an archive failure must never crash the logger
		}
	}

	private rotateIfNeeded(callback: (error?: Error | null) => void): void {
		const nextDate = this.dateProvider();
		if (nextDate === this.currentDate) {
			if (this.usesWallClock) this.nextRolloverAt = nextDayBoundaryMs(this.currentDate);

			callback();

			return;
		}

		this.rotationWaiters.push(callback);
		if (this.rotationInFlight) return;

		this.rotationInFlight = true;
		this.performRotation(nextDate, (error) => {
			const waiters = this.rotationWaiters;
			this.rotationWaiters = [];
			this.rotationInFlight = false;
			for (const waiter of waiters) waiter(error);
		});
	}

	private performRotation(nextDate: string, callback: (error?: Error | null) => void): void {
		this.stream.end(() => {
			archiveExistingFile(this.activePath, this.currentDate, (archiveError) => {
				if (archiveError) {
					callback(archiveError);

					return;
				}

				this.currentDate = nextDate;
				this.nextRolloverAt = this.usesWallClock ? nextDayBoundaryMs(nextDate) : 0;
				this.stream = this.openStream();
				callback();
			});
		});
	}
}

function nextDayBoundaryMs(dateString: string): number {
	const year = Number(dateString.slice(0, 4));
	const month = Number(dateString.slice(5, 7));
	const day = Number(dateString.slice(8, 10));

	return new Date(year, month - 1, day + 1).getTime();
}

function currentLogDateFromTimestamp(timestamp: number): string {
	return formatDateOnly(new Date(timestamp));
}
