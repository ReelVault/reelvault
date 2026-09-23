import type { FieldsConfig, SelectFields } from "@reelvault/sdk/common";
import { serverConfig } from "@/server.config";
import { ValidationError } from "@/utils/errors";
import { isRecord } from "@/utils/type.utils";

interface FieldNode {
	[key: string]: FieldNode | true;
}

/**
 * Fields config enriched by `QueryFields.parse` with a prebuilt selection mask
 * and field set so hot paths skip re-parsing the field list.
 */
export interface ParsedFieldsConfig<F extends string = string> extends FieldsConfig<F> {
	_mask?: FieldNode;
	_fieldSet?: Set<string>;
}

function parseFields<F extends string>({ fields: fieldsString }: { fields?: F | undefined }): ParsedFieldsConfig<F> {
	if (!fieldsString) {
		return { fields: [], relations: {}, __original: fieldsString };
	}

	if (fieldsString.length > serverConfig.database.fields.maxLength) {
		throw new ValidationError(`Fields query must not exceed ${serverConfig.database.fields.maxLength} characters`);
	}

	const fields: string[] = [];
	const seen = new Set<string>();
	for (const raw of fieldsString.split(",")) {
		const f = raw.trim();
		if (f.length === 0) continue;

		if (seen.has(f)) continue;

		seen.add(f);
		fields.push(f);
	}

	if (fields.length > serverConfig.database.fields.maxFields) {
		throw new ValidationError(`Fields query must not contain more than ${serverConfig.database.fields.maxFields} fields`);
	}

	if (fields.some((field) => field.split(".").length > serverConfig.database.fields.maxDepth)) {
		throw new ValidationError(`Fields query must not be nested deeper than ${serverConfig.database.fields.maxDepth} levels`);
	}

	const relations: Record<string, string[]> = {};
	const fieldSet = new Set(fields);
	for (const field of fields) {
		const dotIndex = field.indexOf(".");
		if (dotIndex !== -1) {
			const parent = field.slice(0, dotIndex);
			const child = field.slice(dotIndex + 1);
			relations[parent] ??= [];
			relations[parent].push(child);
			fieldSet.add(`${parent}.*`);
		}
	}

	const mask = buildFieldMask(fields);

	return { fields, relations, __original: fieldsString, _mask: mask, _fieldSet: fieldSet };
}

/**
 * Applies a field selection to a data object.
 */
function applyFields<T extends object>(data: T): T;
function applyFields<T extends object, F extends string>(data: T, config: ParsedFieldsConfig<F> | undefined): SelectFields<T, F>;

function applyFields(data: object, config?: ParsedFieldsConfig): unknown {
	// No fields defined — return the original (SDK default behaviour)
	if (!config?.fields || config.fields.length === 0) return data;

	const mask = config._mask ?? buildFieldMask(config.fields);

	return pickData(data, mask);
}

function includesField<F extends string>(config: ParsedFieldsConfig<F> | undefined, field: string): boolean {
	if (!config?.fields.length) return true;

	const fieldSet = config._fieldSet instanceof Set ? config._fieldSet : undefined;
	if (fieldSet) {
		return fieldSet.has(field) || fieldSet.has(`${field}.*`);
	}

	return config.fields.some((selectedField) => selectedField === field || selectedField.startsWith(`${field}.`));
}

/**
 * Deeply strips empty structures (empty objects/arrays) from a value.
 */
function buildFieldMask(fields: string[]): FieldNode {
	const root: FieldNode = {};

	for (const field of fields) {
		let current = root;
		const parts = field.split(".");

		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			const isLast = i === parts.length - 1;

			if (!part) continue;

			if (isLast) {
				current[part] = true;
			} else {
				if (!current[part] || current[part] === true) {
					current[part] = {};
				}

				current = current[part];
			}
		}
	}

	return root;
}

/**
 * Recursively copies data based on the mask.
 */
function pickData(source: unknown, mask: FieldNode | true): unknown {
	if (mask === true) return source;

	if (source === null || source === undefined) return source;

	if (Array.isArray(source)) {
		return source.map((item) => pickData(item, mask));
	}

	if (isRecord(source) && !(source instanceof Date)) {
		const result: Record<string, unknown> = {};

		// Iterate only over the mask's keys — this guarantees
		// no excess data is pulled from the source
		for (const key of Object.keys(mask)) {
			const maskValue = mask[key];
			const sourceValue = source[key];

			// Copy the value only if it exists in the source object
			if (sourceValue !== undefined && maskValue) {
				result[key] = pickData(sourceValue, maskValue);
			}
		}

		return result;
	}

	return source;
}

export const QueryFields = {
	/**
	 * Parses a "field1,relation.field2" string into the field-selection config.
	 */
	parse: parseFields,
	apply: applyFields,
	includes: includesField,
	_buildFieldMask: buildFieldMask,
	_pickData: pickData,
};
