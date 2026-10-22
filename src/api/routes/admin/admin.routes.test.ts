import { afterEach, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { domainErrorsMiddleware } from "@/api/middleware/domain-errors.middleware";
import { auth } from "@/integrations/better-auth/better-auth.config";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { workerJobRepository } from "@/repositories/worker.repository";
import { workerOperationRepository } from "@/repositories/worker-operation.repository";
import { adminAuditService } from "@/services/admin/admin-audit.service";
import { type MethodStub, stubMethod } from "../../../../tests/helpers/method-stub.helper";
import { useTestDatabase } from "../../../../tests/helpers/test-database.helper";
import { adminRoutes } from "./admin.routes";

// Route wiring runs against the real admin services and the migrated test database.
// Only the better-auth session lookup is stubbed: it maps the bearer token to a seeded user.
// Success paths of the services themselves are tested in their own files.
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

test("the provider order endpoint refuses ids that no installed plugin provides", async () => {
	await signInAs("admin");

	const response = await app.handle(
		new Request("http://localhost/admin/providers/order", {
			method: "PUT",
			headers: { authorization: "Bearer admin", "content-type": "application/json" },
			body: JSON.stringify({ providerIds: ["no-such-provider"] }),
		}),
	);

	expect(response.status).toBe(400);
	expect(await response.json()).toMatchObject({ code: "metadata.providers_unknown" });
});

test("plugin config endpoints refuse a signed-in user who is not an administrator", async () => {
	await signInAs("user");

	const response = await app.handle(
		new Request("http://localhost/admin/plugins/test-plugin/config", { headers: { authorization: "Bearer user" } }),
	);

	expect(response.status).toBe(403);
	expect(await response.json()).toMatchObject({ code: "auth.admin_required" });
});

test("plugin config for a plugin that is not installed answers 404 with its code", async () => {
	await signInAs("admin");

	const response = await app.handle(
		new Request("http://localhost/admin/plugins/no-such-plugin/config", { headers: { authorization: "Bearer admin" } }),
	);

	expect(response.status).toBe(404);
	expect(await response.json()).toMatchObject({ code: "plugin.not_found" });
});

test("pausing the schedule of a worker that is not registered answers 404", async () => {
	await signInAs("admin");

	const response = await app.handle(
		new Request("http://localhost/admin/workers/no-such-worker/enabled", {
			method: "PUT",
			headers: { authorization: "Bearer admin", "content-type": "application/json" },
			body: JSON.stringify({ enabled: false }),
		}),
	);

	expect(response.status).toBe(404);
	expect(await response.json()).toMatchObject({ code: "worker.not_found" });
});

test("retrying a job that has not failed is refused with 409", async () => {
	await signInAs("admin");
	await enqueueJob("job-pending", "library-scan");

	const response = await app.handle(
		new Request("http://localhost/admin/workers/jobs/job-pending/retry", { method: "POST", headers: { authorization: "Bearer admin" } }),
	);

	expect(response.status).toBe(409);
	expect(await response.json()).toMatchObject({ code: "worker.item_not_retryable" });
});

test("the watchdog endpoint reports a worker runtime that has not started", async () => {
	await signInAs("admin");

	const response = await app.handle(new Request("http://localhost/admin/workers/watchdog", { headers: { authorization: "Bearer admin" } }));

	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ running: false, consecutiveFailures: 0, restarts: 0, recoveredJobs: 0 });
});
