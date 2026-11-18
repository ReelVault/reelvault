import { afterEach, expect, test } from "bun:test";
import { pluginCatalogService } from "@/plugins/catalog/plugin-catalog.service";
import { pluginManager } from "@/plugins/lifecycle/plugin.manager";
import { stubMethod } from "../../../tests/helpers/method-stub.helper";
import { pluginAdminService } from "./plugin-admin.service";

const stubs: Array<{ restore(): void }> = [];
afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

const STATUS_A = {
	id: "org.example.a",
	name: "Plugin A",
	version: "1.0.0",
	state: "enabled",
	providers: 1,
	subtitleProviders: 2,
	jobs: 3,
} as const;

const STATUS_B = {
	id: "org.example.b",
	name: "Plugin B",
	version: "2.0.0",
	state: "disabled",
	providers: 0,
	subtitleProviders: 0,
	jobs: 0,
} as const;

const DETAILS_A = {
	capabilities: ["http"],
	installedAt: "2026-01-02T00:00:00.000Z",
	source: "upload",
	integrityOk: true,
	cspDisabled: false,
	pinned: false,
};
const DETAILS_B = { capabilities: ["storage"] };

function stubReads(updatable: ReadonlySet<string>): void {
	stubs.push(
		stubMethod(pluginManager, "getStatus", () => [STATUS_A, STATUS_B]),
		stubMethod(pluginManager, "getPackageDetails", (pluginId: string) => Promise.resolve(pluginId === STATUS_A.id ? DETAILS_A : DETAILS_B)),
		stubMethod(pluginCatalogService, "updatablePluginIds", () => Promise.resolve(updatable)),
	);
}

function stubLifecycle(initialState: "enabled" | "disabled"): void {
	let state = initialState;
	stubs.push(
		stubMethod(pluginManager, "getStatus", () => [{ ...STATUS_A, state }]),
		stubMethod(pluginManager, "getPackageDetails", () => Promise.resolve(DETAILS_A)),
		stubMethod(pluginManager, "setEnabled", (_pluginId: string, enabled: boolean) => {
			state = enabled ? "enabled" : "disabled";
		}),
		stubMethod(pluginManager, "reload", () => {
			state = "disabled";
		}),
		stubMethod(pluginCatalogService, "updatablePluginIds", () => Promise.resolve(new Set<string>())),
	);
}

test("list attaches package details and update flags to every status", async () => {
	stubReads(new Set([STATUS_A.id]));

	expect(await pluginAdminService.list()).toEqual([
		{
			id: "org.example.a",
			name: "Plugin A",
			version: "1.0.0",
			state: "enabled",
			providers: 1,
			subtitleProviders: 2,
			jobs: 3,
			capabilities: ["http"],
			installedAt: "2026-01-02T00:00:00.000Z",
			source: "upload",
			integrityOk: true,
			cspDisabled: false,
			pinned: false,
			updateAvailable: true,
		},
		{
			id: "org.example.b",
			name: "Plugin B",
			version: "2.0.0",
			state: "disabled",
			providers: 0,
			subtitleProviders: 0,
			jobs: 0,
			capabilities: ["storage"],
			updateAvailable: false,
		},
	]);
});

test("get returns the matching plugin with its details and update flag", async () => {
	stubReads(new Set([STATUS_B.id]));

	expect(await pluginAdminService.get(STATUS_B.id)).toEqual({
		id: "org.example.b",
		name: "Plugin B",
		version: "2.0.0",
		state: "disabled",
		providers: 0,
		subtitleProviders: 0,
		jobs: 0,
		capabilities: ["storage"],
		updateAvailable: true,
	});
});

test("get returns undefined for an unknown plugin id", async () => {
	stubReads(new Set([STATUS_A.id]));

	expect(await pluginAdminService.get("org.example.unknown")).toBeUndefined();
});

test("enable applies the change and returns the recorded enabled status", async () => {
	stubLifecycle("disabled");

	expect(await pluginAdminService.enable(STATUS_A.id)).toMatchObject({
		id: "org.example.a",
		state: "enabled",
		capabilities: ["http"],
		updateAvailable: false,
	});
});

test("disable applies the change and returns the recorded disabled status", async () => {
	stubLifecycle("enabled");

	expect(await pluginAdminService.disable(STATUS_A.id)).toMatchObject({
		id: "org.example.a",
		state: "disabled",
		capabilities: ["http"],
		updateAvailable: false,
	});
});

test("reload applies the change and returns the refreshed status", async () => {
	stubLifecycle("enabled");

	expect(await pluginAdminService.reload(STATUS_A.id)).toMatchObject({
		id: "org.example.a",
		state: "disabled",
		capabilities: ["http"],
		updateAvailable: false,
	});
});
