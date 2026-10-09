import { notificationsService } from "@/application/notifications/notifications.service";
import { usersRepository } from "@/database/repositories/users.repository";
import { HOUR } from "@/server.constants";
import { BaseService } from "@/utils/base-service";
import { MemoryCache } from "@/utils/memory-cache";
import { detach } from "@/utils/promise.utils";

/**
 * Failures an administrator must not miss:
 * - a worker job that exhausted its retries,
 * - a failed update install or rollback,
 * - a resource alert (disk/memory pressure).
 *
 * The dashboard receives these live, but only while an admin socket is open;
 * these notifications persist so the failure survives a missed window.
 */
const DEDUP_WINDOW_MS = 6 * HOUR;

class AdminFailureNotificationService extends BaseService {
	constructor() {
		super("AdminFailureNotificationService");
	}

	/** Bounded dedup: one notification per distinct failure inside the window. */
	private readonly recentFailures = new MemoryCache<boolean>({
		ttlMs: DEDUP_WINDOW_MS,
		maxSize: 50,
		name: "adminFailures",
	});

	notifyWorkerFailed(workerId: string, errorText: string | null): void {
		this.dispatch({
			dedupKey: `worker:${workerId}:${errorText ?? ""}`,
			type: "worker_failed",
			titleKey: "notification.worker_failed",
			data: { workerId, error: errorText ?? null },
			link: "/admin/workers",
		});
	}

	notifyUpdateFailed(component: string, version: string | null): void {
		this.dispatch({
			dedupKey: `update:${component}:${version ?? ""}`,
			type: "update_failed",
			titleKey: "notification.update_failed",
			data: { component, version },
			link: "/admin/updates",
		});
	}

	/** `code` is already a frontend-translatable key (e.g. `system.disk_low`). */
	notifyResourceAlert(code: string, params: Record<string, unknown>): void {
		this.dispatch({
			dedupKey: `resource:${code}`,
			type: "resource_alert",
			titleKey: code,
			data: params,
			link: "/admin/dashboard",
		});
	}

	private dispatch(entry: { dedupKey: string; type: string; titleKey: string; data: Record<string, unknown>; link: string }): void {
		if (this.recentFailures.get(entry.dedupKey)) return;
		this.recentFailures.set(entry.dedupKey, true);

		// Retries and alerts fire from worker/pool internals — never block them on the DB write.
		detach(
			(async () => {
				try {
					const admins = await usersRepository.findAllAdministrators();
					for (const admin of admins) {
						await notificationsService.create(
							{
								userId: admin.id,
								type: entry.type,
								title: entry.titleKey,
								data: entry.data,
								link: entry.link,
							},
							{ skipOwnershipCheck: true },
						);
					}

					this.logger.info("Notified administrators about a failure", {
						type: entry.type,
						dedupKey: entry.dedupKey,
						recipients: admins.length,
					});
				} catch (error) {
					this.logger.warn("Could not notify administrators about a failure", { type: entry.type, error });
				}
			})(),
		);
	}
}

export const adminFailureNotificationService = new AdminFailureNotificationService();
