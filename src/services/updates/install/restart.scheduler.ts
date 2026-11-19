import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { systemdNotify } from "@/config/env.config";
import {
	DISCARD_DIR,
	detectSystemdScope,
	LAUNCHER_FILE_NAMES,
	PENDING_DIR,
	PREVIOUS_DIR,
	SERVER_DIR_NAMES,
	type SystemdScope,
} from "@/services/updates/update-environment.utils";
import { isShutdownInProgress, requestApplicationRestart } from "@/system/shutdown.service";
import { createLogger } from "@/utils/logger.utils";
import type { RestartScheduler } from "./shared.types";

const RESTART_FALLBACK_MS = 10_000;
const logger = createLogger("UpdateRestart");

/** A unit file can remain installed after the server was started by hand or in a container. */
function isRunningUnderSystemd(): boolean {
	return Boolean(systemdNotify.socketPath ?? systemdNotify.invocationId);
}

/** Systemd owns the stop/start pair only for a process it actually started. */
export function shouldRequestSystemdRestart(scope: SystemdScope | null, underSystemd: boolean): boolean {
	return scope !== null && underSystemd;
}

export function defaultRestartScheduler(): RestartScheduler {
	return {
		scheduleRestart(root: string): void {
			if (process.platform === "win32") {
				writeWindowsSwapScript(root);
			} else {
				const systemdScope = detectSystemdScope();
				if (systemdScope !== null && shouldRequestSystemdRestart(systemdScope, isRunningUnderSystemd())) {
					// systemd owns the stop/start pair: it sends SIGTERM, the normal
					// shutdown path runs, and a second in-process restart would race
					// that signal and force-exit mid-shutdown.
					logger.info("Requesting systemd restart", { scope: systemdScope });
					detachedSpawn("systemctl", [...(systemdScope === "user" ? ["--user"] : []), "restart", "reelvault"]);
					// A wrong scope or a failed daemon-reload leaves the process alive with
					// the new files swapped in. Restart ourselves when no shutdown follows.
					const fallback = setTimeout(() => {
						if (!isShutdownInProgress()) {
							logger.warn("Systemd restart did not reach the process; restarting in-process");
							requestApplicationRestart();
						}
					}, RESTART_FALLBACK_MS);
					fallback.unref();

					return;
				}

				// No supervisor: a detached helper waits for this process to exit and
				// relaunches the already-swapped application.
				detachedSpawn("sh", [
					"-c",
					'while kill -0 "$1" 2>/dev/null; do sleep 0.5; done; cd "$2" && exec ./start.sh',
					"sh",
					String(process.pid),
					root,
				]);
			}

			requestApplicationRestart();
		},
	};
}

/**
 * Writes a batch script that waits for the server process to exit, swaps the
 * application directories and relaunches. Spawned detached, it outlives the
 * shutting-down server.
 */
function writeWindowsSwapScript(root: string): void {
	const script = join(root, "apply-update.cmd");
	const pid = process.pid;
	const scriptLines = [
		"@echo off",
		'set "ROOT=%~dp0"',
		":wait",
		`tasklist /FI "PID eq ${pid}" 2>NUL | find "${pid}" >NUL`,
		"if not errorlevel 1 ( timeout /t 1 /nobreak >NUL & goto wait )",
		`if exist "%ROOT%\\${PREVIOUS_DIR}" rmdir /s /q "%ROOT%\\${PREVIOUS_DIR}"`,
		`mkdir "%ROOT%\\${PREVIOUS_DIR}"`,
	];

	for (const name of [...SERVER_DIR_NAMES, ...LAUNCHER_FILE_NAMES]) {
		scriptLines.push(
			`if exist "%ROOT%\\${name}" move "%ROOT%\\${name}" "%ROOT%\\${PREVIOUS_DIR}\\${name}" >NUL`,
			`if exist "%ROOT%\\${PENDING_DIR}\\ReelVault\\${name}" move "%ROOT%\\${PENDING_DIR}\\ReelVault\\${name}" "%ROOT%\\${name}" >NUL`,
		);
	}

	scriptLines.push(
		`if exist "%ROOT%\\${PENDING_DIR}" rmdir /s /q "%ROOT%\\${PENDING_DIR}"`,
		`if exist "%ROOT%\\${DISCARD_DIR}" rmdir /s /q "%ROOT%\\${DISCARD_DIR}"`,
		'start "" "%ROOT%start.bat"',
		'del "%~f0"',
		"",
	);

	writeFileSync(script, scriptLines.filter((line) => line.length > 0).join("\r\n"));
	detachedSpawn("cmd", ["/c", "start", "", script]);
}

export function detachedSpawn(command: string, args: string[]): void {
	Bun.spawn([command, ...args], {
		detached: true,
		stdio: ["ignore", "ignore", "ignore"],
	});
}
