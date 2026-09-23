import { FileUtils, readFile } from "@/utils/file.utils";
import type { SidecarFormatOutput, SidecarWriteResult } from "../../sidecar.types";
import { writeXmlDocument } from "../../xml/xml-writer";
import type { SidecarFormatAdapter } from "../sidecar-format.adapter";
import { buildKodiDocument } from "./kodi-document.writer";

export class KodiFormatAdapter implements SidecarFormatAdapter {
	readonly id = "kodi";
	readonly capabilities = ["write"] as const;

	async write({ documentPath, document }: SidecarFormatOutput): Promise<SidecarWriteResult> {
		const contents = writeXmlDocument(buildKodiDocument(documentPath, document));
		// Ingest re-saves unchanged metadata constantly (a season drop hits the
		// same tvshow.nfo once per episode file) — skip the tmp+rename when the
		// content is already identical.
		const existing = await readFile(documentPath, "utf8").catch(() => null);
		if (existing === contents) {
			return { documentPath, writtenFiles: [] };
		}

		await FileUtils.writeAtomic(documentPath, contents);

		return { documentPath, writtenFiles: [documentPath] };
	}
}
