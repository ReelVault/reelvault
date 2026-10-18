import type { SidecarFormatAdapter } from "@/modules/metadata-sidecars/formats/sidecar-format.adapter";
import type { SidecarFormatOutput, SidecarWriteResult } from "@/modules/metadata-sidecars/sidecar.types";
import { writeXmlDocument, writeXmlIfChanged } from "@/modules/metadata-sidecars/xml/xml.writer";
import { buildKodiDocument } from "./kodi-document.writer";

export class KodiFormatAdapter implements SidecarFormatAdapter {
	readonly id = "kodi";
	readonly capabilities = ["write"] as const;

	async write({ documentPath, document }: SidecarFormatOutput): Promise<SidecarWriteResult> {
		const contents = await writeXmlDocument(buildKodiDocument(documentPath, document));
		return await writeXmlIfChanged(documentPath, contents);
	}
}
