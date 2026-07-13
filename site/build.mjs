#!/usr/bin/env node
/**
 * site/build.mjs — static build for the benchmark matrix site
 * (bench.tps.dev, deployed by .github/workflows/deploy-pages.yml).
 *
 * Reads every results/**\/*.json, schema-validates each one (the same
 * ajv-strict validator scripts/validate-results.mjs uses: schema/versions.json
 * picks schema/result.v*.json by the document's own toolVersion), and
 * skip-and-warns on anything invalid rather than crashing the build — a
 * malformed/legacy result file must never take the site down. Valid results
 * are aggregated into a model x host matrix and rendered as a single static
 * site/dist/index.html. No client framework, no client-side JS: the per-row
 * "per-kind breakdown" uses native <details>/<summary>.
 *
 * Usage: node site/build.mjs
 * Env:
 *   GITHUB_SHA   commit SHA to build blob-URL links against (falls back to
 *                the "main" branch ref for local/dev runs).
 */
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const RESULTS_DIR = join(REPO_ROOT, "results");
const SCHEMA_DIR = join(REPO_ROOT, "schema");
const DIST_DIR = join(__dirname, "dist");

const REPO_OWNER = "tpsdev-ai";
const REPO_NAME = "flair-benchmarks";
const REPO_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}`;
const REF = process.env.GITHUB_SHA || "main";
const CUSTOM_DOMAIN = "bench.tps.dev";

// Kern's requirement, verbatim — a banner, not a footnote. Do not reword.
const KERN_BANNER =
  "These are model-pure recall numbers (exact cosine, no BM25 hybrid). " +
  "Production-configured recall may differ — see the flair-bench README.";

const KIND_ORDER = ["stress", "trap", "hard", "clean"];

function pathExists(p) {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function walk(dir) {
  let out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(walk(p));
    else if (entry.isFile() && entry.name.endsWith(".json")) out.push(p);
  }
  return out;
}

function loadJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

/** Returns a `(toolVersion) => ajv-validate-fn-or-null` closure, schema-cached. */
function buildValidatorLookup() {
  const versions = loadJson(join(SCHEMA_DIR, "versions.json"));
  const ajv = new Ajv2020.default({ strict: true, allErrors: true });
  addFormats.default(ajv);
  const cache = new Map();
  return (toolVersion) => {
    const schemaFile = versions[toolVersion];
    if (!schemaFile) return null;
    let v = cache.get(schemaFile);
    if (!v) {
      const schema = loadJson(join(SCHEMA_DIR, schemaFile));
      v = ajv.compile(schema);
      cache.set(schemaFile, v);
    }
    return v;
  };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function pct(n) {
  return `${(n * 100).toFixed(1)}%`;
}

/** Reads + schema-validates every results/**\/*.json. Bad files are warned and dropped, never fatal. */
function collectResults() {
  const lookupValidator = buildValidatorLookup();
  const files = pathExists(RESULTS_DIR) ? walk(RESULTS_DIR) : [];
  const entries = [];

  for (const absPath of files.sort()) {
    const relPath = relative(REPO_ROOT, absPath).split(sep).join("/");
    const segs = relPath.split("/");
    // results/<model-slug>/<host-label>/<file>.json — the naming convention
    // (scripts/lib/naming.mjs) is the source of truth for slug/label, so we
    // read them from the path rather than trusting content that a future
    // schema revision might make optional.
    if (segs.length !== 4 || segs[0] !== "results") {
      console.warn(`[site/build] skip: "${relPath}" does not match results/<model-slug>/<host-label>/<file>.json`);
      continue;
    }
    const [, modelSlug, hostLabel] = segs;

    let doc;
    try {
      doc = loadJson(absPath);
    } catch (e) {
      console.warn(`[site/build] skip: "${relPath}" is not valid JSON — ${e.message}`);
      continue;
    }

    const validate = lookupValidator(doc?.toolVersion);
    if (!validate) {
      console.warn(
        `[site/build] skip: "${relPath}" toolVersion "${doc?.toolVersion}" has no entry in schema/versions.json`,
      );
      continue;
    }
    if (!validate(doc)) {
      const msg = (validate.errors ?? []).map((e) => `${e.instancePath || "/"}: ${e.message}`).join("; ");
      console.warn(`[site/build] skip: "${relPath}" failed schema validation — ${msg}`);
      continue;
    }

    entries.push({ relPath, modelSlug, hostLabel, doc });
  }

  return entries;
}

/**
 * Groups entries into a model(slug+quant) x host matrix. Multiple submissions
 * for the same (model+quant, host) collapse to the latest by timestamp, with
 * a count of how many were folded in.
 */
function aggregate(entries) {
  const groups = new Map(); // "modelSlug::quant::hostLabel" -> entry[]
  for (const e of entries) {
    const quant = e.doc?.model?.quant ?? "unknown";
    const key = `${e.modelSlug}::${quant}::${e.hostLabel}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  const rowMeta = new Map(); // "modelSlug::quant" -> { modelSlug, quant, modelName }
  const cells = new Map(); // "modelSlug::quant" -> Map(hostLabel -> { latest, count })
  const hostLabels = new Set();

  for (const [key, list] of groups) {
    list.sort((a, b) => (a.doc.timestamp < b.doc.timestamp ? 1 : a.doc.timestamp > b.doc.timestamp ? -1 : 0));
    const latest = list[0];
    const [modelSlug, quant, hostLabel] = key.split("::");
    const rowKey = `${modelSlug}::${quant}`;

    if (!rowMeta.has(rowKey)) {
      rowMeta.set(rowKey, { modelSlug, quant, modelName: latest.doc.model.name });
    }
    if (!cells.has(rowKey)) cells.set(rowKey, new Map());
    cells.get(rowKey).set(hostLabel, { latest, count: list.length });
    hostLabels.add(hostLabel);
  }

  const rowKeys = [...rowMeta.keys()].sort((a, b) => {
    const ra = rowMeta.get(a);
    const rb = rowMeta.get(b);
    if (ra.modelSlug !== rb.modelSlug) return ra.modelSlug < rb.modelSlug ? -1 : 1;
    if (ra.quant !== rb.quant) return ra.quant < rb.quant ? -1 : 1;
    return 0;
  });
  const hosts = [...hostLabels].sort();

  return { rowKeys, rowMeta, cells, hosts };
}

function blobUrl(relPath) {
  return `${REPO_URL}/blob/${REF}/${relPath}`;
}

function renderCell(cellData) {
  if (!cellData) return `<td class="cell empty">—</td>`;
  const { latest, count } = cellData;
  const r = latest.doc.results;
  const hw = latest.doc.hardware;
  const url = blobUrl(latest.relPath);
  const countNote = count > 1 ? `<div class="muted small">${count} submissions — latest shown</div>` : "";
  return `<td class="cell">
      <div class="metric"><span class="label">p@3</span>${pct(r.aggregate.p3)}</div>
      <div class="metric"><span class="label">MRR</span>${pct(r.aggregate.mrr)}</div>
      <div class="metric"><span class="label">ms/embed</span>${r.msPerEmbedSerialWarm.toFixed(2)}</div>
      <div class="metric"><span class="label">peak RSS</span>${r.peakRssMiB.toFixed(1)} MiB</div>
      <div class="metric"><span class="label">backend</span>${escapeHtml(hw.backend)}</div>
      ${countNote}
      <a class="raw-link" href="${url}">raw JSON</a>
    </td>`;
}

function renderPerKindDetails(hostCells, hosts) {
  const sections = hosts
    .filter((h) => hostCells.has(h))
    .map((h) => {
      const { latest } = hostCells.get(h);
      const perKind = latest.doc.results.perKind;
      const trs = KIND_ORDER.map((k) => {
        const s = perKind[k];
        return `<tr><td>${k}</td><td>${s.n}</td><td>${pct(s.p3)}</td><td>${pct(s.mrr)}</td></tr>`;
      }).join("");
      return `<div class="host-breakdown">
          <div class="host-name">${escapeHtml(h)}</div>
          <table class="kind-table">
            <thead><tr><th>kind</th><th>n</th><th>p@3</th><th>MRR</th></tr></thead>
            <tbody>${trs}</tbody>
          </table>
        </div>`;
    })
    .join("");
  return `<details>
      <summary>Per-kind MRR breakdown</summary>
      ${sections}
    </details>`;
}

function renderRow(rowKey, rowMeta, cells, hosts) {
  const meta = rowMeta.get(rowKey);
  const hostCells = cells.get(rowKey) ?? new Map();
  const cellsHtml = hosts.map((h) => renderCell(hostCells.get(h))).join("\n");
  const detailsHtml = renderPerKindDetails(hostCells, hosts);
  return `<tr>
      <th scope="row">${escapeHtml(meta.modelName)} <span class="quant">${escapeHtml(meta.quant)}</span></th>
      ${cellsHtml}
    </tr>
    <tr class="details-row"><td colspan="${hosts.length + 1}">${detailsHtml}</td></tr>`;
}

function renderPage(agg, validCount) {
  const { rowKeys, rowMeta, cells, hosts } = agg;
  const generatedAt = new Date().toISOString();
  const colCount = (hosts.length || 1) + 1;
  const theadHosts = hosts.length
    ? hosts.map((h) => `<th scope="col">${escapeHtml(h)}</th>`).join("")
    : `<th scope="col">host</th>`;
  const bodyRows = rowKeys.length
    ? rowKeys.map((rk) => renderRow(rk, rowMeta, cells, hosts)).join("\n")
    : `<tr><td colspan="${colCount}">No valid results yet — see README for how to submit.</td></tr>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>flair-bench matrix</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    max-width: 1100px;
    margin: 2.5rem auto;
    padding: 0 1.25rem;
    line-height: 1.5;
    color: #1a1a1a;
    background: #fff;
  }
  a { color: #0555b1; }
  @media (prefers-color-scheme: dark) {
    body { color: #e6e6e6; background: #14161a; }
    .banner { background: #2a2410; border-color: #6b5b17; color: #f2dd8a; }
    th, td { border-color: #333; }
    a { color: #7db8ff; }
    .muted { color: #999; }
    thead th { background: rgba(255,255,255,0.06); }
    code { background: rgba(255,255,255,0.12); }
  }
  h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
  .subtitle { color: #666; margin-top: 0; }
  .banner {
    background: #fff8e1;
    border: 1px solid #e0c34a;
    color: #6b5b17;
    padding: 0.75rem 1rem;
    border-radius: 6px;
    margin: 1.25rem 0;
    font-size: 0.95rem;
  }
  .table-wrap { overflow-x: auto; margin: 1.5rem 0; }
  table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
  th, td { border: 1px solid #ddd; padding: 0.5rem 0.6rem; vertical-align: top; text-align: left; }
  thead th { background: rgba(127,127,127,0.08); }
  .quant { color: #888; font-weight: normal; font-size: 0.85em; }
  .metric { white-space: nowrap; }
  .metric .label { color: #888; display: inline-block; min-width: 5.5em; }
  .muted { color: #777; }
  .small { font-size: 0.8em; }
  .raw-link { display: inline-block; margin-top: 0.35rem; font-size: 0.85em; }
  .cell.empty { text-align: center; color: #999; }
  .details-row td { border-top: none; padding-top: 0; }
  details { margin: 0.25rem 0; }
  summary { cursor: pointer; color: #555; }
  .host-breakdown { margin: 0.5rem 0 0.75rem 0.5rem; }
  .host-name { font-weight: 600; font-size: 0.85em; margin-bottom: 0.25rem; }
  .kind-table { font-size: 0.85em; width: auto; }
  footer { margin-top: 2.5rem; padding-top: 1rem; border-top: 1px solid #ddd; color: #777; font-size: 0.85rem; }
  footer p { margin: 0.35rem 0; }
  code { background: rgba(127,127,127,0.15); padding: 0.1em 0.35em; border-radius: 4px; }
</style>
</head>
<body>
  <h1>flair-bench matrix</h1>
  <p class="subtitle">Embedding-model recall benchmarks for <a href="https://github.com/tpsdev-ai/flair">Flair</a>, submitted from real hardware.</p>
  <div class="banner">${escapeHtml(KERN_BANNER)}</div>
  <div class="table-wrap">
    <table>
      <thead><tr><th scope="col">model</th>${theadHosts}</tr></thead>
      <tbody>
        ${bodyRows}
      </tbody>
    </table>
  </div>
  <footer>
    <p>Submit your numbers: run <code>flair-bench --share</code>, PR the JSON — see <a href="${REPO_URL}#how-to-submit-a-result">README</a>.</p>
    <p><a href="${REPO_URL}">${REPO_OWNER}/${REPO_NAME}</a> · generated ${escapeHtml(generatedAt)} · ${validCount} result${validCount === 1 ? "" : "s"}</p>
  </footer>
</body>
</html>
`;
}

function main() {
  const entries = collectResults();
  const agg = aggregate(entries);
  const html = renderPage(agg, entries.length);

  mkdirSync(DIST_DIR, { recursive: true });
  writeFileSync(join(DIST_DIR, "index.html"), html, "utf8");
  writeFileSync(join(DIST_DIR, "CNAME"), `${CUSTOM_DOMAIN}\n`, "utf8");

  console.log(
    `[site/build] wrote ${join(DIST_DIR, "index.html")} — ${entries.length} valid result(s), ` +
      `${agg.rowKeys.length} row(s), ${agg.hosts.length} host column(s).`,
  );
}

main();
