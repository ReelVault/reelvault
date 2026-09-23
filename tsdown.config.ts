import { defineConfig } from "tsdown";

export default defineConfig({
	entry: [
		"./sdk/index.ts",
		"./sdk/client/index.ts",
		"./sdk/common/index.ts",
		"./sdk/plugin/index.ts",
		"./sdk/ui/index.ts",
		"./sdk/ui/schema.ts",
		"./sdk/testing/index.ts",
	],
	outDir: "./sdk/dist",
	format: ["esm", "cjs"],
	target: "ESNEXT",
	tsconfig: "./tsconfig.json",
	clean: true,
	minify: "dce-only",
	unbundle: true,
	dts: {
		sourcemap: false,
	},
	exports: false,
});
