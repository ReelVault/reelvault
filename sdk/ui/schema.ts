/**
 * Type-safe builders for declarative plugin UI schemas.
 *
 * These are identity helpers (no runtime behaviour) that give authors
 * autocomplete and compile-time errors. The plugin build serialises the result
 * to JSON, which the host renders with its own components.
 *
 * ```ts
 * import { defineSchema, textField, selectField, textareaField, stack, grid, button } from "reelvault-sdk/ui";
 *
 * export default defineSchema({
 *   fields: [
 *     textField({ name: "title", label: "Title", required: true }),
 *     selectField({ name: "severity", label: "Severity", options: [...] }),
 *   ],
 *   submit: { type: "submit", path: "/reports", successToast: "Submitted", close: true },
 *   body: [stack(...)],
 * });
 * ```
 */
import type { PluginLocalizedText } from "../plugin/ui-manifest";
import type { PluginSchemaField, PluginSchemaFieldNode, PluginSchemaNode, PluginUiSchemaSurface } from "../plugin/ui-schema";

export function defineSchema(surface: PluginUiSchemaSurface): PluginUiSchemaSurface {
	return surface;
}

type FieldSpec = Omit<PluginSchemaField, "input">;

export const textField = (field: FieldSpec): PluginSchemaFieldNode => ({ type: "field", input: "text", ...field });

export const textareaField = (field: FieldSpec): PluginSchemaFieldNode => ({ type: "field", input: "textarea", ...field });

export const numberField = (field: FieldSpec): PluginSchemaFieldNode => ({ type: "field", input: "number", ...field });

export const selectField = (field: FieldSpec): PluginSchemaFieldNode => ({ type: "field", input: "select", ...field });

export const switchField = (field: FieldSpec): PluginSchemaFieldNode => ({ type: "field", input: "switch", ...field });

export const checkboxField = (field: FieldSpec): PluginSchemaFieldNode => ({ type: "field", input: "checkbox", ...field });

export const secretField = (field: FieldSpec): PluginSchemaFieldNode => ({ type: "field", input: "secret", ...field });

export const dateField = (field: FieldSpec): PluginSchemaFieldNode => ({ type: "field", input: "date", ...field });

export const stack = (children: PluginSchemaNode[], options: { gap?: number } = {}): PluginSchemaNode => ({
	type: "stack",
	children,
	...options,
});

export const row = (
	children: PluginSchemaNode[],
	options: { gap?: number; align?: "start" | "center" | "end" | "between" } = {},
): PluginSchemaNode => ({ type: "row", children, ...options });

export const grid = (children: PluginSchemaNode[], options: { columns?: 1 | 2 | 3 | 4; gap?: number } = {}): PluginSchemaNode => ({
	type: "grid",
	children,
	...options,
});

export const card = (
	children: PluginSchemaNode[],
	options: { title?: PluginLocalizedText; description?: PluginLocalizedText } = {},
): PluginSchemaNode => ({
	type: "card",
	children,
	...options,
});

export const section = (
	children: PluginSchemaNode[],
	options: { title?: PluginLocalizedText; description?: PluginLocalizedText } = {},
): PluginSchemaNode => ({
	type: "section",
	children,
	...options,
});

export const separator = (): Extract<PluginSchemaNode, { type: "separator" }> => ({ type: "separator" });

export const tabs = (items: Extract<PluginSchemaNode, { type: "tabs" }>["tabs"]): PluginSchemaNode => ({ type: "tabs", tabs: items });

export const heading = (text: PluginLocalizedText, level: 2 | 3 = 2): PluginSchemaNode => ({ type: "heading", text, level });

export const text = (value: PluginLocalizedText, variant: "default" | "muted" = "default"): PluginSchemaNode => ({
	type: "text",
	text: value,
	variant,
});

export const badge = (
	value: PluginLocalizedText,
	options: Omit<Extract<PluginSchemaNode, { type: "badge" }>, "type" | "text"> = {},
): PluginSchemaNode => ({ type: "badge", text: value, ...options });

export const alert = (options: Omit<Extract<PluginSchemaNode, { type: "alert" }>, "type"> = {}): PluginSchemaNode => ({
	type: "alert",
	...options,
});

export const empty = (options: { title?: PluginLocalizedText; description?: PluginLocalizedText } = {}): PluginSchemaNode => ({
	type: "empty",
	...options,
});

export const stats = (items: Extract<PluginSchemaNode, { type: "stats" }>["items"]): PluginSchemaNode => ({ type: "stats", items });

export const table = (options: Omit<Extract<PluginSchemaNode, { type: "table" }>, "type">): PluginSchemaNode => ({
	type: "table",
	...options,
});

export const list = (options: Omit<Extract<PluginSchemaNode, { type: "list" }>, "type">): PluginSchemaNode => ({
	type: "list",
	...options,
});

export const foreach = (source: string, item: PluginSchemaNode[]): PluginSchemaNode => ({ type: "foreach", source, item });

export const embed = (src: string, options: { title?: PluginLocalizedText; aspect?: "video" | "square" } = {}): PluginSchemaNode => ({
	type: "embed",
	src,
	...options,
});

export const button = (
	label: PluginLocalizedText,
	action: Extract<PluginSchemaNode, { type: "button" }>["action"],
	options: Omit<Extract<PluginSchemaNode, { type: "button" }>, "type" | "label" | "action"> = {},
): PluginSchemaNode => ({ type: "button", label, action, ...options });

export const when = (
	condition: Extract<PluginSchemaNode, { type: "if" }>["condition"],
	content: PluginSchemaNode[],
	otherwise?: PluginSchemaNode[],
): PluginSchemaNode => ({ type: "if", condition, content, ...(otherwise ? { otherwise } : {}) });
