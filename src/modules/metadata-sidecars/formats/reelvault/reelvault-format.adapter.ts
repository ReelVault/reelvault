import { FileUtils, readFile } from "@/utils/file.utils";
import { PathUtils } from "@/utils/path.utils";
import { isRecord } from "@/utils/type.utils";
import type {
	CanonicalSidecarDocument,
	SidecarFormatInput,
	SidecarFormatOutput,
	SidecarSnapshotDocument,
	SidecarWriteResult,
} from "../../sidecar.types";
import { assertXmlDocumentSize, readXmlDocument } from "../../xml/xml-document.reader";
import { readXmlObject, readXmlText } from "../../xml/xml-value.reader";
import { writeXmlDocument } from "../../xml/xml-writer";
import type { SidecarFormatAdapter } from "../sidecar-format.adapter";

const SNAPSHOT_VERSION = 1;

export class ReelVaultFormatAdapter implements SidecarFormatAdapter {
	readonly id = "reelvault";
	readonly capabilities = ["read", "write"] as const;

	canRead({ documentPath }: SidecarFormatInput): Promise<boolean> {
		return Promise.resolve(PathUtils.getFileName(documentPath).toLowerCase().endsWith(".reelvault.nfo"));
	}

	async read({ documentPath }: SidecarFormatInput): Promise<CanonicalSidecarDocument | null> {
		assertXmlDocumentSize(documentPath, FileUtils.getSize(documentPath));
		const source = await readFile(documentPath, "utf8").catch(() => null);
		const document = source ? readXmlDocument(source) : null;
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
		const contents = writeXmlDocument({
			rootName: "reelvault",
			values: { reelvaultSchemaVersion: document.reelvaultSchemaVersion || SNAPSHOT_VERSION, snapshot: JSON.stringify(document) },
		});
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

function isSidecarSnapshotDocument(value: unknown): value is SidecarSnapshotDocument {
	if (!isRecord(value)) return false;

	return typeof value.reelvaultSchemaVersion === "number" && typeof value.title === "string" && isRecord(value.identifiers);
}

function parseSnapshot(value: string | undefined): SidecarSnapshotDocument | undefined {
	if (!value) return undefined;

	try {
		const parsed: unknown = JSON.parse(value);

		return isSidecarSnapshotDocument(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function getMediaKind(documentPath: string): "movie" | "series" | "episode" {
	const name = PathUtils.getFileName(documentPath).toLowerCase();
	if (name === "movie.reelvault.nfo") return "movie";

	if (name === "tvshow.reelvault.nfo") return "series";

	return "episode";
}
