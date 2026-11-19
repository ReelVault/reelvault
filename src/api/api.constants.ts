import { MINUTE } from "@/config/server/server.constants";

/** Mount point of the versioned HTTP API, shared by the router and path classifiers. */
export const API_ROUTER_PREFIX = "/v1";

/** Window of the account-security limits: registration, password change, first-admin setup and the profile PIN switch. */
export const ACCOUNT_SECURITY_WINDOW_MS = 15 * MINUTE;

/** Window of the two-factor management limits: enable, disable and backup-code generation. */
export const TWO_FACTOR_MANAGEMENT_WINDOW_MS = 15 * MINUTE;

/** Window of the two-factor code verification limits. */
export const TWO_FACTOR_VERIFY_WINDOW_MS = 5 * MINUTE;

/** Window of the heavy admin maintenance actions: database restore, update install and update rollback. */
export const ADMIN_MAINTENANCE_WINDOW_MS = 10 * MINUTE;

/** Window of the library-wide refresh actions (error check, refresh of every media file). */
export const LIBRARY_REFRESH_WINDOW_MS = 5 * MINUTE;

/** Window of the image optimization budget. */
export const IMAGE_OPTIMIZATION_WINDOW_MS = 10_000;
