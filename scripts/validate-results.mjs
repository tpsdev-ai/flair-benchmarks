#!/usr/bin/env node
/**
 * validate-results.mjs — the PR gate's actual logic (invoked by
 * .github/workflows/validate.yml; also runnable locally before opening a
 * submission PR).
 *
 * Enforces, in order:
 *   1. every changed file in the PR is under results/**\/*.json — anything
 *      else (workflows/, schema/, README, ...) fails loudly here; those ride
 *      separate human review instead of this bot.
 *   2. each changed results/**\/*.json is <= 64KB.
 *   3. its toolVersion resolves to a known schema (schema/versions.json),
 *      and it validates strictly (additionalProperties: false) against that
 *      schema (ajv-strict).
 *   4. its path matches the results/<model-slug>/<host-label>/<utc-iso>.json
 *      convention AND matches the path derivable from its own content
 *      (scripts/lib/naming.mjs).
 *   5. the forbidden-content sweep (scripts/lib/forbidden-content.mjs) finds
 *      no hostname-like/path-like/username-like strings.
 *
 * Usage:
 *   node scripts/validate-results.mjs --changed-files <path-to-newline-list>
 *   node scripts/validate-results.mjs <file1> <file2> ...   (ad-hoc/local)
 */
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { sweepForbiddenContent } from "./lib/forbidden-content.mjs";
import { checkNaming } from "./lib/naming.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const MAX_BYTES = 64 * 1024;
const RESULTS_PATH_RE = /^results\/.+\.json$/;

function parseArgs(argv) {
  const args = argv.slice(2);
  const idx = args.indexOf("--changed-files");
  if (idx !== -1) {
    const listPath = args[idx + 1];
    if (!listPath) throw new Error("--changed-files requires a path");
    const text = readFileSync(listPath, "utf8");
    return text.split("\n").map((l) => l.trim()).filter(Boolean);
  }
  return args;
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function main() {
  const changedFiles = parseArgs(process.argv);
  const errors = [];

  if (changedFiles.length === 0) {
    console.error("No changed files supplied — nothing to validate.");
    process.exit(1);
  }

  // Gate 1: scope. Every changed path must be results/**/*.json.
  const outOfScope = changedFiles.filter((f) => !RESULTS_PATH_RE.test(f));
  if (outOfScope.length > 0) {
    errors.push(
      [
        "This PR touches file(s) outside results/**/*.json:",
        ...outOfScope.map((f) => `  - ${f}`),
        "",
        "This workflow is the submission gate for benchmark results only.",
        "Changes to workflows/, schema/, README.md, or anything else outside",
        "results/ do not go through this automated check — they need human",
        "(K&S / maintainer) review instead. If this is a results-only",
        "submission, double check you haven't picked up unrelated changes.",
      ].join("\n"),
    );
  }

  const resultFiles = changedFiles.filter((f) => RESULTS_PATH_RE.test(f));
  const versions = loadJson(join(REPO_ROOT, "schema", "versions.json"));

  const ajv = new Ajv2020.default({ strict: true, allErrors: true });
  addFormats.default(ajv);
  const schemaCache = new Map();

  for (const relPath of resultFiles) {
    const absPath = join(REPO_ROOT, relPath);

    let stat;
    try {
      stat = statSync(absPath);
    } catch {
      errors.push(`"${relPath}": file does not exist (was it deleted? this gate only validates additions/changes)`);
      continue;
    }
    if (stat.size > MAX_BYTES) {
      errors.push(`"${relPath}": ${stat.size} bytes exceeds the ${MAX_BYTES}-byte (64KB) cap`);
      continue;
    }

    let doc;
    try {
      doc = loadJson(absPath);
    } catch (e) {
      errors.push(`"${relPath}": not valid JSON — ${e.message}`);
      continue;
    }

    const toolVersion = doc?.toolVersion;
    const schemaFile = versions[toolVersion];
    if (!schemaFile) {
      errors.push(
        `"${relPath}": toolVersion "${toolVersion}" has no entry in schema/versions.json — ` +
          `add a mapping (and a new schema/result.vN.json if the shape actually changed) in a separate PR before this can validate`,
      );
      continue;
    }

    let validate = schemaCache.get(schemaFile);
    if (!validate) {
      const schema = loadJson(join(REPO_ROOT, "schema", schemaFile));
      validate = ajv.compile(schema);
      schemaCache.set(schemaFile, validate);
    }

    if (!validate(doc)) {
      for (const err of validate.errors ?? []) {
        errors.push(`"${relPath}": schema violation at ${err.instancePath || "/"}: ${err.message}`);
      }
      continue;
    }

    for (const msg of checkNaming(relPath, doc)) {
      errors.push(`"${relPath}": ${msg}`);
    }

    for (const msg of sweepForbiddenContent(doc)) {
      errors.push(`"${relPath}": forbidden-content sweep: ${msg}`);
    }
  }

  if (errors.length > 0) {
    console.error("validate-results: FAILED\n");
    for (const e of errors) console.error(e + "\n");
    process.exit(1);
  }

  console.log(`validate-results: OK — ${resultFiles.length} result file(s) validated.`);
}

main();
