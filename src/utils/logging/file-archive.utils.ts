import fs from "node:fs";
import { basename, dirname, extname, join } from "node:path";

export function formatDate(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");

	return `${year}-${month}-${day}`;
}

export function currentLogDate(): string {
	return formatDate(new Date());
}

/** Nth candidate archive path beside the active log: `name`, `name-1`, `name-2`, … in `directory`. */
export function archiveTarget(directory: string, activePath: string, attempt: number): string {
	if (attempt === 0) return join(directory, basename(activePath));

	const extension = extname(activePath);
	const baseName = basename(activePath, extension);

	return join(directory, `${baseName}-${attempt}${extension}`);
}

function archivePath(activePath: string, date: string, callback: (target: string) => void): void {
	const directory = join(dirname(activePath), date);
	let attempt = 0;
	const probe = (): void => {
		const target = archiveTarget(directory, activePath, attempt);
		fs.stat(target, (error) => {
			if (error) {
				callback(target);

				return;
			}

			attempt += 1;
			probe();
		});
	};
	probe();
}

export function archiveExistingFile(activePath: string, date: string, callback: (error?: Error | null) => void): void {
	fs.stat(activePath, (statError) => {
		if (statError) {
			// Nothing to archive yet.
			callback();

			return;
		}

		archivePath(activePath, date, (target) => {
			fs.mkdir(dirname(target), { recursive: true }, (mkdirError) => {
				if (mkdirError) {
					callback(mkdirError);

					return;
				}

				fs.rename(activePath, target, callback);
			});
		});
	});
}
