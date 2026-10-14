import type { XMLParser } from "fast-xml-parser";
import type { SyntaxValidator } from "fast-xml-validator";
import { DomainError } from "@/utils/errors";
import { isRecord } from "@/utils/type.utils";

export interface XmlDocument {
	readonly values: Readonly<Record<string, unknown>>;
}

interface XmlReaderTools {
	readonly parser: XMLParser;
	readonly validator: typeof SyntaxValidator;
}

// Loaded on the first sidecar read and shared after that, so boot does not pay for the XML packages.
let xmlReaderTools: Promise<XmlReaderTools> | undefined;

function loadXmlReaderTools(): Promise<XmlReaderTools> {
	xmlReaderTools ??= createXmlReaderTools();

	return xmlReaderTools;
}

async function createXmlReaderTools(): Promise<XmlReaderTools> {
	const [parserModule, validatorModule] = await Promise.all([import("fast-xml-parser"), import("fast-xml-validator")]);

	return {
		parser: new parserModule.XMLParser({
			ignoreAttributes: false,
			parseAttributeValue: false,
			parseTagValue: false,
			processEntities: true,
			trimValues: true,
		}),
		validator: validatorModule.SyntaxValidator,
	};
}

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

	throw new DomainError(
		"validation",
		`Sidecar document exceeds the maximum supported size of ${MAX_XML_DOCUMENT_BYTES / BYTES_PER_MB} MB: ${documentPath}`,
		{ code: "sidecar.document_too_large", params: { maxMb: MAX_XML_DOCUMENT_BYTES / BYTES_PER_MB } },
	);
}

export async function readXmlDocument(input: string): Promise<XmlDocument | null> {
	if (input.length > MAX_XML_DOCUMENT_BYTES) {
		throw new DomainError("validation", `XML document exceeds the maximum supported size of ${MAX_XML_DOCUMENT_BYTES / BYTES_PER_MB} MB`, {
			code: "sidecar.document_too_large",
			params: { maxMb: MAX_XML_DOCUMENT_BYTES / BYTES_PER_MB },
		});
	}

	if (DTD_OR_ENTITY_REGEX.test(input)) return null;

	const { parser, validator } = await loadXmlReaderTools();
	try {
		// Throws on malformed input (caught below); a valid document falls through.
		validator.validate(input);

		const values: unknown = parser.parse(input);
		if (!isRecord(values)) return null;

		return { values };
	} catch {
		return null;
	}
}
