import { rename } from "node:fs/promises";

/** Swaps the staged package into place. An upgrade moves the old package aside first and restores it if the swap fails. */
export async function activateStagedPackage(paths: {
	stagingDirectory: string;
	targetDirectory: string;
	backupDirectory: string | undefined;
}): Promise<void> {
	const { stagingDirectory, targetDirectory, backupDirectory } = paths;

	if (backupDirectory) {
		// Move the old installation aside; both renames are same-directory
		// so they are atomic on one filesystem. Restored on any failure below.
		await rename(targetDirectory, backupDirectory);
	}

	try {
		await rename(stagingDirectory, targetDirectory);
	} catch (error) {
		if (backupDirectory) await rename(backupDirectory, targetDirectory);

		throw error;
	}
}
