/**
 * The copy/paste budget (1% duplicated lines), measured twice: `.jscpd.json` over all of src/ with
 * tests, at a coarse grain, and `.jscpd.strict.json` over production code only, at a fine grain.
 * `node:child_process` with literal commands is the form knip reads, so it sees the jscpd binary in use.
 */
import { spawnSync } from "node:child_process";

const all = spawnSync("jscpd", ["--config", ".jscpd.json"], { stdio: "inherit" });
const production = spawnSync("jscpd", ["--config", ".jscpd.strict.json"], { stdio: "inherit" });

process.exitCode = all.status === 0 && production.status === 0 ? 0 : 1;
