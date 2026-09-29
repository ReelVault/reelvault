import type { AdminUpdateRelease } from "@reelvault/sdk/common";
import { notificationsService } from "@/application/notifications/notifications.service";
import type { UpdateComponent } from "@/application/updates/update-environment";
import { notificationsRepository } from "@/database/repositories/notifications.repository";
import { usersRepository } from "@/database/repositories/users.repository";
import { BaseService } from "@/utils/base-service";
import { updateCheckService } from "./update-check.service";

const UPDATE_NOTIFICATION_TYPE = "update_available";
// Stable i18n keys — the frontend renders the localized text from the key plus
// the interpolation data (server-owned strings stay language-neutral).
const TITLE_KEYS: Record<UpdateComponent, string> = {
	server: "notification.update_available_server",
	web: "notification.update_available_web",
};

class UpdateNotificationService extends BaseService {
	constructor() {
		super("UpdateNotificationService");
	}

	/**
	 * Refreshes both release checks and, when a newer version exists, sends one
	 * notification per administrator for each component. De-duplicated by
	 * (version, component) — the same release never notifies twice.
	 */
	async notifyIfUpdateAvailable(forceCheck = true): Promise<boolean> {
		return await this.safeExecute("notifyIfUpdateAvailable", async () => {
			await updateCheckService.checkLatest(forceCheck);
			const state = updateCheckService.getState();
			const notifiedServer = await this.notifyComponent("server", state.serverLatest, state.serverUpdateAvailable);
			const notifiedWeb = await this.notifyComponent("web", state.webLatest, state.webUpdateAvailable && !state.webRequiresServerUpdate);

			return notifiedServer || notifiedWeb;
		});
	}

	private async notifyComponent(
		component: UpdateComponent,
		release: AdminUpdateRelease | null,
		updateAvailable: boolean,
	): Promise<boolean> {
		if (!(release && updateAvailable)) return false;

		const alreadyNotified = await notificationsRepository.existsForVersion(UPDATE_NOTIFICATION_TYPE, release.version, component);
		if (alreadyNotified) return false;

		const admins = await usersRepository.findAllAdministrators();
		for (const admin of admins) {
			await notificationsService.create(
				{
					userId: admin.id,
					type: UPDATE_NOTIFICATION_TYPE,
					title: TITLE_KEYS[component],
					data: { version: release.version, component, releaseUrl: release.url },
					link: "/admin/updates",
				},
				{ skipOwnershipCheck: true },
			);
		}
		this.logger.info("Notified administrators about a new release", { component, version: release.version, recipients: admins.length });

		return true;
	}
}

export const updateNotificationService = new UpdateNotificationService();
