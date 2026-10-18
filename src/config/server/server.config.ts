import { libraryConfig } from "./library.config";
import { platformConfig } from "./platform.config";
import { pluginConfig } from "./plugins.config";
import { resourceConfig } from "./resources.config";
import { streamingConfig } from "./streaming.config";
import { workerConfig } from "./workers.config";

/**
 * Server Configuration.
 *
 * Clearly separates:
 * 1. DYNAMIC RUNTIME CONFIGURATION (Values configurable by administrator via Admin Panel / system_settings)
 * 2. STATIC ARCHITECTURAL CONSTANTS (Fixed system invariants, path resolvers, protocol limits)
 *
 * Each section lives in `server-config/`. Getters read the settings store at access time,
 * so the top-level spread only copies references to the section objects.
 */
export const serverConfig = {
	...resourceConfig,
	...streamingConfig,
	...libraryConfig,
	...workerConfig,
	...pluginConfig,
	...platformConfig,
};
