# Scoring v5 offline pipeline

This lane is deliberately network-free. Register and hash source artifacts before running it.
The default manifest contains no accepted rows and therefore emits an honest
`rejected_insufficient_data` result.

Pinned runtime: Node.js 24.14.0, UTC, `en-US`, CPU only. From the repository root:

```sh
npm run scoring:research:validate
npm run scoring:v5:validate
npm run scoring:v5:pipeline
npm run scoring:v5:parity
npm run scoring:v5:audit
```

`scoring:v5:pipeline` performs canonical conversion, dataset construction,
split assignment, labeling, candidate training, validation-only
selection/calibration, final-test evaluation, and a second byte-identity run.
It writes all seven outputs into a sibling staging directory, validates them,
then swaps the complete directory into place. An ordinary write or swap failure
leaves the previous artifact set in place or restores it; partial mixed sets are
never published. `scoring:v5:reproduce` is the same full offline operation under
an explicit reproduction-oriented command name.

Use `--manifest=...`, `--output=...`, `--model-version=5.x.y`, or
`--validate-only`. The runner computes `codeRevision` as a deterministic SHA-256
over its executable modules and every `src/lib/scoring/v5/*.ts` source byte. An
optional `--code-revision=sha256:...` assertion must match that computed value.
Validation recomputes the snapshot and rejects stale generated artifacts. Source paths in the input manifest
are resolved relative to that manifest. The runner hashes `package-lock.json`,
verifies every accepted source hash and license declaration, runs the full
pipeline twice, requires byte identity, then exports JSON artifacts.

Before building or validating, the runner inspects and requires the pinned
Node.js `24.14.0`, active `UTC` timezone, and default `en-US` locale. If `TZ` is
unset it configures the process to `UTC`; an explicitly conflicting environment
fails closed. `--validate-only` freshly executes the complete double run and
byte-compares every checked-in generated artifact, including the reproduction
report, rather than trusting embedded hashes or metadata.

The runner also cross-checks every accepted input ID and citation against
`docs/scoring-research/source-registry.json`. A registry entry must have the
explicit `accepted_dataset` decision, `incorporation.state = implemented`, and
nonempty implementation evidence. Conditional sources and self-declared input
manifests cannot authorize training.

The target is protocol `returner-post-performance-v5-prereg-2026-07-20`:
training-only nearest-rank q80 of `log1p(t1 counter) - log1p(t0 counter)`, with
strict `growth > q80` labels. Social horizons are seven days and GitHub is 28
days. Split assignment uses t0 and the frozen prospective Central-time periods;
the deterministic SHA-256 entity holdout is excluded from fitting/calibration.

The current implementation intentionally cannot pass the production gate. It
exports validation-selected nonnegative logistic research candidates, but
blocks acceptance until the registered V4 replay comparison, one-standard-error
selection refinement, and full calibration-family comparison are implemented.
The default artifacts therefore remain an explicit insufficient-data rejection.
