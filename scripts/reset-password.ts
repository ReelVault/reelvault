/**
 * Offline password recovery: `bun run admin:reset-password <email> [--password <value>] [--disable-2fa]`.
 *
 * ReelVault has no mail transport, so a locked-out administrator resets the password here, on the
 * machine that holds the data directory. Without `--password` a random one is generated and
 * printed once. `--disable-2fa` also removes the TOTP secret and backup codes (lost authenticator).
 * All sessions of the user are revoked; restart a running server to drop its short session cache.
 */
import { randomBytes } from "node:crypto";
import { passwordRecoveryService } from "@/application/auth/password-recovery.service";
import { databaseFactory } from "@/database/database";

function readOption(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);

	return index === -1 ? undefined : args[index + 1];
}

const args = process.argv.slice(2);
const email = args.find((arg) => !arg.startsWith("--") && arg !== readOption(args, "--password"));
if (!email) {
	console.error("Usage: bun run admin:reset-password <email> [--password <value>] [--disable-2fa]");
	process.exit(1);
}

const providedPassword = readOption(args, "--password");
const newPassword = providedPassword ?? randomBytes(12).toString("base64url");

try {
	databaseFactory.migrate();
	const { email: resolvedEmail } = await passwordRecoveryService.resetPassword({
		email,
		newPassword,
		disableTwoFactor: args.includes("--disable-2fa"),
	});
	console.log(`Password reset for ${resolvedEmail}. All sessions were revoked.`);
	if (!providedPassword) console.log(`New password (shown once): ${newPassword}`);
	databaseFactory.shutdown();
} catch (error) {
	console.error(`Password reset failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
