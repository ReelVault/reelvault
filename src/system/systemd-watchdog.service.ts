import { which } from "bun";
import { systemdNotify } from "@/config/env.config";
import { createLogger } from "@/utils/logger.utils";
import { detachCatching, withTimeout } from "@/utils/promise.utils";

/** systemd sends these when the unit has `WatchdogSec=`; without them the integration is inert. */
const NOTIFY_SOCKET = systemdNotify.socketPath;
const WATCHDOG_USEC = Number.parseInt(systemdNotify.watchdogUsec ?? "", 10);

const SEND_TIMEOUT_MS = 2_000;
const MIN_WATCHDOG_INTERVAL_MS = 1_000;
const MAX_WATCHDOG_INTERVAL_MS = 30_000;

/** Half the configured watchdog window, bounded so a tiny unit value cannot spin. */
export function watchdogIntervalMs(watchdogUsec: number): number {
	if (!Number.isFinite(watchdogUsec) || watchdogUsec <= 0) return 0;

	return Math.min(MAX_WATCHDOG_INTERVAL_MS, Math.max(MIN_WATCHDOG_INTERVAL_MS, Math.floor(watchdogUsec / 2_000)));
}

/**
 * Keeps a systemd `WatchdogSec=` window alive from the event loop.
 *
 * The heartbeat is sent by the same loop that serves HTTP and runs the worker
 * poller: a synchronous SQLite call or a blocked disk cannot send it, so
 * systemd restarts the unit instead of leaving a frozen process in place.
 * `systemd-notify` is used because Bun does not expose an `AF_UNIX` datagram
 * socket; the command is tiny and launched with both streams ignored.
 */
class SystemdWatchdogService {
	readonly serviceName = "SystemdWatchdogService";
	readonly logger = createLogger("SystemdWatchdogService");

	private command: string | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;
	private enabled = false;
	private sending = false;

	start(): void {
		if (this.enabled) return;
		if (!NOTIFY_SOCKET) return;

		const intervalMs = watchdogIntervalMs(WATCHDOG_USEC);
		if (intervalMs === 0) {
			this.logger.info("systemd notify socket is present but WatchdogSec is not configured");

			return;
		}

		const command = which("systemd-notify");
		if (!command) {
			this.logger.warn("systemd watchdog requested but systemd-notify is not on PATH — watchdog stays off");

			return;
		}

		this.command = command;
		this.enabled = true;
		detachCatching(this.send(["--ready"]));
		this.timer = setInterval(() => detachCatching(this.send(["--watchdog"])), intervalMs);
		this.timer.unref();
		this.logger.info("systemd watchdog armed", { intervalMs, watchdogUsec: WATCHDOG_USEC });
	}

	async stop(): Promise<void> {
		if (!this.enabled) return;

		this.enabled = false;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}

		await this.send(["--stopping"], true);
	}

	private async send(args: readonly string[], force = false): Promise<void> {
		if (!(force || this.enabled)) return;
		if (this.sending) return;
		if (!this.command) return;

		this.sending = true;
		let process: ReturnType<typeof Bun.spawn> | undefined;
		try {
			process = Bun.spawn({ cmd: [this.command, ...args], stdout: "ignore", stderr: "ignore" });
			await withTimeout(process.exited, SEND_TIMEOUT_MS, `systemd-notify ${args.join(" ")}`);
		} catch (error) {
			// A broken notifier would otherwise be spawned on every interval. One
			// warning is more useful than a log flood; systemd will restart the unit
			// if its watchdog window is real.
			this.disable("systemd-notify failed", { args, error });
			try {
				process?.kill("SIGKILL");
			} catch {
				// Already exited.
			}
		} finally {
			this.sending = false;
		}
	}

	private disable(reason: string, context: Record<string, unknown>): void {
		if (!this.enabled) return;

		this.enabled = false;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		this.logger.warn(reason, context);
	}
}

export const systemdWatchdogService = new SystemdWatchdogService();
