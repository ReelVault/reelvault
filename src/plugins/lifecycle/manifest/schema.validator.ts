import type { PluginUiSchemaSurface } from "@reelvault/sdk/plugin";
import {
	PLUGIN_SCHEMA_ACTION_TYPES as PLUGIN_SCHEMA_ACTION_TYPE_VALUES,
	PLUGIN_SCHEMA_CONDITION_OPS as PLUGIN_SCHEMA_CONDITION_OP_VALUES,
	PLUGIN_SCHEMA_FIELD_INPUTS as PLUGIN_SCHEMA_FIELD_INPUT_VALUES,
} from "@reelvault/sdk/plugin";
import { DomainError } from "@/utils/domain.errors";
import { isRecord } from "@/utils/type.utils";
import {
	assertLocalizedText,
	assertNonEmptyString,
	assertOptionalStringArray,
	assertOptionalType,
	assertSafeHref,
	assertSafePluginSubPath,
} from "./shared.utils";

/**
 * Declarative schema bounds. A schema is admin-installed data rendered by the
 * host; these caps are format/protocol limits (hardware-independent) so a
 * malformed schema cannot exhaust the browser.
 */
export const SCHEMA_MAX_BYTES = 256 * 1024;

const SCHEMA_MAX_NODES = 2000;

const SCHEMA_MAX_DEPTH = 32;

const SCHEMA_MAX_FIELDS = 200;

const SCHEMA_MAX_SOURCES = 50;

const SCHEMA_FIELD_INPUTS: ReadonlySet<string> = new Set(PLUGIN_SCHEMA_FIELD_INPUT_VALUES);

const SCHEMA_CONDITION_OPS: ReadonlySet<string> = new Set(PLUGIN_SCHEMA_CONDITION_OP_VALUES);

const SCHEMA_ACTION_TYPES: ReadonlySet<string> = new Set(PLUGIN_SCHEMA_ACTION_TYPE_VALUES);

/** Validates a declarative schema (used both for inline schemas and loaded schemaRef files). */
export function validatePluginSchema(
	value: unknown,
	field: string,
	dialogIds?: ReadonlySet<string>,
): asserts value is PluginUiSchemaSurface {
	if (!isRecord(value))
		throw new DomainError("validation", `Plugin ui.json ${field} must be an object`, {
			code: "plugin.ui.field_not_object",
			params: { field },
		});

	if (value.data !== undefined) {
		if (!isRecord(value.data))
			throw new DomainError("validation", `Plugin ui.json ${field}.data must be an object`, {
				code: "plugin.ui.field_not_object",
				params: { field: `${field}.data` },
			});

		const sources = Object.entries(value.data);
		if (sources.length > SCHEMA_MAX_SOURCES)
			throw new DomainError("validation", `Plugin ui.json ${field}.data has too many sources`, {
				code: "plugin.ui.data_too_many_sources",
				params: { field },
			});

		for (const [name, source] of sources) {
			if (!isRecord(source))
				throw new DomainError("validation", `Plugin ui.json ${field}.data.${name} must be an object`, {
					code: "plugin.ui.field_not_object",
					params: { field: `${field}.data.${name}` },
				});

			assertSafePluginSubPath(source.path, `${field}.data.${name}.path`);
		}
	}

	if (value.onMount !== undefined) {
		if (!Array.isArray(value.onMount))
			throw new DomainError("validation", `Plugin ui.json ${field}.onMount must be an array`, {
				code: "plugin.ui.field_not_array",
				params: { field: `${field}.onMount` },
			});

		for (const [index, action] of value.onMount.entries()) validateSchemaAction(action, `${field}.onMount[${index}]`, dialogIds);
	}

	const counter = { count: 0, fields: 0 };
	validateSchemaNodes(value.body, `${field}.body`, 0, counter, dialogIds);
}

function validateSchemaField(entry: Record<string, unknown>, fieldName: string): void {
	assertNonEmptyString(entry.name, `${fieldName}.name`);
	if (typeof entry.input !== "string" || !SCHEMA_FIELD_INPUTS.has(entry.input)) {
		throw new DomainError("validation", `Plugin ui.json ${fieldName}.input is unsupported`, {
			code: "plugin.ui.field_unsupported",
			params: { field: `${fieldName}.input` },
		});
	}

	assertLocalizedText(entry.label, `${fieldName}.label`);
	if (entry.description !== undefined) assertLocalizedText(entry.description, `${fieldName}.description`);

	if (entry.placeholder !== undefined) assertLocalizedText(entry.placeholder, `${fieldName}.placeholder`);

	assertOptionalType(entry.required, "boolean", `${fieldName}.required`);

	if (entry.options !== undefined) {
		if (!Array.isArray(entry.options))
			throw new DomainError("validation", `Plugin ui.json ${fieldName}.options must be an array`, {
				code: "plugin.ui.field_not_array",
				params: { field: `${fieldName}.options` },
			});

		for (const option of entry.options) {
			if (!isRecord(option))
				throw new DomainError("validation", `Plugin ui.json ${fieldName}.options entries must be objects`, {
					code: "plugin.ui.entry_not_object",
					params: { field: `${fieldName}.options` },
				});

			assertLocalizedText(option.label, `${fieldName}.options[].label`);
			if (typeof option.value !== "string" && typeof option.value !== "number") {
				throw new DomainError("validation", `Plugin ui.json ${fieldName}.options[].value must be a string or number`, {
					code: "plugin.ui.option_value_invalid",
					params: { field: `${fieldName}.options[].value` },
				});
			}
		}
	}

	if (entry.hiddenIf !== undefined) validateSchemaCondition(entry.hiddenIf, `${fieldName}.hiddenIf`);
}

function validateSchemaNodes(
	nodes: unknown,
	field: string,
	depth: number,
	counter: { count: number; fields: number },
	dialogIds: ReadonlySet<string> | undefined,
): void {
	if (depth > SCHEMA_MAX_DEPTH)
		throw new DomainError("validation", `Plugin ui.json ${field} exceeds the maximum nesting depth`, {
			code: "plugin.ui.nesting_too_deep",
			params: { field },
		});

	if (!Array.isArray(nodes))
		throw new DomainError("validation", `Plugin ui.json ${field} must be an array`, {
			code: "plugin.ui.field_not_array",
			params: { field },
		});

	for (const node of nodes) validateSchemaNode(node, field, depth, counter, dialogIds);
}

interface SchemaNodeContext {
	field: string;
	depth: number;
	counter: { count: number; fields: number };
	dialogIds: ReadonlySet<string> | undefined;
}

function validateFieldNode(node: Record<string, unknown>, context: SchemaNodeContext): void {
	context.counter.fields += 1;
	if (context.counter.fields > SCHEMA_MAX_FIELDS)
		throw new DomainError("validation", `Plugin ui.json ${context.field} has too many fields`, {
			code: "plugin.ui.too_many_fields",
			params: { field: context.field },
		});

	validateSchemaField(node, context.field);
}

function validateContainerNode(node: Record<string, unknown>, context: SchemaNodeContext): void {
	const { field } = context;
	if (node.type === "card" || node.type === "section") {
		if (node.title !== undefined) assertLocalizedText(node.title, `${field}.title`);

		if (node.description !== undefined) assertLocalizedText(node.description, `${field}.description`);
	}

	validateSchemaNodes(node.children, `${field}.children`, context.depth + 1, context.counter, context.dialogIds);
}

function validateTabsNode(node: Record<string, unknown>, context: SchemaNodeContext): void {
	const { field } = context;
	if (!Array.isArray(node.tabs))
		throw new DomainError("validation", `Plugin ui.json ${field}.tabs must be an array`, {
			code: "plugin.ui.field_not_array",
			params: { field: `${field}.tabs` },
		});

	for (const [index, tab] of node.tabs.entries()) {
		if (!isRecord(tab))
			throw new DomainError("validation", `Plugin ui.json ${field}.tabs[${index}] must be an object`, {
				code: "plugin.ui.field_not_object",
				params: { field: `${field}.tabs[${index}]` },
			});

		assertLocalizedText(tab.label, `${field}.tabs[${index}].label`);
		validateSchemaNodes(tab.children, `${field}.tabs[${index}].children`, context.depth + 1, context.counter, context.dialogIds);
	}
}

function validateTextNode(node: Record<string, unknown>, context: SchemaNodeContext): void {
	assertLocalizedText(node.text, `${context.field}.text`);
}

function validateAlertNode(node: Record<string, unknown>, context: SchemaNodeContext): void {
	if (node.title !== undefined) assertLocalizedText(node.title, `${context.field}.title`);

	if (node.description !== undefined) assertLocalizedText(node.description, `${context.field}.description`);
}

function validateButtonNode(node: Record<string, unknown>, context: SchemaNodeContext): void {
	const { field } = context;
	assertLocalizedText(node.label, `${field}.label`);
	validateSchemaAction(node.action, `${field}.action`, context.dialogIds);
	if (node.disabledIf !== undefined) validateSchemaCondition(node.disabledIf, `${field}.disabledIf`);

	if (node.hiddenIf !== undefined) validateSchemaCondition(node.hiddenIf, `${field}.hiddenIf`);
}

function validateStatsNode(node: Record<string, unknown>, context: SchemaNodeContext): void {
	const { field } = context;
	if (!Array.isArray(node.items))
		throw new DomainError("validation", `Plugin ui.json ${field}.items must be an array`, {
			code: "plugin.ui.field_not_array",
			params: { field: `${field}.items` },
		});

	for (const item of node.items) {
		if (!isRecord(item))
			throw new DomainError("validation", `Plugin ui.json ${field}.items entries must be objects`, {
				code: "plugin.ui.entry_not_object",
				params: { field: `${field}.items` },
			});

		assertLocalizedText(item.label, `${field}.items[].label`);
		assertNonEmptyString(item.value, `${field}.items[].value`);
	}
}

function validateTableNode(node: Record<string, unknown>, context: SchemaNodeContext): void {
	const { field } = context;
	assertNonEmptyString(node.source, `${field}.source`);
	if (!Array.isArray(node.columns))
		throw new DomainError("validation", `Plugin ui.json ${field}.columns must be an array`, {
			code: "plugin.ui.field_not_array",
			params: { field: `${field}.columns` },
		});

	for (const column of node.columns) {
		if (!isRecord(column))
			throw new DomainError("validation", `Plugin ui.json ${field}.columns entries must be objects`, {
				code: "plugin.ui.entry_not_object",
				params: { field: `${field}.columns` },
			});

		assertLocalizedText(column.label, `${field}.columns[].label`);
		assertNonEmptyString(column.value, `${field}.columns[].value`);
	}

	if (node.rowActions !== undefined)
		validateSchemaNodes(node.rowActions, `${field}.rowActions`, context.depth + 1, context.counter, context.dialogIds);
}

function validateListNode(node: Record<string, unknown>, context: SchemaNodeContext): void {
	assertNonEmptyString(node.source, `${context.field}.source`);
	validateSchemaNodes(node.item, `${context.field}.item`, context.depth + 1, context.counter, context.dialogIds);
}

function validateEmbedNode(node: Record<string, unknown>, context: SchemaNodeContext): void {
	assertSafeHref(node.src, `${context.field}.src`);
	if (node.title !== undefined) assertLocalizedText(node.title, `${context.field}.title`);
}

function validateIfNode(node: Record<string, unknown>, context: SchemaNodeContext): void {
	const { field } = context;
	validateSchemaCondition(node.condition, `${field}.condition`);
	validateSchemaNodes(node.content, `${field}.content`, context.depth + 1, context.counter, context.dialogIds);
	if (node.otherwise !== undefined)
		validateSchemaNodes(node.otherwise, `${field}.otherwise`, context.depth + 1, context.counter, context.dialogIds);
}

function validateNoopNode(): void {
	// These nodes carry no schema-declared properties.
}

type SchemaNodeValidator = (node: Record<string, unknown>, context: SchemaNodeContext) => void;

const schemaNodeValidators: Readonly<Record<string, SchemaNodeValidator>> = {
	field: validateFieldNode,
	stack: validateContainerNode,
	card: validateContainerNode,
	section: validateContainerNode,
	row: validateContainerNode,
	grid: validateContainerNode,
	tabs: validateTabsNode,
	heading: validateTextNode,
	text: validateTextNode,
	badge: validateTextNode,
	alert: validateAlertNode,
	button: validateButtonNode,
	stats: validateStatsNode,
	table: validateTableNode,
	list: validateListNode,
	foreach: validateListNode,
	embed: validateEmbedNode,
	if: validateIfNode,
	separator: validateNoopNode,
	empty: validateNoopNode,
};

function validateSchemaNode(
	node: unknown,
	field: string,
	depth: number,
	counter: { count: number; fields: number },
	dialogIds: ReadonlySet<string> | undefined,
): void {
	counter.count += 1;
	if (counter.count > SCHEMA_MAX_NODES)
		throw new DomainError("validation", `Plugin ui.json ${field} exceeds the maximum node count`, {
			code: "plugin.ui.too_many_nodes",
			params: { field },
		});

	if (!isRecord(node) || typeof node.type !== "string")
		throw new DomainError("validation", `Plugin ui.json ${field} has an unsupported node type`, {
			code: "plugin.ui.field_unsupported",
			params: { field },
		});

	const validator = schemaNodeValidators[node.type];
	if (!validator)
		throw new DomainError("validation", `Plugin ui.json ${field} has an unsupported node type`, {
			code: "plugin.ui.field_unsupported",
			params: { field },
		});

	validator(node, { field: `${field}.${node.type}`, depth, counter, dialogIds });
}

function validateSchemaAction(action: unknown, field: string, dialogIds?: ReadonlySet<string>): void {
	if (!isRecord(action) || typeof action.type !== "string" || !SCHEMA_ACTION_TYPES.has(action.type)) {
		throw new DomainError("validation", `Plugin ui.json ${field} has an unsupported action type`, {
			code: "plugin.ui.field_unsupported",
			params: { field },
		});
	}

	switch (action.type) {
		case "submit":
		case "call":
		case "delete":
			assertSafePluginSubPath(action.path, `${field}.path`);
			assertOptionalStringArray(action.refresh, `${field}.refresh`);

			return;
		case "navigate":
			assertSafeHref(action.to, `${field}.to`);

			return;
		case "openDialog":
			assertNonEmptyString(action.dialog, `${field}.dialog`);
			if (dialogIds && !dialogIds.has(action.dialog)) {
				throw new DomainError("validation", `Plugin ui.json ${field} references unknown dialog '${action.dialog}'`, {
					code: "plugin.ui.dialog_unknown",
					params: { dialog: action.dialog },
				});
			}

			return;
		case "close":
			return;
		case "toast":
			if (action.level !== "success" && action.level !== "error" && action.level !== "info") {
				throw new DomainError("validation", `Plugin ui.json ${field}.level must be success, error or info`, {
					code: "plugin.ui.level_invalid",
					params: { field: `${field}.level` },
				});
			}

			assertLocalizedText(action.message, `${field}.message`);

			return;
		case "refresh":
			assertOptionalStringArray(action.sources, `${field}.sources`);

			return;
		default:
			throw new DomainError("validation", `Plugin ui.json ${field} has an unsupported action type`, {
				code: "plugin.ui.field_unsupported",
				params: { field },
			});
	}
}

function validateSchemaCondition(condition: unknown, field: string): void {
	if (!isRecord(condition))
		throw new DomainError("validation", `Plugin ui.json ${field} must be an object`, {
			code: "plugin.ui.field_not_object",
			params: { field },
		});

	assertNonEmptyString(condition.left, `${field}.left`);
	if (typeof condition.op !== "string" || !SCHEMA_CONDITION_OPS.has(condition.op)) {
		throw new DomainError("validation", `Plugin ui.json ${field}.op is unsupported`, {
			code: "plugin.ui.field_unsupported",
			params: { field: `${field}.op` },
		});
	}
}
