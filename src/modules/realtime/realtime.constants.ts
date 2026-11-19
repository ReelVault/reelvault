/**
 * Upper bound of playback-session subscriptions a single WebSocket can hold.
 * Prevents malicious or misbehaving clients from leaking memory via unlimited `subscribe_session`.
 */
export const MAX_SESSION_SUBSCRIPTIONS_PER_CONNECTION = 10;

/** Hard ceiling on open realtime sockets, so one account or a buggy client cannot exhaust memory. */
export const MAX_REALTIME_CONNECTIONS = 10_000;
export const MAX_REALTIME_CONNECTIONS_PER_USER = 32;

/**
 * Inactive duration before a WebSocket connection without ping/activity is considered stale.
 */
export const CLIENT_STALE_TIMEOUT_MS = 60_000;

/**
 * Sweep interval for reaping closed or unresponsive sockets.
 */
export const STALE_SWEEP_INTERVAL_MS = 30_000;

/** WebSocket close code "Try Again Later". */
export const WS_CLOSE_TRY_AGAIN_LATER = 1013;
