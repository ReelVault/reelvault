import { MINUTE } from "@/server.constants";

/** Wrong PINs allowed per user and profile in one window. Same budget as the profile switch route, so the warning is never stricter. */
export const PIN_ATTEMPT_LIMIT = 10;
export const PIN_ATTEMPT_WINDOW_MS = 15 * MINUTE;
/** Bounds the tracked keys so many different profile ids cannot grow the map without limit. */
const MAX_TRACKED_KEYS = 10_000;

interface PinAttemptWindow {
	failures: number;
	endsAt: number;
}

const windows = new Map<string, PinAttemptWindow>();

function activeWindow(key: string, now: number): PinAttemptWindow | undefined {
	const window = windows.get(key);
	if (window && window.endsAt > now) return window;

	windows.delete(key);

	return undefined;
}

/** Wrong PINs still allowed for a key, and the seconds until its window ends. */
export function pinAttemptStatus(key: string, now = Date.now()): { attemptsRemaining: number; retryAfterSeconds: number } {
	const window = activeWindow(key, now);
	if (!window) return { attemptsRemaining: PIN_ATTEMPT_LIMIT, retryAfterSeconds: 0 };

	return {
		attemptsRemaining: Math.max(0, PIN_ATTEMPT_LIMIT - window.failures),
		retryAfterSeconds: Math.ceil((window.endsAt - now) / 1000),
	};
}

export function recordWrongPin(key: string, now = Date.now()): void {
	const window = activeWindow(key, now) ?? { failures: 0, endsAt: now + PIN_ATTEMPT_WINDOW_MS };
	window.failures += 1;
	windows.set(key, window);

	if (windows.size > MAX_TRACKED_KEYS) {
		const oldest = windows.keys().next().value;
		if (oldest !== undefined) windows.delete(oldest);
	}
}

export function clearWrongPins(key: string): void {
	windows.delete(key);
}
