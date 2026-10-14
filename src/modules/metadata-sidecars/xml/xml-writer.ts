import { FileUtils, readFile } from "@/utils/file.utils";
import type { SidecarWriteResult } from "../sidecar.types";

export interface XmlDocumentOutput {
	readonly rootName: string;
	readonly values: Readonly<Record<string, unknown>>;
}

let xmlBuilderModule: Promise<typeof import("fast-xml-builder")> | undefined;

/** Loaded on first write, so the builder package stays out of the boot-time heap. Memoized: a per-call import costs ~3 µs per document. */
function loadXmlBuilder(): Promise<typeof import("fast-xml-builder")> {
	xmlBuilderModule ??= import("fast-xml-builder");

	return xmlBuilderModule;
}

export async function writeXmlDocument({ rootName, values }: XmlDocumentOutput): Promise<string> {
	const { default: XMLBuilder } = await loadXmlBuilder();
	const builder = new XMLBuilder({
		format: true,
		ignoreAttributes: false,
		suppressEmptyNode: true,
		// Kodi/Plex readers expect `default="true"` — the bare-attribute shorthand is not parsed back.
		suppressBooleanAttributes: false,
	});

	return `<?xml version="1.0" encoding="UTF-8"?>\n${builder.build({ [rootName]: values })}\n`;
}

/**
 * Writes XML `contents` atomically unless the file already holds exactly those
 * bytes. Ingest re-saves unchanged metadata constantly (a season drop hits the
 * same tvshow.nfo once per episode file) — skip the tmp+rename when the content
 * is already identical.
 */
export async function writeXmlIfChanged(documentPath: string, contents: string): Promise<SidecarWriteResult> {
	const existing = await readFile(documentPath, "utf8").catch(() => null);
	if (existing === contents) {
		return { documentPath, writtenFiles: [] };
	}

	await FileUtils.writeAtomic(documentPath, contents);

	return { documentPath, writtenFiles: [documentPath] };
}
