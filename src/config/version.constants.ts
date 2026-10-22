import pkg from "../../package.json";

/**
 * Version of the running server binary — read once from the package.json that
 * ships next to `src/` in both the repository and the release archives.
 */
export const SERVER_VERSION: string = pkg.version;

/** The oldest Bun the server runs on: `engines.bun` without its `>=`. */
export const MIN_BUN_VERSION: string = pkg.engines.bun.replace(">=", "");
