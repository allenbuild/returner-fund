# Scoring v4 Source and Pipeline Audit

## Scope, evidence levels, and conclusion

This audit covers the current working tree's source discovery, identity, ingestion, validation, persistence, history, scoring, API/cache, and UI paths. It reads code, migrations, checked-in source snapshots, coverage and discovery reports, the live-refresh stage log, benchmark stores, the daily workflow, and all nine generated graph JSON files.

The audit itself did **not** add an account, source, evidence row, score, migration, benchmark, or graph snapshot. It did not run a source collector, a refresh POST, a database migration, or a workflow. Notes embedded in existing snapshots that say rows were "added" describe earlier source-hunt work, not this audit.

Evidence in this document uses four levels:

| Level | Meaning |
| --- | --- |
| Verified local runtime | Observed from a read-only in-memory build or HTTP GET against the already-running local app during this audit |
| Checked-in artifact | Present in a JSON/report file; proves what was recorded, not that the remote source is reachable now |
| Code support | Implemented by the current working tree and, where noted, covered by tests; does not prove deployment or credentials |
| Verified live access | A remote source or database was contacted successfully during this audit |

No remote social platform, YC directory, GitHub API, Supabase project, or GitHub Actions run received a live request during this audit. Therefore this document makes **no verified-live-access claim** for those systems. Existing timestamps and stage logs are historical local evidence only.

**Post-audit consistency update:** Concurrent work continued after the point-in-time observations below. The later integrity pass made external A16Z Top Voice attention company-owned, kept LinkedIn comments/activity fragments context-only, hardened verified-account parsing and native attribution proof, preserved fresh lower/zero live corrections, rebuilt live score surfaces atomically, and removed the client filter's server-only benchmark import. Historical failure details remain below as chronology, but they are superseded as current-state claims. The settled-worktree release evidence belongs in [`SCORING_V4_FINAL_REPORT.md`](./SCORING_V4_FINAL_REPORT.md), not in this point-in-time source audit.

The material conclusions are:

1. The current graph code builds `returner-traction` v`4.0.0` in memory for 339 companies and 4,074 cohort-scoped input rows. A temporary client/server import regression made every local graph/home request return HTTP 500 during this audit; the later fix removed that browser import, and the recorded final production smoke returned HTTP 200 for all three cohorts and the home page. Returned eligible evidence counts were 1,976, 362, and 245 for S2026, S26, and A16ZSR006.
2. Runtime persistence is still JSON-first. The database migrations define a much stronger source, metric-history, and score-lineage architecture, and migration 007 now registers the canonical v4 model, but no application worker writes that model end to end and no live database application was verified.
3. `/api/ingest/batch` is not the production source pipeline. Its demo mode returns deterministic seed data; database mode records only run/batch metadata and then intentionally fails because real adapters are not wired.
4. `/api/graph/refresh` is a separate path. Its only real-time collector is public X; every other requested platform is reported as `adapter_not_wired`. It appends accepted rows to `targeted-evidence-current.json` and then rebuilds or overlays a graph.
5. Static graph snapshots are accepted only after the shared canonical v4 contract validates model identity, all-platform scope, score breakdowns, evidence references, ranking surfaces, timestamps, and requested batch/audience identity. The browser falls back to the API when a static file fails validation and starts an API revalidation after any accepted static response; the refresh route likewise rebuilds dynamically when its stricter static fast-path checks fail.
6. Coverage is broad but uneven. X dominates S2026 scored evidence; LinkedIn leads S26 and A16ZSR006. Instagram and company/founder account identity are especially sparse in both YC cohorts. TikTok, Bluesky, and Bilibili have no materialized evidence in any current cohort. The detailed tables below are the earlier 2,013/367/245 scored-row snapshot; after attribution/comment hardening, the recorded current totals are 1,976/362/245.

## Dependency map

```text
remote/public pages and manual seeds
  -> discovery attempts and source paths
  -> company/founder IDs plus verified social accounts
  -> standalone collectors or manual/static evidence snapshots
  -> batch/identity/attribution/review/link/native-URL validation
  -> JSON source snapshots (actual runtime source of truth)
  -> entity and physical-post dedupe
  -> v4 evidence normalization, platform aggregation, company calibration
  -> benchmark JSON history and generated graph JSON publication
  -> dynamic /api/graph plus process-local cache and optional live X overlay
  -> Dashboard static-first load, API background replacement, client filters
```

| Stage | Current implementation and dependency | Actual output / handoff | Boundary |
| --- | --- | --- | --- |
| Discovery | YC directory collector, broad public collector, GitHub collector, logged-in OpenCLI collector, targeted/manual source hunts, and A16Z profile/account seed script | YC snapshots; account snapshots; evidence snapshots; [`outputs/discovery-attempts-current.json`](../outputs/discovery-attempts-current.json); [`outputs/source-discovery-paths-current.json`](../outputs/source-discovery-paths-current.json) | Several real network scripts exist, but none was live-smoked here. The connector registry is not the same thing as the collectors that produced the snapshots. |
| Identity | Official YC/A16Z profile links, [`verified-social-overrides.json`](../src/lib/social/verified-social-overrides.json), A16Z hard-coded `SOCIAL_ACCOUNTS`, founder profile links, review states, and match reasons | `CompanyRecord` / `FounderRecord` IDs and parsed `SocialAccountSummary` rows | Account URLs must yield a non-generic platform identity; nested LinkedIn admin/about/posts/activity routes do not become handles. A `verified` row is still an identity assertion, not proof that the account is reachable now. |
| Ingestion | Standalone scripts write JSON; `/api/graph/refresh` can append live X rows; `/api/ingest/batch` is demo/run-metadata only | `public-evidence-current.json`, `logged-in-evidence-current.json`, `targeted-evidence-current.json`, three GitHub snapshots, A16Z seed snapshots | There is no unified durable ingestion worker. The two APIs named "ingest" and "refresh" do different work. |
| Validation | Batch/entity allowlists, review state, verified-account parsing, native-proof attribution guard, comment/context policy, strict native-object URL/ID eligibility, canonicalization, and dedupe | Eligible v4 rows and zero-score context/excluded rows | Generated labels/provenance do not prove attribution; external A16Z attention stays company-owned; comment parent IDs/metrics never become company traction. Review rejection, link invalidity, upstream exclusion, and scoring eligibility rejection remain distinct counters. |
| Persistence | Current runtime imports JSON at module load. Migrations 001-007 define normalized database storage and v4 lineage | JSON files today; database schema only as code support | Migration presence does not prove it is applied. No current writer populates `evidence_items` plus `metric_observations` plus versioned score runs end to end. |
| History | Three active benchmark stores append daily/weekly leaderboard snapshots; live source JSON retains only a merged latest row | [`outputs/benchmarks/`](../outputs/benchmarks/) | Benchmark history is score/rank history, not append-only metric history. |
| Scoring | Dataset assembly -> entity/physical dedupe -> `normalizeEvidenceScores` -> platform slots -> cross-platform aggregate -> batch company calibration | Current `CompanyRecord`, `FounderRecord`, and graph response | One canonical all-platform company score and rank are preserved through platform and Top Voice visibility filters. See [`SCORING_V4_AUDIT.md`](./SCORING_V4_AUDIT.md). |
| API/cache | `GET /api/graph` builds/sanitizes v4, attaches benchmark momentum, overlays persisted live X rows, and stores a 60-second process-local response cache | No-store HTTP JSON | HTTP is no-store, but server computation is cached in memory by filters, local day, benchmark version, and live-evidence version. Cache is not shared across hosts. |
| UI | [`Dashboard.tsx`](../src/components/Dashboard.tsx) fetches `/graph/*.json` first for unfiltered cohorts, validates the canonical contract, and revalidates accepted static responses through `/api/graph`; filters are often applied client-side | Interactive graph, leaderboard, evidence, and refresh UI | Invalid or mismatched static files fall back to the API. Accepted base and Top Voice static files both trigger background API revalidation. |

## Source inventory

### Cohort and account sources

| Source | Recorded time | Recorded inventory | Runtime use |
| --- | --- | --- | --- |
| [`spring-2026-companies.json`](../src/lib/yc/spring-2026-companies.json) | `2026-06-27T21:39:28.548Z` | expected 197, observed 197 | S2026, labeled YC Spring 2026 (P26) |
| [`summer-2026-companies.json`](../src/lib/yc/summer-2026-companies.json) | `2026-07-09T16:58:00.374Z` | expected 83, observed 83 | S26, labeled YC Summer 2026 (S26) |
| [`github-traction.json`](../src/lib/social/github-traction.json) | `2026-06-28T03:03:16.422Z` | 43 targets, 42 fetched; 6 explicit and 44 discovered candidates recorded | Legacy S2026 GitHub input |
| [`github-traction-summer-2026.json`](../src/lib/social/github-traction-summer-2026.json) | `2026-07-09T16:58:01.691Z` | 15 explicit targets, 14 fetched | S26 GitHub input |
| [`github-traction-a16z-speedrun-006.json`](../src/lib/social/github-traction-a16z-speedrun-006.json) | `2026-07-10T06:56:16.353Z` | 17 targets, 16 fetched; 20 discovered candidates, 80 searches | A16ZSR006 GitHub input |
| [`a16z-speedrun-006-social-accounts.json`](../src/lib/social/a16z-speedrun-006-social-accounts.json) | `2026-07-11T00:00:00.000Z` | 59 companies; 116 company-account rows; 212 founder-account rows | A16Z identity input. Company accounts originate in a hard-coded list; founder links originate on A16Z founder profiles. |

The GitHub discovery counters are not additive unique-account counts. For example, S2026 records 6 explicit targets and 44 website-discovered candidates but stores 43 target account rows after matching/dedupe.

### Evidence sources

| Snapshot | Recorded time | Rows and state | Important scope |
| --- | --- | --- | --- |
| [`public-evidence-current.json`](../src/lib/social/public-evidence-current.json) | `2026-07-09T17:31:59.583Z` | 1,021 evidence, 994 review candidates, 2,549 failures; 140 positive upstream flags and 881 zero | Broad collector is hard-wired to `summer-2026-companies.json`, despite merged checkpoint content spanning 281 company slugs. |
| [`logged-in-evidence-current.json`](../src/lib/social/logged-in-evidence-current.json) | `2026-07-09T17:58:46.209Z` | 2,546 evidence, 328 attempt-failure rows; 2,524 verified and 22 `needs_review`; 2,485 positive flags | Opt-in OpenCLI browser source. Metadata says 120 targets fetched and 0 target-level failures, which is a different counter from the 328 attempt-failure rows. LinkedIn requires both `--platforms=linkedin` and `--allow-linkedin`. Snapshot existence does not prove a session is still valid. |
| [`targeted-evidence-current.json`](../src/lib/social/targeted-evidence-current.json) | fetched `2026-07-16T19:17:20.770Z`; content generation/cleanup `2026-07-16T02:18:38.478Z` | 468 verified positive rows, 1 separate review candidate; cleanup metadata says 532 before, 467 after, 65 removed, then the file contains 468 | Manual/source-hunt evidence plus any accepted live-refresh X rows. `fetchedAt` can advance independently from the earlier import/cleanup metadata. |
| [`a16z-speedrun-006-social-evidence.json`](../src/lib/social/a16z-speedrun-006-social-evidence.json) | `2026-07-16T02:18:38.478Z` | 251 verified seed rows; cleanup 254 before, 251 after, 3 removed, 150 platform IDs backfilled | Static/manual A16Z evidence. Dataset assembly assigns normalized contribution; the raw file's contribution flags are not the final score count. |

Raw snapshot platform/failure inventory:

| Snapshot | Evidence rows by platform | Failures by platform |
| --- | --- | --- |
| Public | web 773; YouTube 78; HN 50; LinkedIn 49; RSS 39; X 32 | X 839; Product Hunt 443; Reddit 281; Instagram 257; HN 250; YouTube 220; LinkedIn 166; web 90; RSS 3 |
| Logged-in | X 2,158; LinkedIn 302; Instagram 86 | X 224; Instagram 61; LinkedIn 43 |
| Targeted | LinkedIn 179; X 166; GitHub 49; YouTube 41; HN 21; Product Hunt 9; Instagram 2; Reddit 1 | none stored |
| A16Z seed | Instagram 68; LinkedIn 62; YouTube 50; X 38; GitHub 18; Reddit 10; Product Hunt 5 | none stored |

Link-state inventory before cohort assembly is also uneven. Public has 762 verified, 49 unchecked, 49 blocked, 7 invalid, and 154 missing links. Logged-in has 36 verified and 2,510 missing. Targeted has 427 verified, 9 stored as `valid`, and 32 missing. Current cohort assembly removes or zeroes rows according to its own batch, attribution, review, link, and scoring rules, so raw-source totals must not be used as graph totals.

### Discovery and refresh evidence

[`outputs/discovery-attempts-current.json`](../outputs/discovery-attempts-current.json) contains 1,243 attempts from `2026-06-28T07:56:32.613Z` through `2026-07-09T17:31:59.583Z`: 36 success, 10 partial success, 23 needs review, 433 skipped, and 741 failed. The source split is 841 `public_connector`, 397 `yc_profile_social_links`, and 5 missing-social searches. Platform attempt counts are Product Hunt 400, Instagram 260, web 97, X 95, and 86 each for HN, Reddit, RSS, and YouTube, plus 47 LinkedIn.

[`outputs/source-discovery-paths-current.json`](../outputs/source-discovery-paths-current.json) contains 89 company-only paths over the same date range: 88 `needs_review` and 1 verified. They cover LinkedIn 48, X 27, YouTube 9, Instagram 4, and Reddit 1. These are candidates/paths, not automatically accepted account additions.

[`outputs/ingestion-refresh-stage-log-current.json`](../outputs/ingestion-refresh-stage-log-current.json) is evidence of one earlier X refresh run generated at `2026-07-15T06:51:51.115Z`, not a live result from this audit. Its 150 stages are: 49 requests sent, 49 received, 49 dropped, 1 parsed, 1 task created, and 1 stored summary whose count is zero. Drop reasons are 41 `top_voice_post_missing_company_mention` and 8 `no_status_ids`.

## Audit-snapshot v4 coverage and staleness

These tables come from a read-only in-memory build at `2026-07-17T01:25:23.786Z`. They reconciled exactly with the frozen v4 diagnostic artifact generated at `2026-07-16T12:00:00.000Z` at that point. Later native-proof attribution and LinkedIn comment fixes changed scored/returned evidence, so the tables are retained as an audit snapshot rather than present-worktree counts. The latest recorded summary is in Sections 3.3 and 13.1 of [`SCORING_V4_FINAL_REPORT.md`](./SCORING_V4_FINAL_REPORT.md).

Definitions:

- `account rows/entities/missing` counts materialized `SocialAccountSummary` rows, distinct entities with at least one row on that platform, and cohort entities with none on that platform.
- `evidence all/scored/excluded` counts materialized rows and uses final `contributionScore > 0` for scored.
- `companies scored/missing` uses positive final company `platformScores[platform]`.
- Check freshness uses the latest available value per row across `metricsCheckedAt`, `last_checked_at`, `observedAt`, `linkCheckedAt`, `last_updated_at`, and `first_seen_at`. The table shows the oldest and newest such checks and their age at audit time. This is observation/check staleness, not publication age.
- Platforms omitted from a cohort table have zero account rows and zero evidence rows. Bilibili, TikTok, and Bluesky are zero in all three cohorts.

### Cohort totals

| Batch | Companies | Founders | Company account rows | Founder account rows | Evidence all/scored/excluded | Companies positive/zero | Needs-review queue | Evidence as of |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| S2026 | 197 | 397 | 320 | 637 | 3,273 / 2,013 / 1,260 | 176 / 21 | 891 | `2026-07-16T19:17:20.770Z` |
| S26 | 83 | 165 | 139 | 263 | 548 / 367 / 181 | 68 / 15 | 103 | `2026-07-16T02:16:53.074Z` |
| A16ZSR006 | 59 | 128 | 116 | 212 | 253 / 245 / 8 | 54 / 5 | 0 | `2026-07-16T02:18:38.478Z` |

### S2026 coverage

| Platform | Company accounts rows/entities/missing | Founder accounts rows/entities/missing | Evidence all/scored/excluded | Companies scored/missing | Founder entities scored | Oldest -> newest check (age days) |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| GitHub | 6 / 6 / 191 | 0 / 0 / 397 | 211 / 92 / 119 | 24 / 173 | 0 | `2026-06-28T03:03:16.422Z` -> `2026-07-16T02:16:53.074Z` (18.93 -> 0.96) |
| X | 125 / 125 / 72 | 242 / 242 / 155 | 1,979 / 1,658 / 321 | 143 / 54 | 176 | `2026-06-28T18:03:53.742Z` -> `2026-07-16T19:17:20.770Z` (18.31 -> 0.26) |
| LinkedIn | 176 / 176 / 21 | 394 / 394 / 3 | 136 / 103 / 33 | 80 / 117 | 62 | `2026-06-27T23:59:53.446Z` -> `2026-07-16T01:50:22.000Z` (19.06 -> 0.98) |
| Instagram | 13 / 13 / 184 | 1 / 1 / 396 | 62 / 62 / 0 | 3 / 194 | 1 | `2026-06-29T02:30:19.374Z` -> `2026-06-30T15:32:58.187Z` (17.95 -> 16.41) |
| Product Hunt | 0 / 0 / 197 | 0 / 0 / 397 | 5 / 3 / 2 | 2 / 195 | 0 | `2026-07-15T22:30:00.000Z` -> `2026-07-16T02:16:53.074Z` (1.12 -> 0.96) |
| YouTube | 0 / 0 / 197 | 0 / 0 / 397 | 82 / 76 / 6 | 63 / 134 | 2 | `2026-06-27T23:59:53.446Z` -> `2026-07-16T02:02:15.000Z` (19.06 -> 0.97) |
| RSS | 0 / 0 / 197 | 0 / 0 / 397 | 20 / 0 / 20 | 0 / 197 | 0 | `2026-06-30T06:54:27.957Z` -> `2026-06-30T07:11:57.952Z` (16.77 -> 16.76) |
| web | 0 / 0 / 197 | 0 / 0 / 397 | 759 / 0 / 759 | 0 / 197 | 0 | `2026-06-27T23:59:53.446Z` -> `2026-06-30T09:33:50.379Z` (19.06 -> 16.66) |
| Reddit | 0 / 0 / 197 | 0 / 0 / 397 | 1 / 1 / 0 | 1 / 196 | 0 | `2026-07-16T02:02:15.000Z` (0.97) |
| Hacker News | 0 / 0 / 197 | 0 / 0 / 397 | 18 / 18 / 0 | 18 / 179 | 0 | `2026-06-30T07:09:54.742Z` -> `2026-07-16T00:05:00.000Z` (16.76 -> 1.06) |

### S26 coverage

| Platform | Company accounts rows/entities/missing | Founder accounts rows/entities/missing | Evidence all/scored/excluded | Companies scored/missing | Founder entities scored | Oldest -> newest check (age days) |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| GitHub | 16 / 16 / 67 | 1 / 1 / 164 | 82 / 56 / 26 | 15 / 68 | 0 | `2026-07-09T16:58:01.691Z` -> `2026-07-16T02:16:53.074Z` (7.35 -> 0.96) |
| X | 46 / 46 / 37 | 98 / 98 / 67 | 273 / 224 / 49 | 29 / 54 | 32 | `2026-07-09T17:12:01.891Z` -> `2026-07-15T23:59:00.000Z` (7.34 -> 1.06) |
| LinkedIn | 77 / 77 / 6 | 164 / 164 / 1 | 143 / 67 / 76 | 45 / 38 | 34 | `2026-07-09T17:12:01.891Z` -> `2026-07-16T01:50:22.000Z` (7.34 -> 0.98) |
| Product Hunt | 0 / 0 / 83 | 0 / 0 / 165 | 4 / 1 / 3 | 1 / 82 | 0 | `2026-07-15T22:30:00.000Z` -> `2026-07-15T23:59:00.000Z` (1.12 -> 1.06) |
| YouTube | 0 / 0 / 83 | 0 / 0 / 165 | 16 / 16 / 0 | 9 / 74 | 0 | `2026-07-09T17:31:59.583Z` -> `2026-07-16T02:02:15.000Z` (7.33 -> 0.97) |
| RSS | 0 / 0 / 83 | 0 / 0 / 165 | 19 / 0 / 19 | 0 / 83 | 0 | `2026-07-09T17:31:59.583Z` (7.33) |
| web | 0 / 0 / 83 | 0 / 0 / 165 | 7 / 0 / 7 | 0 / 83 | 0 | `2026-07-09T17:31:59.583Z` (7.33) |
| Hacker News | 0 / 0 / 83 | 0 / 0 / 165 | 4 / 3 / 1 | 3 / 80 | 0 | `2026-07-15T23:45:00.000Z` -> `2026-07-16T00:05:00.000Z` (1.07 -> 1.06) |

S26 has no Instagram or Reddit evidence at all.

### A16ZSR006 coverage

| Platform | Company accounts rows/entities/missing | Founder accounts rows/entities/missing | Evidence all/scored/excluded | Companies scored/missing | Founder entities scored | Oldest -> newest check (age days) |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| GitHub | 7 / 6 / 53 | 22 / 22 / 106 | 19 / 13 / 6 | 5 / 54 | 1 | `2026-07-10T06:56:16.353Z` -> `2026-07-16T02:18:38.478Z` (6.77 -> 0.96) |
| X | 28 / 28 / 31 | 57 / 57 / 71 | 38 / 38 / 0 | 10 / 49 | 7 | `2026-07-16T02:18:38.478Z` (0.96) |
| LinkedIn | 54 / 52 / 7 | 128 / 128 / 0 | 63 / 63 / 0 | 35 / 24 | 36 | `2026-07-09T17:12:01.891Z` -> `2026-07-16T02:18:38.478Z` (7.34 -> 0.96) |
| Instagram | 17 / 16 / 43 | 4 / 4 / 124 | 68 / 68 / 0 | 16 / 43 | 4 | `2026-07-16T02:18:38.478Z` (0.96) |
| Product Hunt | 3 / 3 / 56 | 0 / 0 / 128 | 5 / 3 / 2 | 1 / 58 | 1 | `2026-07-16T02:18:38.478Z` (0.96) |
| YouTube | 7 / 7 / 52 | 1 / 1 / 127 | 50 / 50 / 0 | 12 / 47 | 1 | `2026-07-16T02:18:38.478Z` (0.96) |
| Reddit | 0 / 0 / 59 | 0 / 0 / 128 | 10 / 10 / 0 | 7 / 52 | 0 | `2026-07-16T02:18:38.478Z` (0.96) |

A16ZSR006 has no RSS, web, Hacker News, Bilibili, TikTok, or Bluesky evidence in the materialized dataset.

## Missing accounts

The per-platform missing counts are in the coverage tables. The stricter list below contains entities with **no materialized social account on any platform**. It does not mean there is no account on the internet; it means the current identity inputs contain none.

| Batch | Companies with no account | Founders with no account |
| --- | --- | --- |
| S2026 | Akkari; BioStack Platforms; Chronicle Labs; Clara; Eden Robotics; General Aviation; Hexa; Imperfect; Incandor; Lattice Health; Lumius; matforge; Savant; Soria; transload; Zibra Labs | Saket Joshi (Uno Wallet) |
| S26 | Agentcard; Blueprints; Floracene; HyperProbe | Yuan Tan (Nebula Security) |
| A16ZSR006 | Advocate; Alike; August; SafeWorld | none |

At the audit snapshot, all materialized account rows were marked `verified`: 957 in S2026, 402 in S26, and 328 in A16ZSR006. Generic-profile hardening later retained 957 S2026 rows as 953 verified plus 4 rejected; S26 and A16ZSR006 remained 402 and 328 verified. The parser rejects generic or malformed identity segments instead of manufacturing a handle. Stored review state is not current liveness verification, and this audit did not promote or add any account.

## Validation, exclusions, invalid rows, and duplicates

### Audit-snapshot materialized review and link states

The following state table predates the final comment and native-proof attribution policy. In the current policy, stable LinkedIn comments and profile-activity fragments remain visible with zero contribution, unlocated comments are review-gated, and rows that present another author's comment through a parent-post identity are rejected as traction. External A16Z Top Voice posts attach to the company unless verified founder authorship is resolved; a mentioned founder can be retained separately as `targetFounderId`.

| Batch | Evidence review states | Evidence link states |
| --- | --- | --- |
| S2026 | 2,916 verified; 357 needs review; 0 rejected | 1,036 verified; 9 `valid`; 49 unchecked; 48 blocked; 2,131 missing; 0 invalid |
| S26 | 520 verified; 28 needs review; 0 rejected | 132 verified; 1 unchecked; 415 missing; 0 invalid/blocked |
| A16ZSR006 | 253 verified; 0 needs review/rejected | 253 missing |

The seven raw `invalid` rows in the public snapshot do not survive into the current cohort datasets. No `review_state: rejected` evidence row survives either.

### Scoring eligibility exclusions

The checked-in frozen [`scoring-diagnostics-v4-report.md`](./outputs/scoring-diagnostics-v4-report.md) uses the then-exported production `scoringEligibility` predicate at a frozen clock. Its `rejected_row_count` means **excluded from scoring**, not `review_state: rejected`. The table is exact for that artifact but predates the final integrity fixes and must not be treated as current-worktree output.

| Batch | Evaluated | Eligible/scored | Excluded | Exclusion reasons | Excluded by platform |
| --- | ---: | ---: | ---: | --- | --- |
| S2026 | 3,273 | 2,013 | 1,260 | unsupported platform 779; not verified 357; upstream excluded 124 | web 759; X 321; GitHub 119; LinkedIn 33; RSS 20; YouTube 6; Product Hunt 2 |
| S26 | 548 | 367 | 181 | upstream excluded 127; not verified 28; unsupported platform 26 | LinkedIn 76; X 49; GitHub 26; RSS 19; web 7; Product Hunt 3; HN 1 |
| A16ZSR006 | 253 | 245 | 8 | upstream excluded 8 | GitHub 6; Product Hunt 2 |

Across all cohorts there are 1,449 eligibility exclusions and zero cases where an upstream-positive contribution flag was later rejected. Web and RSS are retained as context but unsupported by v4 scoring weights.

### Duplicate inventory

The same diagnostic reports:

- 0 duplicate company-ID groups and 0 duplicate founder-ID groups.
- 11 normalized social-account URL groups covering 22 rows globally. These can represent the same account attached to related entities; they are identity findings, not evidence-score duplication.
- 0 duplicate canonical evidence-ID groups, platform-post-ID groups, production canonical evidence-key groups, or production physical-post-key groups.
- 18 duplicate canonical source-URL groups covering 36 rows, all in S2026; only 3 of those rows are scored. The production physical-post key still has zero duplicate groups.
- 60 scored rows have publication-date metadata gaps; no scored row has a metric gap.

[`outputs/duplicates-debug-s2026.json`](../outputs/duplicates-debug-s2026.json) says zero duplicate groups, but it was generated on `2026-06-30T11:52:04.520Z` with an older debug canonicalizer. It is historical and is not the current duplicate authority.

## Real adapters versus static/manual sources

The classes returned by [`src/lib/connectors/registry.ts`](../src/lib/connectors/registry.ts) are not a reliable inventory of the scripts that populated current JSON. Several classes advertise capabilities but inherit no-op methods from `ReadOnlyConnector`.

| Platform/source | Registry/runtime class | Actual collection path in this repository | Audit classification |
| --- | --- | --- | --- |
| YC directory | not a social connector | [`fetch-yc-spring-2026.mjs`](../scripts/fetch-yc-spring-2026.mjs) fetches public YC/Algolia pages and writes a cohort snapshot | Real network adapter in code; historical snapshot present; no live access verified here |
| GitHub | `GitHubConnector` fabricates `github.com/<normalized-name>` candidates and echoes cached profile metrics; it does not fetch | [`fetch-github-traction.mjs`](../scripts/fetch-github-traction.mjs) uses the public GitHub API and optional website/search discovery | Standalone real adapter; registry class is not the collector |
| Public web | `PublicWebConnector` returns the already-known official URL; no recent-post override | [`fetch-public-traction.mjs`](../scripts/fetch-public-traction.mjs) performs public web, RSS, HN, YouTube, Product Hunt, Reddit, X, LinkedIn, and Instagram attempts | Standalone real multi-source collector; registry class is identity-only |
| Product Hunt | `ProductHuntConnector` performs DuckDuckGo discovery and public page parsing | Also collected in the broad public script and represented in targeted/manual seeds | Real public adapter in code, review-gated; no live access verified here |
| YouTube / RSS | Classes declare support but inherit empty discovery/post/metric methods | Broad public script has actual implementations | Registry placeholders with separate real script implementations |
| Instagram | `InstagramPublicConnector` inherits no-op collection | Broad public attempts plus opt-in logged-in OpenCLI collector; targeted/manual rows | No active registry adapter; historical public/logged/manual evidence exists |
| X | `XOfficialApiConnector` is a disabled credential placeholder | Broad public collector; logged-in OpenCLI collector; [`live-source-refresh.ts`](../src/lib/ingestion/live-source-refresh.ts) reads public X profile HTML and FxTwitter/VxTwitter post JSON | Real standalone and live-refresh code; live refresh is X-only |
| LinkedIn | Registry connector is `manual_only` and no-op | Broad public collector, guarded logged-in OpenCLI path, and targeted/manual rows | No active registry adapter; historical evidence exists |
| TikTok / Bluesky | Explicit disabled/stub classes | No current collector or evidence rows; schema and types accept them | Code/schema forward compatibility only; not a source and not scored |
| A16Z accounts | no discovery connector owns the inventory | [`ingest-a16z-speedrun-social-accounts.mjs`](../scripts/ingest-a16z-speedrun-social-accounts.mjs) combines a hard-coded company account list with public founder-profile links | Static/manual seed generator with some profile fetches; rerunning does not discover arbitrary new company accounts |
| A16Z evidence | normal dataset import | Static/manual source-hunt seed plus GitHub snapshot and one explicit public attachment in [`a16z-speedrun-006-dataset.ts`](../src/lib/graph/a16z-speedrun-006-dataset.ts) | Static/manual evidence with downstream validation and scoring |

## Persistence and history

### Actual runtime persistence

The production-shaped graph dataset imports JSON directly in [`yc-spring-2026-dataset.ts`](../src/lib/graph/yc-spring-2026-dataset.ts) and [`a16z-speedrun-006-dataset.ts`](../src/lib/graph/a16z-speedrun-006-dataset.ts). The live X refresh merges by evidence key and atomically replaces `targeted-evidence-current.json`; it preserves the earliest `first_seen_at` but does not append each metric observation as history.

`/api/ingest/batch` uses [`ingest-batch.ts`](../src/lib/workers/ingest-batch.ts) and [`run-store.ts`](../src/lib/workers/run-store.ts):

- demo mode stores its run in a process-local `Map` and returns a deterministic demo graph;
- database mode can upsert a batch and create/update an `ingestion_runs` row;
- database mode then intentionally returns 501 because real YC/connectors are not wired;
- it never persists companies, founders, accounts, posts/evidence, observations, scores, or graph edges.

### Migration architecture

| Migration | Code support introduced | Runtime/application status |
| --- | --- | --- |
| [`001_initial_schema.sql`](../supabase/migrations/001_initial_schema.sql) | batches, companies, founders, social accounts, posts, post metrics, baselines, ingestion/scoring runs, post scores, company/founder traction snapshots, graph edges | Schema only unless separately applied; no live application verified |
| [`002_public_ingestion_queue_and_timestamps.sql`](../supabase/migrations/002_public_ingestion_queue_and_timestamps.sql) | `ingestion_tasks`, `source_failures`, post canonical/timestamp fields | No worker claims/locks tasks, retries abandoned leases, or drains this queue in current app code |
| [`003_discovery_learning_tables.sql`](../supabase/migrations/003_discovery_learning_tables.sql) | `platform_coverage`, `discovery_attempts`, `source_discovery_paths` | Current collectors write JSON reports, not these tables |
| [`004_traction_scoring_evidence_lineage.sql`](../supabase/migrations/004_traction_scoring_evidence_lineage.sql) | canonical `evidence_items`, attributions, append-oriented `metric_observations`, model versions, versioned run/snapshot lineage | No backfill for legacy posts/metrics and no current end-to-end writer |
| [`005_harden_public_table_access.sql`](../supabase/migrations/005_harden_public_table_access.sql) | RLS and grants: public metadata read; operational/raw/scoring tables restricted to service role | Security design in migration; deployment not verified |
| [`006_add_tiktok_bluesky_platforms.sql`](../supabase/migrations/006_add_tiktok_bluesky_platforms.sql) | TikTok/Bluesky accepted by account/post constraints | No adapters or evidence |
| [`007_register_traction_scoring_v4.sql`](../supabase/migrations/007_register_traction_scoring_v4.sql) | inserts canonical `returner-traction` v`4.0.0` config/hash, rejects config drift, adds model/batch/as-of history index | Fixes the previously missing model seed in migration code; no live insertion verified |

Migration 004 enforces completed-run provenance and protects a scoring model definition after a completed run references it; referenced model rows also cannot be deleted. Migration 007 seeds canonical v4 and rejects config drift on rerun. Only the append-only description of `metric_observations` lacks an update/delete prevention trigger.

### Score history and generated graphs

Active benchmark stores are:

| Batch | Store updated | Daily rows | Weekly rows | Recorded span |
| --- | --- | ---: | ---: | --- |
| S2026 | `2026-07-16T07:51:13.720Z` | 16 | 3 | daily `2026-06-29` -> `2026-07-16` |
| S26 | `2026-07-16T07:41:47.577Z` | 11 | 3 | daily `2026-07-06` -> `2026-07-16` |
| A16ZSR006 | `2026-07-16T07:41:47.872Z` | 11 | 1 | daily `2026-07-06` -> `2026-07-16` |

The existing entries predate the current publisher's per-snapshot `scoringModelVersion` and `inputGeneratedAt` fields, so older history rows have no model identity. `s2025-score-benchmarks.json` and `w2026-score-benchmarks.json` each contain one legacy daily/weekly row from July 1 and are not updated by the active workflow.

The generated graph inventory is:

| Batch | Base file generated / nodes / evidence / review | YC Partners variant | Insiders variant | v4 `scoringContext` |
| --- | --- | --- | --- | --- |
| S2026 | `2026-07-16T20:46:53.946Z` / 197 / 2,069 / 891 | `20:46:55.355Z` / 39 nodes / 73 evidence | `20:46:56.762Z` / 21 nodes / 34 evidence | missing in all three |
| S26 | `2026-07-16T20:46:56.854Z` / 83 / 473 / 103 | `20:46:58.084Z` / 8 nodes / 17 evidence | `20:46:59.360Z` / 2 nodes / 2 evidence | missing in all three |
| A16ZSR006 | `2026-07-16T20:46:59.379Z` / 59 / 251 / 0 | `20:47:00.608Z` / 0 nodes / 0 evidence | `20:47:01.870Z` / 5 nodes / 10 evidence | missing in all three |

The inventory above is a point-in-time observation, not a current publication verdict. Both [`Dashboard.tsx`](../src/components/Dashboard.tsx) and the refresh route now apply the shared static snapshot contract before trusting a file. The browser falls back to `/api/graph` when validation or requested batch/audience identity fails and starts background API revalidation after an accepted static response. The refresh route additionally requires current-Central-day freshness and dynamically rebuilds when its generated-snapshot fast path is unavailable. [`update-daily-benchmarks.mjs`](../scripts/update-daily-benchmarks.mjs) requires all published responses to share the canonical model identity and all-platform score scope.

## Queue, schedule, cache, and publication failure modes

| Area | Fixed or mitigated in current code | Remaining failure modes |
| --- | --- | --- |
| Broad collector checkpointing | Per-task checkpoint, serialized checkpoint write chain, temp-file rename, resume/force controls, per-platform lanes/cooldowns | Hard-wired to S26 YC input and shared output/checkpoint; process crash between external request and checkpoint can repeat work; no cross-process lock; historical failures accumulate until explicitly handled |
| Live refresh request queue | Strict schema/body limits; production secret; same-key requests join; a different in-flight request gets 429 plus `Retry-After`; direct source URLs restricted to X hosts | Single process-local `inFlightRefresh`; no durable queue, job ID, lease, retry policy, or multi-host coordination; UI labels `ingest` and `refresh` call the same implementation |
| Live snapshot write | Reads and validates existing JSON before replacement; per-file process-local mutex; merge/dedupe; earliest first-seen preservation; temp-file rename; corrupt/invalid source refused | Mutex is explicitly process-local; multi-process/host writers can lose updates; stage-log replacement has no matching mutex and is last-writer-wins; filesystem rename does not create metric history |
| X fetch | Target caps, concurrency 10, 4.5-second request timeout, native author/post/metric validation, retweet and company-mention guards, 10-minute Top Voice miss cache | Public X HTML and FxTwitter/VxTwitter availability are external dependencies; short timeout can produce false misses; lexical company/Top Voice matching can miss or misattribute edge cases; all non-X adapters remain unwired |
| Graph response cache | Key includes filters, output flags, local day, benchmark store version, and live-evidence version; TTL 60 seconds; max 64 entries; refresh clears it | Cache is per Node process and not shared/invalidation-broadcast across hosts; expired entries remain until overwritten/evicted; API no-store headers do not disable this server cache |
| Generated-snapshot refresh fast path | Refresh validates canonical v4 structure, batch, audience, identity, and current-Central-day freshness before reuse; invalid or stale snapshots fall back to a dynamic rebuild | Dynamic fallback adds latency but prevents an invalid generated snapshot from becoming the refresh result |
| Client graph cache | Static contract validation, API fallback, background revalidation after every accepted static response, request dedupe, abort/stale-request checks, cache clear after refresh and local midnight, API recovery polling after a refresh timeout | In-memory client entries have no general TTL and caches are process/tab local |
| Client/server module boundary | [`client-filters.ts`](../src/lib/graph/client-filters.ts) keeps client momentum ordering local and no longer imports server-oriented [`benchmarks.ts`](../src/lib/graph/benchmarks.ts), which owns `node:fs`/`node:path` persistence | Fixed in the recorded final production build and graph/home GET smoke. The build still reports an unexpectedly broad NFT trace through the refresh route; typecheck/jsdom alone remain insufficient boundary tests. |
| Benchmark workflow | Two UTC schedules correctly select Central midnight across DST; workflow concurrency does not cancel; script requires all responses, matching v4 model identity/scope, full base cohorts, current generation window; stages writes and rolls back local publication failures | Workflow refreshes scores/graphs from already-committed source files; it does not run ingestion. Git push can still lose a race/non-fast-forward and has no fetch/rebase/retry. Atomicity is local filesystem only; runtime consumers independently validate static artifacts. |
| Database queue/history | Migrations define task/failure/discovery/coverage, canonical evidence, observations, model versions, and score-run lineage | No deployed-state proof, no queue worker, no source-to-database backfill, no observation writer, and no graph reader from those normalized tables |
| Live overlay | Exact effective replay is a no-op; material updates preserve fresh lower/zero corrections, merge/dedupe evidence, recalibrate company scores, and rebuild company radii, leaderboard ranks, momentum rows, and scoring provenance | Standalone founder graph-node totals/radii are not rebuilt with the recalibrated company peer set. The projection-equivalence regression is covered by the now-passing focused suite. Neither path writes durable metric observations. |

## Schedule and UI path

[`daily-benchmarks.yml`](../.github/workflows/daily-benchmarks.yml) runs at 05:00 and 06:00 UTC and lets the script select the slot corresponding to midnight in `America/Chicago`. It builds the app, fetches all nine graph variants from a production Next server, atomically replaces the nine graph files and appends the three active benchmark stores when due, commits exactly the allowed graph/history files that changed, and pushes. It does not fetch YC or social sources.

The UI path is:

1. [`page.tsx`](../src/app/page.tsx) renders `Dashboard` without `initialGraph`; the server-side [`initial-page-graph.ts`](../src/lib/graph/initial-page-graph.ts) helper is currently unused by the page.
2. For an unfiltered cohort, `Dashboard` first requests `/graph/<batch>[-audience].json` with a local-day cache key, `force-cache`, and a bounded timeout. It accepts the response only when the canonical snapshot contract and requested batch/audience identity validate; otherwise it falls back to the API.
3. After any accepted static graph, including a Top Voice audience snapshot, `Dashboard` starts a background forced API request and replaces the cached projection when that response succeeds. A local-midnight timer also clears client graph caches and revalidates through the API.
4. API requests have a 20-second client timeout and up to three attempts. The API builds current v4, adds benchmark momentum, overlays validated persisted live X rows, sanitizes output, and returns `Cache-Control: no-store, max-age=0`.
5. Platform/industry/group/min-score changes are usually applied client-side to the cached unfiltered graph. Refresh POSTs have a 45-second UI timeout followed by background GET polls.

The static-first design improves first-paint latency while treating static publication correctness as part of the scoring contract. Runtime validation prevents an invalid snapshot from being trusted, and API fallback/revalidation supplies the dynamic canonical response.

## Operational commands that exist

All commands below are backed by a current package script or script argument parser. Commands marked **writes source** or **writes generated output** should not be run concurrently with another collector/publisher.

### Source refresh and backfill

```bash
# YC Summer 2026 / S26. Uses the script's current defaults: 83 companies and
# src/lib/yc/summer-2026-companies.json. Writes source.
node scripts/fetch-yc-spring-2026.mjs

# YC Spring 2026 / S2026. Writes source.
node scripts/fetch-yc-spring-2026.mjs \
  --batch-name="Spring 2026" \
  --expected-count=197 \
  --out=src/lib/yc/spring-2026-companies.json

# GitHub refreshes supported by this script. Writes source.
node scripts/fetch-github-traction.mjs --batch=S26
node scripts/fetch-github-traction.mjs --batch=A16ZSR006

# Conservative A16Z discovery expansion. Writes source; review results before use.
node scripts/fetch-github-traction.mjs --batch=A16ZSR006 --website --search

# S26 broad public collection, one company, all known company/founder social
# targets, selected platforms. Writes the public snapshot, checkpoint, and
# discovery reports.
node scripts/fetch-public-traction.mjs \
  --company=contextdev \
  --social=all \
  --platforms=x,linkedin,youtube \
  --workers=2 \
  --delay-ms=1200 \
  --force

# Opt-in logged-in collector. Writes logged-in snapshot/checkpoint; requires an
# existing persistent OpenCLI session. LinkedIn is disabled without both flags.
node scripts/fetch-logged-in-social-traction.mjs \
  --company=contextdev \
  --entities=all \
  --platforms=instagram,x,linkedin \
  --allow-linkedin \
  --workers=1 \
  --force

# Regenerates the A16Z account snapshot from the script's hard-coded company
# list plus public founder-profile links. Writes source; it is not general account discovery.
node scripts/ingest-a16z-speedrun-social-accounts.mjs
```

Important command gaps:

- `npm run ingest:s26:company` is the intentionally named company-social collector for the **S26 Summer** snapshot. It is not an S2026/P26 backfill.
- `fetch-github-traction.mjs` supports only `S26` and `A16ZSR006`. There is no current supported command to regenerate legacy S2026 [`github-traction.json`](../src/lib/social/github-traction.json).
- There is no broad-public collector batch flag for S2026, no TikTok/Bluesky collector, and no database backfill command for migrations 004/007.

### Live X refresh

With a local app already running, this scans the selected cohort's known X accounts and **writes source plus the refresh stage log**:

```bash
curl -fsS -X POST http://127.0.0.1:3000/api/graph/refresh \
  -H 'content-type: application/json' \
  -d '{"action":"refresh","batchSlug":"S2026","platforms":["x"],"sourceUrls":[],"topVoices":"off"}'
```

In production, add `Authorization: Bearer $GRAPH_REFRESH_SECRET` (or an accepted refresh-secret header). Asking for other platforms does not backfill them; the response/stage log reports `adapter_not_wired`.

### Recompute and publish

```bash
# Rebuild current code, then atomically regenerate all nine graph files and append
# the three active benchmark stores when a daily/weekly observation is due.
npm run build
npm run benchmarks:daily -- --port=3100

# Use an already-running graph API instead of starting the production server.
GRAPH_API_BASE_URL=http://127.0.0.1:3120 npm run benchmarks:daily

# Frozen, network-disabled v4 recomputation/diagnostics. Writes only the two
# files under docs/outputs named by the script.
npm run scoring:audit:v4
```

The commands and arguments above exist. The earlier `client-filters.ts` -> `benchmarks.ts` -> `node:fs` browser import failure was fixed, and a later direct production build plus local graph/home smoke passed. The build still emits a broad NFT trace warning through `live-source-refresh.ts` and the refresh route. The benchmark command is a publisher, not a source refresh; do not run it concurrently with another benchmark/graph publisher.

### Read-only API smoke and targeted debugging

```bash
# Dynamic v4 graph smoke; writes only /tmp in this example.
curl -fsS \
  'http://127.0.0.1:3000/api/graph?batch=S2026&includeNonScoring=1&includeWhy=1' \
  > /tmp/s2026-graph.json
jq '{batch:.batch.slug, generatedAt, scoringContext, nodes:(.nodes|length), evidence:(.evidence|length)}' \
  /tmp/s2026-graph.json

# Company evidence/scoring debug reports. These GET the API and write outputs/.
GRAPH_API_URL='http://127.0.0.1:3000/api/graph?batch=S2026&includeNonScoring=1&includeWhy=1' \
  npm run debug:evidence -- --company='Runtime'
GRAPH_API_URL='http://127.0.0.1:3000/api/graph?batch=S2026&includeWhy=1' \
  npm run debug:scoring -- --left='InsForge' --right='Interfaze'

# Coverage and duplicate reports. These write generated reports; debug:coverage
# also rewrites docs/COVERAGE_REPORT.md.
GRAPH_API_URL='http://127.0.0.1:3000/api/graph?batch=S26&includeNonScoring=1' \
  npm run debug:coverage
GRAPH_API_URL='http://127.0.0.1:3000/api/graph?batch=S2026&includeNonScoring=1' \
  npm run debug:duplicates
```

`npm run ingest:public` is not a real source backfill. It POSTs `/api/ingest/batch`, defaults to demo mode, and writes an `outputs/ingest-public-*.json` response. Setting `PUBLIC_INGEST_DATABASE=true` selects the intentionally blocked database mode rather than enabling a source worker.

## Live-smoke boundary for this audit

Performed during the original audit without writes to tracked source, graph, benchmark, or report files (the already-running Next dev server may maintain its ignored `.next` cache):

- Imported the then-current TypeScript dataset/scorer through the repository's diagnostics loader and built all three cohort graphs in memory.
- Early in the audit, GET-smoked the already-running local dev server at `http://127.0.0.1:3120` for S2026, S26, and A16ZSR006. All returned HTTP 200, `Cache-Control: no-store, max-age=0`, model `returner-traction` v`4.0.0`, and exact totals of 197/3,273/891, 83/548/103, and 59/253/0 for companies/evidence/review queue. At that time `/?batch=S2026` also returned HTTP 200 with title `YC Network Map` and the loading shell.
- Re-smoked after concurrent working-tree edits at `2026-07-17T01:43:12Z`. All three graph URLs and `/?batch=S2026` then returned HTTP 500 with HTML. The Next import trace was `benchmarks.ts` -> `client-filters.ts` -> `Dashboard.tsx` -> `page.tsx`, with `the chunking context (unknown) does not support external modules (request: node:fs)`. This was a real intermediate regression, but it is not the final served state.
- After the client/server fix and later integrity changes, the final verification recorded in [`SCORING_V4_FINAL_REPORT.md`](./SCORING_V4_FINAL_REPORT.md) passed a production build and returned HTTP 200 for the same three graph routes plus the home page on port `3121`. The graph responses reported 197/1,976/895, 83/362/103, and 59/245/0 for companies/returned eligible evidence/review queue.
- Read all nine generated graph files directly and checked their batch/audience identity, generated time, row counts, and absence of `scoringContext`.

Local code verification used Node v24.14.0 and repository-local TypeScript/Vitest binaries:

- `npm run typecheck -- --incremental false` is the reproducible package command equivalent of the executed `tsc --noEmit --incremental false`; it passed during the audit. The temporary browser import failure nevertheless demonstrated that typecheck alone does not enforce the client/server bundling boundary.
- The original focused run produced 155 passing and 6 failing tests out of 161. The failures covered old-contract refresh fixtures, founder-radius expectations, and server/client projection equivalence; they were actionable point-in-time evidence, not final results.
- The later suite added native-proof attribution, A16Z ownership, verified-target, comment/context, zero-correction, projection, and bundle-related coverage. Company radii, leaderboard, momentum, and scoring context now rebuild after a material overlay; standalone founder graph-node totals/radii remain the documented limitation. Current settled-worktree totals are recorded only in the final report.

Not performed:

- No POST to `/api/graph/refresh` or `/api/ingest/batch` because both can write local source/output state.
- No YC, GitHub, X, LinkedIn, Instagram, Product Hunt, YouTube, RSS, HN, Reddit, TikTok, Bluesky, A16Z, or search-engine live request.
- No Supabase connection, migration application, RLS probe, queue operation, or database history query.
- No benchmark publisher run and no GitHub Actions dispatch, because those rewrite generated graphs/history and may commit/push.
- No standalone build was run during the original source audit because it would rewrite the concurrently used `.next` tree. A later direct production build passed after the browser/server import fix; it still emitted the broad NFT trace warning documented above.
- Browser interaction could not be completed because the in-app browser webview did not attach. Later HTML/API GETs passed, but no claim is made about rendered graph pixels, interactions, or client-side static-to-API replacement.

## Stale reports and interpretation cautions

[`outputs/coverage-debug-s2026.json`](../outputs/coverage-debug-s2026.json) was generated at `2026-07-16T00:24:31.860Z` from a local API and reports 3,294 evidence rows and older per-platform counts. The later audit snapshot had 3,273 cohort-scoped S2026 input rows; the final API returned 1,976 eligible rows after hardening. The report is useful historical evidence but is not a present-worktree authority.

Likewise, the generated graph files contain 2,069/473/251 sanitized base evidence rows rather than the current in-memory 3,273/548/253 inventories because they were produced under an older output/scoring contract and sanitize/exclude fields differently. Their timestamps do not turn them into current v4 artifacts.

Coverage is not source correctness. Verified review state and native URL syntax do not prove ownership, liveness, metric freshness, or resistance to manipulated engagement. Missing account rows are missing knowledge, not proof of absence. Existing snapshot timestamps are not verified live access. The database migrations are an architecture declaration until deployment and writer behavior are observed.
