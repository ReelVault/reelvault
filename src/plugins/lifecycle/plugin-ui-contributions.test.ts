import { describe, expect, test } from "bun:test";
import type { PluginUiManifest } from "@reelvault/sdk/plugin";
import { applyUiOverrides, listUiContributions } from "./plugin-ui-contributions.utils";

const manifest: PluginUiManifest = {
	name: "Requests",
	version: "1.0.0",
	pages: [
		{ id: "requests", path: "requests", name: { en: "Requests", pl: "Prośby" }, tag: "rv-requests", nav: "user" },
		{ id: "mine", path: "mine", name: "My requests", tag: "rv-mine" },
	],
	dialogs: [{ id: "new", title: "New request", tag: "rv-new" }],
	tabs: { "admin-plugin": [{ id: "queue", host: "admin-plugin", label: "Queue", page: "requests" }] },
	slots: {
		"navbar-profile-menu": [
			{ label: "Mine", action: { type: "page", page: "mine" } },
			{ label: "Mine again", action: { type: "page", page: "mine" } },
			{ label: "New", action: { type: "dialog", dialog: "new" } },
		],
	},
	searchProvider: { endpoint: "/search", itemPage: "mine" },
	playbackPreRoll: { endpoint: "/pre-roll" },
};

describe("listUiContributions", () => {
	test("keys a slot entry with an explicit id independently of its position", () => {
		const withIds: PluginUiManifest = {
			...manifest,
			slots: {
				"navbar-profile-menu": [
					{ id: "new-request", label: "New", action: { type: "dialog", dialog: "new" } },
					{ id: "mine", label: "Mine", action: { type: "page", page: "mine" } },
				],
			},
		};

		expect(listUiContributions(withIds).map((item) => item.key)).toEqual([
			"page:requests",
			"page:mine",
			"dialog:new",
			"tab:admin-plugin:queue",
			"slot:navbar-profile-menu:id:new-request",
			"slot:navbar-profile-menu:id:mine",
			"searchProvider",
			"playbackPreRoll",
		]);
	});

	test("gives every contribution a unique, stable key", () => {
		expect(listUiContributions(manifest).map((item) => item.key)).toEqual([
			"page:requests",
			"page:mine",
			"dialog:new",
			"tab:admin-plugin:queue",
			"slot:navbar-profile-menu:page:mine",
			"slot:navbar-profile-menu:page:mine#2",
			"slot:navbar-profile-menu:dialog:new",
			"searchProvider",
			"playbackPreRoll",
		]);
	});

	test("resolves a localized label to its first entry", () => {
		expect(listUiContributions(manifest)[0]?.label).toBe("Requests");
	});
});

describe("applyUiOverrides", () => {
	test("returns the manifest untouched when nothing is hidden", () => {
		expect(applyUiOverrides(manifest, new Set())).toBe(manifest);
	});

	test("hiding a page also removes tabs, slot actions and the search item page that point at it", () => {
		const result = applyUiOverrides(manifest, new Set(["page:mine"]));

		expect(result.pages?.map((page) => page.id)).toEqual(["requests"]);
		expect(result.slots?.["navbar-profile-menu"]?.map((entry) => entry.label)).toEqual(["New"]);
		expect(result.searchProvider?.itemPage).toBeUndefined();
		expect(result.tabs?.["admin-plugin"]).toHaveLength(1);

		const withoutRequests = applyUiOverrides(manifest, new Set(["page:requests"]));
		expect(withoutRequests.tabs?.["admin-plugin"]).toEqual([]);
	});

	test("hides a single slot entry without touching its duplicate", () => {
		const result = applyUiOverrides(manifest, new Set(["slot:navbar-profile-menu:page:mine"]));

		expect(result.slots?.["navbar-profile-menu"]?.map((entry) => entry.label)).toEqual(["Mine again", "New"]);
	});

	test("hiding a dialog removes the slot action that opens it", () => {
		const result = applyUiOverrides(manifest, new Set(["dialog:new"]));

		expect(result.dialogs).toEqual([]);
		expect(result.slots?.["navbar-profile-menu"]?.map((entry) => entry.label)).toEqual(["Mine", "Mine again"]);
	});

	test("drops the search provider and pre-roll declarations when hidden", () => {
		const result = applyUiOverrides(manifest, new Set(["searchProvider", "playbackPreRoll"]));

		expect(result.searchProvider).toBeUndefined();
		expect(result.playbackPreRoll).toBeUndefined();
	});
});
