import { isRecord } from "@/utils/type.utils";
import type { XmlDocument } from "./xml-document.reader";

const TEXT_NODE_NAME = "#text";
const ATTRIBUTE_PREFIX = "@_";

export function readXmlObject(document: XmlDocument, elementName: string): Readonly<Record<string, unknown>> | undefined {
	const value = document.values[elementName];

	return isRecord(value) ? value : undefined;
}

/** Child element as a record (`<fanart><thumb>` → the `<fanart>` record). */
export function readXmlChildObject(
	element: Readonly<Record<string, unknown>>,
	elementName: string,
): Readonly<Record<string, unknown>> | undefined {
	const value = element[elementName];

	return isRecord(value) ? value : undefined;
}

/** Attribute on an element (`<rating name="imdb">` → `readXmlAttr(rating, "name")`). */
export function readXmlAttr(element: Readonly<Record<string, unknown>>, attributeName: string): string | undefined {
	return toText(element[`${ATTRIBUTE_PREFIX}${attributeName}`]);
}

/** Text content of the element itself, as opposed to one of its child elements. */
export function readXmlValue(element: Readonly<Record<string, unknown>>): string | undefined {
	return toText(element);
}

export function readXmlText(element: Readonly<Record<string, unknown>>, elementName: string): string | undefined {
	return toText(element[elementName]);
}

export function readXmlTexts(element: Readonly<Record<string, unknown>>, elementName: string): readonly string[] {
	const value = element[elementName];
	const values = Array.isArray(value) ? value : [value];

	return values.flatMap((item) => {
		const text = toText(item);

		return text === undefined ? [] : [text];
	});
}

/** Repeated child elements as objects (e.g. `<actor>`/`<rating>` lists). */
export function readXmlObjects(
	element: Readonly<Record<string, unknown>>,
	elementName: string,
): ReadonlyArray<Readonly<Record<string, unknown>>> {
	const value = element[elementName];
	const values = Array.isArray(value) ? value : [value];

	return values.filter((item) => isRecord(item));
}

function toText(value: unknown): string | undefined {
	if (typeof value === "string") return value.trim() || undefined;

	if (typeof value === "number" || typeof value === "boolean") return String(value);

	if (!isRecord(value)) return undefined;

	return toText(value[TEXT_NODE_NAME]);
}
