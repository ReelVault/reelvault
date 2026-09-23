/**
 * Declarative plugin UI schema
 *
 * A schema is **data** describing a surface (dialog/page) built from the host's
 * own components. The host renders it, so the result matches the app look with
 * no duplicated styling. Schema nodes cannot execute code: data is fetched and
 * mutations run through the plugin's own backend routes via the host bridge.
 *
 * Authors normally build these with the type-safe helpers in
 * `reelvault-sdk/ui` (`defineSchema`, `textField`, `button`, …) and the plugin
 * build emits JSON.
 */
import type { PluginLocalizedText } from "./ui-manifest";
import type { PluginSchemaConditionOp, PluginSchemaFieldInput } from "./vocabulary";

/** Scalar value usable in interpolations and comparisons. */
export type PluginSchemaValue = string | number | boolean | null;

/** Comparison against an expression such as `form.title` or `data.summary.total`. */
export interface PluginSchemaCondition {
	/** Left-hand expression (see interpolation syntax). */
	left: string;
	op: PluginSchemaConditionOp;
	right?: PluginSchemaValue | undefined;
}

/** A named GET source resolved through the host (`host.api.call`). */
export interface PluginSchemaDataSource {
	path: string;
	query?: Record<string, string> | undefined;
}

/** A mutation or host action triggered by a button/submit. */
export type PluginSchemaAction =
	/** Submits the surface form (or an explicit body) to a plugin route. */
	| {
			type: "submit";
			path: string;
			method?: "POST" | "PATCH" | undefined;
			body?: Record<string, unknown> | undefined;
			successToast?: PluginLocalizedText | undefined;
			close?: boolean | undefined;
			refresh?: string[] | undefined;
	  }
	/** Calls a plugin route with an explicit method/body/query. */
	| {
			type: "call";
			path: string;
			method?: "POST" | "PUT" | "PATCH" | "DELETE" | undefined;
			body?: Record<string, unknown> | undefined;
			query?: Record<string, string> | undefined;
			confirm?: PluginLocalizedText | undefined;
			successToast?: PluginLocalizedText | undefined;
			close?: boolean | undefined;
			refresh?: string[] | undefined;
	  }
	/** Deletes a resource by path (DELETE). */
	| {
			type: "delete";
			path: string;
			confirm?: PluginLocalizedText | undefined;
			successToast?: PluginLocalizedText | undefined;
			close?: boolean | undefined;
			refresh?: string[] | undefined;
	  }
	/** Navigates the host to an in-app path. */
	| { type: "navigate"; to: string }
	/** Opens one of the plugin's dialogs. */
	| { type: "openDialog"; dialog: string; params?: Record<string, string> | undefined }
	/** Closes the current surface (dialog). */
	| { type: "close" }
	/** Shows a toast. */
	| { type: "toast"; level: "success" | "error" | "info"; message: PluginLocalizedText }
	/** Refreshes one or all data sources. */
	| { type: "refresh"; sources?: string[] | undefined };

/** A form field rendered with the host's input components. */
export interface PluginSchemaField {
	name: string;
	input: PluginSchemaFieldInput;
	label: PluginLocalizedText;
	description?: PluginLocalizedText | undefined;
	placeholder?: PluginLocalizedText | undefined;
	required?: boolean | undefined;
	default?: PluginSchemaValue | undefined;
	options?: Array<{ label: PluginLocalizedText; value: string | number }> | undefined;
	min?: number | undefined;
	max?: number | undefined;
	step?: number | undefined;
	rows?: number | undefined;
	/** Grid span inside a `grid` node. */
	colspan?: 1 | 2 | 3 | 4 | undefined;
	hiddenIf?: PluginSchemaCondition | undefined;
}

/** A form field node. Its value is part of the surface form and is submitted by a `submit` action. */
export type PluginSchemaFieldNode = { type: "field" } & PluginSchemaField;

/** A single UI node. Containers nest their children. */
export type PluginSchemaNode =
	// Form
	| PluginSchemaFieldNode
	// Layout
	| { type: "stack"; gap?: number | undefined; children: PluginSchemaNode[] }
	| {
			type: "row";
			gap?: number | undefined;
			align?: "start" | "center" | "end" | "between" | undefined;
			children: PluginSchemaNode[];
	  }
	| { type: "grid"; columns?: 1 | 2 | 3 | 4 | undefined; gap?: number | undefined; children: PluginSchemaNode[] }
	| { type: "card"; title?: PluginLocalizedText | undefined; description?: PluginLocalizedText | undefined; children: PluginSchemaNode[] }
	| {
			type: "section";
			title?: PluginLocalizedText | undefined;
			description?: PluginLocalizedText | undefined;
			children: PluginSchemaNode[];
	  }
	| { type: "tabs"; tabs: Array<{ label: PluginLocalizedText; icon?: string | undefined; children: PluginSchemaNode[] }> }
	| { type: "separator" }
	// Text
	| { type: "heading"; text: PluginLocalizedText; level?: 2 | 3 | undefined }
	| { type: "text"; text: PluginLocalizedText; variant?: "default" | "muted" | undefined }
	| {
			type: "badge";
			text: PluginLocalizedText;
			variant?: "default" | "secondary" | "outline" | "destructive" | undefined;
			icon?: string | undefined;
	  }
	| {
			type: "alert";
			title?: PluginLocalizedText | undefined;
			description?: PluginLocalizedText | undefined;
			variant?: "default" | "destructive" | undefined;
	  }
	// Actions
	| {
			type: "button";
			label: PluginLocalizedText;
			icon?: string | undefined;
			variant?: "default" | "outline" | "secondary" | "destructive" | "ghost" | undefined;
			action: PluginSchemaAction;
			disabledIf?: PluginSchemaCondition | undefined;
			hiddenIf?: PluginSchemaCondition | undefined;
	  }
	// Data display
	| { type: "stats"; items: Array<{ label: PluginLocalizedText; value: string; icon?: string | undefined }> }
	| {
			type: "table";
			source: string;
			columns: Array<{
				label: PluginLocalizedText;
				value: string;
				variant?: "text" | "muted" | "badge" | undefined;
			}>;
			empty?: PluginLocalizedText | undefined;
			rowActions?: PluginSchemaNode[] | undefined;
	  }
	| { type: "list"; source: string; empty?: PluginLocalizedText | undefined; item: PluginSchemaNode[] }
	| {
			type: "embed";
			/** URL template, e.g. a YouTube embed with `{{data.trailer.trailerKey}}`. */
			src: string;
			title?: PluginLocalizedText | undefined;
			aspect?: "video" | "square" | undefined;
	  }
	| { type: "empty"; title?: PluginLocalizedText | undefined; description?: PluginLocalizedText | undefined }
	// Control flow
	| { type: "foreach"; source: string; item: PluginSchemaNode[] }
	| {
			type: "if";
			condition: PluginSchemaCondition;
			/** Nodes rendered when the condition holds. */
			content: PluginSchemaNode[];
			/** Nodes rendered otherwise. */
			otherwise?: PluginSchemaNode[] | undefined;
	  };

/** The full surface definition stored (inlined) in `ui.json` or referenced by `schemaRef`. */
export interface PluginUiSchemaSurface {
	/** Named data sources fetched on mount and on `refresh`. */
	data?: Record<string, PluginSchemaDataSource> | undefined;
	/** Content tree (including `field` nodes for form inputs and buttons for actions). */
	body: PluginSchemaNode[];
	/** Actions executed once on mount. */
	onMount?: PluginSchemaAction[] | undefined;
}
