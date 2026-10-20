/** Quotes a CSV cell when it holds a separator, a quote or a line break. */
const CSV_SPECIAL_CHARACTERS = /[",\n\r]/;

export function toCsvCell(value: string | number | boolean | null | undefined): string {
	const text = String(value ?? "");

	return CSV_SPECIAL_CHARACTERS.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** One CSV line from its cells, quoted where needed. */
export function toCsvLine(cells: ReadonlyArray<string | number | boolean | null | undefined>): string {
	return cells.map((cell) => toCsvCell(cell)).join(",");
}

export interface CsvExport {
	body: string;
	contentType: string;
	filename: string;
}

/** A complete CSV download: the header line, the rows and the trailing newline. */
export function buildCsvExport(header: string, lines: readonly string[], filename: string): CsvExport {
	return { body: `${[header, ...lines].join("\n")}\n`, contentType: "text/csv; charset=utf-8", filename };
}
