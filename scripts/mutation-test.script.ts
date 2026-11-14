/**
 * `bun run mutation` — measures how much of the production code the test suite watches.
 *
 * Every production module that a test reaches, directly or through other modules and
 * test helpers, is a subject. For each subject the script applies one mutant at a time
 * (an operator flipped, a condition negated, a literal nudged, a call swapped, a block
 * emptied) and runs the test files that reach the subject. A mutant that a test kills is
 * behavior the suite notices; a survivor is a spot nobody watches.
 *
 * The measurement follows these rules:
 * - The source is parsed with `oxc-parser`; only real value positions become mutants.
 *   Type-only nodes are skipped, so a change the transpiler erases is never reported.
 * - A mutant that does not transpile is stillborn. It is dropped before any test runs.
 * - A mutant whose transpiled output equals the original's is equivalent: the change is
 *   erased by the transpiler (a type, a type argument), so no test can observe it. It is
 *   dropped too, so a type-only change never counts as a survivor.
 * - A subject whose covering tests already fail on the untouched source is skipped and
 *   reported, so a red suite cannot inflate the score. A timeout or crash on the untouched
 *   source is reported as such.
 * - A run that times out or crashes counts as killed (a hang or crash is a visible change)
 *   and is counted apart from assertion failures.
 * - A survivor that makes `tsc --noEmit` fail is a compile error, not a survivor: the
 *   code could never ship in that shape, so it is excluded from the score. `--no-typecheck`
 *   turns the check off; the baseline type check runs once.
 * - Every viable mutant runs by default. The nearest 10 covering test files run per mutant;
 *   `--max-tests=all` runs every test that reaches it, and `--max-tests=N` narrows the list.
 *   `--max-mutants=N` caps the mutants per module when a full run is too long.
 * - `--in-diff=<base>` mutates only the lines added against a Git base, like
 *   `cargo-mutants --in-diff`. Untracked files count as fully changed.
 * - Each worker mutates a private copy of the repository, so `--jobs` runs mutants in
 *   parallel without touching the working tree, and a test that reads a source file sees
 *   the mutant.
 * - Results are cached by the subject, the mutant, the covering tests, the subject's local
 *   imports and the environment. `--no-cache` disables the cache; `--clear-cache` drops it.
 * - One process may run a shard (`--shard=1/4`), and several shards may run in parallel
 *   from CI without sharing a working tree.
 * - The committed `.mutation-ledger.json` records which subjects were checked (full or
 *   partial), how many survivors remain and which survivors were accepted as noise or
 *   equivalents. `--update-ledger` writes it, `--status` prints it, and `--accept=<id>`
 *   moves a current survivor into the accepted baseline. Accepted survivors are excluded
 *   from the score and from `--fail-on-survivors`.
 *
 * This measures **sensitivity, not correctness**. Mutation testing cannot tell an intended
 * change from an unintended one, so a suite can kill every mutant and still assert the wrong
 * value. A survivor is not automatically a missing test either: an unreachable branch can
 * survive without a behavior change. Use the report to find blind spots, never as a certificate.
 *
 * Usage:
 *   bun run mutation                              # every viable mutant, nearest 10 covering tests
 *   bun run mutation -- --in-diff=main            # only lines changed against main
 *   bun run mutation -- --files=ffmpeg            # only modules whose path matches
 *   bun run mutation -- --max-mutants=12          # cap mutants per module
 *   bun run mutation -- --max-tests=5             # cap covering test files per mutant
 *   bun run mutation -- --max-tests=all           # every test file that reaches the mutant
 *   bun run mutation -- --jobs=4                  # parallel sandbox workers
 *   bun run mutation -- --shard=1/4               # one CI shard
 *   bun run mutation -- --mutators=block,string   # only selected mutators
 *   bun run mutation -- --exclude-mutators=block  # drop noisy mutators
 *   bun run mutation -- --plan                    # counts and the run budget; no test runs
 *   bun run mutation -- --list                    # every selected mutant; no test runs
 *   bun run mutation -- --json                    # machine-readable report
 *   bun run mutation -- --update-ledger           # save triage state in .mutation-ledger.json
 *   bun run mutation -- --status                  # what is checked, accepted and still todo
 *   bun run mutation -- --accept=<id,id>          # accept known survivors for later runs
 *   bun run mutation -- --no-typecheck            # skip the tsc filter on survivors
 *   bun run mutation -- --fail-on-survivors       # exit 1 when a survivor exists
 *   bun run mutation -- --threshold=85            # exit 1 below an 85% score
 */

import { type ChildProcess, spawn } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve as resolvePath, sep } from "node:path";
import { type Node, parseSync, visitorKeys } from "oxc-parser";

/** The folder the production code lives in. Its modules are the subjects. */
const SOURCE_ROOT = "src";

/** Test files and the helpers they import come from both roots: `tests/` holds the cross-cutting suites. */
const TEST_ROOTS = [SOURCE_ROOT, "tests"];

/** The alias the production code and the tests import through. */
const SOURCE_ALIAS = "@/";

/** A test file may run this long before bun itself fails it. */
const DEFAULT_TEST_TIMEOUT_MS = 30_000;

/** The nearest covering test files a mutant tries before it is declared a survivor. `--max-tests=all` removes the cap. */
const DEFAULT_MAX_TESTS = 10;

/** A `bun test` process still alive after this long is killed, and the mutant counts as killed. */
const DEFAULT_RUN_TIMEOUT_MS = 60_000;

/** A survivor's `tsc --noEmit` check gets this long before it is treated as a compile error. */
const TYPECHECK_TIMEOUT_MS = 120_000;

/** Bump when the mutators or the site discovery change, so an old verdict is not reused. */
const CACHE_VERSION = "7";

/** The committed triage ledger: what was checked, what is accepted and what is still todo. */
const LEDGER_VERSION = 1;
const DEFAULT_LEDGER_FILE = ".mutation-ledger.json";
const LEDGER_RUN_LIMIT = 100;

/** The local result cache. It is machine-local and never written into the repository. */
const CACHE_FILE = join(tmpdir(), "reelvault-mutation-cache.json");

/** An older version wrote originals here before mutating files in place. Restore them once. */
const LEGACY_RECOVERY_FILE = join(tmpdir(), "reelvault-mutation.json");

/** Files and folders a worker's private copy does not need, and the copy would make huge. */
const SANDBOX_EXCLUDES = new Set([".git", ".VSCodeCounter", ".stryker-tmp", "benchmark-results", "coverage", "node_modules", "reports"]);

/** Files whose contents can change a verdict without changing the subject or a test. */
const ENVIRONMENT_FILES = ["package.json", "tsconfig.json", "bunfig.toml", ".env", "bun.lock"];

/** How many new verdicts are written to disk between saves. */
const CACHE_SAVE_INTERVAL = 1000;

/** The header of a unified-diff hunk: `@@ -old +new @@`. */
const DIFF_HUNK_PATTERN = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/** A comment after an accepted id in `--accept-file`. */
const ACCEPT_COMMENT_PATTERN = /#.*$/;

/** AST fields that only carry types, never runtime values. */
const SKIP_CHILD_KEYS = new Set([
	"attributes",
	"implements",
	"returnType",
	"superTypeArguments",
	"typeAnnotation",
	"typeArguments",
	"typeParameters",
]);

/** TS wrappers whose expression still runs. Other `TS*` nodes are type-only. */
const TS_VALUE_NODES = new Set([
	"TSAsExpression",
	"TSEnumBody",
	"TSEnumDeclaration",
	"TSEnumMember",
	"TSInstantiationExpression",
	"TSModuleBlock",
	"TSModuleDeclaration",
	"TSNonNullExpression",
	"TSParameterProperty",
	"TSSatisfiesExpression",
	"TSTypeAssertion",
]);

type BooleanNode = Extract<Extract<Node, { type: "Literal" }>, { value: boolean }>;
type CallNode = Extract<Node, { type: "CallExpression" }>;
type LiteralNode = Extract<Node, { type: "Literal" }>;
type MemberNode = Extract<Node, { type: "MemberExpression" }>;
type NullNode = Extract<LiteralNode, { value: null }>;
type NumericNode = Extract<LiteralNode, { value: number }>;
type StringNode = Extract<LiteralNode, { value: string }>;
type TemplateNode = Extract<Node, { type: "TemplateLiteral" }>;
type ArrayNode = Extract<Node, { type: "ArrayExpression" }>;
type ArrowNode = Extract<Node, { type: "ArrowFunctionExpression" }>;
type AwaitNode = Extract<Node, { type: "AwaitExpression" }>;
type BlockNode = Extract<Node, { type: "BlockStatement" }>;
type ObjectNode = Extract<Node, { type: "ObjectExpression" }>;
type ReturnNode = Extract<Node, { type: "ReturnStatement" }>;
type ThrowNode = Extract<Node, { type: "ThrowStatement" }>;
type ConditionalNode = Extract<Node, { type: "ConditionalExpression" }>;
type AssignmentNode = Extract<Node, { type: "AssignmentExpression" }>;
type BinaryNode = Extract<Node, { type: "BinaryExpression" }>;
type LogicalNode = Extract<Node, { type: "LogicalExpression" }>;
type UnaryNode = Extract<Node, { type: "UnaryExpression" }>;
type UpdateNode = Extract<Node, { type: "UpdateExpression" }>;

interface Site {
	kind: string;
	index: number;
	before: string;
	after: string;
	line: number;
	endLine: number;
	/** Stable identity among identical sites in the same file, so moved code keeps its ledger entry. */
	occurrence: number;
}

type Mutant = Site;

interface Analysis {
	viable: Mutant[];
	stillborn: number;
	equivalent: number;
	baseline: string;
}

interface Shard {
	index: number;
	count: number;
}

interface Options {
	files: string[] | undefined;
	maxMutants: number | undefined;
	maxTests: number | undefined;
	jobs: number;
	testTimeoutMs: number;
	runTimeoutMs: number;
	json: boolean;
	plan: boolean;
	list: boolean;
	inDiff: string | undefined;
	diffFile: string | undefined;
	shard: Shard | undefined;
	cache: boolean;
	clearCache: boolean;
	typecheck: boolean;
	failOnSurvivors: boolean;
	threshold: number | undefined;
	mutators: Set<string> | undefined;
	excludeMutators: Set<string> | undefined;
	ledger: string;
	updateLedger: boolean;
	acceptIds: string[];
	status: boolean;
}

interface LineRange {
	start: number;
	end: number;
}

interface MutationFilter {
	subject: string;
	kinds: Set<string> | undefined;
	exclude: Set<string> | undefined;
	ranges: Map<string, LineRange[]> | undefined;
}

interface TestReach {
	path: string;
	/** Production modules the test reaches, with the import hops to each (1 = imported directly). */
	reached: Map<string, number>;
}

interface Survivor {
	id: string;
	fingerprint: string;
	subject: string;
	line: number;
	kind: string;
	before: string;
	after: string;
	occurrence: number;
	tests: string[];
}

interface LedgerAccepted {
	subject: string;
	kind: string;
	before: string;
	after: string;
	occurrence: number;
	acceptedAt: string;
}

interface LedgerSubject {
	checkedAt: string;
	lastRunId: string;
	coverage: "full" | "partial";
	fullCheckedAt: string | undefined;
	scope: string;
	viable: number;
	killed: number;
	todo: number;
	accepted: number;
	compileErrors: number;
	skipped: string | undefined;
	maxTests: number | undefined;
	maxMutants: number | undefined;
	typecheck: boolean;
}

interface LedgerRun {
	id: string;
	startedAt: string;
	finishedAt: string;
	commit: string | undefined;
	dirty: boolean | undefined;
	coverage: "full" | "partial";
	scope: string;
	maxTests: number | undefined;
	maxMutants: number | undefined;
	typecheck: boolean;
	subjects: number;
	killed: number;
	todo: number;
	accepted: number;
	compileErrors: number;
}

interface MutationLedger {
	version: number;
	createdAt: string;
	updatedAt: string;
	subjects: Record<string, LedgerSubject>;
	accepted: Record<string, LedgerAccepted>;
	runs: LedgerRun[];
}

interface RecordDetails {
	cached: boolean;
	accepted: boolean;
}

interface ReconcileInput {
	infos: SubjectInfo[];
	results: SubjectResult[];
	options: Options;
	startedAt: string;
	finishedAt: string;
	acceptedBySubject: Map<string, number>;
}

interface KindStats {
	killed: number;
	survived: number;
	accepted: number;
	compileErrors: number;
}

interface FileStats {
	subject: string;
	killed: number;
	survived: number;
	skipped: string | undefined;
}

interface SubjectResult {
	subject: string;
	skipped: string | undefined;
	stillborn: number;
	equivalent: number;
	tried: number;
	cached: number;
	killed: number;
	timedOut: number;
	crashed: number;
	compileErrors: number;
	accepted: number;
	survivors: Survivor[];
	byKind: Record<string, KindStats>;
}

interface PlanLine {
	subject: string;
	viable: number;
	sampled: number;
	tests: string[];
	skipped: string | undefined;
}

interface Summary {
	score: number | null;
	killed: number;
	survived: number;
	timedOut: number;
	crashed: number;
	stillborn: number;
	equivalent: number;
	cached: number;
	compileErrors: number;
	accepted: number;
	skipped: Array<{ subject: string; reason: string }>;
	survivors: Survivor[];
	unwatched: string[];
	byKind: Record<string, KindStats>;
	files: FileStats[];
}

interface RunOutcome {
	passed: boolean;
	timedOut: boolean;
	crashed: boolean;
}

interface MutantVerdict {
	killed: boolean;
	timedOut: boolean;
	crashed: boolean;
	compileError: boolean;
	killedBy: string | undefined;
	skipReason: string | undefined;
}

interface SubjectInfo {
	subject: string;
	source: string;
	analysis: Analysis | undefined;
	covering: string[];
	skipped: string | undefined;
	taskCount: number;
	sourceHash: string;
	testsHash: string;
	dependencyHash: string;
}

interface Task {
	info: SubjectInfo;
	mutant: Mutant;
}

interface BuildContext {
	reaches: TestReach[];
	graph: Map<string, string[]>;
	filter: MutationFilter;
	options: Options;
	fileHashes: Map<string, string>;
	hashing: boolean;
}

interface RunContext {
	options: Options;
	environmentHash: string;
	accepted: Set<string>;
}

interface BaselineCache {
	tests: Map<string, Promise<RunOutcome>>;
}

interface WorkerContext {
	tasks: Task[];
	queue: { index: number };
	results: Map<string, SubjectResult>;
	baselineSandbox: string;
	baselineCache: BaselineCache;
	cache: MutationCache;
	context: RunContext;
	printed: Set<string>;
}

interface MutationCache {
	entries: Map<string, MutantVerdict>;
	additions: number;
}

interface RecoveryRecord {
	pid: number;
	originals: Array<[string, string]>;
}

interface OperatorMutation {
	kind: string;
	after: string;
}

interface OperatorSite {
	start: number;
	end: number;
	operator: string;
	after: string;
}

/** One site finder appends every mutation it sees to the context. */
interface SiteContext {
	source: string;
	sites: Site[];
	seen: Set<string>;
	lineStarts: number[];
	filter: MutationFilter;
}

/**
 * The operator, literal, statement and call mutators. A kind is the stable name used by
 * `--mutators`, `--exclude-mutators` and the report.
 */
const BINARY_MUTATIONS: Readonly<Record<string, readonly OperatorMutation[]>> = {
	"!==": [{ kind: "inequality", after: "===" }],
	"!=": [{ kind: "loose-inequality", after: "==" }],
	"===": [{ kind: "equality", after: "!==" }],
	"==": [{ kind: "loose-equality", after: "!=" }],
	">": [{ kind: "greater", after: ">=" }],
	">=": [{ kind: "at-least", after: ">" }],
	"<": [{ kind: "less", after: "<=" }],
	"<=": [{ kind: "at-most", after: "<" }],
	"+": [{ kind: "arithmetic-add", after: "-" }],
	"-": [{ kind: "arithmetic-subtract", after: "+" }],
	"*": [{ kind: "arithmetic-multiply", after: "/" }],
	"/": [{ kind: "arithmetic-divide", after: "*" }],
	"%": [{ kind: "arithmetic-modulo", after: "*" }],
	"**": [{ kind: "arithmetic-exponent", after: "*" }],
	"<<": [{ kind: "shift-left", after: ">>" }],
	">>": [{ kind: "shift-right", after: "<<" }],
	">>>": [{ kind: "shift-right-unsigned", after: ">>" }],
	"&": [{ kind: "bitwise-and", after: "|" }],
	"|": [{ kind: "bitwise-or", after: "&" }],
	"^": [{ kind: "bitwise-xor", after: "&" }],
};

const LOGICAL_MUTATIONS: Readonly<Record<string, readonly OperatorMutation[]>> = {
	"&&": [{ kind: "and", after: "||" }],
	"||": [{ kind: "or", after: "&&" }],
	"??": [{ kind: "nullish", after: "||" }],
};

const ASSIGNMENT_MUTATIONS: Readonly<Record<string, readonly OperatorMutation[]>> = {
	"+=": [{ kind: "assignment-add", after: "-=" }],
	"-=": [{ kind: "assignment-subtract", after: "+=" }],
	"*=": [{ kind: "assignment-multiply", after: "/=" }],
	"/=": [{ kind: "assignment-divide", after: "*=" }],
	"%=": [{ kind: "assignment-modulo", after: "*=" }],
	"**=": [{ kind: "assignment-exponent", after: "*=" }],
	"<<=": [{ kind: "assignment-shift-left", after: ">>=" }],
	">>=": [{ kind: "assignment-shift-right", after: "<<=" }],
	">>>=": [{ kind: "assignment-shift-right-unsigned", after: ">>=" }],
	"&=": [{ kind: "assignment-bitwise-and", after: "|=" }],
	"|=": [{ kind: "assignment-bitwise-or", after: "&=" }],
	"^=": [{ kind: "assignment-bitwise-xor", after: "&=" }],
	"&&=": [{ kind: "assignment-and", after: "||=" }],
	"||=": [{ kind: "assignment-or", after: "&&=" }],
	"??=": [{ kind: "assignment-nullish", after: "||=" }],
};

const UNARY_MUTATIONS: Readonly<Record<string, readonly OperatorMutation[]>> = {
	"!": [{ kind: "negation", after: "" }],
	"+": [{ kind: "unary-plus", after: "-" }],
	"-": [{ kind: "unary-minus", after: "+" }],
	"~": [{ kind: "bitwise-not", after: "" }],
	typeof: [{ kind: "typeof", after: "" }],
	void: [{ kind: "void", after: "" }],
	delete: [{ kind: "delete", after: "" }],
};

const UPDATE_MUTATIONS: Readonly<Record<string, readonly OperatorMutation[]>> = {
	"++": [{ kind: "increment", after: "--" }],
	"--": [{ kind: "decrement", after: "++" }],
};

/** A call whose callee is swapped as a whole. */
const CALL_SWAPS: Readonly<Record<string, string>> = {
	"Math.ceil": "Math.floor",
	"Math.floor": "Math.ceil",
	"Math.max": "Math.min",
	"Math.min": "Math.max",
};

/** A call whose method suffix is swapped. */
const CALL_SUFFIX_SWAPS: ReadonlyArray<readonly [string, string]> = [
	[".every", ".some"],
	[".some", ".every"],
];

/** Every kind the CLI accepts. */
const KNOWN_MUTATOR_KINDS = new Set<string>([
	...Object.values(BINARY_MUTATIONS).flatMap((mutations) => mutations.map((mutation) => mutation.kind)),
	...Object.values(LOGICAL_MUTATIONS).flatMap((mutations) => mutations.map((mutation) => mutation.kind)),
	...Object.values(ASSIGNMENT_MUTATIONS).flatMap((mutations) => mutations.map((mutation) => mutation.kind)),
	...Object.values(UNARY_MUTATIONS).flatMap((mutations) => mutations.map((mutation) => mutation.kind)),
	...Object.values(UPDATE_MUTATIONS).flatMap((mutations) => mutations.map((mutation) => mutation.kind)),
	"array",
	"arrow-body",
	"await-remove",
	"block",
	"call-swap",
	"condition-false",
	"condition-negation",
	"condition-true",
	"conditional-swap",
	"falsy",
	"null",
	"number",
	"object",
	"optional-chain",
	"regex",
	"return-value",
	"string",
	"template",
	"throw-value",
	"truthy",
]);

/** The child processes in flight, so an interrupt kills them instead of leaving them running. */
const activeChildren = new Set<ChildProcess>();

/** The private repository copies in use, so an interrupt removes them. */
const sandboxes = new Set<string>();

const transpiler = new Bun.Transpiler({ loader: "ts" });

/** Hooks the exit paths: stop every test process and remove every private copy. */
function cleanup(): void {
	for (const child of activeChildren) child.kill("SIGKILL");
	activeChildren.clear();
	for (const directory of sandboxes) rmSync(directory, { recursive: true, force: true });
	sandboxes.clear();
}

process.on("exit", cleanup);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		cleanup();
		process.exit(130);
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isNode(value: unknown): value is Node {
	if (!isRecord(value)) return false;

	return typeof value.type === "string" && typeof value.start === "number" && typeof value.end === "number";
}

function isPair(value: unknown): value is [string, string] {
	return Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "string";
}

function isRecoveryRecord(value: unknown): value is RecoveryRecord {
	return isRecord(value) && typeof value.pid === "number" && Array.isArray(value.originals) && value.originals.every(isPair);
}

function isVerdict(value: unknown): value is MutantVerdict {
	if (!isRecord(value)) return false;

	return (
		typeof value.killed === "boolean" &&
		typeof value.timedOut === "boolean" &&
		typeof value.crashed === "boolean" &&
		typeof value.compileError === "boolean" &&
		(value.killedBy === undefined || typeof value.killedBy === "string") &&
		(value.skipReason === undefined || typeof value.skipReason === "string")
	);
}

function isCacheFile(value: unknown): value is { version: string; entries: Record<string, unknown> } {
	return isRecord(value) && value.version === CACHE_VERSION && isRecord(value.entries);
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);

		return true;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
}

/** The record an earlier version left, or undefined when there is none or it cannot be read. */
function readRecovery(): RecoveryRecord | undefined {
	if (!existsSync(LEGACY_RECOVERY_FILE)) return undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(LEGACY_RECOVERY_FILE, "utf8"));

		return isRecoveryRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** Puts back files an older in-place run left mutated, then removes the record. */
function restoreLegacyRecovery(): void {
	const record = readRecovery();
	if (record === undefined) return;
	if (record.pid !== process.pid && isProcessAlive(record.pid)) {
		console.error(`another mutation run (pid ${record.pid}) is active; wait for it to finish`);
		process.exit(1);
	}
	for (const [file, original] of record.originals) writeFileSync(file, original);
	rmSync(LEGACY_RECOVERY_FILE, { force: true });
	console.log(`restored ${record.originals.length} file(s) left mutated by an interrupted run`);
}

function readOptions(): Options {
	const args = process.argv.slice(2);
	const value = (name: string): string | undefined => {
		const prefix = `--${name}=`;

		return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
	};
	const flag = (name: string): boolean => args.includes(`--${name}`);
	const inDiff = parseInDiff(args);
	const mutators = parseKindList(value("mutators"), "--mutators");
	const excludeMutators = parseKindList(value("exclude-mutators"), "--exclude-mutators");
	const acceptIds = parseAcceptIds(value("accept"), value("accept-file"));

	return {
		files: parseFiles(value("files")),
		maxMutants: parseLimit(value("max-mutants"), undefined, "--max-mutants"),
		maxTests: parseLimit(value("max-tests"), DEFAULT_MAX_TESTS, "--max-tests"),
		jobs: positiveInt(value("jobs"), 1, "--jobs"),
		testTimeoutMs: positiveInt(value("timeout"), DEFAULT_TEST_TIMEOUT_MS, "--timeout"),
		runTimeoutMs: positiveInt(value("run-timeout"), DEFAULT_RUN_TIMEOUT_MS, "--run-timeout"),
		json: flag("json"),
		plan: flag("plan"),
		list: flag("list"),
		inDiff,
		diffFile: value("diff-file"),
		shard: parseShard(value("shard")),
		cache: !flag("no-cache"),
		clearCache: flag("clear-cache"),
		typecheck: !flag("no-typecheck"),
		failOnSurvivors: flag("fail-on-survivors"),
		threshold: parseThreshold(value("threshold")),
		mutators,
		excludeMutators,
		ledger: value("ledger") ?? DEFAULT_LEDGER_FILE,
		updateLedger: flag("update-ledger") || acceptIds.length > 0,
		acceptIds,
		status: flag("status"),
	};
}

function parseAcceptIds(raw: string | undefined, file: string | undefined): string[] {
	const ids = raw === undefined ? [] : raw.split(",");
	if (file !== undefined) {
		for (const line of readFileSync(file, "utf8").split("\n")) {
			const id = line.replace(ACCEPT_COMMENT_PATTERN, "").trim();
			if (id.length > 0) ids.push(id);
		}
	}

	return [...new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0))];
}

function parseInDiff(args: string[]): string | undefined {
	const argument = args.find((arg) => arg === "--in-diff" || arg.startsWith("--in-diff="));
	if (argument === undefined) return undefined;
	const value = argument.slice("--in-diff=".length);

	return value === "" ? "HEAD" : value;
}

function parseFiles(raw: string | undefined): string[] | undefined {
	if (raw === undefined) return undefined;

	return raw
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

function parseKindList(raw: string | undefined, flagName: string): Set<string> | undefined {
	if (raw === undefined) return undefined;
	const kinds = raw
		.split(",")
		.map((kind) => kind.trim())
		.filter((kind) => kind.length > 0);
	for (const kind of kinds) {
		if (!KNOWN_MUTATOR_KINDS.has(kind)) {
			console.error(`Unknown mutator in ${flagName}: ${kind}\n\nKnown mutators:\n${[...KNOWN_MUTATOR_KINDS].toSorted().join(", ")}`);
			process.exit(2);
		}
	}

	return new Set(kinds);
}

function positiveInt(raw: string | undefined, fallback: number, name: string): number {
	if (raw === undefined) return fallback;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		console.error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
		process.exit(2);
	}

	return parsed;
}

function parseLimit(raw: string | undefined, fallback: number | undefined, name: string): number | undefined {
	if (raw === undefined) return fallback;
	if (raw === "all") return undefined;

	return positiveInt(raw, 0, name);
}

function parseThreshold(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
		console.error(`--threshold must be between 0 and 100, got ${JSON.stringify(raw)}`);
		process.exit(2);
	}

	return parsed;
}

function parseShard(raw: string | undefined): Shard | undefined {
	if (raw === undefined) return undefined;
	const [indexText, countText] = raw.split("/");
	const index = Number(indexText);
	const count = Number(countText);
	if (!(Number.isInteger(index) && Number.isInteger(count)) || count < 1 || index < 1 || index > count) {
		console.error(`--shard must look like 1/4, got ${JSON.stringify(raw)}`);
		process.exit(2);
	}

	return { index, count };
}

/** Every `.ts` file below a folder, as repository-relative paths. Declaration files are not modules. */
function collectTypeScript(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory)) {
		if (entry === "node_modules") continue;
		const path = join(directory, entry);
		if (statSync(path).isDirectory()) files.push(...collectTypeScript(path));
		else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) files.push(path);
	}

	return files;
}

/** The repository file a relative or `@/` specifier points at, or undefined for a package import. */
function resolveLocalImport(specifier: string, fromFile: string): string | undefined {
	let base: string;
	if (specifier.startsWith("./") || specifier.startsWith("../")) base = resolvePath(dirname(fromFile), specifier);
	else if (specifier.startsWith(SOURCE_ALIAS)) base = resolvePath(SOURCE_ROOT, specifier.slice(SOURCE_ALIAS.length));
	else return undefined;

	for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
		if (existsSync(candidate)) return relative(process.cwd(), candidate);
	}

	return undefined;
}

/** The repository files one module imports directly. Commented-out imports do not count. */
function readLocalImports(file: string): string[] {
	const source = readFileSync(file, "utf8");
	const parsed = parseSync(file, source, { lang: "ts" });
	if (parsed.errors.length > 0) return [];
	const specifiers: string[] = [];
	for (const entry of parsed.module.staticImports) {
		const runtime = entry.entries.length === 0 || entry.entries.some((specifier) => !specifier.isType);
		if (runtime) specifiers.push(entry.moduleRequest.value);
	}
	for (const statement of parsed.module.staticExports) {
		for (const entry of statement.entries) {
			if (entry.moduleRequest === null || entry.isType) continue;
			specifiers.push(entry.moduleRequest.value);
		}
	}
	for (const entry of parsed.module.dynamicImports)
		specifiers.push(source.slice(entry.moduleRequest.start + 1, entry.moduleRequest.end - 1));
	const imports = new Set<string>();
	for (const specifier of specifiers) {
		const target = resolveLocalImport(specifier, file);
		if (target !== undefined) imports.add(target);
	}

	return [...imports];
}

/** The production modules a test file reaches through imports, nearest first. Helpers under `tests/` are passed through, not subjects. */
function reachedModules(start: string, graph: Map<string, string[]>): Map<string, number> {
	const hops = new Map<string, number>([[start, 0]]);
	const queue: string[] = [start];
	for (const current of queue) {
		const next = (hops.get(current) ?? 0) + 1;
		for (const target of graph.get(current) ?? []) {
			if (hops.has(target)) continue;
			hops.set(target, next);
			queue.push(target);
		}
	}

	const reached = new Map<string, number>();
	for (const [file, count] of hops) {
		if (file !== start && isProductionPath(file)) reached.set(file, count);
	}

	return reached;
}

/**
 * The test files that reach the subject, the one named after it first, then the ones in its
 * folder, then the rest. Within each rank, fewer import hops come first. The default limit
 * keeps a mutant from running the whole suite; `--max-tests=all` removes it.
 */
function coveringTests(subject: string, reaches: TestReach[], limit: number | undefined): string[] {
	const name = basename(subject, ".ts");
	const rank = (reach: TestReach): 0 | 1 | 2 | 3 => {
		if (basename(reach.path) === `${name}.test.ts`) return 0;
		if ((reach.reached.get(subject) ?? 0) === 1) return 1;

		return dirname(reach.path) === dirname(subject) ? 2 : 3;
	};
	const ordered = reaches
		.filter((reach) => reach.reached.has(subject))
		.toSorted(
			(left, right) =>
				rank(left) - rank(right) ||
				(left.reached.get(subject) ?? 0) - (right.reached.get(subject) ?? 0) ||
				left.path.localeCompare(right.path),
		);
	const selected = limit === undefined ? ordered : ordered.slice(0, limit);

	return selected.map((reach) => reach.path);
}

/** A finder for every match of `pattern` in the code. The replacement is computed from the matched text. */
function lineStarts(source: string): number[] {
	const starts = [0];
	for (let index = source.indexOf("\n"); index !== -1; index = source.indexOf("\n", index + 1)) starts.push(index + 1);

	return starts;
}

/** The 1-based line of an index, by binary search over the line starts. */
function lineAt(starts: number[], index: number): number {
	let low = 0;
	let high = starts.length - 1;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if ((starts[middle] ?? 0) <= index) low = middle;
		else high = middle - 1;
	}

	return low + 1;
}

/** True when the mutation kind is enabled and the mutated span overlaps the active diff. */
function siteAllowed(ctx: SiteContext, kind: string, startLine: number, endLine: number): boolean {
	if (ctx.filter.kinds !== undefined && !ctx.filter.kinds.has(kind)) return false;
	if (ctx.filter.exclude?.has(kind) === true) return false;
	if (ctx.filter.ranges === undefined) return true;
	const ranges = ctx.filter.ranges.get(ctx.filter.subject);
	if (ranges === undefined) return false;

	return ranges.some((range) => startLine <= range.end && endLine >= range.start);
}

function addSite(ctx: SiteContext, kind: string, index: number, before: string, after: string): void {
	if (before === after) return;
	const line = lineAt(ctx.lineStarts, index);
	const endLine = lineAt(ctx.lineStarts, index + before.length);
	if (!siteAllowed(ctx, kind, line, endLine)) return;
	const key = `${index}\0${before}\0${after}`;
	if (ctx.seen.has(key)) return;
	ctx.seen.add(key);
	ctx.sites.push({ kind, index, before, after, line, endLine, occurrence: 0 });
}

function addNodeReplacement(ctx: SiteContext, kind: string, node: Node, after: string): void {
	addSite(ctx, kind, node.start, ctx.source.slice(node.start, node.end), after);
}

/** Finds an operator between two offsets while ignoring comments. */
function findCodeOperator(source: string, start: number, end: number, operator: string): number | undefined {
	let index = start;
	while (index < end) {
		if (source.startsWith("//", index)) {
			const newline = source.indexOf("\n", index);
			index = newline === -1 ? end : newline + 1;
			continue;
		}
		if (source.startsWith("/*", index)) {
			const close = source.indexOf("*/", index + 2);
			index = close === -1 ? end : close + 2;
			continue;
		}
		if (source.startsWith(operator, index)) return index;
		index++;
	}

	return undefined;
}

function addOperatorSite(ctx: SiteContext, kind: string, site: OperatorSite): void {
	const index = findCodeOperator(ctx.source, site.start, site.end, site.operator);
	if (index === undefined) return;
	addSite(ctx, kind, index, site.operator, site.after);
}

function addOperatorMutations(ctx: SiteContext, mutations: readonly OperatorMutation[] | undefined, site: OperatorSite): void {
	if (mutations === undefined) return;
	for (const mutation of mutations) addOperatorSite(ctx, mutation.kind, { ...site, after: mutation.after });
}

function addBinaryMutations(node: BinaryNode, ctx: SiteContext): void {
	addOperatorMutations(ctx, BINARY_MUTATIONS[node.operator], {
		start: node.left.end,
		end: node.right.start,
		operator: node.operator,
		after: "",
	});
}

function addLogicalMutations(node: LogicalNode, ctx: SiteContext): void {
	addOperatorMutations(ctx, LOGICAL_MUTATIONS[node.operator], {
		start: node.left.end,
		end: node.right.start,
		operator: node.operator,
		after: "",
	});
}

function addAssignmentMutations(node: AssignmentNode, ctx: SiteContext): void {
	addOperatorMutations(ctx, ASSIGNMENT_MUTATIONS[node.operator], {
		start: node.left.end,
		end: node.right.start,
		operator: node.operator,
		after: "",
	});
}

function addUnaryMutations(node: UnaryNode, ctx: SiteContext): void {
	addOperatorMutations(ctx, UNARY_MUTATIONS[node.operator], {
		start: node.start,
		end: node.argument.start,
		operator: node.operator,
		after: "",
	});
}

function addUpdateMutations(node: UpdateNode, ctx: SiteContext): void {
	const start = node.prefix ? node.start : node.argument.end;
	const end = node.prefix ? node.argument.start : node.end;
	addOperatorMutations(ctx, UPDATE_MUTATIONS[node.operator], { start, end, operator: node.operator, after: "" });
}

/** A condition is worth negating, and forcing to either constant is a second, independent check. */
function addConditionMutations(test: Node, ctx: SiteContext): void {
	const before = ctx.source.slice(test.start, test.end);
	if (before === "true") {
		addSite(ctx, "condition-false", test.start, before, "false");

		return;
	}
	if (before === "false") {
		addSite(ctx, "condition-true", test.start, before, "true");

		return;
	}
	addSite(ctx, "condition-negation", test.start, before, `!(${before})`);
	addSite(ctx, "condition-true", test.start, before, "true");
	addSite(ctx, "condition-false", test.start, before, "false");
}

function addConditionalMutations(node: ConditionalNode, ctx: SiteContext): void {
	addConditionMutations(node.test, ctx);
	const consequent = ctx.source.slice(node.consequent.start, node.consequent.end);
	const alternate = ctx.source.slice(node.alternate.start, node.alternate.end);
	addSite(ctx, "conditional-swap", node.consequent.start, consequent, alternate);
}

function addBlockMutation(node: BlockNode, ctx: SiteContext): void {
	if (node.body.length === 0) return;
	addNodeReplacement(ctx, "block", node, "{}");
}

function addReturnMutation(node: ReturnNode, ctx: SiteContext): void {
	if (node.argument === null) return;
	const before = ctx.source.slice(node.argument.start, node.argument.end);
	if (before === "undefined" || before.startsWith("void ")) return;
	addNodeReplacement(ctx, "return-value", node.argument, "undefined");
}

function addThrowMutation(node: ThrowNode, ctx: SiteContext): void {
	const before = ctx.source.slice(node.argument.start, node.argument.end);
	if (before === "undefined" || before.startsWith("void ")) return;
	addNodeReplacement(ctx, "throw-value", node.argument, "undefined");
}

function addArrowMutation(node: ArrowNode, ctx: SiteContext): void {
	if (!node.expression) return;
	const before = ctx.source.slice(node.body.start, node.body.end);
	if (before === "undefined" || before.startsWith("void ")) return;
	addNodeReplacement(ctx, "arrow-body", node.body, "undefined");
}

function addAwaitMutation(node: AwaitNode, ctx: SiteContext): void {
	const after = ctx.source.slice(node.argument.start, node.argument.end);
	addSite(ctx, "await-remove", node.start, ctx.source.slice(node.start, node.end), after);
}

function addArrayMutation(node: ArrayNode, ctx: SiteContext): void {
	addNodeReplacement(ctx, "array", node, node.elements.length === 0 ? "[1]" : "[]");
}

function addObjectMutation(node: ObjectNode, ctx: SiteContext): void {
	addNodeReplacement(ctx, "object", node, node.properties.length === 0 ? "{ a: 1 }" : "{}");
}

function addTemplateMutation(node: TemplateNode, parent: Node | undefined, ctx: SiteContext): void {
	if (parent?.type === "TaggedTemplateExpression") return;
	const text = node.quasis.map((quasi) => quasi.value.raw).join("");
	addNodeReplacement(ctx, "template", node, text.length === 0 ? '"Stryker was here!"' : '""');
}

function addCallSwap(node: CallNode, ctx: SiteContext): void {
	const callee = ctx.source.slice(node.callee.start, node.callee.end);
	const exact = CALL_SWAPS[callee];
	if (exact !== undefined) {
		addNodeReplacement(ctx, "call-swap", node.callee, exact);

		return;
	}
	for (const [from, to] of CALL_SUFFIX_SWAPS) {
		if (!callee.endsWith(from)) continue;
		addNodeReplacement(ctx, "call-swap", node.callee, `${callee.slice(0, -from.length)}${to}`);

		return;
	}
}

function addOptionalMember(node: MemberNode, ctx: SiteContext): void {
	if (node.computed) {
		addOperatorSite(ctx, "optional-chain", {
			start: node.object.end,
			end: node.property.start,
			operator: "?.[",
			after: "[",
		});

		return;
	}
	addOperatorSite(ctx, "optional-chain", {
		start: node.object.end,
		end: node.property.start,
		operator: "?.",
		after: ".",
	});
}

function addOptionalCall(node: CallNode, ctx: SiteContext): void {
	addOperatorSite(ctx, "optional-chain", {
		start: node.callee.end,
		end: node.end,
		operator: "?.",
		after: "",
	});
}

function isModuleSpecifier(parent: Node | undefined, key: string): boolean {
	if (parent === undefined) return false;
	if (parent.type === "CallExpression") {
		const callee = parent.callee;

		return callee.type === "Identifier" && callee.name === "require";
	}
	if (key !== "source") return false;

	return (
		parent.type === "ImportDeclaration" ||
		parent.type === "ExportAllDeclaration" ||
		parent.type === "ExportNamedDeclaration" ||
		parent.type === "ImportExpression"
	);
}

function addStringMutation(node: StringNode, parent: Node | undefined, key: string, ctx: SiteContext): void {
	if (isModuleSpecifier(parent, key)) return;
	if (parent !== undefined && "directive" in parent) return;
	addNodeReplacement(ctx, "string", node, node.value.length === 0 ? '"Stryker was here!"' : '""');
}

function addBooleanMutation(node: BooleanNode, ctx: SiteContext): void {
	addNodeReplacement(ctx, "truthy", node, node.value ? "false" : "true");
}

function addNumberMutation(node: NumericNode, ctx: SiteContext): void {
	if (!Number.isFinite(node.value)) return;
	addNodeReplacement(ctx, "number", node, String(node.value + 1));
	addNodeReplacement(ctx, "number", node, String(node.value - 1));
	if (node.value !== 0) addNodeReplacement(ctx, "number", node, "0");
}

function addNullMutation(node: NullNode, ctx: SiteContext): void {
	addNodeReplacement(ctx, "null", node, "undefined");
}

function compileRegex(pattern: string, flags: string): RegExp | undefined {
	try {
		return new RegExp(pattern, flags);
	} catch {
		return undefined;
	}
}

function isValidRegex(pattern: string, flags: string): boolean {
	return compileRegex(pattern, flags) !== undefined;
}

function addRegexMutation(node: LiteralNode, regex: { pattern: string; flags: string }, ctx: SiteContext): void {
	const pattern = regex.pattern;
	const candidates = new Set<string>();
	candidates.add(pattern.startsWith("^") ? pattern.slice(1) : `^${pattern}`);
	candidates.add(pattern.endsWith("$") ? pattern.slice(0, -1) : `${pattern}$`);
	candidates.add(pattern.replaceAll(String.raw`\d`, String.raw`\D`));
	candidates.add(pattern.replaceAll(String.raw`\w`, String.raw`\W`));
	candidates.add(pattern.replaceAll(String.raw`\s`, String.raw`\S`));
	candidates.add(pattern.replaceAll("+", "*"));
	candidates.add(pattern.replaceAll("*", "+"));
	for (const candidate of candidates) {
		if (candidate === pattern || candidate.length === 0) continue;
		if (!isValidRegex(candidate, regex.flags)) continue;
		addNodeReplacement(ctx, "regex", node, `/${candidate}/${regex.flags}`);
	}
}

function addLiteralMutation(node: LiteralNode, parent: Node | undefined, key: string, ctx: SiteContext): void {
	if ("regex" in node) {
		addRegexMutation(node, node.regex, ctx);

		return;
	}
	if (typeof node.value === "boolean") {
		addBooleanMutation(node, ctx);

		return;
	}
	if (node.value === null) {
		addNullMutation(node, ctx);

		return;
	}
	if (typeof node.value === "number") {
		addNumberMutation(node, ctx);

		return;
	}
	if (typeof node.value === "string") addStringMutation(node, parent, key, ctx);
}

/** Walks the runtime children of the AST. Type-only fields are skipped before they are visited. */
function walkAst(
	node: Node,
	parent: Node | undefined,
	key: string,
	visit: (node: Node, parent: Node | undefined, key: string) => void,
): void {
	if ("directive" in node) return;
	if (node.type.startsWith("TS") && !TS_VALUE_NODES.has(node.type)) return;
	visit(node, parent, key);
	for (const childKey of visitorKeys[node.type] ?? []) {
		if (SKIP_CHILD_KEYS.has(childKey)) continue;
		const child: unknown = Reflect.get(node, childKey);
		if (Array.isArray(child)) {
			for (const item of child) if (isNode(item)) walkAst(item, node, childKey, visit);
		} else if (isNode(child)) {
			walkAst(child, node, childKey, visit);
		}
	}
}

function visitOperatorNode(node: Node, ctx: SiteContext): boolean {
	if (node.type === "BinaryExpression") {
		addBinaryMutations(node, ctx);

		return true;
	}
	if (node.type === "LogicalExpression") {
		addLogicalMutations(node, ctx);

		return true;
	}
	if (node.type === "AssignmentExpression") {
		addAssignmentMutations(node, ctx);

		return true;
	}
	if (node.type === "UnaryExpression") {
		addUnaryMutations(node, ctx);

		return true;
	}
	if (node.type === "UpdateExpression") {
		addUpdateMutations(node, ctx);

		return true;
	}

	return false;
}

function visitConditionNode(node: Node, ctx: SiteContext): boolean {
	if (node.type === "ConditionalExpression") {
		addConditionalMutations(node, ctx);

		return true;
	}
	if (node.type === "IfStatement") {
		addConditionMutations(node.test, ctx);

		return true;
	}
	if (node.type === "WhileStatement") {
		addConditionMutations(node.test, ctx);

		return true;
	}
	if (node.type === "DoWhileStatement") {
		addConditionMutations(node.test, ctx);

		return true;
	}
	if (node.type === "ForStatement") {
		if (node.test !== null) addConditionMutations(node.test, ctx);

		return true;
	}

	return false;
}

function visitLiteralNode(node: Node, parent: Node | undefined, key: string, ctx: SiteContext): boolean {
	if (node.type === "Literal") {
		addLiteralMutation(node, parent, key, ctx);

		return true;
	}
	if (node.type === "TemplateLiteral") {
		addTemplateMutation(node, parent, ctx);

		return true;
	}
	if (node.type === "ArrayExpression") {
		addArrayMutation(node, ctx);

		return true;
	}
	if (node.type === "ObjectExpression") {
		addObjectMutation(node, ctx);

		return true;
	}

	return false;
}

function visitStructuralNode(node: Node, ctx: SiteContext): boolean {
	if (node.type === "CallExpression") {
		addCallSwap(node, ctx);
		if (node.optional) addOptionalCall(node, ctx);

		return true;
	}
	if (node.type === "MemberExpression") {
		if (node.optional) addOptionalMember(node, ctx);

		return true;
	}
	if (node.type === "ArrowFunctionExpression") {
		addArrowMutation(node, ctx);

		return true;
	}
	if (node.type === "AwaitExpression") {
		addAwaitMutation(node, ctx);

		return true;
	}
	if (node.type === "BlockStatement") {
		addBlockMutation(node, ctx);

		return true;
	}
	if (node.type === "ReturnStatement") {
		addReturnMutation(node, ctx);

		return true;
	}
	if (node.type === "ThrowStatement") {
		addThrowMutation(node, ctx);

		return true;
	}

	return false;
}

function visitNode(node: Node, parent: Node | undefined, key: string, ctx: SiteContext): void {
	if (visitOperatorNode(node, ctx)) return;
	if (visitConditionNode(node, ctx)) return;
	if (visitLiteralNode(node, parent, key, ctx)) return;
	visitStructuralNode(node, ctx);
}

/** Every mutation site in a module, in source order. Undefined when the source does not parse. */
function readMutants(source: string, subject: string, filter: MutationFilter): Site[] | undefined {
	if (filter.ranges !== undefined && !filter.ranges.has(subject)) return [];
	const parsed = parseSync(subject, source, { lang: "ts" });
	if (parsed.errors.length > 0) return undefined;
	const ctx: SiteContext = { source, sites: [], seen: new Set(), lineStarts: lineStarts(source), filter };
	walkAst(parsed.program, undefined, "", (node, parent, key) => visitNode(node, parent, key, ctx));
	const sites = ctx.sites.toSorted((left, right) => left.index - right.index);
	const occurrences = new Map<string, number>();
	for (const site of sites) {
		const key = `${site.kind}\0${site.before}\0${site.after}`;
		const occurrence = occurrences.get(key) ?? 0;
		site.occurrence = occurrence;
		occurrences.set(key, occurrence + 1);
	}

	return sites;
}

/** The source with one mutant applied. The splice is done on the original text. */
function applyMutant(source: string, mutant: Site): string {
	return source.slice(0, mutant.index) + mutant.after + source.slice(mutant.index + mutant.before.length);
}

function transpileOrUndefined(source: string): string | undefined {
	try {
		return transpiler.transformSync(source);
	} catch {
		return undefined;
	}
}

/** The viable mutants of a module, with the counts of the dropped ones. Undefined when the untouched source does not transpile or parse. */
function analyse(source: string, subject: string, filter: MutationFilter): Analysis | undefined {
	if (filter.ranges !== undefined && !filter.ranges.has(subject)) return { viable: [], stillborn: 0, equivalent: 0, baseline: "" };
	const baseline = transpileOrUndefined(source);
	if (baseline === undefined) return undefined;
	const mutants = readMutants(source, subject, filter);
	if (mutants === undefined) return undefined;
	const viable: Mutant[] = [];
	let stillborn = 0;
	let equivalent = 0;
	for (const mutant of mutants) {
		const output = transpileOrUndefined(applyMutant(source, mutant));
		if (output === undefined) stillborn++;
		else if (output === baseline) equivalent++;
		else viable.push(mutant);
	}

	return { viable, stillborn, equivalent, baseline };
}

/** Mutants spread evenly over the module, so a long file is not judged by its first lines. */
function sampleEvenly(mutants: Mutant[], limit: number | undefined): Mutant[] {
	if (limit === undefined || mutants.length <= limit) return mutants;
	const sample: Mutant[] = [];
	for (let slot = 0; slot < limit; slot++) {
		const mutant = mutants[Math.floor((slot * mutants.length) / limit)];
		if (mutant !== undefined) sample.push(mutant);
	}

	return sample;
}

/** The lines added to each file by a diff. A file missing from the map has no changed lines. */
function addRange(ranges: Map<string, LineRange[]>, file: string, start: number, end: number): void {
	const existing = ranges.get(file);
	if (existing === undefined) ranges.set(file, [{ start, end }]);
	else existing.push({ start, end });
}

function parseDiff(text: string): Map<string, LineRange[]> {
	const ranges = new Map<string, LineRange[]>();
	let file: string | undefined;
	for (const line of text.split("\n")) {
		if (line.startsWith("+++ b/")) {
			file = line.slice("+++ b/".length);
			continue;
		}
		if (line.startsWith("+++ /dev/null")) {
			file = undefined;
			continue;
		}
		if (file === undefined || !line.startsWith("@@ ")) continue;
		const match = DIFF_HUNK_PATTERN.exec(line);
		if (match === null) continue;
		const startText = match[1];
		if (startText === undefined) continue;
		const start = Number(startText);
		const count = match[2] === undefined ? 1 : Number(match[2]);
		if (Number.isInteger(start) && Number.isInteger(count) && count > 0) addRange(ranges, file, start, start + count - 1);
	}

	return ranges;
}

function runGit(args: string[]): string {
	const result = Bun.spawnSync({
		cmd: ["git", ...args],
		cwd: process.cwd(),
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr).trim()}`);

	return String(result.stdout);
}

/** Changed lines against a Git base, or the contents of an explicit diff file. */
function readDiffRanges(options: Options): Map<string, LineRange[]> | undefined {
	if (options.diffFile !== undefined) return parseDiff(readFileSync(options.diffFile, "utf8"));
	if (options.inDiff === undefined) return undefined;
	const ranges = parseDiff(runGit(["diff", "-U0", options.inDiff, "--", "*.ts"]));
	const untracked = runGit(["ls-files", "--others", "--exclude-standard", "--", "*.ts"])
		.split("\n")
		.filter((line) => line.length > 0);
	for (const file of untracked) {
		if (!file.endsWith(".ts") || file.endsWith(".d.ts")) continue;
		const lines = readFileSync(file, "utf8").split("\n").length;
		addRange(ranges, file, 1, lines);
	}

	return ranges;
}

function createSandbox(id: string): string {
	const directory = join(tmpdir(), `reelvault-mutation-${process.pid}-${id}`);
	rmSync(directory, { recursive: true, force: true });
	cpSync(process.cwd(), directory, {
		recursive: true,
		filter: (source) => {
			const path = relative(process.cwd(), source);
			if (path === "") return true;
			const topLevel = path.split(sep)[0] ?? "";

			return !SANDBOX_EXCLUDES.has(topLevel);
		},
	});
	const modules = join(process.cwd(), "node_modules");
	if (existsSync(modules)) symlinkSync(modules, join(directory, "node_modules"), "dir");
	sandboxes.add(directory);

	return directory;
}

/** Runs one test file in a private copy. Exit code 0 is a pass; bun exits 1 on any failure. */
function runTest(file: string, sandbox: string, options: Options): Promise<RunOutcome> {
	return new Promise((resolve) => {
		let timedOut = false;
		const child = spawn(process.execPath, ["test", file, "--timeout", String(options.testTimeoutMs), "--bail=1"], {
			cwd: sandbox,
			env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
			stdio: "ignore",
		});
		activeChildren.add(child);
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, options.runTimeoutMs);
		let settled = false;
		const finish = (outcome: RunOutcome): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			activeChildren.delete(child);
			resolve(outcome);
		};
		child.on("error", () => finish({ passed: false, timedOut: false, crashed: true }));
		child.on("close", (code, signal) =>
			finish({
				passed: code === 0 && !timedOut && signal === null,
				timedOut,
				crashed: signal !== null && !timedOut,
			}),
		);
	});
}

/** One test file on the untouched source. Every subject in this worker that covers it shares the promise. */
function greenOutcome(test: string, sandbox: string, cache: BaselineCache, options: Options): Promise<RunOutcome> {
	const known = cache.tests.get(test);
	if (known !== undefined) return known;
	const outcome = runTest(test, sandbox, options);
	cache.tests.set(test, outcome);

	return outcome;
}

function baselineFailure(test: string, outcome: RunOutcome): string {
	if (outcome.timedOut) return `covering test timed out on the untouched source: ${test}`;
	if (outcome.crashed) return `covering test crashed on the untouched source: ${test}`;

	return `covering test is red without a mutation: ${test}`;
}

/**
 * Applies one mutant in a private copy, runs the covering tests until one fails, and always
 * restores the copy. A test is checked on the untouched source immediately before it is used,
 * so a subject with one killing test does not pay for the other covering tests' baselines.
 */
/** Runs the project's own TypeScript checker over a mutated worker copy. */
function typecheckSurvivor(sandbox: string): Promise<boolean> {
	const tsc = join(sandbox, "node_modules", "typescript", "bin", "tsc");
	if (!existsSync(tsc)) return Promise.resolve(true);

	return new Promise((resolve) => {
		const child = spawn(process.execPath, [tsc, "--noEmit", "--pretty", "false"], {
			cwd: sandbox,
			stdio: "ignore",
		});
		activeChildren.add(child);
		const timer = setTimeout(() => child.kill("SIGKILL"), TYPECHECK_TIMEOUT_MS);
		let settled = false;
		const finish = (clean: boolean): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			activeChildren.delete(child);
			resolve(clean);
		};
		child.on("error", () => finish(false));
		child.on("close", (code) => finish(code === 0));
	});
}

/** The untouched source must pass the checker once; otherwise the filter would report stale errors. */
function typecheckAvailable(): boolean {
	const sandbox = createSandbox("typecheck");
	const tsc = join(sandbox, "node_modules", "typescript", "bin", "tsc");
	if (!existsSync(tsc)) {
		console.warn("type checking is unavailable: typescript/bin/tsc was not found; rerun with --no-typecheck");

		return false;
	}
	const result = Bun.spawnSync({
		cmd: [process.execPath, tsc, "--noEmit", "--pretty", "false"],
		cwd: sandbox,
		stdout: "ignore",
		stderr: "pipe",
	});
	if (result.exitCode === 0) return true;
	const details = String(result.stderr).trim().split("\n").slice(0, 5).join("\n");
	console.warn(`type checking is unavailable: the untouched source does not pass tsc --noEmit; rerun with --no-typecheck\n${details}`);

	return false;
}

async function judgeMutant(
	sandbox: string,
	baselineSandbox: string,
	task: Task,
	baselineCache: BaselineCache,
	options: Options,
): Promise<MutantVerdict> {
	const target = join(sandbox, task.info.subject);
	writeFileSync(target, applyMutant(task.info.source, task.mutant));
	try {
		for (const test of task.info.covering) {
			const baseline = await greenOutcome(test, baselineSandbox, baselineCache, options);
			if (!baseline.passed) {
				return {
					killed: false,
					timedOut: false,
					crashed: false,
					compileError: false,
					killedBy: undefined,
					skipReason: baselineFailure(test, baseline),
				};
			}
			const outcome = await runTest(test, sandbox, options);
			if (!outcome.passed) {
				return {
					killed: true,
					timedOut: outcome.timedOut,
					crashed: outcome.crashed,
					compileError: false,
					killedBy: test,
					skipReason: undefined,
				};
			}
		}
		const compileError = options.typecheck ? !(await typecheckSurvivor(sandbox)) : false;

		return { killed: false, timedOut: false, crashed: false, compileError, killedBy: undefined, skipReason: undefined };
	} finally {
		writeFileSync(target, task.info.source);
	}
}

function createResult(info: SubjectInfo): SubjectResult {
	return {
		subject: info.subject,
		skipped: info.skipped,
		stillborn: info.analysis?.stillborn ?? 0,
		equivalent: info.analysis?.equivalent ?? 0,
		tried: 0,
		cached: 0,
		killed: 0,
		timedOut: 0,
		crashed: 0,
		compileErrors: 0,
		accepted: 0,
		survivors: [],
		byKind: {},
	};
}

function recordVerdict(result: SubjectResult, info: SubjectInfo, mutant: Mutant, verdict: MutantVerdict, details: RecordDetails): void {
	result.tried++;
	if (details.cached) result.cached++;
	const stats = result.byKind[mutant.kind] ?? { killed: 0, survived: 0, accepted: 0, compileErrors: 0 };
	if (verdict.compileError) {
		result.compileErrors++;
		stats.compileErrors++;
	} else if (verdict.killed) {
		result.killed++;
		if (verdict.timedOut) result.timedOut++;
		if (verdict.crashed) result.crashed++;
		stats.killed++;
	} else if (details.accepted) {
		result.accepted++;
		stats.accepted++;
	} else {
		const fingerprint = survivorFingerprint(info.subject, mutant);
		stats.survived++;
		result.survivors.push({
			id: survivorId(fingerprint),
			fingerprint,
			subject: info.subject,
			line: mutant.line,
			kind: mutant.kind,
			before: mutant.before,
			after: mutant.after,
			occurrence: mutant.occurrence,
			tests: info.covering,
		});
	}
	result.byKind[mutant.kind] = stats;
}

function cacheKey(info: SubjectInfo, mutant: Mutant, environmentHash: string): string {
	return Bun.hash(
		`${CACHE_VERSION}\0${info.subject}\0${info.sourceHash}\0${mutant.kind}\0${mutant.index}\0${mutant.before}\0${mutant.after}\0${info.testsHash}\0${info.dependencyHash}\0${environmentHash}`,
	).toString(36);
}

function hashFile(file: string, cache: Map<string, string>): string {
	const known = cache.get(file);
	if (known !== undefined) return known;
	if (!existsSync(file)) {
		cache.set(file, "missing");

		return "missing";
	}
	const hash = Bun.hash(readFileSync(file, "utf8")).toString(36);
	cache.set(file, hash);

	return hash;
}

function dependencyClosure(start: string, graph: Map<string, string[]>): string[] {
	const seen = new Set([start]);
	const queue = [start];
	for (const current of queue) {
		for (const next of graph.get(current) ?? []) {
			if (seen.has(next)) continue;
			seen.add(next);
			queue.push(next);
		}
	}

	return [...seen].toSorted();
}

function computeEnvironmentHash(options: Options, fileHashes: Map<string, string>): string {
	const hashes = ENVIRONMENT_FILES.map((file) => hashFile(file, fileHashes));
	const variables = Object.entries(process.env)
		.filter(([key]) => key.startsWith("REELVAULT_") || key === "CI" || key === "NODE_ENV" || key === "TZ")
		.toSorted(([left], [right]) => left.localeCompare(right))
		.map(([key, value]) => `${key}=${value ?? ""}`);

	return Bun.hash(
		`${Bun.version}\0${process.platform}\0${hashes.join("\0")}\0${variables.join("\0")}\0${options.testTimeoutMs}\0${options.runTimeoutMs}\0${options.typecheck}`,
	).toString(36);
}

interface SubjectHashes {
	sourceHash: string;
	testsHash: string;
	dependencyHash: string;
}

function computeSubjectHashes(
	subject: string,
	source: string,
	covering: string[],
	analysis: Analysis | undefined,
	context: BuildContext,
): SubjectHashes {
	if (analysis === undefined || analysis.viable.length === 0 || !context.hashing) {
		return { sourceHash: "", testsHash: "", dependencyHash: "" };
	}
	const testsHash = Bun.hash(covering.map((test) => hashFile(test, context.fileHashes)).join("\0")).toString(36);
	const dependencies = new Set(dependencyClosure(subject, context.graph));
	for (const test of covering) {
		for (const file of dependencyClosure(test, context.graph)) dependencies.add(file);
	}
	const dependencyHash = Bun.hash(
		[...dependencies]
			.toSorted()
			.map((file) => hashFile(file, context.fileHashes))
			.join("\0"),
	).toString(36);

	return { sourceHash: Bun.hash(source).toString(36), testsHash, dependencyHash };
}

function buildSubjectInfos(subjects: string[], context: BuildContext): SubjectInfo[] {
	const infos: SubjectInfo[] = [];
	for (const subject of subjects) {
		const source = readFileSync(subject, "utf8");
		const filter = { ...context.filter, subject };
		const analysis = analyse(source, subject, filter);
		const covering =
			analysis === undefined || analysis.viable.length === 0 ? [] : coveringTests(subject, context.reaches, context.options.maxTests);
		const skipped = analysis === undefined ? "the untouched source does not parse or transpile" : undefined;
		const hashes = computeSubjectHashes(subject, source, covering, analysis, context);
		infos.push({ subject, source, analysis, covering, skipped, taskCount: 0, ...hashes });
	}

	return infos;
}

function buildTasks(infos: SubjectInfo[], options: Options): Task[] {
	const tasks: Task[] = [];
	for (const info of infos) {
		if (info.analysis === undefined) continue;
		for (const mutant of sampleEvenly(info.analysis.viable, options.maxMutants)) tasks.push({ info, mutant });
	}
	const shard = options.shard;
	const sharded = shard === undefined ? tasks : tasks.filter((_task, index) => index % shard.count === shard.index - 1);
	const counts = new Map<string, number>();
	for (const task of sharded) counts.set(task.info.subject, (counts.get(task.info.subject) ?? 0) + 1);
	for (const info of infos) info.taskCount = counts.get(info.subject) ?? 0;

	return sharded;
}

function loadCache(options: Options): MutationCache {
	const cache: MutationCache = { entries: new Map(), additions: 0 };
	if (options.clearCache) rmSync(CACHE_FILE, { force: true });
	if (!options.cache) return cache;
	if (!existsSync(CACHE_FILE)) return cache;
	try {
		const parsed: unknown = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
		if (!isCacheFile(parsed)) return cache;
		for (const [key, value] of Object.entries(parsed.entries)) {
			if (isVerdict(value) && value.skipReason === undefined) cache.entries.set(key, value);
		}
	} catch {
		return cache;
	}

	return cache;
}

function saveCache(cache: MutationCache, options: Options): void {
	if (!options.cache) return;
	try {
		const temporary = `${CACHE_FILE}.${process.pid}.tmp`;
		writeFileSync(temporary, JSON.stringify({ version: CACHE_VERSION, entries: Object.fromEntries(cache.entries) }));
		renameSync(temporary, CACHE_FILE);
		cache.additions = 0;
	} catch (error) {
		console.error(`could not write the mutation cache: ${String(error)}`);
	}
}

function maybeSaveCache(cache: MutationCache, options: Options): void {
	if (cache.additions < CACHE_SAVE_INTERVAL) return;
	saveCache(cache, options);
}

function emptyLedger(): MutationLedger {
	const now = new Date().toISOString();

	return { version: LEDGER_VERSION, createdAt: now, updatedAt: now, subjects: {}, accepted: {}, runs: [] };
}

function isMutationLedger(value: unknown): value is MutationLedger {
	return (
		isRecord(value) && value.version === LEDGER_VERSION && isRecord(value.subjects) && isRecord(value.accepted) && Array.isArray(value.runs)
	);
}

function loadLedger(path: string): MutationLedger {
	if (!existsSync(path)) return emptyLedger();
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		console.error(`could not read the mutation ledger at ${path}: ${String(error)}`);
		process.exit(2);
	}
	if (!isMutationLedger(parsed)) {
		console.error(`the mutation ledger at ${path} has an unknown shape or version; restore it or pass --ledger=<path>`);
		process.exit(2);
	}

	return parsed;
}

function writeLedger(path: string, ledger: MutationLedger): void {
	try {
		const directory = dirname(path);
		if (directory !== ".") mkdirSync(directory, { recursive: true });
		const temporary = `${path}.${process.pid}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(ledger, null, "\t")}\n`);
		renameSync(temporary, path);
	} catch (error) {
		console.error(`could not write the mutation ledger at ${path}: ${String(error)}`);
		process.exit(2);
	}
}

function acceptedSet(ledger: MutationLedger): Set<string> {
	return new Set(Object.keys(ledger.accepted));
}

function survivorFingerprint(subject: string, mutant: Mutant): string {
	return Bun.hash(`${subject}\0${mutant.kind}\0${mutant.before}\0${mutant.after}\0${mutant.occurrence}`).toString(36);
}

function survivorId(fingerprint: string): string {
	return fingerprint.slice(0, 12);
}

function isFullCoverage(options: Options): boolean {
	return (
		options.maxMutants === undefined &&
		options.maxTests === undefined &&
		options.inDiff === undefined &&
		options.diffFile === undefined &&
		options.shard === undefined &&
		options.mutators === undefined &&
		options.excludeMutators === undefined
	);
}

function describeScope(options: Options): string {
	const parts: string[] = [];
	if (options.files !== undefined) parts.push(`files=${options.files.join(",")}`);
	if (options.inDiff !== undefined) parts.push(`in-diff=${options.inDiff}`);
	if (options.diffFile !== undefined) parts.push(`diff-file=${options.diffFile}`);
	if (options.shard !== undefined) parts.push(`shard=${options.shard.index}/${options.shard.count}`);
	if (options.maxMutants !== undefined) parts.push(`max-mutants=${options.maxMutants}`);
	parts.push(options.maxTests === undefined ? "max-tests=all" : `max-tests=${options.maxTests}`);
	if (options.mutators !== undefined) parts.push(`mutators=${[...options.mutators].join(",")}`);
	if (options.excludeMutators !== undefined) parts.push(`exclude-mutators=${[...options.excludeMutators].join(",")}`);

	return parts.join("; ");
}

function tryGit(args: string[]): string | undefined {
	try {
		return runGit(args).trim();
	} catch {
		return undefined;
	}
}

function acceptSurvivors(
	ledger: MutationLedger,
	survivors: Survivor[],
	ids: string[],
): { accepted: number; bySubject: Map<string, number>; ids: Set<string>; survivors: Survivor[] } {
	const byId = new Map(survivors.map((survivor) => [survivor.id, survivor]));
	const bySubject = new Map<string, number>();
	const acceptedIds = new Set<string>();
	const acceptedSurvivors: Survivor[] = [];
	const now = new Date().toISOString();
	let accepted = 0;
	for (const raw of ids) {
		let survivor = byId.get(raw);
		if (survivor === undefined) {
			const candidates = survivors.filter((candidate) => candidate.id.startsWith(raw));
			if (candidates.length > 1) {
				console.error(`ambiguous survivor id ${raw}; use more characters`);
				process.exit(2);
			}
			survivor = candidates[0];
		}
		if (survivor === undefined) {
			console.error(`no current survivor matches id ${raw}`);
			process.exit(2);
		}
		if (ledger.accepted[survivor.fingerprint] !== undefined) continue;
		ledger.accepted[survivor.fingerprint] = {
			subject: survivor.subject,
			kind: survivor.kind,
			before: survivor.before,
			after: survivor.after,
			occurrence: survivor.occurrence,
			acceptedAt: now,
		};
		bySubject.set(survivor.subject, (bySubject.get(survivor.subject) ?? 0) + 1);
		acceptedIds.add(survivor.id);
		acceptedSurvivors.push(survivor);
		accepted++;
	}

	return { accepted, bySubject, ids: acceptedIds, survivors: acceptedSurvivors };
}

function reconcileLedger(ledger: MutationLedger, input: ReconcileInput): void {
	const runId = crypto.randomUUID();
	const coverage = isFullCoverage(input.options) ? "full" : "partial";
	const scope = describeScope(input.options);
	const results = new Map(input.results.map((result) => [result.subject, result]));
	for (const info of input.infos) {
		const result = results.get(info.subject);
		if (result === undefined) continue;
		const acceptedNow = input.acceptedBySubject.get(info.subject) ?? 0;
		const existing = ledger.subjects[info.subject];
		if (existing?.fullCheckedAt !== undefined && coverage === "partial") {
			existing.accepted += acceptedNow;
			existing.todo = Math.max(0, existing.todo - acceptedNow);
			continue;
		}
		ledger.subjects[info.subject] = {
			checkedAt: input.finishedAt,
			lastRunId: runId,
			coverage,
			fullCheckedAt: coverage === "full" ? input.finishedAt : existing?.fullCheckedAt,
			scope,
			viable: info.analysis?.viable.length ?? 0,
			killed: result.killed,
			todo: Math.max(0, result.survivors.length - acceptedNow),
			accepted: result.accepted + acceptedNow,
			compileErrors: result.compileErrors,
			skipped: result.skipped,
			maxTests: input.options.maxTests,
			maxMutants: input.options.maxMutants,
			typecheck: input.options.typecheck,
		};
	}
	let killed = 0;
	let todo = 0;
	let accepted = 0;
	let compileErrors = 0;
	for (const result of input.results) {
		const acceptedNow = input.acceptedBySubject.get(result.subject) ?? 0;
		killed += result.killed;
		todo += Math.max(0, result.survivors.length - acceptedNow);
		accepted += result.accepted + acceptedNow;
		compileErrors += result.compileErrors;
	}
	const run: LedgerRun = {
		id: runId,
		startedAt: input.startedAt,
		finishedAt: input.finishedAt,
		commit: tryGit(["rev-parse", "--short", "HEAD"]),
		dirty: tryGit(["status", "--porcelain", "--untracked-files=no"]) !== "",
		coverage,
		scope,
		maxTests: input.options.maxTests,
		maxMutants: input.options.maxMutants,
		typecheck: input.options.typecheck,
		subjects: input.infos.length,
		killed,
		todo,
		accepted,
		compileErrors,
	};
	ledger.runs.push(run);
	if (ledger.runs.length > LEDGER_RUN_LIMIT) ledger.runs = ledger.runs.slice(-LEDGER_RUN_LIMIT);
	ledger.updatedAt = input.finishedAt;
}

function printLedgerStatus(ledger: MutationLedger, path: string, json: boolean): void {
	const subjects = Object.entries(ledger.subjects).map(([subject, record]) => ({ subject, ...record }));
	const full = subjects.filter((subject) => subject.fullCheckedAt !== undefined).length;
	const partial = subjects.length - full;
	const done = subjects.filter((subject) => subject.todo === 0).length;
	let todo = 0;
	let accepted = 0;
	for (const subject of subjects) {
		todo += subject.todo;
		accepted += subject.accepted;
	}
	const todoSubjects = subjects
		.filter((subject) => subject.todo > 0)
		.toSorted((left, right) => right.todo - left.todo || left.subject.localeCompare(right.subject));
	const lastRun = ledger.runs.at(-1);
	if (json) {
		console.log(
			JSON.stringify(
				{
					ledger: path,
					updatedAt: ledger.updatedAt,
					subjects: { checked: subjects.length, full, partial, done },
					survivors: { todo, accepted },
					todo: todoSubjects.map(({ subject, todo: count, coverage }) => ({ subject, todo: count, coverage })),
					lastRun,
				},
				null,
				2,
			),
		);

		return;
	}
	console.log(`ledger: ${path}`);
	console.log(`updated: ${ledger.updatedAt}`);
	console.log(`subjects checked: ${subjects.length} (full ${full}, partial ${partial}); no todo: ${done}`);
	console.log(`survivors remaining: ${todo}; accepted: ${accepted}`);
	if (subjects.length === 0) console.log("no checked subjects yet; run with --update-ledger");
	if (todoSubjects.length > 0) {
		console.log("\ntodo by subject:");
		for (const subject of todoSubjects.slice(0, 20)) {
			console.log(`  ${String(subject.todo).padStart(4)}  ${subject.subject}  (${subject.coverage})`);
		}
		if (todoSubjects.length > 20) console.log(`  ... ${todoSubjects.length - 20} more`);
	}
	if (lastRun !== undefined) {
		console.log(
			`\nlast run: ${lastRun.finishedAt}  ${lastRun.coverage}  ${lastRun.scope}  killed ${lastRun.killed}, todo ${lastRun.todo}, accepted ${lastRun.accepted}, compile errors ${lastRun.compileErrors}`,
		);
	}
}

function printProgress(result: SubjectResult): void {
	if (result.skipped !== undefined) {
		console.log(`  ${result.subject}  skipped: ${result.skipped}`);

		return;
	}
	const cached = result.cached === 0 ? "" : ` (${result.cached} cached)`;
	console.log(`  ${result.subject}  killed ${result.killed}/${result.tried}${cached}`);
}

function applyAcceptance(summary: Summary, acceptance: { accepted: number; ids: Set<string>; survivors: Survivor[] }): void {
	summary.survived -= acceptance.accepted;
	summary.accepted += acceptance.accepted;
	summary.survivors = summary.survivors.filter((survivor) => !acceptance.ids.has(survivor.id));
	for (const survivor of acceptance.survivors) {
		const stats = summary.byKind[survivor.kind];
		if (stats === undefined) continue;
		stats.survived--;
		stats.accepted++;
	}
	const judged = summary.killed + summary.survived;
	summary.score = judged === 0 ? null : (summary.killed / judged) * 100;
}

function printWhenComplete(result: SubjectResult, info: SubjectInfo, printed: Set<string>, quiet: boolean): void {
	if (quiet) return;
	if (printed.has(info.subject)) return;
	if (result.skipped === undefined && info.taskCount === 0) return;
	if (result.skipped === undefined && result.tried < info.taskCount) return;
	printed.add(info.subject);
	printProgress(result);
}

async function runWorkers(tasks: Task[], infos: SubjectInfo[], context: RunContext, cache: MutationCache): Promise<SubjectResult[]> {
	const results = new Map<string, SubjectResult>();
	for (const info of infos) results.set(info.subject, createResult(info));
	if (tasks.length === 0) return [...results.values()];
	const workerCount = Math.min(context.options.jobs, tasks.length);
	const shared = { tasks, queue: { index: 0 }, results };
	const printed = new Set<string>();
	await Promise.all(
		Array.from({ length: workerCount }, async (_value, index) => {
			await runWorker(index, {
				...shared,
				baselineSandbox: createSandbox(`baseline-${index}`),
				baselineCache: { tests: new Map() },
				cache,
				context,
				printed,
			});
		}),
	);
	for (const info of infos) {
		const result = results.get(info.subject);
		if (result !== undefined) printWhenComplete(result, info, printed, context.options.json);
	}

	return [...results.values()];
}

async function runWorker(id: number, worker: WorkerContext): Promise<void> {
	const sandbox = createSandbox(String(id));
	for (;;) {
		const index = worker.queue.index++;
		const task = worker.tasks[index];
		if (task === undefined) return;
		const result = worker.results.get(task.info.subject);
		if (result === undefined || result.skipped !== undefined) continue;
		const key = cacheKey(task.info, task.mutant, worker.context.environmentHash);
		const cached = worker.cache.entries.get(key);
		if (cached !== undefined) {
			const accepted = worker.context.accepted.has(survivorFingerprint(task.info.subject, task.mutant));
			recordVerdict(result, task.info, task.mutant, cached, { cached: true, accepted });
			printWhenComplete(result, task.info, worker.printed, worker.context.options.json);
			continue;
		}
		const verdict = await judgeMutant(sandbox, worker.baselineSandbox, task, worker.baselineCache, worker.context.options);
		if (verdict.skipReason !== undefined) {
			result.skipped = verdict.skipReason;
			printWhenComplete(result, task.info, worker.printed, worker.context.options.json);
			continue;
		}
		worker.cache.entries.set(key, verdict);
		worker.cache.additions++;
		const accepted = worker.context.accepted.has(survivorFingerprint(task.info.subject, task.mutant));
		recordVerdict(result, task.info, task.mutant, verdict, { cached: false, accepted });
		printWhenComplete(result, task.info, worker.printed, worker.context.options.json);
		maybeSaveCache(worker.cache, worker.context.options);
	}
}

function summarize(results: SubjectResult[], unwatched: string[]): Summary {
	let killed = 0;
	let survived = 0;
	let timedOut = 0;
	let crashed = 0;
	let stillborn = 0;
	let equivalent = 0;
	let cached = 0;
	let compileErrors = 0;
	let accepted = 0;
	const survivors: Survivor[] = [];
	const skipped: Array<{ subject: string; reason: string }> = [];
	const byKind: Record<string, KindStats> = {};
	const files: FileStats[] = [];
	for (const result of results) {
		killed += result.killed;
		timedOut += result.timedOut;
		crashed += result.crashed;
		stillborn += result.stillborn;
		equivalent += result.equivalent;
		cached += result.cached;
		compileErrors += result.compileErrors;
		accepted += result.accepted;
		survived += result.survivors.length;
		for (const survivor of result.survivors) survivors.push(survivor);
		if (result.skipped !== undefined) skipped.push({ subject: result.subject, reason: result.skipped });
		for (const [kind, stats] of Object.entries(result.byKind)) {
			const total = byKind[kind] ?? { killed: 0, survived: 0, accepted: 0, compileErrors: 0 };
			total.killed += stats.killed;
			total.survived += stats.survived;
			total.accepted += stats.accepted;
			total.compileErrors += stats.compileErrors;
			byKind[kind] = total;
		}
		if (result.tried > 0 || result.skipped !== undefined) {
			files.push({ subject: result.subject, killed: result.killed, survived: result.survivors.length, skipped: result.skipped });
		}
	}
	const judged = killed + survived;

	return {
		score: judged === 0 ? null : (killed / judged) * 100,
		killed,
		survived,
		timedOut,
		crashed,
		stillborn,
		equivalent,
		cached,
		compileErrors,
		accepted,
		skipped,
		survivors,
		unwatched,
		byKind,
		files,
	};
}

function printList(tasks: Task[]): void {
	for (const task of tasks) {
		const fingerprint = survivorFingerprint(task.info.subject, task.mutant);
		console.log(
			`[${survivorId(fingerprint)}] ${task.info.subject}:${task.mutant.line}  ${task.mutant.kind}  ${JSON.stringify(task.mutant.before)} -> ${JSON.stringify(task.mutant.after)}`,
		);
	}
	console.log(`\nmutants: ${tasks.length}`);
}

function printPlan(plans: PlanLine[], unwatched: string[]): void {
	let mutants = 0;
	let runs = 0;
	const testFiles = new Set<string>();
	for (const plan of plans) {
		const suffix = plan.skipped === undefined ? "" : `  skipped: ${plan.skipped}`;
		console.log(`  ${plan.subject}  viable ${plan.viable}  selected ${plan.sampled}  tests ${plan.tests.length}${suffix}`);
		mutants += plan.sampled;
		runs += plan.sampled * plan.tests.length;
		for (const test of plan.tests) testFiles.add(test);
	}
	console.log(`\nsubjects with mutants: ${plans.length}; unwatched modules: ${unwatched.length}`);
	console.log(`mutants: ${mutants}; test runs: ${runs} at most; green checks: ${testFiles.size} test files`);
	console.log("each mutant stops at its first killing test, so the real count of test runs is lower");
}

function printReport(summary: Summary): void {
	const score = summary.score === null ? "n/a (no viable mutant was run)" : `${summary.score.toFixed(1)}%`;
	console.log(
		`\nmutation score: ${score} (${summary.killed} killed, ${summary.survived} survived; ${summary.timedOut} timed out, ${summary.crashed} crashed; ${summary.compileErrors} compile errors, ${summary.stillborn} stillborn and ${summary.equivalent} equivalent excluded; ${summary.accepted} accepted, ${summary.cached} cached)`,
	);
	const kinds = Object.entries(summary.byKind).toSorted(([left], [right]) => left.localeCompare(right));
	if (kinds.length > 0) {
		console.log("\nby mutator:");
		for (const [kind, stats] of kinds) {
			console.log(
				`  ${kind}: ${stats.killed} killed, ${stats.survived} survived, ${stats.accepted} accepted, ${stats.compileErrors} compile errors`,
			);
		}
	}
	if (summary.survivors.length === 0) console.log("\nno survivors");
	else {
		console.log(`\nsurvived (${summary.survivors.length}):`);
		for (const survivor of summary.survivors) {
			console.log(
				`  [${survivor.id}] ${survivor.subject}:${survivor.line}  ${survivor.kind}  ${JSON.stringify(survivor.before)} -> ${JSON.stringify(survivor.after)}  (${survivor.tests.length} covering tests)`,
			);
		}
	}
	for (const skip of summary.skipped) console.log(`skipped ${skip.subject}: ${skip.reason}`);
	console.log(`unwatched modules (no test reaches them): ${summary.unwatched.length}`);
}

function planLine(info: SubjectInfo): PlanLine {
	return {
		subject: info.subject,
		viable: info.analysis?.viable.length ?? 0,
		sampled: info.taskCount,
		tests: info.covering,
		skipped: info.skipped,
	};
}

function isTestPath(path: string): boolean {
	return path.endsWith(".test.ts");
}

function isProductionPath(path: string): boolean {
	return path.startsWith(`${SOURCE_ROOT}/`) && !isTestPath(path);
}

restoreLegacyRecovery();
const options = readOptions();
if (options.status) {
	printLedgerStatus(loadLedger(options.ledger), options.ledger, options.json);
	process.exit(0);
}
const diffRanges = readDiffRanges(options);
const filter: MutationFilter = { subject: "", kinds: options.mutators, exclude: options.excludeMutators, ranges: diffRanges };
const files = TEST_ROOTS.flatMap((root) => collectTypeScript(root));
const graph = new Map(files.map((file): [string, string[]] => [file, readLocalImports(file)]));
const reaches: TestReach[] = files.filter((file) => isTestPath(file)).map((path) => ({ path, reached: reachedModules(path, graph) }));
const reachedAll = new Set(reaches.flatMap((reach) => [...reach.reached.keys()]));
const unwatched = files.filter((file) => isProductionPath(file) && !reachedAll.has(file)).toSorted();
const subjects = [...reachedAll]
	.filter((subject) => options.files === undefined || options.files.some((pattern) => subject.includes(pattern)))
	.toSorted();

try {
	if (!(options.plan || options.list) && options.typecheck) options.typecheck = typecheckAvailable();
	const fileHashes = new Map<string, string>();
	const environmentHash = computeEnvironmentHash(options, fileHashes);
	const context: BuildContext = { reaches, graph, filter, options, fileHashes, hashing: !(options.plan || options.list) };
	const infos = buildSubjectInfos(subjects, context);
	const tasks = buildTasks(infos, options);
	if (options.list) {
		const mutants = tasks.map((task) => {
			const fingerprint = survivorFingerprint(task.info.subject, task.mutant);

			return {
				id: survivorId(fingerprint),
				subject: task.info.subject,
				line: task.mutant.line,
				kind: task.mutant.kind,
				before: task.mutant.before,
				after: task.mutant.after,
			};
		});
		if (options.json) console.log(JSON.stringify({ mutants, unwatched }, null, 2));
		else printList(tasks);
	} else if (options.plan) {
		const plans = infos.map((info) => planLine(info)).filter((plan) => plan.viable > 0 || plan.skipped !== undefined);
		if (options.json) console.log(JSON.stringify({ plans, unwatched }, null, 2));
		else printPlan(plans, unwatched);
	} else {
		const ledger = loadLedger(options.ledger);
		const accepted = acceptedSet(ledger);
		const cache = loadCache(options);
		const startedAt = new Date().toISOString();
		const results = await runWorkers(tasks, infos, { options, environmentHash, accepted }, cache);
		const finishedAt = new Date().toISOString();
		const summary = summarize(results, unwatched);
		let acceptedBySubject = new Map<string, number>();
		if (options.acceptIds.length > 0) {
			const acceptance = acceptSurvivors(ledger, summary.survivors, options.acceptIds);
			acceptedBySubject = acceptance.bySubject;
			applyAcceptance(summary, acceptance);
			if (!options.json) console.error(`accepted ${acceptance.accepted} survivor(s) in the ledger; the next run skips them`);
		}
		if (options.json) console.log(JSON.stringify(summary, null, 2));
		else printReport(summary);
		saveCache(cache, options);
		if (options.updateLedger) {
			reconcileLedger(ledger, { infos, results, options, startedAt, finishedAt, acceptedBySubject });
			writeLedger(options.ledger, ledger);
		}
		if (options.threshold !== undefined && summary.score !== null && summary.score < options.threshold) process.exitCode = 1;
		if (options.failOnSurvivors && summary.survived > 0) process.exitCode = 1;
	}
} finally {
	cleanup();
}
