# V5 rejection log

Decision date: `2026-07-20`
Artifact: `traction-post-forecast-v5@5.0.0-research`
Decision: `reject` (`rejected_insufficient_data`)

## Primary gate failure

No platform has compatible rows with both outcome classes in every frozen
training, validation, and final-test split. Consequently no platform model was
selected, calibrated, or evaluated, and company aggregation is unsupported.

## Evidence behind the failure

- zero accepted training sources in the input manifest;
- zero genuinely incorporated sources in the 25-source registry;
- 649 adjacent internal audit candidates, only 127 with changed comparable
  counters, five seven-day candidates, and no 30-day candidates;
- no independent three-period population;
- current company histories are V4-derived circular targets;
- public graph manifest hashes are stale relative to the current graph bytes;
- no local database dump or credentials for append-only metric histories.

## Additional unconditional acceptance blockers

- no registered same-population V4 replay comparison;
- one-standard-error refinement pending;
- full calibration-family comparison pending;
- weekly-query macro evaluation pending;
- reliability-bin, subgroup/fairness, manipulation, and latency gates pending;
- no per-post statistical interval;
- no company-level future target or learned aggregation;
- genuine source-specific research incorporation failed independent review.

## Explicitly rejected shortcuts

The release did not substitute current final totals for historical outcomes,
split duplicate representations randomly, train on V4 score history, infer
missing dates, transfer X parameters to unsupported platforms, add a confidence
heuristic to score, or reintroduce V4's hand-selected coefficients, recency,
post-slot, platform, or cohort blend under a V5 name.

## Required decision to reopen training

A new run requires legally accepted, registry-linked, hashed longitudinal source
artifacts that meet the target/feature overlap and frozen support gates. Any
change to target, periods, features, search, calibration, or acceptance after
final-test access requires a new protocol ID and untouched final test.
