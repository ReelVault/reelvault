import pkg from "../package.json";

/**
 * Version of the running server binary — read once from the package.json that
 * ships next to `src/` in both the repository and the release archives.
 */
export const SERVER_VERSION: string = pkg.version;
