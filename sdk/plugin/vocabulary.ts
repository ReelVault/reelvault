/**
 * Single source of truth for the plugin capability vocabulary.
 *
 * Capabilities are the only access gate a plugin declares. Every host method a
 * plugin touches asserts the matching capability at runtime (fail-fast), so the
 * server never needs a separate permission list and the vocabulary can never
 * drift between the SDK, the manifest validator and the registry.
 */
export const PLUGIN_CAPABILITIES = [
	"metadataProvider",
	"providerAccess",
	"subtitleProvider",
	"mediaAnalyzer",
	"mediaRead",
	"metadataRead",
	"artifactsRead",
	"artifactsWrite",
	"ffmpegRun",
	"markers",
	"jobs",
	"eventHandler",
	"storage",
	"httpRoute",
	"accessPolicy",
	"notification",
	"httpFetch",
] as const;

export type PluginCapabilityName = (typeof PLUGIN_CAPABILITIES)[number];

export const PLUGIN_CAPABILITY_SET: ReadonlySet<string> = new Set(PLUGIN_CAPABILITIES);

/**
 * Named slot extension points rendered inline by the host. Each name maps to a
 * fixed mount location in the application UI.
 */
export const PLUGIN_SLOT_NAMES = [
	"root-floating-overlay",
	"player-footer",
	"dashboard-section",
	"details-action-bar",
	"details-dropdown",
	"media-file-card-actions",
	"admin-sidebar-plugin-section",
	"navbar-profile-menu",
] as const;

export type PluginSlotName = (typeof PLUGIN_SLOT_NAMES)[number];

/** Named tab hosts a plugin can contribute tabs into. */
export const PLUGIN_TAB_HOST_NAMES = ["details", "admin-plugin", "settings"] as const;

export type PluginTabHostName = (typeof PLUGIN_TAB_HOST_NAMES)[number];

export const PLUGIN_DIALOG_SIZES = ["sm", "md", "lg", "xl"] as const;

export type PluginDialogSize = (typeof PLUGIN_DIALOG_SIZES)[number];

/** Declarative schema vocabulary (validated by the host before rendering). */
export const PLUGIN_SCHEMA_NODE_TYPES = [
	"field",
	"stack",
	"row",
	"grid",
	"card",
	"section",
	"tabs",
	"separator",
	"heading",
	"text",
	"badge",
	"alert",
	"button",
	"stats",
	"table",
	"list",
	"embed",
	"empty",
	"foreach",
	"if",
] as const;

export const PLUGIN_SCHEMA_FIELD_INPUTS = ["text", "textarea", "number", "select", "switch", "checkbox", "secret", "date"] as const;

export type PluginSchemaFieldInput = (typeof PLUGIN_SCHEMA_FIELD_INPUTS)[number];

export const PLUGIN_SCHEMA_CONDITION_OPS = ["eq", "neq", "gt", "gte", "lt", "lte", "contains", "truthy", "falsy"] as const;

export type PluginSchemaConditionOp = (typeof PLUGIN_SCHEMA_CONDITION_OPS)[number];

export const PLUGIN_SCHEMA_ACTION_TYPES = ["submit", "call", "delete", "navigate", "openDialog", "close", "toast", "refresh"] as const;

export type PluginSchemaActionType = (typeof PLUGIN_SCHEMA_ACTION_TYPES)[number];
