import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginManifest } from "@reelvault/sdk/plugin";
import { defineConfig, field } from "@reelvault/sdk/plugin";
import { removeTreeSync } from "@/utils/directory.utils";
import { validatePluginSchema } from "./manifest/schema.validator";
import { validatePluginUiManifest } from "./manifest/ui.validator";
import {
	assertDeclaredPluginCapabilities,
	resolvePluginEntry,
	resolvePluginUiSchemas,
	validatePluginConfig,
	validatePluginManifest,
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

describe("plugin manifest", () => {
	it("accepts a complete manifest and resolves its entry within the plugin directory", () => {
		validatePluginManifest(validManifest);
		expect(resolvePluginEntry("/plugins/example", validManifest)).toBe("/plugins/example/dist/index.js");
	});

	it("rejects a manifest that declares an unsupported capability", () => {
		expect(() => validatePluginManifest({ ...validManifest, capabilities: ["rawDatabase"] })).toThrow(
			expect.objectContaining({
				category: "validation",
				code: "plugin.capability_unsupported",
			}),
		);
	});

	it("rejects an entry that escapes the plugin directory", () => {
		expect(() => validatePluginManifest({ ...validManifest, entry: "../index.js" })).toThrow(
			expect.objectContaining({
				category: "validation",
				code: "plugin.field_path_invalid",
			}),
		);
	});

	it("rejects csp directives that could widen script or style execution", () => {
		expect(() => validatePluginManifest({ ...validManifest, csp: { "script-src": ["https://evil.example.com"] } })).toThrow(
			expect.objectContaining({ category: "validation", code: "plugin.csp_directive_unsupported" }),
		);
		expect(() => validatePluginManifest({ ...validManifest, csp: { "style-src": ["https://evil.example.com"] } })).toThrow(
			expect.objectContaining({ category: "validation", code: "plugin.csp_directive_unsupported" }),
		);
	});

	it("rejects csp sources that are not plain origins", () => {
		for (const source of ["https://example.com/path", "https://example.com; script-src *", "*", "data:"]) {
			expect(() => validatePluginManifest({ ...validManifest, csp: { "img-src": [source] } })).toThrow(
				expect.objectContaining({
					category: "validation",
					code: "plugin.csp_source_invalid",
				}),
			);
		}

		expect(() => validatePluginManifest({ ...validManifest, csp: { "img-src": [] } })).toThrow(
			expect.objectContaining({ category: "validation", code: "plugin.field_empty" }),
		);
	});

	it("rejects runtime capabilities that are not declared in the manifest", () => {
		expect(() => assertDeclaredPluginCapabilities(["eventHandler"], ["eventHandler", "metadataProvider"])).toThrow(
			expect.objectContaining({ category: "validation", code: "plugin.capability_undeclared" }),
		);
	});

	it("validates configuration through the declared schema before plugin initialization", () => {
		const definition = defineConfig({
			apiKey: field.secret({ label: "API key", required: true, default: "" }),
			language: field.string({ label: "Language", default: "en-US" }),
		});

		expect(validatePluginConfig({ apiKey: "secret", language: "pl" }, definition)).toEqual({ apiKey: "secret", language: "pl" });
		expect(validatePluginConfig({}, definition)).toEqual({ apiKey: "", language: "en-US" });
		expect(() => validatePluginConfig(["invalid"])).toThrow(
			expect.objectContaining({ category: "validation", code: "plugin.config_not_object" }),
		);
	});
});

describe("plugin ui manifest references and slots", () => {
	it("requires the custom-element entry module", () => {
		expect(() => validatePluginUiManifest({ ...validUiManifest, entry: undefined })).toThrow(
			expect.objectContaining({ category: "validation", code: "plugin.ui.field_not_string" }),
		);
	});

	it("rejects an unsupported slot name", () => {
		expect(() => validatePluginUiManifest({ ...validUiManifest, slots: { "not-a-slot": [{ label: "x" }] } })).toThrow(
			expect.objectContaining({
				category: "validation",
				code: "plugin.ui.slot_unsupported",
			}),
		);
	});

	it("rejects an unsupported tab host", () => {
		expect(() => validatePluginUiManifest({ ...validUiManifest, tabs: { nowhere: [] } })).toThrow(
			expect.objectContaining({
				category: "validation",
				code: "plugin.ui.tab_host_unsupported",
			}),
		);
	});

	it("rejects an entry that is not a relative path", () => {
		expect(() => validatePluginUiManifest({ ...validUiManifest, entry: "/etc/passwd" })).toThrow(
			expect.objectContaining({
				category: "validation",
				code: "plugin.ui.field_path_invalid",
			}),
		);
	});

	it("rejects a slot entry that declares both or neither action and element", () => {
		expect(() => validatePluginUiManifest({ ...validUiManifest, slots: { "player-footer": [{ label: "x" }] } })).toThrow(
			expect.objectContaining({ category: "validation", code: "plugin.ui.slot_entry_ambiguous" }),
		);
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
		).toThrow(expect.objectContaining({ category: "validation", code: "plugin.ui.slot_entry_ambiguous" }));
	});

	it("rejects a slot action that references an unknown surface", () => {
		expect(() =>
			validatePluginUiManifest({
				...validUiManifest,
				slots: { "player-footer": [{ label: "x", action: { type: "page", page: "nope" } }] },
			}),
		).toThrow(expect.objectContaining({ category: "validation", code: "plugin.ui.page_unknown" }));
		expect(() =>
			validatePluginUiManifest({
				...validUiManifest,
				slots: { "player-footer": [{ label: "x", action: { type: "dialog", dialog: "nope" } }] },
			}),
		).toThrow(expect.objectContaining({ category: "validation", code: "plugin.ui.dialog_unknown" }));
	});

	it("rejects a tab that references an unknown page", () => {
		expect(() =>
			validatePluginUiManifest({ ...validUiManifest, tabs: { details: [{ id: "t", host: "details", label: "T", page: "nope" }] } }),
		).toThrow(expect.objectContaining({ category: "validation", code: "plugin.ui.page_unknown" }));
	});
});

describe("plugin ui manifest schema references", () => {
	it("rejects a schema button that opens an undeclared dialog", () => {
		expect(() =>
			validatePluginUiManifest({
				...validUiManifest,
				pages: [
					...validUiManifest.pages,
					{
						id: "manage-page",
						path: "manage",
						name: "Manage",
						schema: { body: [{ type: "button", label: "Open", action: { type: "openDialog", dialog: "missing" } }] },
					},
				],
			}),
		).toThrow(expect.objectContaining({ category: "validation", code: "plugin.ui.dialog_unknown" }));
	});

	it("validates schemaRef dialog references against the manifest", async () => {
		const directory = mkdtempSync(join(tmpdir(), "reelvault-plugin-"));
		try {
			await Bun.write(
				join(directory, "schema.json"),
				JSON.stringify({ body: [{ type: "button", label: "Open", action: { type: "openDialog", dialog: "missing" } }] }),
			);
			const manifest = {
				name: "X",
				version: "1.0.0",
				entry: "./dist/ui/index.js",
				dialogs: [{ id: "report", title: "Report", tag: "rv-x-report" }],
				pages: [{ id: "admin", path: "admin", name: "Admin", schemaRef: "./schema.json" }],
			};

			await expect(resolvePluginUiSchemas(directory, manifest)).rejects.toMatchObject({
				category: "validation",
				code: "plugin.ui.dialog_unknown",
			});
		} finally {
			removeTreeSync(directory);
		}
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
		).toThrow(expect.objectContaining({ category: "validation", code: "plugin.ui.duplicate_id" }));
	});
});

describe("plugin ui manifest elements and links", () => {
	it("rejects an invalid custom element tag", () => {
		expect(() =>
			validatePluginUiManifest({
				...validUiManifest,
				slots: { "player-footer": [{ label: "x", element: { tag: "NoHyphen" } }] },
			}),
		).toThrow(expect.objectContaining({ category: "validation", code: "plugin.ui.element_tag_invalid" }));
	});

	it("rejects slot actions that use a javascript: or protocol-relative href", () => {
		expect(() =>
			validatePluginUiManifest({
				...validUiManifest,
				slots: { "player-footer": [{ label: "x", action: { type: "external", href: SCRIPT_URL } }] },
			}),
		).toThrow(expect.objectContaining({ category: "validation", code: "plugin.ui.url_invalid" }));
		expect(() =>
			validatePluginUiManifest({
				...validUiManifest,
				slots: { "player-footer": [{ label: "x", action: { type: "navigate", href: "//evil.example" } }] },
			}),
		).toThrow(expect.objectContaining({ category: "validation", code: "plugin.ui.url_invalid" }));
	});

	it("accepts a slot entry id and rejects an invalid or duplicate one", () => {
		const slot = (ids: string[]) => ({
			...validUiManifest,
			slots: { "player-footer": ids.map((id) => ({ id, label: "x", action: { type: "navigate", href: "/x" } })) },
		});

		validatePluginUiManifest(slot(["first", "second"]));
		expect(() => validatePluginUiManifest(slot(["bad id!"]))).toThrow(
			expect.objectContaining({ category: "validation", code: "plugin.ui.characters_unsupported" }),
		);
		expect(() => validatePluginUiManifest(slot(["same", "same"]))).toThrow(
			expect.objectContaining({ category: "validation", code: "plugin.ui.duplicate_id" }),
		);
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

	it("rejects a surface that declares both tag and schema", () => {
		expect(() =>
			validatePluginUiManifest({
				name: "X",
				version: "1.0.0",
				entry: "./dist/ui/index.js",
				dialogs: [{ id: "report", title: "Report", tag: "rv-x-report", schema: validSchema }],
			}),
		).toThrow(expect.objectContaining({ category: "validation", code: "plugin.ui.element_source_invalid" }));
	});

	it("rejects an unsupported node type", () => {
		expect(() => validatePluginSchema({ body: [{ type: "marquee" }] }, "ui")).toThrow(
			expect.objectContaining({
				category: "validation",
				code: "plugin.ui.field_unsupported",
			}),
		);
	});

	it("rejects a field with an unsupported input", () => {
		expect(() => validatePluginSchema({ body: [{ type: "field", name: "x", input: "color", label: "X" }] }, "ui")).toThrow(
			expect.objectContaining({ category: "validation", code: "plugin.ui.field_unsupported" }),
		);
	});

	it("rejects traversal in schema data paths and non-http(s) embed sources", () => {
		expect(() => validatePluginSchema({ data: { report: { path: "../../admin/users" } }, body: [] }, "ui")).toThrow(
			expect.objectContaining({
				category: "validation",
				code: "plugin.ui.path_invalid",
			}),
		);
		expect(() => validatePluginSchema({ body: [{ type: "embed", src: SCRIPT_URL }] }, "ui")).toThrow(
			expect.objectContaining({
				category: "validation",
				code: "plugin.ui.url_invalid",
			}),
		);
		validatePluginSchema({ body: [{ type: "embed", src: "https://example.com/e" }] }, "ui");
	});

	it("rejects a button with an unknown action type", () => {
		expect(() => validatePluginSchema({ body: [{ type: "button", label: "Go", action: { type: "explode" } }] }, "ui")).toThrow(
			expect.objectContaining({ category: "validation", code: "plugin.ui.field_unsupported" }),
		);
	});
});
