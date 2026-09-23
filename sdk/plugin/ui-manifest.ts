import type { PluginUiSchemaSurface } from "./ui-schema";
import type { PluginDialogSize, PluginSlotName, PluginTabHostName } from "./vocabulary";

export type { PluginDialogSize, PluginSlotName, PluginTabHostName } from "./vocabulary";

/**
 * Plugin UI Manifest (`ui.json`)
 *
 * Declares where a plugin contributes UI. A surface renders either as a
 * **declarative schema** (host-rendered, no JavaScript) or as a **custom
 * element** (a Web Component defined by the manifest `entry` module). Custom
 * elements mount inline in the host document — no iframes, no sandbox, no
 * postMessage — styled in isolation by Shadow DOM while CSS custom properties
 * (theme tokens, fonts) inherit from the host.
 */

/**
 * A label that may be localized. A plain string is used verbatim; a record is
 * resolved against the active locale, falling back to the first entry.
 */
export type PluginLocalizedText = string | Record<string, string>;

/**
 * A custom-element surface. The host imports the module that defines `tag`
 * (see `PluginUiManifest.entry`) and mounts it.
 */
export interface PluginSurface {
	/** Custom element tag name, e.g. `rv-bug-reports-panel`. */
	tag: string;
}

/** A click action a slot contribution can perform. */
export type PluginSlotAction =
	/** Navigate to one of the plugin's own pages. */
	| { type: "page"; page: string; params?: Record<string, string> | undefined }
	/** Open one of the plugin's own dialogs. */
	| { type: "dialog"; dialog: string; params?: Record<string, string> | undefined }
	/** Navigate to an application route. */
	| { type: "navigate"; href: string }
	/** Open an external URL in a new tab. */
	| { type: "external"; href: string };

/**
 * A contribution to a named slot. Either `action` (clickable button/menu item)
 * or `element` (inline custom element) must be present.
 */
export interface PluginSlotContribution {
	label: PluginLocalizedText;
	/** Lucide icon name from the host allowlist. */
	icon?: string | undefined;
	/** Click behaviour when the contribution is a button/menu item. */
	action?: PluginSlotAction | undefined;
	/** Inline custom element when the contribution is an embedded widget. */
	element?: PluginSurface | undefined;
	/** Position priority (lower = first). Default: 100. */
	priority?: number | undefined;
	/** Render only for administrators. */
	adminOnly?: boolean | undefined;
	/** Render the label as an icon-only control (accessible name kept). */
	iconOnly?: boolean | undefined;
}

/**
 * How a surface renders: a custom element (`tag`) or a declarative schema
 * (`schema` inline / `schemaRef` to a JSON file). Exactly one is required.
 */
export interface PluginSurfaceDefinition {
	/** Custom element tag rendered for this surface. */
	tag?: string | undefined;
	/** Declarative schema rendered with the host's components. */
	schema?: PluginUiSchemaSurface | undefined;
	/** Path (relative to the plugin dir) to a JSON schema produced by the build. */
	schemaRef?: string | undefined;
}

/** A full-page surface owned by the plugin. */
export interface PluginPageContribution extends PluginSurfaceDefinition {
	/** Stable identifier used by slots/tabs to reference this page. */
	id: string;
	/** URL path segment, mounted at `/plugins/<pluginId>/page/<path>`. */
	path: string;
	name: PluginLocalizedText;
	icon?: string | undefined;
	/** Visible and reachable only to administrators. */
	adminOnly?: boolean | undefined;
	/** Where the host advertises this page. `false` hides it from navigation. */
	nav?: "user" | "admin" | false | undefined;
	/** Navigation order (lower = first). Default: 100. */
	priority?: number | undefined;
}

/** A modal surface owned by the plugin. */
export interface PluginDialogContribution extends PluginSurfaceDefinition {
	/** Stable identifier used by slot actions to open this dialog. */
	id: string;
	title: PluginLocalizedText;
	icon?: string | undefined;
	size?: PluginDialogSize | undefined;
	adminOnly?: boolean | undefined;
}

/** A tab injected into an existing host surface. */
export interface PluginTabContribution {
	/** Stable identifier within the host. */
	id: string;
	/** Host surface that receives the tab. */
	host: PluginTabHostName;
	label: PluginLocalizedText;
	icon?: string | undefined;
	/** Id of a page in this manifest whose content fills the tab. */
	page: string;
	adminOnly?: boolean | undefined;
	/** Tab order (lower = first). Default: 100. */
	priority?: number | undefined;
}

export interface PluginUiManifest {
	/** Plugin display name. */
	name: string;
	/** Plugin version. */
	version: string;
	/**
	 * Locale the plugin falls back to when the host locale is not provided in a
	 * localized text (e.g. `"en"`). Defaults to the first entry of each map.
	 */
	defaultLocale?: string | undefined;
	/**
	 * ESM module (relative to the plugin directory) that registers every custom
	 * element the plugin declares, e.g. `./dist/ui/index.js`. Required only when
	 * a surface uses `tag`; schema-only plugins omit it.
	 */
	entry?: string | undefined;
	/** Full-page surfaces. */
	pages?: PluginPageContribution[] | undefined;
	/** Modal surfaces. */
	dialogs?: PluginDialogContribution[] | undefined;
	/** Tabs injected into named hosts. */
	tabs?: Partial<Record<PluginTabHostName, PluginTabContribution[]>> | undefined;
	/** Inline slot contributions. */
	slots?: Partial<Record<PluginSlotName, PluginSlotContribution[]>> | undefined;
	/**
	 * Declares that this plugin supplies pre-play content for the player (e.g.
	 * cinema-mode trailers). `endpoint` is a plugin route (relative, mounted
	 * under `/v1/plugins/<pluginId>/`) returning the pre-roll entries; the host
	 * consults the first such plugin before starting playback.
	 */
	playbackPreRoll?: { endpoint: string } | undefined;
	/**
	 * Declares that this plugin extends the host's global search with provider
	 * titles. `endpoint` is queried with `?query=<term>` and returns search
	 * items; `requestEndpoint` (optional) accepts a POST with the same item to
	 * create a request for it; `itemPage` (optional) is the manifest page id
	 * opened when an item is selected (receives providerId/externalId/mediaType
	 * as query params).
	 */
	searchProvider?: { endpoint: string; requestEndpoint?: string | undefined; itemPage?: string | undefined } | undefined;
}

/** Aggregated UI manifest returned by GET /v1/plugins/ui/manifest. */
export interface PluginUiManifestResponse {
	/** Per-plugin UI manifests, keyed by plugin ID. */
	plugins: Record<string, PluginUiManifest>;
}
