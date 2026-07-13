#!/usr/bin/env node
/**
 * check-schema-sync.mjs — .github/workflows/schema-sync.yml's logic
 * (push-to-main only; never runs on PRs).
 *
 * flair-bench doesn't ship a dedicated JSON Schema file — the closest
 * published artifact describing its --share output shape is the "Share
 * schema" section of its own README (a documented JSON example), which ships
 * inside the npm tarball. This script:
 *
 *   1. Looks up @tpsdev-ai/flair-bench on the npm registry (public read, no
 *      auth). If it 404s — expected right now: flair-bench merged to main
 *      but no release has been cut yet — this is a NEUTRAL SKIP, not a
 *      failure: log it plainly and exit 0. This workflow arms itself
 *      automatically the day the first release publishes; no one needs to
 *      remember to come back and turn it on.
 *   2. If found, downloads the tarball for the latest published version,
 *      extracts its README.md, and pulls out the "Share schema" fenced
 *      example.
 *   3. Structurally compares that example's key set (recursively, per
 *      object) against schema/result.v1.json's declared properties (with
 *      $ref to $defs.stat resolved). This is a best-effort, key-presence-only
 *      diff — it can't check field types (the README example isn't a formal
 *      schema), but it WILL catch an added/removed/renamed field, which is
 *      the drift that actually matters here (schema/ is meant to byte-match
 *      the tool's real output shape).
 *   4. Any drift fails the job loudly with the specific path that changed.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const PACKAGE_NAME = "@tpsdev-ai/flair-bench";
const REGISTRY = "https://registry.npmjs.org";

async function fetchRegistryMetadata() {
  const url = `${REGISTRY}/${encodeURIComponent(PACKAGE_NAME).replace("%40", "@")}`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`registry lookup failed: ${res.status} ${res.statusText}`);
  return res.json();
}

function extractShareSchemaBlock(readmeText) {
  const heading = readmeText.indexOf("## Share schema");
  if (heading === -1) throw new Error('README has no "## Share schema" section — flair-bench README structure changed upstream');
  const fenceStart = readmeText.indexOf("```", heading);
  const fenceContentStart = readmeText.indexOf("\n", fenceStart) + 1;
  const fenceEnd = readmeText.indexOf("```", fenceContentStart);
  if (fenceStart === -1 || fenceEnd === -1) throw new Error('"## Share schema" section has no fenced code block — flair-bench README structure changed upstream');
  return readmeText.slice(fenceContentStart, fenceEnd);
}

function parseJsoncExample(block) {
  // The README's example uses a bare "…" ellipsis placeholder for stubbed
  // nested objects (e.g. perKind's per-kind entries) — not valid JSON on its
  // own. Replace "{ … }" with "{}" so it parses; this loses the STUBBED
  // sub-object's own keys (acceptable: perKind's kind-keys are still visible,
  // and the full stat shape is separately visible via the fully-spelled-out
  // "aggregate" example).
  const jsonish = block.replace(/\{\s*…\s*\}/g, "{}");
  return JSON.parse(jsonish);
}

/** Reduces a value to a nested "key set" tree: objects -> {key: subtree}, everything else -> null. */
function keyTree(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = keyTree(v);
    return out;
  }
  return null;
}

/**
 * The README's example stubs each perKind entry with a bare "…" (parsed as
 * "{}" above), since it already spells the identical shape out in full via
 * "aggregate" (AggregateStat and PerKindStat are the same shape in
 * types.ts — Record<QueryKind, PerKindStat> literally reuses it). Without
 * this, every run would report a false "n/p3/mrr missing from README" drift
 * under every perKind entry, which isn't real drift — it's the doc's own
 * elision. Backfill each stubbed perKind entry from the real aggregate shape
 * before diffing.
 */
function backfillPerKindFromAggregate(readmeTree) {
  const agg = readmeTree?.results?.aggregate;
  const perKind = readmeTree?.results?.perKind;
  if (!agg || !perKind) return readmeTree;
  for (const kind of Object.keys(perKind)) {
    if (perKind[kind] && Object.keys(perKind[kind]).length === 0) {
      perKind[kind] = { ...agg };
    }
  }
  return readmeTree;
}

/** Same reduction, but walking a JSON-Schema node (resolving $ref against $defs) instead of a value. */
function schemaKeyTree(node, defs) {
  if (node?.$ref) {
    const refName = node.$ref.split("/").pop();
    return schemaKeyTree(defs[refName], defs);
  }
  if (node?.type === "object" && node.properties) {
    const out = {};
    for (const [k, v] of Object.entries(node.properties)) out[k] = schemaKeyTree(v, defs);
    return out;
  }
  return null;
}

function diffTrees(readmeTree, schemaTree, path, drift) {
  if (readmeTree === null || schemaTree === null) return;
  const readmeKeys = new Set(Object.keys(readmeTree));
  const schemaKeys = new Set(Object.keys(schemaTree));
  for (const k of readmeKeys) {
    if (!schemaKeys.has(k)) drift.push(`${path}${k}: present in flair-bench's published README example, missing from schema/result.v1.json`);
  }
  for (const k of schemaKeys) {
    if (!readmeKeys.has(k)) drift.push(`${path}${k}: required by schema/result.v1.json, absent from flair-bench's published README example`);
  }
  for (const k of readmeKeys) {
    if (schemaKeys.has(k)) diffTrees(readmeTree[k], schemaTree[k], `${path}${k}.`, drift);
  }
}

async function main() {
  const meta = await fetchRegistryMetadata();
  if (meta === null) {
    console.log(
      `[schema-sync] ${PACKAGE_NAME} is not yet published to npm (registry 404) — neutral skip.\n` +
        `[schema-sync] This is expected today: flair-bench merged to tpsdev-ai/flair main but no release has been cut.\n` +
        `[schema-sync] Nothing to do here — this check arms itself automatically once the first version publishes.`,
    );
    return;
  }

  const latest = meta["dist-tags"]?.latest;
  const tarballUrl = meta.versions?.[latest]?.dist?.tarball;
  if (!latest || !tarballUrl) throw new Error(`registry metadata for ${PACKAGE_NAME} is missing dist-tags.latest or its tarball URL`);

  console.log(`[schema-sync] ${PACKAGE_NAME}@${latest} is published — checking schema/result.v1.json against its README's Share schema example.`);

  const workDir = mkdtempSync(join(tmpdir(), "flair-bench-schema-sync-"));
  try {
    const tarballPath = join(workDir, "package.tgz");
    execFileSync("npm", ["pack", `${PACKAGE_NAME}@${latest}`, "--registry", REGISTRY, "--pack-destination", workDir], { stdio: "inherit" });
    // npm pack names the file deterministically; find it rather than assume.
    const packed = execFileSync("sh", ["-c", `ls "${workDir}"/*.tgz`], { encoding: "utf8" }).trim();
    execFileSync("tar", ["-xzf", packed, "-C", workDir], { stdio: "inherit" });
    void tarballPath;

    const readmeText = readFileSync(join(workDir, "package", "README.md"), "utf8");
    const block = extractShareSchemaBlock(readmeText);
    const example = parseJsoncExample(block);
    const readmeTree = backfillPerKindFromAggregate(keyTree(example));

    const schema = JSON.parse(readFileSync(join(REPO_ROOT, "schema", "result.v1.json"), "utf8"));
    const schemaTree = schemaKeyTree(schema, schema.$defs ?? {});

    const drift = [];
    diffTrees(readmeTree, schemaTree, "", drift);

    if (drift.length > 0) {
      console.error(`[schema-sync] DRIFT DETECTED between ${PACKAGE_NAME}@${latest}'s published shape and schema/result.v1.json:\n`);
      for (const d of drift) console.error(`  - ${d}`);
      console.error(`\n[schema-sync] Add a new schema/result.vN.json + schema/versions.json entry (additive-only — do not edit result.v1.json).`);
      process.exit(1);
    }

    console.log(`[schema-sync] OK — schema/result.v1.json matches ${PACKAGE_NAME}@${latest}'s published shape.`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`[schema-sync] error: ${err.stack ?? err.message}`);
  process.exit(1);
});
