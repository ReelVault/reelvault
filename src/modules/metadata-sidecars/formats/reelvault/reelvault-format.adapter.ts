import { basename } from "node:path";
import type { SidecarFormatAdapter } from "@/modules/metadata-sidecars/formats/sidecar-format.adapter";
import type {
	CanonicalSidecarDocument,
	SidecarFormatInput,
	SidecarFormatOutput,
	SidecarSnapshotDocument,
	SidecarWriteResult,
} from "@/modules/metadata-sidecars/sidecar.types";
import { writeXmlDocument, writeXmlIfChanged } from "@/modules/metadata-sidecars/xml/xml.writer";
import { loadXmlDocumentFile } from "@/modules/metadata-sidecars/xml/xml-document.reader";
import { readXmlObject, readXmlText } from "@/modules/metadata-sidecars/xml/xml-value.reader";
import { safeParseJson } from "@/utils/json.utils";
import { isRecord } from "@/utils/type.utils";

const SNAPSHOT_VERSION = 1;

export class ReelVaultFormatAdapter implements SidecarFormatAdapter {
	readonly id = "reelvault";
	readonly capabilities = ["read", "write"] as const;

	canRead({ documentPath }: SidecarFormatInput): Promise<boolean> {
		return Promise.resolve(basename(documentPath).toLowerCase().endsWith(".reelvault.nfo"));
	}

	async read({ documentPath }: SidecarFormatInput): Promise<CanonicalSidecarDocument | null> {
		const document = await loadXmlDocumentFile(documentPath);
		const root = document ? readXmlObject(document, "reelvault") : undefined;
		const snapshot = root ? parseSnapshot(readXmlText(root, "snapshot")) : undefined;
		if (!snapshot) return null;

		return {
			mediaKind: getMediaKind(documentPath),
			identifiers: snapshot.identifiers,
			title: snapshot.title,
			originalTitle: snapshot.originalTitle,
			year: snapshot.year,
			releaseDate: snapshot.releaseDate,
			overview: snapshot.overview,
			tagline: snapshot.tagline,
			status: snapshot.status,
			providerSnapshot: snapshot,
			artwork: {},
		};
	}

	async write({ documentPath, document }: SidecarFormatOutput): Promise<SidecarWriteResult> {
		const contents = await writeXmlDocument({
			rootName: "reelvault",
			values: { reelvaultSchemaVersion: document.reelvaultSchemaVersion || SNAPSHOT_VERSION, snapshot: JSON.stringify(document) },
		});
		return await writeXmlIfChanged(documentPath, contents);
	}
}

function isSidecarSnapshotDocument(value: unknown): value is SidecarSnapshotDocument {
	if (!isRecord(value)) return false;

	return typeof value.reelvaultSchemaVersion === "number" && typeof value.title === "string" && isRecord(value.identifiers);
}

function parseSnapshot(value: string | undefined): SidecarSnapshotDocument | undefined {
	if (!value) return undefined;

	const parsed = safeParseJson(value);

	return isSidecarSnapshotDocument(parsed) ? parsed : undefined;
}

function getMediaKind(documentPath: string): "movie" | "series" | "episode" {
	const name = basename(documentPath).toLowerCase();
	if (name === "movie.reelvault.nfo") return "movie";

	if (name === "tvshow.reelvault.nfo") return "series";

	return "episode";
}
