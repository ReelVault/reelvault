/**
 * `bun run lint awaits` — reports adjacent `await` statements in `src/` that could run in parallel.
 *
 * Two awaits in a row are reported when the second does not read a name the first one binds (it cannot
 * start before the first one finishes anyway). Statements inside a transaction are not reported: there a
 * `Promise.all` is not used at all (AGENTS.md), so the order is the policy, not a finding. A function takes
 * a transaction when a parameter is `tx`, `*Tx` or a `DatabaseTransaction`, or when it is passed to a
 * transaction opener (`transaction`, `runInTransaction`, `runTransaction`, `unitOfWorkRepository.run`).
 *
 * A marker directly above an await explains the pair it starts and every pair after it in the same run:
 *
 *   // awaits: sequential — <why the steps are ordered>
 *
 * A file whose steps are ordered throughout carries one marker in its header:
 *
 *   // awaits: sequential-file — <why the steps are ordered>
 *
 * A marker without a reason explains nothing. A marker that explains no pair is stale and fails the check,
 * so markers never outlive the code they describe.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseSync } from "oxc-parser";

const ROOT = join(import.meta.dir, "..", "..");
const SOURCE_ROOT = join(ROOT, "src");
const MARKER = /^\s*\/\/\s*awaits:\s*sequential(-file)?\b(.*)$/;
const MARKER_SEPARATOR = /^\s*[—–-]\s*/;
/** A parameter that carries the transaction: `tx`, `runTx`, `targetTx` or a `DatabaseTransaction`. */
const TRANSACTION_PARAMETER = /\b(?:tx|\w+Tx|DatabaseTransaction)\b/;
/** A callee that opens a transaction, so a function passed to it runs inside one. */
const TRANSACTION_OPENER = /\b(?:transaction|runInTransaction|runTransaction|unitOfWorkRepository\.run)$/;
const FUNCTION_TYPES = new Set(["ArrowFunctionExpression", "FunctionDeclaration", "FunctionExpression"]);
const STATEMENT_LIST_TYPES = new Set(["BlockStatement", "Program", "StaticBlock", "TSModuleBlock"]);

interface AstNode {
	type: string;
	start: number;
	end: number;
	[key: string]: unknown;
}

type Ancestors = readonly AstNode[];
type Visitor = (node: AstNode, ancestors: Ancestors) => void;

interface Marker {
	line: number;
	fileScope: boolean;
	reason: string;
}

interface Pair {
	file: string;
	line: number;
	first: string;
	second: string;
	reason: string;
	markerWithoutReason: boolean;
}

interface FileReport {
	pairs: Pair[];
	stale: string[];
	dependent: number;
	inTransaction: number;
}

interface ScanContext {
	file: string;
	source: string;
	lines: readonly string[];
	lineStarts: readonly number[];
	headerMarker: Marker | undefined;
	report: FileReport;
	usedMarkers: Set<number>;
}

async function collectTypeScriptFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const files = await Promise.all(
		entries.map(async (entry) => {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) return await collectTypeScriptFiles(path);
			if (!(entry.isFile() && entry.name.endsWith(".ts")) || entry.name.endsWith(".test.ts")) return [];

			return [path];
		}),
	);

	return files.flat();
}

function isAstNode(value: unknown): value is AstNode {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		typeof value.type === "string" &&
		"start" in value &&
		typeof value.start === "number" &&
		"end" in value &&
		typeof value.end === "number"
	);
}

function asList(value: unknown): readonly unknown[] {
	return Array.isArray(value) ? value : [];
}

function asNodes(value: unknown): AstNode[] {
	return asList(value).filter((item): item is AstNode => isAstNode(item));
}

function childNodes(node: AstNode): AstNode[] {
	return Object.values(node).flatMap((value) => (isAstNode(value) ? [value] : asNodes(value)));
}

function walk(node: AstNode, ancestors: Ancestors, visit: Visitor): void {
	visit(node, ancestors);
	for (const child of childNodes(node)) walk(child, [...ancestors, node], visit);
}

function identifierNames(node: AstNode): string[] {
	const names: string[] = [];
	walk(node, [], (child) => {
		if (child.type === "Identifier" && typeof child.name === "string") names.push(child.name);
	});

	return names;
}

function isAwait(value: unknown): boolean {
	return isAstNode(value) && value.type === "AwaitExpression";
}

/** `await x;`, `y = await x;` or `const y = await x;`. */
function isAwaitStatement(statement: AstNode): boolean {
	if (statement.type === "ExpressionStatement") return isAwaitedAssignment(statement.expression);
	if (statement.type === "VariableDeclaration") return asNodes(statement.declarations).some((declarator) => isAwait(declarator.init));

	return false;
}

function isAwaitedAssignment(expression: unknown): boolean {
	if (isAwait(expression)) return true;

	return isAstNode(expression) && expression.type === "AssignmentExpression" && isAwait(expression.right);
}

/** The places a statement writes: the declarators of `const`/`let`/`var`, or the target of an assignment. */
function writtenTargets(statement: AstNode): AstNode[] {
	if (statement.type === "VariableDeclaration") return asNodes(statement.declarations).flatMap((declarator) => asNodes([declarator.id]));

	const expression = statement.type === "ExpressionStatement" ? statement.expression : undefined;

	return isAstNode(expression) && expression.type === "AssignmentExpression" ? asNodes([expression.left]) : [];
}

/** The names a statement writes. Conservative: a destructuring key or a member object counts as written too. */
function writtenNames(statement: AstNode): string[] {
	return writtenTargets(statement).flatMap((target) => identifierNames(target));
}

function dependsOn(first: AstNode, second: AstNode): boolean {
	const bound = writtenNames(first);
	if (bound.length === 0) return false;

	const used = new Set(identifierNames(second));

	return bound.some((name) => used.has(name));
}

function takesTransaction(fn: AstNode, source: string): boolean {
	return asNodes(fn.params).some((param) => TRANSACTION_PARAMETER.test(source.slice(param.start, param.end)));
}

function isTransactionCallback(fn: AstNode, parent: AstNode | undefined, source: string): boolean {
	if (parent?.type !== "CallExpression") return false;

	const callee = parent.callee;

	return isAstNode(callee) && TRANSACTION_OPENER.test(source.slice(callee.start, callee.end)) && asNodes(parent.arguments).includes(fn);
}

/** Whether a function around the statement takes the transaction, or is a callback handed to a transaction opener. */
function inTransaction(ancestors: Ancestors, source: string): boolean {
	return ancestors.some(
		(ancestor, index) =>
			FUNCTION_TYPES.has(ancestor.type) &&
			(takesTransaction(ancestor, source) || isTransactionCallback(ancestor, ancestors[index - 1], source)),
	);
}

function statementList(node: AstNode): AstNode[] | undefined {
	if (node.type === "SwitchCase") return asNodes(node.consequent);
	if (STATEMENT_LIST_TYPES.has(node.type)) return asNodes(node.body);

	return undefined;
}

function lineStartsOf(source: string): number[] {
	const starts = [0];
	let newline = source.indexOf("\n");
	while (newline !== -1) {
		starts.push(newline + 1);
		newline = source.indexOf("\n", newline + 1);
	}

	return starts;
}

/** Zero-based line index of `offset`, by binary search over the line starts. */
function lineIndexOf(lineStarts: readonly number[], offset: number): number {
	let low = 0;
	let high = lineStarts.length - 1;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if ((lineStarts[middle] ?? 0) <= offset) low = middle;
		else high = middle - 1;
	}

	return low;
}

function readMarker(line: string): Omit<Marker, "line"> | undefined {
	const match = MARKER.exec(line);
	if (!match) return undefined;

	return { fileScope: match[1] !== undefined, reason: (match[2] ?? "").replace(MARKER_SEPARATOR, "").trim() };
}

/** The nearest pair marker in the comment lines directly above `lineIndex`. */
function markerAbove(lines: readonly string[], lineIndex: number): Marker | undefined {
	for (let index = lineIndex - 1; index >= 0 && (lines[index] ?? "").trim().startsWith("//"); index--) {
		const marker = readMarker(lines[index] ?? "");
		if (marker && !marker.fileScope) return { line: index, ...marker };
	}

	return undefined;
}

/** The file-level marker: a comment in the header, before the first line of code. */
function fileMarker(lines: readonly string[], firstCodeLine: number): Marker | undefined {
	for (let index = 0; index < firstCodeLine; index++) {
		const marker = readMarker(lines[index] ?? "");
		if (marker?.fileScope) return { line: index, ...marker };
	}

	return undefined;
}

function lineText(context: ScanContext, node: AstNode): string {
	return (context.lines[lineIndexOf(context.lineStarts, node.start)] ?? "").trim();
}

function recordPair(context: ScanContext, first: AstNode, second: AstNode, explained: Marker | undefined): void {
	const reason = explained?.reason ?? "";
	if (explained) context.usedMarkers.add(explained.line);
	context.report.pairs.push({
		file: relative(ROOT, context.file),
		line: lineIndexOf(context.lineStarts, first.start) + 1,
		first: lineText(context, first),
		second: lineText(context, second),
		reason,
		markerWithoutReason: explained !== undefined && reason === "",
	});
}

function scanStatements(context: ScanContext, statements: readonly AstNode[], ancestors: Ancestors): void {
	if (inTransaction(ancestors, context.source)) {
		for (let index = 0; index + 1 < statements.length; index++) {
			const first = statements[index];
			const second = statements[index + 1];
			if (first && second && isAwaitStatement(first) && isAwaitStatement(second)) context.report.inTransaction++;
		}

		return;
	}

	// A run is consecutive await statements; the first marker found in the run explains every pair in it.
	let runMarker: Marker | undefined;
	for (let index = 0; index + 1 < statements.length; index++) {
		const first = statements[index];
		const second = statements[index + 1];
		if (!(first && second)) continue;
		if (!isAwaitStatement(first)) {
			runMarker = undefined;
			continue;
		}

		runMarker ??= markerAbove(context.lines, lineIndexOf(context.lineStarts, first.start));
		if (!isAwaitStatement(second)) continue;
		if (dependsOn(first, second)) {
			context.report.dependent++;
			continue;
		}

		recordPair(context, first, second, context.headerMarker ?? runMarker);
	}
}

function analyzeFile(file: string, source: string): FileReport {
	const parsed = parseSync(file, source);
	if (parsed.errors.length > 0 || !isAstNode(parsed.program)) throw new Error(`${relative(ROOT, file)}: the parser rejected the file`);

	const lines = source.split("\n");
	const lineStarts = lineStartsOf(source);
	const program = parsed.program;
	const firstStatement = asNodes(program.body)[0];
	const firstCodeLine = firstStatement ? lineIndexOf(lineStarts, firstStatement.start) : lines.length;
	const report: FileReport = { pairs: [], stale: [], dependent: 0, inTransaction: 0 };
	const context: ScanContext = {
		file,
		source,
		lines,
		lineStarts,
		headerMarker: fileMarker(lines, firstCodeLine),
		report,
		usedMarkers: new Set(),
	};

	walk(program, [], (node, ancestors) => {
		const statements = statementList(node);
		if (statements) scanStatements(context, statements, ancestors);
	});

	for (const [index, line] of lines.entries()) {
		if (readMarker(line) && !context.usedMarkers.has(index)) {
			report.stale.push(`${relative(ROOT, file)}:${index + 1} explains no pair, remove it`);
		}
	}

	return report;
}

const files = await collectTypeScriptFiles(SOURCE_ROOT);
const reports = await Promise.all(files.map(async (file) => analyzeFile(file, await readFile(file, "utf8"))));
const pairs = reports.flatMap((report) => report.pairs);
const stale = reports.flatMap((report) => report.stale);
const dependent = reports.reduce((total, report) => total + report.dependent, 0);
const transactionPairs = reports.reduce((total, report) => total + report.inTransaction, 0);
const skipped = pairs.filter((pair) => pair.reason !== "");
const toReview = pairs.filter((pair) => pair.reason === "");

if (toReview.length > 0 || stale.length > 0) {
	for (const pair of toReview) {
		console.log(`${pair.file}:${pair.line}`);
		console.log(`  ${pair.first}`);
		console.log(`  ${pair.second}`);
		if (pair.markerWithoutReason) console.log("  (the marker above has no reason)");
	}
	for (const message of stale) console.log(message);
	console.log(
		`\n[awaits] ${toReview.length} pair(s) to review, ${stale.length} stale marker(s), ${skipped.length} skipped, ${dependent} dependent (the second statement reads a name the first one binds), ${transactionPairs} in a transaction (not checked). Parallelise independent I/O with Promise.all; annotate ordered steps with \`// awaits: sequential — reason\`.`,
	);
	process.exit(1);
}

const skippedFiles = new Set(skipped.map((pair) => pair.file));
console.log(
	`[awaits] ${skipped.length} intentional pair(s) skipped in ${skippedFiles.size} file(s), ${dependent} dependent pair(s) left out, ${transactionPairs} transaction pair(s) not checked.`,
);
