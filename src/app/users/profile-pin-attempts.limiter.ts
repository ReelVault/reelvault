import { MINUTE } from "@/config/server/server.constants";
import { InMemoryRateLimiter } from "@/utils/in-memory.limiter";

/** Wrong PINs allowed per user and profile in one window. Same budget as the profile switch route, so the warning is never stricter. */
export const PIN_ATTEMPT_LIMIT = 10;
export const PIN_ATTEMPT_WINDOW_MS = 15 * MINUTE;

const limiter = new InMemoryRateLimiter();

/** Wrong PINs still allowed for a key, and the seconds until its window ends. */
export function pinAttemptStatus(key: string, now = Date.now()): { attemptsRemaining: number; retryAfterSeconds: number } {
	const state = limiter.peek(key, PIN_ATTEMPT_LIMIT, now);
	if (!state) return { attemptsRemaining: PIN_ATTEMPT_LIMIT, retryAfterSeconds: 0 };

	return {
		attemptsRemaining: state.remaining,
		retryAfterSeconds: Math.ceil(state.resetMs / 1000),
	};
}

export function recordWrongPin(key: string, now = Date.now()): void {
	limiter.consume(key, PIN_ATTEMPT_LIMIT, PIN_ATTEMPT_WINDOW_MS, now);
}

export function clearWrongPins(key: string): void {
	limiter.reset(key);
}
