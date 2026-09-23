import XMLBuilder from "fast-xml-builder";

export interface XmlDocumentOutput {
	readonly rootName: string;
	readonly values: Readonly<Record<string, unknown>>;
}

const builder = new XMLBuilder({
	format: true,
	ignoreAttributes: false,
	suppressEmptyNode: true,
	// Kodi/Plex readers expect `default="true"` — the bare-attribute shorthand is not parsed back.
	suppressBooleanAttributes: false,
});

export function writeXmlDocument({ rootName, values }: XmlDocumentOutput): string {
	return `<?xml version="1.0" encoding="UTF-8"?>\n${builder.build({ [rootName]: values })}\n`;
}
