/**
 * Offline escape from enforced two-factor authentication: `bun run admin:two-factor-enforcement <on|off>`.
 *
 * While `auth.enforceTwoFactor` is on, an account without an authenticator cannot sign in, so an
 * administrator who has not enrolled yet cannot switch enforcement off from the web panel either.
 * This switches it off (or back on) directly in the database, on the machine that holds the data
 * directory. A running server keeps the value it loaded, so restart it afterwards.
 */

import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { systemSettingsService } from "@/services/admin/system-settings.service";

const state = process.argv[2];
if (state !== "on" && state !== "off") {
	console.error("Usage: bun run admin:two-factor-enforcement <on|off>");
	process.exit(1);
}

try {
	databaseFactory.migrate();
	await systemSettingsService.updateSettings({ "auth.enforceTwoFactor": state === "on" });
	console.log(`Two-factor enforcement is now ${state}. Restart a running server to apply it.`);
	databaseFactory.shutdown();
} catch (error) {
	console.error(`Changing two-factor enforcement failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
