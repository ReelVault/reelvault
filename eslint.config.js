import stylistic from "@stylistic/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

// ESLint is used ONLY as a formatter here (via `eslint --fix`).
// Linting is handled by Biome (`.biome.json`) and oxlint (`.oxlintrc.json`).
// Keep only formatting rules that those two do not support, e.g. `padding-line-between-statements`.
export default [
	{
		// Generated / build output — keep in sync with biome.json and .oxlintrc.json
		ignores: ["dist/**", "build/**", "node_modules/**", "**/routeTree.gen.ts", "**/*.gen.ts", "drizzle/**"],
	},
	{
		name: "reelvault/formatting",
		files: ["**/*.{js,mjs,cjs,ts,jsx,tsx}"],
		languageOptions: {
			// ESLint's default parser (espree) cannot parse TypeScript syntax.
			// No `parserOptions.project` needed — formatting rules are purely syntactic.
			parser: tsParser,
			ecmaVersion: "latest",
			sourceType: "module",
		},
		plugins: {
			"@stylistic": stylistic,
		},
		rules: {
			"@stylistic/padding-line-between-statements": [
				"error",

				// 1. Blank line BEFORE `return` (separate the result from the logic above).
				{ blankLine: "always", prev: "*", next: "return" },

				// 2. Blank line AFTER control-flow statements (guard clauses / loops / blocks).
				//    e.g. `if (...) continue;` is followed by a blank line before the next statement.
				{ blankLine: "always", prev: ["if", "for", "while", "switch", "try", "do", "iife"], next: "*" },

				// 3. Blank line BEFORE function / class / export declarations.
				{ blankLine: "always", prev: "*", next: ["function", "class", "export"] },

				// 4. Blank line AFTER directives (e.g. "use strict", "use client").
				{ blankLine: "always", prev: "directive", next: "*" },
			],
		},
	},
];
