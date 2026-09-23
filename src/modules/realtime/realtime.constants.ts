/**
 * Upper bound of playback-session subscriptions a single WebSocket can hold.
 * Prevents malicious or misbehaving clients from leaking memory via unlimited `subscribe_session`.
 */
export const MAX_SESSION_SUBSCRIPTIONS_PER_CONNECTION = 10;

/**
 * Inactive duration before a WebSocket connection without ping/activity is considered stale.
 */
export const CLIENT_STALE_TIMEOUT_MS = 60_000;

/**
 * Sweep interval for reaping closed or unresponsive sockets.
 */
export const STALE_SWEEP_INTERVAL_MS = 30_000;
