/**
 * forbidden-content.mjs — belt-over-suspenders content sweep.
 *
 * schema/result.v1.json already forbids hostname/path/username FIELDS by
 * omission (additionalProperties: false, no such property declared anywhere
 * in the schema). This module is the second, independent layer: it scans the
 * serialized JSON *content* (every string value, not just key names) for
 * hostname-like, path-like, and username-like substrings, so a value smuggled
 * into an otherwise-legal field (e.g. someone hand-edits `hardware.label` to
 * "ran on jsmith-laptop.local") still gets caught even though the schema has
 * no way to know that particular string is a hostname.
 *
 * Deliberately coarse — false positives here are cheap (a human just renames
 * a label), false negatives are the thing we're actually defending against.
 */

const PATH_PATTERNS = [
  { name: "unix home path", re: /\/(Users|home|root)\// },
  { name: "windows user path", re: /[A-Za-z]:\\\\?Users\\\\?/i },
  { name: "windows drive path", re: /[A-Za-z]:\\[A-Za-z0-9_.\\-]+\\/ },
  { name: "multi-segment absolute path", re: /(?:^|[^a-zA-Z0-9_./-])\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_./-]+/ },
  { name: "home-relative path", re: /~\/[a-zA-Z0-9_./-]+/ },
];

const HOSTNAME_PATTERNS = [
  { name: "local/lan/internal hostname suffix", re: /\b[a-zA-Z0-9-]+\.(local|lan|internal|corp|home)\b/i },
  { name: "IPv4 address", re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/ },
];

const USERNAME_PATTERNS = [
  { name: "env-style username assignment", re: /\b(USER|USERNAME|LOGNAME)=/ },
  { name: "whoami output reference", re: /\bwhoami\b/i },
];

// Forbidden field/key names — redundant with the schema's additionalProperties:
// false, but checked independently here in case a schema is ever loaded loosely
// (e.g. a future version regresses strictness) or validation is skipped.
const FORBIDDEN_KEYS = ["hostname", "username", "userinfo", "homedir", "cwd"];

function collectStrings(value, out) {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      collectStrings(v, out);
    }
  }
  return out;
}

/**
 * Sweeps a parsed result document for forbidden content.
 * @param {unknown} doc parsed JSON
 * @returns {string[]} human-readable violation messages; empty = clean
 */
export function sweepForbiddenContent(doc) {
  const violations = [];
  const strings = collectStrings(doc, []);

  for (const s of strings) {
    const lower = s.toLowerCase();
    for (const key of FORBIDDEN_KEYS) {
      if (lower === key) {
        violations.push(`forbidden key/value present: "${s}"`);
      }
    }
    for (const { name, re } of PATH_PATTERNS) {
      if (re.test(s)) violations.push(`path-like content (${name}) in value: "${s}"`);
    }
    for (const { name, re } of HOSTNAME_PATTERNS) {
      if (re.test(s)) violations.push(`hostname-like content (${name}) in value: "${s}"`);
    }
    for (const { name, re } of USERNAME_PATTERNS) {
      if (re.test(s)) violations.push(`username-like content (${name}) in value: "${s}"`);
    }
  }

  return violations;
}
