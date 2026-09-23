import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, spawn } from "bun";

const projectDirectory = join(import.meta.dir, "../..");
const sdkDirectory = join(projectDirectory, "node_modules", "@reelvault", "sdk");
const fixtureContent = `import type { PlaybackArtifact } from "@reelvault/sdk/common";
import {
	definePlugin,
	type PluginManifest,
	type ProviderMetadataResult,
	type ProviderSearchResult,
} from "@reelvault/sdk/plugin";

const manifest = {
	id: "org.reelvault.external-consumer",
	name: "External consumer fixture",
	version: "1.0.0",
	entry: "./index.js",
	capabilities: ["metadataProvider"],
} satisfies PluginManifest;

const plugin = definePlugin({
	async setup(host) {
		await host.providers.register({
			id: "external-consumer",
			name: "External consumer",
			version: "1.0.0",
			initialize: async () => undefined,
			search: async (): Promise<ProviderSearchResult[]> => [],
			getDetails: async (): Promise<ProviderMetadataResult | null> => null,
			getSeasonDetails: async () => null,
			getEpisodeDetails: async () => null,
		});
	},
});

const artifact: PlaybackArtifact = {
	id: "artifact-1",
	mediaFileId: "media-1",
	pluginId: manifest.id,
	kind: "trickplay",
	url: "/v1/artifacts/artifact-1",
	contentType: "image/webp",
	createdAt: "2026-07-25T00:00:00.000Z",
};

if (!plugin.setup || artifact.kind !== "trickplay") {
	throw new Error("Published @reelvault/sdk package is not usable by an external consumer");
}
`;

// A CommonJS consumer must resolve the `require` condition of the exports map
// (the `.d.cts` declarations). This guards the dual-format package contract.
const commonJsFixtureContent = `import {
	definePlugin,
	type PluginManifest,
	type ProviderMetadataResult,
	type ProviderSearchResult,
} from "@reelvault/sdk/plugin";

const manifest = {
	id: "org.reelvault.external-consumer-cjs",
	name: "External consumer CJS fixture",
	version: "1.0.0",
	entry: "./index.cjs",
	capabilities: ["metadataProvider"],
} satisfies PluginManifest;

export const plugin = definePlugin({
	async setup(host) {
		await host.providers.register({
			id: "external-consumer-cjs",
			name: "External consumer CJS",
			version: "1.0.0",
			initialize: async () => undefined,
			search: async (): Promise<ProviderSearchResult[]> => [],
			getDetails: async (): Promise<ProviderMetadataResult | null> => null,
			getSeasonDetails: async () => null,
			getEpisodeDetails: async () => null,
		});
	},
});

export const pluginId = manifest.id;
`;
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })));
});

describe("built SDK package", () => {
	test("type-checks and executes from an external consumer without project aliases", async () => {
		const consumerDirectory = await mkdtemp(join(tmpdir(), "reelvault-sdk-consumer-"));
		temporaryDirectories.push(consumerDirectory);
		const nodeModules = join(consumerDirectory, "node_modules");
		const fixture = join(consumerDirectory, "consumer.ts");
		const outputDirectory = join(consumerDirectory, "dist");

		await mkdir(join(nodeModules, "@reelvault"), { recursive: true });
		await symlink(sdkDirectory, join(nodeModules, "@reelvault", "sdk"), "dir");
		await writeFile(fixture, fixtureContent);
		await writeFile(
			join(consumerDirectory, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: {
					module: "NodeNext",
					moduleResolution: "NodeNext",
					noEmit: true,
					strict: true,
					skipLibCheck: true,
				},
			}),
		);

		const typeCheck = spawn([join(projectDirectory, "node_modules/.bin/tsc"), "--project", join(consumerDirectory, "tsconfig.json")], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const typeCheckExitCode = await typeCheck.exited;
		if (typeCheckExitCode !== 0) {
			const output = await Promise.all([new Response(typeCheck.stdout).text(), new Response(typeCheck.stderr).text()]);
			throw new Error(output.join("\n"));
		}

		const b = await build({ entrypoints: [fixture], outdir: outputDirectory, target: "bun" });
		expect(b.success).toBe(true);

		const execution = spawn([process.execPath, join(outputDirectory, "consumer.js")], { stdout: "pipe", stderr: "pipe" });
		expect(await execution.exited).toBe(0);
		expect((await readFile(fixture, "utf8")).includes("@/")).toBe(false);
	});

	test("type-checks from a CommonJS (require) consumer", async () => {
		const consumerDirectory = await mkdtemp(join(tmpdir(), "reelvault-sdk-cjs-consumer-"));
		temporaryDirectories.push(consumerDirectory);
		const nodeModules = join(consumerDirectory, "node_modules");
		const fixture = join(consumerDirectory, "consumer.cts");

		await mkdir(join(nodeModules, "@reelvault"), { recursive: true });
		await symlink(sdkDirectory, join(nodeModules, "@reelvault", "sdk"), "dir");
		await writeFile(fixture, commonJsFixtureContent);
		await writeFile(
			join(consumerDirectory, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: {
					module: "NodeNext",
					moduleResolution: "NodeNext",
					noEmit: true,
					strict: true,
					skipLibCheck: true,
				},
			}),
		);

		const typeCheck = spawn([join(projectDirectory, "node_modules/.bin/tsc"), "--project", join(consumerDirectory, "tsconfig.json")], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const typeCheckExitCode = await typeCheck.exited;
		if (typeCheckExitCode !== 0) {
			const output = await Promise.all([new Response(typeCheck.stdout).text(), new Response(typeCheck.stderr).text()]);
			throw new Error(output.join("\n"));
		}
	});
});
