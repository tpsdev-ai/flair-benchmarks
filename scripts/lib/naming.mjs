/**
 * naming.mjs — the results/<model-slug>/<host-label>/<utc-iso>.json convention.
 *
 * Both the CI gate (validate-results.mjs) and the seed submission use this
 * module, so the convention is defined exactly once.
 */

export function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** "2026-07-13T14:05:22.123Z" -> "2026-07-13T14-05-22-123Z" (colon/dot are filesystem-hostile). */
export function utcIsoForFilename(isoTimestamp) {
  return String(isoTimestamp).replace(/:/g, "-").replace(/\./g, "-");
}

export const FILENAME_RE =
  /^results\/([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9]+(?:-[a-z0-9]+)*)\/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.json$/;

/**
 * Derives the canonical path for a parsed share document.
 * @param {any} doc parsed result JSON (must already be schema-valid)
 * @returns {string} e.g. "results/nomic-embed-text-v1-5/rockit-m4/2026-07-13T14-05-22-123Z.json"
 */
export function canonicalPath(doc) {
  const modelSlug = slugify(doc.model.name);
  const hostLabel = slugify(doc.hardware.label ?? "");
  const ts = utcIsoForFilename(doc.timestamp);
  return `results/${modelSlug}/${hostLabel}/${ts}.json`;
}

/**
 * Checks a repo-relative file path against the naming convention AND against
 * the document it actually contains (not just the shape of the path).
 * @returns {string[]} violation messages; empty = clean
 */
export function checkNaming(repoRelativePath, doc) {
  const violations = [];
  const m = FILENAME_RE.exec(repoRelativePath);
  if (!m) {
    violations.push(
      `path "${repoRelativePath}" does not match results/<model-slug>/<host-label>/<utc-iso>.json`,
    );
    return violations;
  }
  if (!doc?.hardware?.label) {
    violations.push(`"${repoRelativePath}": document has no hardware.label, but the naming convention requires a host-label path segment`);
    return violations;
  }
  const expected = canonicalPath(doc);
  if (expected !== repoRelativePath) {
    violations.push(`"${repoRelativePath}" does not match the path derived from its own content: expected "${expected}"`);
  }
  return violations;
}
