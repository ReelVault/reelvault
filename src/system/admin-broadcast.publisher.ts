import type { Logger } from "@reelvault/sdk/common";
import { detach } from "@/utils/promise.utils";

/**
 * Publishes to the admin broadcast port without letting a failing socket break
 * the caller. Fire-and-forget: the promise never rejects, and a failure is
 * logged rather than swallowed.
 */
export function publishAdminBroadcast(logger: Logger, label: string, publish: () => Promise<void>): void {
	detach(
		(async () => {
			try {
				await publish();
			} catch (error) {
				logger.error(`Failed to broadcast ${label}`, error);
			}
		})(),
	);
}
