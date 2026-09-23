/** Prints an ASCII table. Rows are pre-formatted strings aligned to `columns`. */
export function printTable(title: string, columns: readonly string[], rows: ReadonlyArray<readonly string[]>): void {
	const widths = columns.map((column, index) => Math.max(column.length, ...rows.map((row) => row[index]?.length ?? 0)));
	const separator = `+${widths.map((width) => "-".repeat(width + 2)).join("+")}+`;
	const formatRow = (row: readonly string[]) => `| ${row.map((cell, index) => cell.padStart(widths[index] ?? 0)).join(" | ")} |`;

	console.log(`\n${title}`);
	console.log(separator);
	console.log(formatRow(columns));
	console.log(separator);
	for (const row of rows) console.log(formatRow(row));

	console.log(separator);
}

export const fmtMs = (value: number): string => `${value.toFixed(2)}ms`;

export const fmtNumber = (value: number): string => value.toFixed(2);

export const fmtMb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)}MB`;
