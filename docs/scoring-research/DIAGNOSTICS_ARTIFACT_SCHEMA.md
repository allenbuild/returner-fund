# Scoring diagnostics artifact schema

`docs/outputs/scoring-diagnostics-v4-audit.json` keeps the v4 model audit name but uses
schema version 5 after the next intentional regeneration. The schema is release-safe:
the audit still evaluates the complete local corpus, computes every aggregate, runs every
invariant, and hashes the full input envelope before repetitive row-level detail is bounded.

## Authoritative data

The following remain complete rather than sampled:

- model identity, methodology, input file hashes, config-leaf hashes, and source-role hashes;
- global and cohort aggregate counts, distributions, concentration measures, perturbation
  summaries, and largest-change summaries;
- invariant observations and every invariant result;
- compact lists that are naturally bounded, such as input files, config parameters, cohorts,
  platforms, top-ten rows, and invariant checks.

Aggregate count fields are authoritative. Consumers must not infer a total from the length of
a repetitive detail array when that array has a matching retention descriptor.

## Bounded detail

Repetitive diagnostic arrays longer than 32 records are replaced by at most 32 deterministic
examples. Selection first covers distinct diagnostic signatures (for example issue, reason,
platform, direction, owner scope, and change direction), then fills remaining slots with
evenly spaced records in stable source order.

`metadata.detail_retention` records the policy and one descriptor for every bounded array:

| Field | Meaning |
| --- | --- |
| `json_pointer` | RFC 6901-style pointer to the retained example array |
| `total_count` | Full pre-bounding record count |
| `retained_count` | Number of emitted examples |
| `omitted_count` | `total_count - retained_count` |
| `diagnostic_signature_count` | Distinct signatures in the full collection |
| `retained_signature_count` | Distinct signatures represented by examples |
| `full_collection_sha256` | SHA-256 of canonical JSON for the complete pre-bounding array |
| `retained_examples_sha256` | Recomputable SHA-256 of the emitted examples |

The retention object also commits to its descriptor list with
`collection_manifest_sha256` and to every full-array count/digest tuple with
`full_detail_sha256`. Nested detail is safe: a parent collection digest is taken before any
nested array is bounded, while its retained-example digest is taken after nested bounding.

## Release limit and failure behavior

The pretty-printed tracked JSON has a hard ceiling of 48 MiB (`50,331,648` bytes), comfortably
below the repository's 75 MiB artifact policy and GitHub's 100 MiB per-file rejection limit.
Serialization validates every retained pointer, count, and digest, then fails before either
output is written if the audit exceeds the ceiling. The limit and the 32-example cap cannot be
raised by generator options.

Focused verification:

```bash
npm run test:scoring:audit:v4
```

The test regenerates into temporary paths, confirms the checked-in outputs were not mutated,
checks all original audit invariants, validates aggregate-to-full-detail counts before
bounding, validates the retention manifest after bounding, and enforces the byte ceiling.
