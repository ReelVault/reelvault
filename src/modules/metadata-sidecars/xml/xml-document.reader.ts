import { XMLParser } from "fast-xml-parser";
import { SyntaxValidator } from "fast-xml-validator";
import { ValidationError } from "@/utils/errors";
import { isRecord } from "@/utils/type.utils";

export interface XmlDocument {
	readonly values: Readonly<Record<string, unknown>>;
}

const parser = new XMLParser({
	ignoreAttributes: false,
	parseAttributeValue: false,
	parseTagValue: false,
	processEntities: true,
	trimValues: true,
});

const BYTES_PER_MB = 1024 * 1024;

export const MAX_XML_DOCUMENT_BYTES = 2 * BYTES_PER_MB;

/**
 * DTD/entity declarations enable entity-expansion DoS (billion laughs) and XXE.
 * Sidecar `.nfo` files never legitimately need them, so documents declaring any
 * are rejected before parsing.
 */
const DTD_OR_ENTITY_REGEX = /<!DOCTYPE|<!ENTITY/i;

export function assertXmlDocumentSize(documentPath: string, sizeBytes: number | undefined): void {
	if (sizeBytes === undefined || sizeBytes <= MAX_XML_DOCUMENT_BYTES) return;

	throw new ValidationError(
		`Sidecar document exceeds the maximum supported size of ${MAX_XML_DOCUMENT_BYTES / BYTES_PER_MB} MB: ${documentPath}`,
	);
}

export function readXmlDocument(input: string): XmlDocument | null {
	if (input.length > MAX_XML_DOCUMENT_BYTES) {
		throw new ValidationError(`XML document exceeds the maximum supported size of ${MAX_XML_DOCUMENT_BYTES / BYTES_PER_MB} MB`);
	}

	if (DTD_OR_ENTITY_REGEX.test(input)) return null;

	try {
		// Throws on malformed input (caught below); a valid document falls through.
		SyntaxValidator.validate(input);

		const values: unknown = parser.parse(input);
		if (!isRecord(values)) return null;

		return { values };
	} catch {
		return null;
	}
}
