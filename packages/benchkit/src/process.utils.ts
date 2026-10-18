import { sleep, spawn, write } from "bun";

/** Fire-and-forget for promises that own their errors (they catch internally). */
function detach(_promise: Promise<unknown>): void {
	// Detached intentionally: errors are owned by the task itself.
}

const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;
const DEFAULT_HEALTH_POLL_MS = 300;

export interface ManagedProcess {
	pid: number;
	exited: Promise<number>;
	/** Kills the process and resolves once it is gone. */
	stop(): Promise<void>;
}

export interface ManagedProcessOptions {
	cmd: string[];
	cwd: string;
	env: Record<string, string>;
	/** stdout+stderr are drained into this file as the process exits. */
	logPath?: string | undefined;
}

/**
 * Spawns a long-running child process with piped output and fire-and-forget
 * log draining — awaiting the drain inline would block until the process
 * stops, because `.text()` only resolves at pipe EOF.
 */
export function spawnManagedProcess(options: ManagedProcessOptions): ManagedProcess {
	const child = spawn({ cmd: options.cmd, cwd: options.cwd, env: options.env, stdout: "pipe", stderr: "pipe" });
	if (options.logPath) detach(drainLogs(options.logPath, child));

	return {
		pid: child.pid,
		exited: child.exited,
		stop: async () => {
			child.kill();
			await child.exited;
		},
	};
}

async function drainLogs(logPath: string, child: Bun.Subprocess<"ignore" | "pipe", "pipe", "pipe">): Promise<void> {
	try {
		const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
		await write(logPath, out + err);
	} catch {
		// process exited before its pipes drained — nothing to log
	}
}

export interface HealthOptions {
	timeoutMs?: number;
	pollMs?: number;
}

/** Polls `url` until it responds 2xx, then resolves; throws on timeout. */
export async function waitForHealth(url: string, options: HealthOptions = {}): Promise<void> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
	const pollMs = options.pollMs ?? DEFAULT_HEALTH_POLL_MS;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(url);
			if (response.ok) return;
		} catch {
			// not up yet
		}

		await sleep(pollMs);
	}

	throw new Error(`Process did not become healthy within ${timeoutMs}ms (polled ${url})`);
}
