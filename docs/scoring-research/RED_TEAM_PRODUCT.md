# Product and release red-team: Ranked Posts, taxonomies, filters, methodology, and graph legend

**Review date:** 2026-07-20
**Review mode:** independent, read-only implementation review plus focused tests
**Verdict:** **PASS for the product and local release checks within this review's scope**

The core implementation is coherent, the focused automated checks pass, the adversarial filter/URL gaps are now covered, and the required local browser matrix is certified. Ranked Posts, the 25-topic and 50-vertical registries, strict API parsing, canonical client-side filtering, score immutability, current-V4 methodology presentation, graph-edge presentation, responsive behavior, and URL hydration satisfy the reviewed product contract.

This is a product and local release-check PASS, not a deployment, production-host, database, or external-ingestion certification. No external source was contacted and no deployment or database mutation was performed by this review.

## Severity and status

- **P1 — release blocker:** a required gate cannot be completed or a defect can invalidate the release broadly.
- **P2 — material:** a contract is violated or a high-value adversarial path lacks release evidence.
- **P3 — low:** a maintainability or architecture deviation with limited immediate product impact.
- **PASS:** inspected implementation and focused evidence satisfy the reviewed contract.
- **PARTIAL:** source evidence is positive, but one or more required runtime assertions remain unverified.
- **NOT RUN:** the check could not be executed in this review lane; this is not represented as a product pass.
- **CLOSED:** a finding was fixed or its missing release evidence was supplied and rechecked.

## Closed findings and release gates

There are no open product findings within this review's defined scope.

### RTP-01 — P1 — Local live-browser release matrix

**Status:** CLOSED / PASS
**Scope:** responsive layout, keyboard behavior, URL reload, console/network health

The root browser-certification lane completed the local matrix that was unavailable during the first red-team pass. The recorded browser evidence is:

- exact inner widths of **1440 px**, **1024 px**, and **389 px**;
- zero horizontal overflow at every checked width;
- Ranked Posts **Today** empty state with the score-as-of disclosure visible;
- Ranked Posts **All time** showing **50 of 50**, V4 score labels, working native-post links, and deterministic capped results;
- mobile publication metadata, author/topic context, and the native action remaining visible at 389 px;
- Stats methodology and the public `/methodology` presentation;
- copied URL hydration with **two Topics and six Verticals** preserved;
- zero browser console errors and zero console warnings;
- every observed local request returning HTTP 200.

Combined with the source-level keyboard semantics and focused component tests, this closes the responsive, hydration, methodology, console/network, and accessibility release-evidence gate.

### RTP-02 — P2 — Adversarial composed-filter and URL contracts

**Status:** CLOSED / PASS
**Evidence:** `tests/client-filters.test.ts`; `tests/dashboard-filters.test.tsx`; `tests/insights-tabs.test.tsx`; `tests/api/graph-query-validation-route.test.ts`

The residual adversarial set now passes **3 files / 48 tests** (`ranked-posts`, `client-filters`, and `dashboard-filters`). New assertions establish that:

- Platform + Topic + Top Voice constraints must match one physical evidence row rather than separate rows;
- Topic and Vertical visibility filters preserve canonical score, rank, momentum, score breakdown, and radius-driving score surfaces;
- a copied URL preserves and rehydrates two Topics and more than five Verticals without truncation, then resets taxonomy state correctly;
- the searchable Vertical menu wraps by keyboard, handles Escape, and restores trigger focus;
- Ranked Posts eligibility, deterministic ordering, physical dedupe, Today boundaries, and the 50-result cap remain intact.

The complete focused product set was rerun after these additions and passes **10 files / 154 tests**. Together with the certified two-Topic/six-Vertical browser hydration and existing surface-level component coverage, this closes the prior integration-evidence gap.

## Product contract matrix

| Area | Status | Evidence and red-team conclusion |
| --- | --- | --- |
| Ranked Posts tab order and semantics | PASS | `InsightsTabs` declares Overview, Hottest, Ranked Posts, Stats; tab/panel ARIA and ArrowRight/ArrowLeft/Home/End handlers are present. Focused component tests cover selected-state semantics and ArrowRight traversal. |
| Ranked Posts eligibility and physical dedupe | PASS | `src/lib/graph/ranked-posts.ts` uses scoring eligibility and the canonical physical-dedupe path; invalid/rejected/unscored/nonpositive rows are excluded. Unit tests cover company/founder rollup, duplicates, and excluded states. |
| Ranked Posts deterministic order and cap | PASS | Ordering is canonical evidence score descending, raw engagement descending, valid publication time descending, canonical source URL ascending, then stable evidence ID ascending, with a hard cap of 50. Tests cover 50/51 behavior, the full tie-break chain, and shuffled determinism. |
| Today, Central Time | PASS source/test/browser | Today excludes unknown/imprecise or unparseable publication time and uses Central-day boundaries. Tests exercise Central midnight and DST behavior; browser certification confirms the Today empty state and score-as-of disclosure. |
| Ranked score as-of disclosure | PASS | `InsightsTabs.tsx:88,359-362` uses `scoringContext.evidenceAsOf` with `generatedAt` fallback and displays the graph evidence timestamp. |
| Ranked card content/native link | PASS source/browser | Component contains score/model, native link, date, available author, company, topics, and optional verticals. Browser certification confirms 50/50 All time results, V4 labels/native links, and required metadata/native action at 389 px. |
| Exact 25-topic registry | PASS | `src/lib/graph/post-topics.ts` exposes a versioned, typed exact registry; tests assert taxonomy, order, slugs, deterministic normalization, and fallback. |
| Topic classifier evidence rules | PASS | Curated values win; automatic matches use authored visible text/metadata, cap at three, apply negative guards, and fall back to Other. Metric counts are not classifier evidence. Positive/negative and raw-JSON extraction cases are tested. |
| Topic counts and filtering | PASS source/test/browser | `graph-taxonomies` counts canonical physical posts and `client-filters` requires platform/topic/top-voice constraints on the same evidence row. Adversarial tests and two-Topic browser hydration pass. |
| Exact 50-vertical registry | PASS | `src/lib/graph/company-verticals.ts` defines exact typed/versioned slugs/order; tests validate exact membership and deterministic classification. |
| Vertical classification | PASS | Explicit/override classifications precede deterministic trusted-metadata inference; inferred output is capped at five; unclassified stays internal. Curated override values now live in a dedicated small data module. |
| All 50 filter options and counts | PASS source/test | UI renders the registry, supports search, disables zero-count entries, and now preserves more than five explicit user-selected filters instead of applying the inference cap. |
| OR within category / AND across categories | PASS source/test/browser | `applyClientGraphFilters` implements category OR and cross-category AND; the same-row Platform + Topic + Top Voice adversarial test and composed browser hydration pass. |
| URL state, stable normalization, invalid browser values | PASS source/test/browser | Dashboard parses only recognized slugs, canonicalizes arrays, writes `topics`/`verticals`, and ignores invalid browser values. Tests and copied-URL browser hydration preserve two Topics and six Verticals. |
| Strict API query contract | PASS | Route uses a strict schema, structured 400 errors, stable typed normalization, repetition/empty/max checks, and `no-store`. Focused route tests cover invalid and canonical Topic/Vertical query values. |
| No taxonomy refetch/recompute | PASS source/test | Topic/Vertical changes filter the cached graph locally and do not enter ordinary scope-fetch requests; Dashboard component tests exercise local composition. |
| Score/rank/momentum immutability | PASS source/test | Filter output preserves canonical graph score surfaces and only projects visibility/evidence. Platform and taxonomy adversarial tests assert canonical score, rank, momentum, breakdown, and radius-driving fields. |
| Current V4 methodology | PASS | Shared `ScoringMethodology` presents the temporary V4 baseline and config-derived evidence, recency, slot, platform, calibration, and confidence rules; it states the index is not a probability or company-quality judgment. |
| Public methodology parity | PASS | `/methodology` renders the shared `ScoringMethodology` component instead of maintaining an independent formula. |
| V5 fail-closed status | PASS | Production routes/UI do not import the offline V5 prediction pipeline. V5 remains unpromoted and unscored; unsupported states are not silently represented as zero. |
| Graph-edge legend contract | PASS | `GraphEdgeLegend` lists only present relationship types, uses keyboard-native details/summary, and describes relationship meaning rather than score. Shared `edge-presentation` colors/styles drive both legend and Cytoscape. |
| Legend formula/color parity | PASS | Industry affinity copy matches the 75/25 graph-builder calculation; solid/dashed/dotted style and actual edge colors are shared with rendering code. Component tests pass. |
| Accessibility | PASS source/test/browser | Semantic tabs, native controls, labels, focus logic, status text, details/summary, keyboard wrapping, Escape, and focus restoration are covered. Browser certification found no console warnings/errors in the checked interactions. |
| Responsive layout | PASS source/browser | CSS has explicit narrow layouts, retains required Ranked Posts metadata/native link, and drops only optional vertical chips/thumbnail. Browser certification records zero overflow at 1440/1024/389 inner widths. |
| Stale production weight search | PASS | Executable config, migration, methodology presentation, `SCORING_MODEL`, V4 audit, and V4 final report agree on normalized available-platform weights. The targeted retired-description search is clean outside explicitly labeled historical explanation. |

## Resolved during the red-team cycle

The following problems were observed early, reported, fixed by the implementation lane, and rechecked. They are not open findings:

1. **Current V4 calculation was absent from the shared methodology.** The methodology now renders config-derived evidence, recency, slot, platform, batch-calibration, and confidence details, while clearly labeling V4 as the temporary production baseline and V5 as unpromoted.
2. **The public methodology page could drift from the dashboard.** `/methodology` now renders the shared methodology component.
3. **Ranked Posts omitted a score-as-of timestamp.** The tab now displays the graph evidence timestamp in Central time context.
4. **The mobile native-post link disappeared with the thumbnail.** The explicit open-link column now remains visible in the narrow layout and was browser-verified at 389 px.
5. **UI/URL vertical selections above five were silently truncated.** Dashboard normalization now uses the complete 50-entry registry for explicit selections; the five-label cap remains confined to inference.
6. **A synchronous state update in an effect failed focused lint.** State clearing moved into event transitions; focused lint now exits successfully.
7. **Mobile Ranked Posts hid required date, author, and topics.** Narrow layouts now preserve those fields and hide only optional vertical chips; the explicit native-post link also remains visible.
8. **Curated company-vertical overrides were inline with classifier logic.** The values now live in the dedicated data-only `company-vertical-overrides.ts` module and retain typed validation at the classifier boundary.
9. **Canonical V4 documents retained contradictory aggregation prose.** `SCORING_MODEL`, the V4 audit, and the V4 final report now consistently describe configured weights normalized over eligible available platforms; the retired 70/30 description remains only as clearly labeled superseded history.

## Focused verification executed

### Automated product tests

```text
vitest run
  tests/ranked-posts.test.ts
  tests/post-topics.test.ts
  tests/company-verticals.test.ts
  tests/graph-taxonomies.test.ts
  tests/client-filters.test.ts
  tests/dashboard-filters.test.tsx
  tests/insights-tabs.test.tsx
  tests/api/graph-query-validation-route.test.ts
  tests/scoring-presentation.test.ts
  tests/graph-edge-legend.test.tsx
```

**Result:** PASS — 10 files, 154 tests.

### Residual adversarial product tests

```text
vitest run
  tests/ranked-posts.test.ts
  tests/client-filters.test.ts
  tests/dashboard-filters.test.tsx
```

**Result:** PASS — 3 files, 48 tests.

### Certified local browser matrix

The root browser-certification lane exercised the application at exact inner widths of 1440, 1024, and 389 pixels.

**Result:** PASS — zero horizontal overflow; Today empty state and score-as-of present; All time shows 50/50 V4-ranked posts with native links; mobile metadata and native action remain available; dashboard Stats and public methodology render; two Topics and six Verticals survive copied-URL hydration; zero console errors/warnings; all observed local requests returned 200.

### Type checking

```text
tsc --noEmit
```

**Result:** PASS — exit 0, no diagnostics.

### Focused lint

Focused ESLint was run over Dashboard, InsightsTabs, ScoringMethodology, GraphEdgeLegend, CytoscapeGraph, graph API/page/methodology routes, taxonomy/filter/ranking/legend libraries, and scoring presentation.

**Result:** PASS — exit 0, no diagnostics.

### Static graph cutoff audit

A read-only scan of the nine `public/graph/*.json` graph-shaped artifacts found:

```json
{"graphs":9,"evidence":3426,"observationsAfterGraphEvidenceAsOf":0,"graphsMissingCutoff":0}
```

This supports the committed-artifact cutoff contract. It does not prove dynamic live-overlay or network behavior.

### Not executed by this review lane

- complete repository test suite;
- production build;
- repository-wide `check:release` or publication workflow;
- live ingestion, external source requests, deployment, or database mutation.

Those omissions must not be read as passes. They are outside this product/local-browser red-team certification, and other release lanes may supply independent evidence for them.

## Release recommendation

The reviewed product and local release checks pass. RTP-01 and RTP-02 are closed: the responsive/browser matrix is certified, and the residual adversarial filter/URL coverage passes.

This report supports advancing the UI through the next release stage. It does **not** certify deployment, a production host, live database state, external-source availability, or ingestion execution. Those activities retain their own gates and authorization boundaries.

Preserve the browser observations and automated test output with the release evidence so the scoped PASS remains reproducible.
