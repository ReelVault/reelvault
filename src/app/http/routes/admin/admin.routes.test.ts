import { afterEach, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { adminService } from "@/app/admin/admin.service";
import { adminAuditService } from "@/app/admin/admin-audit.service";
import { adminWorkerOperationsService } from "@/app/admin/admin-worker-operations.service";
import { domainErrorsMiddleware } from "@/app/http/middleware/domain-errors.middleware";
import { workerJobRepository } from "@/app/repositories/worker.repository";
import { workerOperationRepository } from "@/app/repositories/worker-operation.repository";
import { auth } from "@/integrations/better-auth/better-auth.config";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { providerService } from "@/plugins/capabilities/provider.service";
import { type MethodStub, stubMethod } from "../../../../../tests/helpers/method-stub.helper";
import { useTestDatabase } from "../../../../../tests/helpers/test-database.helper";
import { adminRoutes } from "./admin.routes";

// Route wiring runs against the real admin services and the migrated test database.
// Only the better-auth session lookup is stubbed: it maps the bearer token to a seeded user.
const db = useTestDatabase();
const app = new Elysia().use(domainErrorsMiddleware).use(adminRoutes);
const stubs: MethodStub[] = [];

afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

async function signInAs(role: "admin" | "user"): Promise<void> {
	const id = role === "admin" ? "admin-1" : "user-1";
	await db
		.client()
		.insert(schema.users)
		.values({ id, name: id, email: `${id}@example.com`, emailVerified: true, role });
	const user = {
		id,
		name: id,
		email: `${id}@example.com`,
		emailVerified: true,
		createdAt: new Date(),
		updatedAt: new Date(),
		role,
		banned: false,
	};
	stubs.push(stubMethod(auth.api, "getSession", async () => ({ user, session: { id: "session-1" } })));
}

function enqueueJob(id: string, workerId: string, operationId?: string) {
	return workerJobRepository.enqueue({
		id,
		workerId,
		operationId,
		data: "{}",
		priority: 0,
		maxAttempts: 3,
		backoffType: "fixed",
		backoffDelayMs: 0,
		runAt: new Date(0),
	});
}

test("admin audit endpoint rejects unauthenticated requests", async () => {
	const response = await app.handle(new Request("http://localhost/admin/audit"));

	expect(response.status).toBe(401);
});

test("admin audit endpoint refuses a signed-in user without audit permission", async () => {
	await signInAs("user");

	const response = await app.handle(new Request("http://localhost/admin/audit", { headers: { authorization: "Bearer user" } }));

	expect(response.status).toBe(403);
	expect(await response.json()).toMatchObject({ code: "auth.admin_required" });
});

test("admin audit endpoint lists the entries the administrator actions recorded", async () => {
	await signInAs("admin");
	await adminAuditService.record({
		action: "update",
		resourceType: "worker_queue",
		resourceId: "all",
		summary: "cancelled pending jobs",
		context: { actorUserId: "admin-1" },
	});

	const response = await app.handle(new Request("http://localhost/admin/audit?limit=50", { headers: { authorization: "Bearer admin" } }));

	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({
		total: 1,
		data: [expect.objectContaining({ action: "update", resourceType: "worker_queue", resourceId: "all" })],
	});
});

test("cancelling a pending job stores it as cancelled and the worker-scoped bulk cancel leaves other workers alone", async () => {
	await signInAs("admin");
	await enqueueJob("job-1", "image-processing");
	await enqueueJob("job-2", "image-processing");
	await enqueueJob("job-other", "library-scan");
	const headers = { authorization: "Bearer admin" };

	const listed = await app.handle(new Request("http://localhost/admin/workers/jobs", { headers }));
	expect(listed.status).toBe(200);
	expect((await listed.json()).data).toHaveLength(3);

	const cancelItem = await app.handle(new Request("http://localhost/admin/workers/jobs/job-1/cancel", { method: "POST", headers }));
	expect(cancelItem.status).toBe(200);
	expect(await workerJobRepository.findItem("job-1")).toMatchObject({ status: "cancelled" });

	const cancelWorker = await app.handle(new Request("http://localhost/admin/workers/image-processing/cancel", { method: "POST", headers }));
	expect(cancelWorker.status).toBe(200);
	expect(await cancelWorker.json()).toEqual({ success: true, cancelledCount: 1 });
	expect(await workerJobRepository.findItem("job-2")).toMatchObject({ status: "cancelled" });
	// The bulk cancel is scoped to the worker: another worker's pending job stays queued.
	expect(await workerJobRepository.findItem("job-other")).toMatchObject({ status: "pending" });
});

test("cancelling an operation through the admin routes cancels its pending jobs", async () => {
	await signInAs("admin");
	await workerOperationRepository.create({ id: "op-1", type: "library-scan" });
	await enqueueJob("job-op-1", "library-scan", "op-1");
	const headers = { authorization: "Bearer admin" };

	const operation = await app.handle(new Request("http://localhost/admin/workers/operations/op-1", { headers }));
	expect(operation.status).toBe(200);
	expect(await operation.json()).toMatchObject({ id: "op-1", totalItems: 1 });

	const operationJobs = await app.handle(new Request("http://localhost/admin/workers/operations/op-1/jobs", { headers }));
	expect((await operationJobs.json()).data).toEqual([expect.objectContaining({ id: "job-op-1" })]);

	const cancel = await app.handle(new Request("http://localhost/admin/workers/operations/op-1/cancel", { method: "POST", headers }));
	expect(cancel.status).toBe(200);
	expect(await workerOperationRepository.findById("op-1")).toMatchObject({ status: "cancelled", cancelledItems: 1 });
});

test("metadata provider reorder endpoint hands the requested order to the provider service", async () => {
	await signInAs("admin");
	let received: string[] | undefined;
	stubs.push(
		stubMethod(providerService, "reorderConfigurations", (providerIds: string[]) => {
			received = [...providerIds];

			return Promise.resolve([
				{ id: "imdb", name: "IMDb", version: "1.0.0", pluginId: "omdb-plugin", priority: 10, enabled: true },
				{ id: "tmdb", name: "TMDB", version: "1.0.0", pluginId: "tmdb-plugin", priority: 20, enabled: true },
			]);
		}),
	);

	const response = await app.handle(
		new Request("http://localhost/admin/providers/order", {
			method: "PUT",
			headers: { authorization: "Bearer admin", "content-type": "application/json" },
			body: JSON.stringify({ providerIds: ["imdb", "tmdb"] }),
		}),
	);

	expect(response.status).toBe(200);
	expect(received).toEqual(["imdb", "tmdb"]);
	expect(await response.json()).toMatchObject([{ id: "imdb" }, { id: "tmdb" }]);
});

test("plugin config endpoints return the schema fields and return the submitted values", async () => {
	await signInAs("admin");
	const fields = [
		{ name: "autoApprove", type: "boolean", label: "Auto Approve", default: true },
		{ name: "threshold", type: "number", label: "Threshold", default: 2 },
	];
	stubs.push(
		stubMethod(adminService, "pluginConfig", async (id: string) => ({
			id,
			name: "Test Plugin",
			version: "1.0.0",
			description: "A test plugin",
			config: { autoApprove: true, threshold: 2 },
			fields,
		})),
		stubMethod(adminService, "updatePluginConfig", async (id: string, updated: Record<string, unknown>) => ({
			id,
			name: "Test Plugin",
			version: "1.0.0",
			description: "A test plugin",
			config: updated,
			fields,
		})),
	);
	const headers = { authorization: "Bearer admin" };

	const getRes = await app.handle(new Request("http://localhost/admin/plugins/test-plugin/config", { headers }));
	expect(getRes.status).toBe(200);
	expect(await getRes.json()).toMatchObject({ id: "test-plugin", fields });

	const putRes = await app.handle(
		new Request("http://localhost/admin/plugins/test-plugin/config", {
			method: "PUT",
			headers: { ...headers, "content-type": "application/json" },
			body: JSON.stringify({ autoApprove: false, threshold: 5 }),
		}),
	);
	expect(putRes.status).toBe(200);
	expect(await putRes.json()).toMatchObject({ config: { autoApprove: false, threshold: 5 } });
});

test("admin worker routes pause and resume a schedule, retry failed jobs and report the watchdog", async () => {
	await signInAs("admin");
	stubs.push(
		stubMethod(adminWorkerOperationsService, "setScheduleEnabled", async (workerId: string, enabled: boolean) => ({
			workerId,
			enabled,
			nextRunAt: enabled ? "2026-10-09T10:00:00.000Z" : null,
		})),
		stubMethod(adminWorkerOperationsService, "retryItem", async () => ({ success: true, jobId: "item-2" })),
		stubMethod(adminWorkerOperationsService, "getWatchdogState", () => ({
			running: true,
			consecutiveFailures: 0,
			restarts: 0,
			elapsedSinceLastPollMs: 120,
			lastPollAt: "2026-10-09T10:00:00.000Z",
			recoveredJobs: 2,
		})),
	);
	const headers = { authorization: "Bearer admin" };

	const pauseRes = await app.handle(
		new Request("http://localhost/admin/workers/library-scan/enabled", {
			method: "PUT",
			headers: { ...headers, "content-type": "application/json" },
			body: JSON.stringify({ enabled: false }),
		}),
	);
	expect(pauseRes.status).toBe(200);
	expect(await pauseRes.json()).toEqual({ workerId: "library-scan", enabled: false, nextRunAt: null });

	const retryRes = await app.handle(new Request("http://localhost/admin/workers/jobs/item-1/retry", { method: "POST", headers }));
	expect(retryRes.status).toBe(200);
	expect(await retryRes.json()).toEqual({ success: true, jobId: "item-2" });

	const watchdogRes = await app.handle(new Request("http://localhost/admin/workers/watchdog", { headers }));
	expect(watchdogRes.status).toBe(200);
	expect(await watchdogRes.json()).toMatchObject({ running: true, recoveredJobs: 2 });
});
