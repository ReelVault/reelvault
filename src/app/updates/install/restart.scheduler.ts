import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	DISCARD_DIR,
	LAUNCHER_FILE_NAMES,
	PENDING_DIR,
	PREVIOUS_DIR,
	SERVER_DIR_NAMES,
	systemdServiceRegistered,
} from "@/app/updates/update-environment.utils";
import { requestApplicationRestart } from "@/system/shutdown.service";
import type { RestartScheduler } from "./shared.types";

export function defaultRestartScheduler(): RestartScheduler {
	return {
		scheduleRestart(root: string): void {
			if (process.platform === "win32") {
				writeWindowsSwapScript(root);
			} else if (systemdServiceRegistered()) {
				// systemd stops (graceful SIGTERM) and starts the unit in one call —
				// the exit code of the running process becomes irrelevant.
				detachedSpawn("systemctl", ["--user", "restart", "reelvault"]);
			} else {
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
