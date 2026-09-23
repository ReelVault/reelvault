import { describe, expect, it } from "bun:test";
import type { PluginManifest } from "@reelvault/sdk/plugin";
import { defineConfig, field } from "@reelvault/sdk/plugin";
import {
	assertDeclaredPluginCapabilities,
	resolvePluginEntry,
	validatePluginConfig,
	validatePluginManifest,
	validatePluginSchema,
	validatePluginUiManifest,
} from "./plugin.manifest";

// Built at runtime so the linter's no-script-url rule does not flag the fixture.
const SCRIPT_URL = ["javascript", "alert(1)"].join(":");

const validManifest = {
	id: "org.reelvault.example",
	name: "Example plugin",
	version: "1.0.0",
	entry: "./dist/index.js",
	capabilities: ["eventHandler", "jobs"],
} satisfies PluginManifest;

describe("plugin manifest", () => {
	it("accepts a complete manifest and resolves its entry within the plugin directory", () => {
		expect(() => validatePluginManifest(validManifest)).not.toThrow();
		expect(resolvePluginEntry("/plugins/example", validManifest)).toBe("/plugins/example/dist/index.js");
	});

	it("rejects a manifest that declares an unsupported capability", () => {
		expect(() => validatePluginManifest({ ...validManifest, capabilities: ["rawDatabase"] })).toThrow("unsupported capability");
	});

	it("accepts the notification capability", () => {
		expect(() => validatePluginManifest({ ...validManifest, capabilities: ["notification"] })).not.toThrow();
	});

	it("rejects an entry that escapes the plugin directory", () => {
		expect(() => validatePluginManifest({ ...validManifest, entry: "../index.js" })).toThrow("relative path");
	});

	it("rejects runtime capabilities that are not declared in the manifest", () => {
		expect(() => assertDeclaredPluginCapabilities(["eventHandler"], ["eventHandler", "metadataProvider"])).toThrow("metadataProvider");
		expect(() => assertDeclaredPluginCapabilities(["eventHandler"], ["eventHandler"])).not.toThrow();
	});

	it("validates configuration through the declared schema before plugin initialization", () => {
		const definition = defineConfig({
			apiKey: field.secret({ label: "API key", required: true, default: "" }),
			language: field.string({ label: "Language", default: "en-US" }),
		});

		expect(validatePluginConfig({ apiKey: "secret", language: "pl" }, definition)).toEqual({ apiKey: "secret", language: "pl" });
		expect(validatePluginConfig({}, definition)).toEqual({ apiKey: "", language: "en-US" });
		expect(() => validatePluginConfig(["invalid"])).toThrow("configuration must be an object");
	});
});

describe("plugin ui manifest", () => {
	const validUiManifest = {
		name: "Example UI",
		version: "1.0.0",
		entry: "./dist/ui/index.js",
		pages: [
			{ id: "list", path: "list", name: "List", tag: "rv-example-list", nav: "admin", adminOnly: true },
			{ id: "submit", path: "submit", name: { pl: "Zgłoś", en: "Submit" }, tag: "rv-example-submit", nav: "user" },
		],
		dialogs: [{ id: "details", title: "Details", size: "lg", tag: "rv-example-details" }],
		tabs: { details: [{ id: "example", host: "details", label: "Example", page: "list" }] },
		slots: {
			"player-footer": [{ label: "Example", icon: "Star", priority: 10, action: { type: "page", page: "submit" } }],
			"root-floating-overlay": [{ label: "Widget", element: { tag: "rv-example-widget" } }],
		},
	};

	it("accepts a well-formed ui manifest", () => {
		expect(() => validatePluginUiManifest(validUiManifest)).not.toThrow();
	});

	it("requires the custom-element entry module", () => {
		expect(() => validatePluginUiManifest({ ...validUiManifest, entry: undefined })).toThrow("entry");
	});

	it("rejects an unsupported slot name", () => {
		expect(() => validatePluginUiManifest({ ...validUiManifest, slots: { "not-a-slot": [{ label: "x" }] } })).toThrow("unsupported slot");
	});

	it("rejects an unsupported tab host", () => {
		expect(() => validatePluginUiManifest({ ...validUiManifest, tabs: { nowhere: [] } })).toThrow("unsupported tab host");
	});

	it("rejects an entry that is not a relative path", () => {
		expect(() => validatePluginUiManifest({ ...validUiManifest, entry: "/etc/passwd" })).toThrow("relative path");
	});

	it("rejects a slot entry that declares both or neither action and element", () => {
		expect(() => validatePluginUiManifest({ ...validUiManifest, slots: { "player-footer": [{ label: "x" }] } })).toThrow("exactly one");
		expect(() =>
			validatePluginUiManifest({
				...validUiManifest,
				slots: {
					"player-footer": [
						{
							label: "x",
							action: { type: "page", page: "submit" },
							element: { tag: "rv-example-x" },
						},
					],
				},
			}),
		).toThrow("exactly one");
	});

	it("rejects a slot action that references an unknown surface", () => {
		expect(() =>
			validatePluginUiManifest({
				...validUiManifest,
				slots: { "player-footer": [{ label: "x", action: { type: "page", page: "nope" } }] },
			}),
		).toThrow("unknown page");
		expect(() =>
			validatePluginUiManifest({
				...validUiManifest,
				slots: { "player-footer": [{ label: "x", action: { type: "dialog", dialog: "nope" } }] },
			}),
		).toThrow("unknown dialog");
	});

	it("rejects a tab that references an unknown page", () => {
		expect(() =>
			validatePluginUiManifest({ ...validUiManifest, tabs: { details: [{ id: "t", host: "details", label: "T", page: "nope" }] } }),
		).toThrow("unknown page");
	});

	it("rejects duplicate page ids", () => {
		expect(() =>
			validatePluginUiManifest({
				...validUiManifest,
				pages: [
					{ id: "x", path: "a", name: "A", tag: "rv-example-a" },
					{ id: "x", path: "b", name: "B", tag: "rv-example-b" },
				],
			}),
		).toThrow("duplicate page id");
	});

	it("rejects an invalid custom element tag", () => {
		expect(() =>
			validatePluginUiManifest({
				...validUiManifest,
				slots: { "player-footer": [{ label: "x", element: { tag: "NoHyphen" } }] },
			}),
		).toThrow("custom element tag");
	});

	it("rejects slot actions that use a javascript: or protocol-relative href", () => {
		expect(() =>
			validatePluginUiManifest({
				...validUiManifest,
				slots: { "player-footer": [{ label: "x", action: { type: "external", href: SCRIPT_URL } }] },
			}),
		).toThrow("unsupported URL scheme");
		expect(() =>
			validatePluginUiManifest({
				...validUiManifest,
				slots: { "player-footer": [{ label: "x", action: { type: "navigate", href: "//evil.example" } }] },
			}),
		).toThrow("protocol-relative");
	});
});

describe("plugin declarative schema", () => {
	const validSchema = {
		data: { report: { path: "/reports" } },
		body: [
			{ type: "text", text: "Describe the problem" },
			{ type: "field", name: "title", input: "text", label: "Title", required: true },
			{
				type: "grid",
				columns: 2,
				children: [{ type: "field", name: "category", input: "select", label: "Category", options: [{ label: "A", value: "a" }] }],
			},
			{ type: "button", label: "Send", action: { type: "submit", path: "/reports", successToast: "ok", close: true } },
		],
	};

	it("accepts a well-formed schema surface", () => {
		expect(() =>
			validatePluginUiManifest({
				name: "X",
				version: "1.0.0",
				entry: "./dist/ui/index.js",
				dialogs: [{ id: "report", title: "Report", schema: validSchema }],
			}),
		).not.toThrow();
	});

	it("rejects a surface that declares both tag and schema", () => {
		expect(() =>
			validatePluginUiManifest({
				name: "X",
				version: "1.0.0",
				entry: "./dist/ui/index.js",
				dialogs: [{ id: "report", title: "Report", tag: "rv-x-report", schema: validSchema }],
			}),
		).toThrow("exactly one");
	});

	it("rejects an unsupported node type", () => {
		expect(() => validatePluginSchema({ body: [{ type: "marquee" }] }, "ui")).toThrow("unsupported node type");
	});

	it("rejects a field with an unsupported input", () => {
		expect(() => validatePluginSchema({ body: [{ type: "field", name: "x", input: "color", label: "X" }] }, "ui")).toThrow(
			"input is unsupported",
		);
	});

	it("rejects traversal in schema data paths and non-http(s) embed sources", () => {
		expect(() => validatePluginSchema({ data: { report: { path: "../../admin/users" } }, body: [] }, "ui")).toThrow("relative plugin path");
		expect(() => validatePluginSchema({ body: [{ type: "embed", src: SCRIPT_URL }] }, "ui")).toThrow("unsupported URL scheme");
		expect(() => validatePluginSchema({ body: [{ type: "embed", src: "https://example.com/e" }] }, "ui")).not.toThrow();
	});

	it("rejects a button with an unknown action type", () => {
		expect(() => validatePluginSchema({ body: [{ type: "button", label: "Go", action: { type: "explode" } }] }, "ui")).toThrow(
			"unsupported action type",
		);
	});
});
