import type { SidecarFormatOutput, SidecarWriteResult } from "../../sidecar.types";
import { writeXmlDocument, writeXmlIfChanged } from "../../xml/xml-writer";
import type { SidecarFormatAdapter } from "../sidecar-format.adapter";
import { buildKodiDocument } from "./kodi-document.writer";

export class KodiFormatAdapter implements SidecarFormatAdapter {
	readonly id = "kodi";
	readonly capabilities = ["write"] as const;

	async write({ documentPath, document }: SidecarFormatOutput): Promise<SidecarWriteResult> {
		return await writeXmlIfChanged(documentPath, writeXmlDocument(buildKodiDocument(documentPath, document)));
	}
}
