import { afterEach, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { adminService } from "@/application/admin/admin.service";
import { adminWorkerOperationsService } from "@/application/admin/admin-worker-operations.service";
import { domainErrorsMiddleware } from "@/middleware/domain-errors.middleware";

process.env.BETTER_AUTH_SECRET ??= "test-secret-with-at-least-32-characters";
const [{ adminRoutes }, { auth }, { adminAuditService }, { workerService }, { providerService }] = await Promise.all([
	import("./admin.routes"),
	import("@/integrations/better-auth/better-auth.config"),
	import("@/application/admin/admin-audit.service"),
	import("@/workers/worker.service"),
	import("@/plugins/capabilities/provider.service"),
]);
const app = new Elysia().use(domainErrorsMiddleware).use(adminRoutes);

const originalGetSession = auth.api.getSession;
const originalUserHasPermission = auth.api.userHasPermission;
const originalGetAll = adminAuditService.getAll;
const originalListOperations = workerService.listOperations;
const originalGetConfigurations = providerService.getConfigurations;
const originalReorderConfigurations = providerService.reorderConfigurations;

afterEach(() => {
	auth.api.getSession = originalGetSession;
	auth.api.userHasPermission = originalUserHasPermission;
	adminAuditService.getAll = originalGetAll;
	workerService.listOperations = originalListOperations;
	providerService.getConfigurations = originalGetConfigurations;
	providerService.reorderConfigurations = originalReorderConfigurations;
});

/** Wraps a fake better-auth session payload so the mock matches auth.api.getSession's shape. */
function fakeGetSession(body: unknown): typeof auth.api.getSession {
	return (async () => body) as typeof auth.api.getSession;
}

test("admin audit endpoint rejects unauthenticated requests", async () => {
	const response = await app.handle(new Request("http://localhost/admin/audit"));

	expect(response.status).toBe(401);
});

test("admin audit endpoint returns a page for an authorized administrator", async () => {
	auth.api.getSession = fakeGetSession({
		user: {
			id: "admin-1",
			name: "Admin",
			email: "admin@example.com",
			emailVerified: true,
			createdAt: new Date(),
			updatedAt: new Date(),
			role: "admin",
			banned: false,
		},
		session: { id: "session-1" },
	});
	auth.api.userHasPermission = (async () => ({ success: true })) as typeof auth.api.userHasPermission;
	adminAuditService.getAll = async () => ({
		data: [],
		pagination: { total: 0, page: 1, limit: 50, totalPages: 1 },
	});

	const response = await app.handle(new Request("http://localhost/admin/audit?limit=50", { headers: { authorization: "Bearer admin" } }));

	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ data: [], pagination: { total: 0, page: 1, limit: 50, totalPages: 1 } });
});

test("admin audit endpoint rejects an authenticated user without permission", async () => {
	auth.api.getSession = fakeGetSession({
		user: {
			id: "user-1",
			name: "User",
			email: "user@example.com",
			emailVerified: true,
			createdAt: new Date(),
			updatedAt: new Date(),
			role: "user",
			banned: false,
		},
		session: { id: "session-1" },
	});
	auth.api.userHasPermission = (async () => ({ success: false })) as typeof auth.api.userHasPermission;

	const response = await app.handle(new Request("http://localhost/admin/audit", { headers: { authorization: "Bearer user" } }));

	expect(response.status).toBe(403);
});

test("worker operations endpoint returns paginated operations for an authorized administrator", async () => {
	auth.api.getSession = fakeGetSession({
		user: {
			id: "admin-1",
			name: "Admin",
			email: "admin@example.com",
			emailVerified: true,
			createdAt: new Date(),
			updatedAt: new Date(),
			role: "admin",
			banned: false,
		},
		session: { id: "session-1" },
	});
	auth.api.userHasPermission = (async () => ({ success: true })) as typeof auth.api.userHasPermission;
	workerService.listOperations = async () => ({ page: 1, limit: 20, total: 0, totalPages: 0, data: [] });

	const response = await app.handle(
		new Request("http://localhost/admin/workers/operations?status=running&limit=20", {
			headers: { authorization: "Bearer admin" },
		}),
	);

	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ page: 1, limit: 20, total: 0, totalPages: 0, data: [] });
});

test("metadata provider configuration endpoint returns priority for an authorized administrator", async () => {
	auth.api.getSession = fakeGetSession({
		user: {
			id: "admin-1",
			name: "Admin",
			email: "admin@example.com",
			emailVerified: true,
			createdAt: new Date(),
			updatedAt: new Date(),
			role: "admin",
			banned: false,
		},
		session: { id: "session-1" },
	});
	auth.api.userHasPermission = (async () => ({ success: true })) as typeof auth.api.userHasPermission;
	providerService.getConfigurations = async () => [
		{ id: "tmdb", name: "TMDB", version: "1.0.0", pluginId: "tmdb-plugin", priority: 10, enabled: true },
	];

	const response = await app.handle(new Request("http://localhost/admin/providers", { headers: { authorization: "Bearer admin" } }));

	expect(response.status).toBe(200);
	expect(await response.json()).toEqual([
		{ id: "tmdb", name: "TMDB", version: "1.0.0", pluginId: "tmdb-plugin", priority: 10, enabled: true },
	]);
});

test("metadata provider reorder endpoint persists the requested order", async () => {
	auth.api.getSession = fakeGetSession({
		user: {
			id: "admin-1",
			name: "Admin",
			email: "admin@example.com",
			emailVerified: true,
			createdAt: new Date(),
			updatedAt: new Date(),
			role: "admin",
			banned: false,
		},
		session: { id: "session-1" },
	});
	auth.api.userHasPermission = (async () => ({ success: true })) as typeof auth.api.userHasPermission;
	let received: string[] | undefined;
	providerService.reorderConfigurations = (providerIds) => {
		received = [...providerIds];

		return Promise.resolve([
			{ id: "imdb", name: "IMDb", version: "1.0.0", pluginId: "omdb-plugin", priority: 10, enabled: true },
			{ id: "tmdb", name: "TMDB", version: "1.0.0", pluginId: "tmdb-plugin", priority: 20, enabled: true },
		]);
	};

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

test("plugin config endpoints return schema and update configuration for administrator", async () => {
	auth.api.getSession = fakeGetSession({
		user: {
			id: "admin-1",
			name: "Admin",
			email: "admin@example.com",
			emailVerified: true,
			createdAt: new Date(),
			updatedAt: new Date(),
			role: "admin",
			banned: false,
		},
		session: { id: "session-1" },
	});
	auth.api.userHasPermission = (async () => ({ success: true })) as typeof auth.api.userHasPermission;

	const originalPluginConfig = adminService.pluginConfig;
	const originalUpdatePluginConfig = adminService.updatePluginConfig;

	adminService.pluginConfig = async (id: string) => ({
		id,
		name: "Test Plugin",
		version: "1.0.0",
		description: "A test plugin",
		config: { autoApprove: true, threshold: 2 },
		fields: [
			{ name: "autoApprove", type: "boolean", label: "Auto Approve", default: true },
			{ name: "threshold", type: "number", label: "Threshold", default: 2 },
		],
	});

	adminService.updatePluginConfig = async (id: string, updated: Record<string, unknown>) => ({
		id,
		name: "Test Plugin",
		version: "1.0.0",
		description: "A test plugin",
		config: updated,
		fields: [
			{ name: "autoApprove", type: "boolean", label: "Auto Approve", default: true },
			{ name: "threshold", type: "number", label: "Threshold", default: 2 },
		],
	});

	try {
		const getRes = await app.handle(
			new Request("http://localhost/admin/plugins/test-plugin/config", {
				headers: { authorization: "Bearer admin" },
			}),
		);
		expect(getRes.status).toBe(200);
		const data = await getRes.json();
		expect(data.id).toBe("test-plugin");
		expect(data.fields.length).toBe(2);

		const putRes = await app.handle(
			new Request("http://localhost/admin/plugins/test-plugin/config", {
				method: "PUT",
				headers: { authorization: "Bearer admin", "content-type": "application/json" },
				body: JSON.stringify({ autoApprove: false, threshold: 5 }),
			}),
		);
		expect(putRes.status).toBe(200);
		const updatedData = await putRes.json();
		expect(updatedData.config.autoApprove).toBe(false);
		expect(updatedData.config.threshold).toBe(5);
	} finally {
		adminService.pluginConfig = originalPluginConfig;
		adminService.updatePluginConfig = originalUpdatePluginConfig;
	}
});

test("admin worker routes handle items, operations, stats and cancel requests", async () => {
	auth.api.getSession = fakeGetSession({
		user: {
			id: "admin-1",
			name: "Admin",
			email: "admin@example.com",
			emailVerified: true,
			createdAt: new Date(),
			updatedAt: new Date(),
			role: "admin",
			banned: false,
		},
		session: { id: "session-1" },
	});
	auth.api.userHasPermission = (async () => ({ success: true })) as typeof auth.api.userHasPermission;

	const originalGetWorkerItems = adminWorkerOperationsService.getItems;
	const originalGetWorkerItem = adminWorkerOperationsService.getItem;
	const originalCancelWorkerItem = adminWorkerOperationsService.cancelItem;
	const originalCancelPendingItems = adminWorkerOperationsService.cancelPendingItems;
	const originalGetWorkerStats = adminWorkerOperationsService.getStats;
	const originalGetWorkerOperation = adminWorkerOperationsService.getOperation;
	const originalGetWorkerOperationItems = adminWorkerOperationsService.getOperationItems;
	const originalCancelWorkerOperation = adminWorkerOperationsService.cancelOperation;
	const originalCancelAllOperations = adminWorkerOperationsService.cancelAllOperations;

	const mockItem = {
		id: "item-1",
		workerId: "test-worker",
		operationId: "op-1",
		dependsOnTaskIds: [],
		status: "pending" as const,
		priority: 0,
		attempts: 0,
		maxAttempts: 3,
		runAt: new Date().toISOString(),
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};

	const mockOp = {
		id: "op-1",
		type: "library-scan",
		status: "running" as const,
		cancelRequested: false,
		totalItems: 1,
		pendingItems: 1,
		runningItems: 0,
		completedItems: 0,
		failedItems: 0,
		cancelledItems: 0,
		progressPercent: 0,
		etaMs: null,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};

	const originalGetWorkerSummaries = adminWorkerOperationsService.getWorkerSummaries;

	const mockSummary = {
		id: "test-worker",
		name: "Test Worker",
		description: "A test worker",
		category: "library" as const,
		concurrency: 2,
		timeoutMs: 30000,
		stats: { workerId: "test-worker", concurrency: 2, timeoutMs: 30000, waiting: 1, active: 0, completed: 0, failed: 0 },
		triggers: [],
	};

	adminWorkerOperationsService.getWorkerSummaries = async () => [mockSummary];
	adminWorkerOperationsService.getItems = async () => [mockItem];
	adminWorkerOperationsService.getItem = async () => mockItem;
	adminWorkerOperationsService.cancelItem = async () => ({ success: true });
	adminWorkerOperationsService.cancelPendingItems = async (workerId?: string) => ({ count: workerId ? 5 : 12 });
	adminWorkerOperationsService.getStats = async () => [
		{ workerId: "test-worker", concurrency: 2, timeoutMs: 30000, waiting: 1, active: 0, completed: 0, failed: 0 },
	];
	adminWorkerOperationsService.getOperation = async () => mockOp;
	adminWorkerOperationsService.getOperationItems = async () => ({
		items: [mockItem],
		summary: { total: 1, pending: 1, running: 0, completed: 0, failed: 0, cancelled: 0 },
		page: 1,
		limit: 50,
		total: 1,
		totalPages: 1,
	});
	adminWorkerOperationsService.cancelOperation = async () => ({ success: true });
	adminWorkerOperationsService.cancelAllOperations = async () => ({ count: 3 });

	try {
		const itemsRes = await app.handle(new Request("http://localhost/admin/workers/jobs", { headers: { authorization: "Bearer admin" } }));
		expect(itemsRes.status).toBe(200);
		expect((await itemsRes.json()).length).toBe(1);

		const itemRes = await app.handle(
			new Request("http://localhost/admin/workers/jobs/item-1", { headers: { authorization: "Bearer admin" } }),
		);
		expect(itemRes.status).toBe(200);

		const cancelItemRes = await app.handle(
			new Request("http://localhost/admin/workers/jobs/item-1", {
				method: "DELETE",
				headers: { authorization: "Bearer admin" },
			}),
		);
		expect(cancelItemRes.status).toBe(200);

		const cancelWorkerPendingRes = await app.handle(
			new Request("http://localhost/admin/workers/image-processing/cancel", {
				method: "POST",
				headers: { authorization: "Bearer admin" },
			}),
		);
		expect(cancelWorkerPendingRes.status).toBe(200);
		expect(await cancelWorkerPendingRes.json()).toEqual({ success: true, cancelledCount: 5 });

		const cancelAllPendingRes = await app.handle(
			new Request("http://localhost/admin/workers/cancel-all", {
				method: "POST",
				headers: { authorization: "Bearer admin" },
			}),
		);
		expect(cancelAllPendingRes.status).toBe(200);
		expect(await cancelAllPendingRes.json()).toEqual({ success: true, cancelledCount: 12 });

		const workersRes = await app.handle(new Request("http://localhost/admin/workers", { headers: { authorization: "Bearer admin" } }));
		expect(workersRes.status).toBe(200);
		expect((await workersRes.json()).length).toBe(1);

		const opRes = await app.handle(
			new Request("http://localhost/admin/workers/operations/op-1", { headers: { authorization: "Bearer admin" } }),
		);
		expect(opRes.status).toBe(200);

		const opItemsRes = await app.handle(
			new Request("http://localhost/admin/workers/operations/op-1/jobs", { headers: { authorization: "Bearer admin" } }),
		);
		expect(opItemsRes.status).toBe(200);

		const cancelAllOpsRes = await app.handle(
			new Request("http://localhost/admin/workers/operations/cancel-all", {
				method: "POST",
				headers: { authorization: "Bearer admin" },
			}),
		);
		expect(cancelAllOpsRes.status).toBe(200);
		expect(await cancelAllOpsRes.json()).toEqual({ success: true, cancelledCount: 3 });

		const cancelOpRes = await app.handle(
			new Request("http://localhost/admin/workers/operations/op-1/cancel", {
				method: "POST",
				headers: { authorization: "Bearer admin" },
			}),
		);
		expect(cancelOpRes.status).toBe(200);
	} finally {
		adminWorkerOperationsService.getWorkerSummaries = originalGetWorkerSummaries;
		adminWorkerOperationsService.getItems = originalGetWorkerItems;
		adminWorkerOperationsService.getItem = originalGetWorkerItem;
		adminWorkerOperationsService.cancelItem = originalCancelWorkerItem;
		adminWorkerOperationsService.cancelPendingItems = originalCancelPendingItems;
		adminWorkerOperationsService.getStats = originalGetWorkerStats;
		adminWorkerOperationsService.getOperation = originalGetWorkerOperation;
		adminWorkerOperationsService.getOperationItems = originalGetWorkerOperationItems;
		adminWorkerOperationsService.cancelOperation = originalCancelWorkerOperation;
		adminWorkerOperationsService.cancelAllOperations = originalCancelAllOperations;
	}
});
