# flair-benchmarks

Benchmark results for Flair's embedding recall instrument. This repo is the submission and provenance layer for [`@tpsdev-ai/flair-bench`](https://github.com/tpsdev-ai/flair/tree/main/packages/flair-bench) — the standalone CLI that measures embedding-model recall (precision@3, MRR) for [Flair](https://github.com/tpsdev-ai/flair)'s use case on real hardware. Every result under `results/` is a machine that actually ran the benchmark, submitted as a PR.

## What this is for

`flair-bench` answers "would a different embedding model/quant actually recall better *for Flair's use case*, on *my* hardware?" This repo is where the answers accumulate: a model × infra matrix built entirely from submitted, schema-validated, redacted result files — no central server, no telemetry, no accounts. A PR is the only way data gets in here.

## How to submit a result

1. Run the benchmark with `--share`:
   ```bash
   npx @tpsdev-ai/flair-bench run --model-file /path/to/model.gguf --label "your-host-label" --share
   ```
   `--label` is a freeform string you choose to identify your hardware/infra (e.g. `"local-m4-mini"`, `"fabric-gpu-a"`) — never your machine's real hostname. See the [flair-bench README](https://github.com/tpsdev-ai/flair/tree/main/packages/flair-bench#--label-benchmarking-infra-not-just-models) for the full privacy contract: the tool never writes a hostname, filesystem path, or username into the share file.

2. Rename the written file to the naming convention (see below) and place it under `results/`.

3. Validate it locally before opening a PR (optional but saves a round trip):
   ```bash
   npm ci
   git diff --name-only origin/main > /tmp/changed.txt   # or list your new file(s) directly
   node scripts/validate-results.mjs --changed-files /tmp/changed.txt
   ```

4. Open a PR that touches **only** file(s) under `results/**/*.json`. `.github/workflows/validate.yml` runs automatically and checks:
   - the PR touches nothing outside `results/**/*.json` (schema/workflow/doc changes ride separate maintainer review, not this bot)
   - the file is ≤ 64KB
   - it validates against the schema selected by its own `toolVersion` field (`schema/versions.json` → `schema/result.v*.json`)
   - its path matches the naming convention below, and matches the path derivable from its own content
   - it contains no hostname-like, path-like, or username-like strings (a second, independent layer on top of the schema's own `additionalProperties: false` — see `schema/result.v1.json` and `scripts/lib/forbidden-content.mjs`)

   Green check + maintainer review = merge.

## Naming convention

```
results/<model-slug>/<host-label>/<utc-iso>.json
```

- `<model-slug>` — the share document's `model.name`, lowercased, slugified (`nomic-embed-text-v1.5` → `nomic-embed-text-v1-5`)
- `<host-label>` — the share document's `hardware.label`, lowercased, slugified
- `<utc-iso>` — the share document's `timestamp`, with `:` and `.` replaced by `-` (filesystem-hostile characters), e.g. `2026-07-13T14:05:22.123Z` → `2026-07-13T14-05-22-123Z`

`scripts/lib/naming.mjs` is the single source of truth for this convention (used by both the CI gate and anyone submitting locally).

## What the numbers mean — and a caveat

Each result reports precision@3 and MRR, aggregate and per query-kind (`stress`/`trap`/`hard`/`clean` — see flair-bench's README for what those mean), plus ms/embed (serial, warm), peak RSS delta, and the host that produced it.

**Model-pure caveat**: `flair-bench` scores by **exact cosine similarity** against every corpus record — it has no HNSW approximate index and no BM25 lexical fusion. Flair's production `/SemanticSearch` path uses Harper's HNSW index and (per the recall-quality roadmap) BM25 hybrid fusion on top of the embedding. A number here isolates **the embedding model itself**; it is not a prediction of end-to-end production recall, which depends on the surrounding retrieval pipeline too. Treat these results as "which model is the best foundation," not "what recall will I get in prod."

## Review and merge flow

- Anyone can open a submission PR (results-only, per the naming convention above).
- `.github/workflows/validate.yml` is the automated gate for submissions.
- Anything touching `schema/`, `.github/workflows/`, or this README goes through ordinary maintainer review — it's out of scope for the automated results gate by design.
- `.github/workflows/schema-sync.yml` runs on every push to `main` and checks `schema/` against whatever `@tpsdev-ai/flair-bench` has most recently published to npm, failing loudly on drift (neutral no-op today — see the workflow's own comments — since flair-bench hasn't had a release cut yet).

## Where this data is used

The accumulated `results/` matrix is the data source for the (upcoming) benchmark matrix site and an agent-queryable MCP surface — both read straight from this repo's `results/` directory; there's no separate database to keep in sync.

## Repo layout

```
schema/
  result.v1.json     JSON Schema (draft 2020-12), strict, derived from flair-bench's ShareDocument
  versions.json      toolVersion -> schema file discriminator map (additive-only)
scripts/
  validate-results.mjs     the PR gate's logic (also runnable locally)
  check-schema-sync.mjs    the push-to-main schema-drift check
  lib/
    forbidden-content.mjs  hostname/path/username content sweep
    naming.mjs              the results/<model-slug>/<host-label>/<utc-iso>.json convention
results/
  <model-slug>/<host-label>/<utc-iso>.json   submitted results
```
