# Internal Longitudinal Data Audit

Audit date: `2026-07-20`
Repository: `/Users/allenxu/Documents/Codex/2026-07-09/pu/returner-fund`
Git branch at audit start: `main`
Git HEAD at audit start: `0a7c18c`
Write scope: this audit did not modify production code, tests, datasets, evidence, snapshots, benchmark stores, or ingestion outputs.

## Executive decision

**No platform has a production-ready internal longitudinal training set today.**

The repository contains useful seed histories, but it does not contain a local, queryable dump of append-only `metric_observations` or `scoring_runs`, and its file history spans too few collection waves to make leakage-safe training, validation, calibration, and final-test partitions. The historical score benchmarks are V4 outputs and are circular labels for a learned replacement.

The strict public-graph audit found:

- 52 committed base-graph revisions;
- 45,633 raw evidence appearances across those revisions;
- 3,695 canonical platform-native audit units after eligibility/timestamp checks;
- 474 units with two or more distinct dated readings;
- 649 adjacent `t0 -> t1` candidate transitions;
- only 127 transitions where at least one shared, comparable native metric changed;
- zero 30-day pairs within ±72 hours;
- no platform with enough aligned pairs and independent temporal waves for the minimum support gate.

The 649 transitions are **candidates, not accepted training examples**. Derived graph files lack a per-reading artifact hash and ingestion-run foreign key. Of the 649, 522 repeat the same comparable metric values at a new timestamp, and repository evidence cannot establish in every case whether that timestamp represents a fresh metric capture, an import/cleanup, or a carried value. The 127 changed transitions prove a changed captured state more strongly, but they still do not create three temporal partitions.

## Worktree safety and initial state

The required opening commands were run before inspection:

```bash
pwd
git status --short
git branch --show-current
git log --oneline -15
git diff --stat
git diff --check
```

The worktree was already heavily dirty with shared ingestion, dataset, scoring, UI, and test work. This lane did not edit or regenerate any of it. `outputs/source-hunt/current-run-handoff.md` was not present.

Repeated status checks confirmed that the only intended writes from this lane are:

- `docs/scoring-research/TARGET_SPEC.md`
- `docs/scoring-research/FEATURE_SPEC.md`
- `docs/scoring-research/INTERNAL_DATA_AUDIT.md`

## Sources inspected

### Durable database design

The schema supports the right design:

- `evidence_items` stores platform-scoped canonical identity;
- `metric_observations` stores `(evidence_id, metric_name, source_name, observed_at)` and is append-only after migration 008;
- `scoring_model_versions` and completed `scoring_runs` carry immutable version/cutoff/fingerprint fields;
- `post_scores`, `traction_snapshots`, and founder snapshots reference scoring runs.

The durable importer:

- upserts canonical evidence by `(platform, canonical_key)`;
- writes metrics only for verified, attributable, traction-eligible objects;
- ignores derived score-like metrics;
- uses a uniqueness key of `(evidence_id, metric_name, source_name, observed_at)`;
- treats GitHub repositories separately from accounts.

This is suitable for future longitudinal capture, but the database contents were not available locally. The process environment reported:

```text
NEXT_PUBLIC_SUPABASE_URL=unset
SUPABASE_SERVICE_ROLE_KEY=unset
NEXT_PUBLIC_SUPABASE_ANON_KEY=unset
```

The current public evidence export independently records: `Durable Supabase import was skipped because complete optional credentials were not configured; this export is file-backed.` Therefore the exact deployed `metric_observations` and `scoring_runs` row counts are **unknown**, not zero. No claims in this audit rely on an inaccessible database.

### Current collector files

| File/source | Current rows | Source timestamp | Longitudinal limitation |
| --- | ---: | --- | --- |
| `public-evidence-current.json` | 2,286 evidence, 2,103 needs-review, 5,439 failures | 2026-07-20 02:01:09.632Z | merged latest export; older values overwritten except through Git history |
| `logged-in-evidence-current.json` | 2,546 evidence, 328 failures | 2026-07-09 17:58:46.209Z | one current file; mixed platforms; no append-only local series |
| `targeted-evidence-current.json` | 1,072 evidence, 1 needs-review | 2026-07-20 08:00:00Z | includes imported/source-hunt rows; import time is not always metric time |
| `a16z-speedrun-006-social-evidence.json` | 304 evidence | 2026-07-19 06:35:00Z | seeded/imported rows; several cleanup/import timestamps |
| `eden-robotics-verified-native-evidence.json` | 12 evidence | 2026-07-20 08:00:00Z | one captured state only |
| Spring GitHub snapshot | 40 account rows | 2026-07-20 02:01:09.690Z | current file mixes account/repository rows; account total is not a post outcome |
| Summer GitHub snapshot | 22 account rows | 2026-07-20 02:01:09.691Z | same |
| A16Z GitHub snapshot | 17 account rows | 2026-07-20 02:01:09.691Z | current metadata reports retained/failed rows; source time cannot be assigned blindly to every carry |

Counts overlap and must not be added as unique posts. Imported source-hunt rows and public graphs often represent the same object.

The two July 9 long-run summaries preserve aggregate row counts but not complete per-object metric snapshots. The long-run files contain process event logs (48, 29, 77, 145, 30, 20, and 36 events across the seven event-log files), not a metric-observation fact table. They cannot supply `t0/t1` labels.

The source-hunt directory was actively changing during this shared-worktree audit: the first checkpoint contained 77 files (75 JSON), while a later checkpoint contained 85 files (83 JSON). Its inspected ledger checkpoint had 904 candidates, 875 rejected candidates, 29 accepted candidates absent from canonical evidence, 718 source URLs/native IDs, and 176 searched entries. This moving state was excluded from longitudinal counts. The files are discovery/verification ledgers: they may prove lineage for a single reading but are not a longitudinal outcome series. Accepted evidence already imported into canonical collector files must not be counted again.

### Current static public graphs

| Base graph | Evidence rows | Company nodes | Generated | Evidence as of |
| --- | ---: | ---: | --- | --- |
| S2026 | 2,240 | 197 | 2026-07-20 08:27:39.302Z | 2026-07-20 08:00:00Z |
| S26 | 714 | 115 | 2026-07-20 08:27:41.765Z | 2026-07-20 02:01:09.691Z |
| A16ZSR006 | 302 | 59 | 2026-07-20 08:27:42.886Z | 2026-07-20 02:01:09.691Z |

The three current base graphs contain 3,256 rows and 3,215 audit-canonical native objects; cross-batch/representation duplicates explain the difference. Current object coverage is broad but mostly cross-sectional:

| Platform | Current canonical objects | Registered target counter present |
| --- | ---: | ---: |
| X | 2,191 | views 2,148 |
| LinkedIn | 438 | impressions 0 |
| GitHub | 204 | stars 203 |
| YouTube | 177 | views 177 |
| Instagram | 165 | views 9; plays 24 |
| Hacker News | 23 | points 20 |
| Reddit | 11 | upvotes 11 |
| Product Hunt | 6 | upvotes 6 |

The publication-date surface is also incomplete: current X has 4 unknown dates, YouTube 59, and LinkedIn 185. Day-precision rows exist on X, YouTube, Instagram, and Reddit. Unknown/day precision cannot be turned into an exact age by choosing a convenient time.

### Manifest mismatch

`public/graph/manifest.json` is not a valid manifest for the current graph bytes:

- manifest `publishedAt`: 2026-07-20 02:02:10.450Z;
- manifest `evidenceCollectedAt`: 2026-07-20 02:01:09.691Z;
- manifest ingestion run: `file:catchup-central-2026-07-19-0600`;
- current base graph generation: approximately 08:27Z;
- manifest SHA-256 entries describe the earlier 02:02Z graph generation;
- current base graph SHA-256 values do not match those manifest entries.

Consequently the current manifest cannot supply accepted training lineage for the 08:27Z graph files. No artifact regeneration was attempted because this is a shared dirty worktree and canonical evidence is active.

## Strict graph-history reconstruction

### Scope

Only the three base graphs were used. Top-Voice variants are filtered projections of the same physical observations and were intentionally excluded to prevent duplicates.

Git history provided:

- S2026: 18 revisions;
- S26: 17 revisions;
- A16ZSR006: 17 revisions;
- total: 52 revisions.

The first retained eligible observation is `2026-06-27T23:59:53.446Z`; the last is `2026-07-20T08:00:00.000Z`.

### Eligibility and audit identity

For each revision, the audit retained only a verified row with a positive numeric metric and a valid metric-observation timestamp, in priority order:

1. `metricsCheckedAt`;
2. `observedAt`;
3. `last_checked_at`;
4. `first_seen_at`.

It rejected a reading if the observation was after graph generation or before the row's publication time. It never used `last_updated_at`, `postedAt`, link-check time, graph generation, or commit time as the metric timestamp.

Audit identity was `platform + normalized platformPostId`, falling back only to a normalized canonical URL when the native ID was absent. This mirrors the production native-ID/URL priority but deliberately does not use the production content-fingerprint fallback. A row lacking both native identity and native URL cannot be a supervised unit.

Across 45,633 appearances:

- invalid/missing observation timestamp: 0;
- observation later than graph generation: 0;
- observation before publication: 136 appearances, excluded;
- 121 of the 136 were GitHub rows where `postedAt` behaved like mutable `pushedAt` rather than repository creation;
- 15 were LinkedIn rows with inconsistent timestamps.

This confirms that production display timestamps cannot be reused as model-age fields without lineage-aware normalization.

### Exact candidate transitions

| Platform | Historical canonical units | Units with ≥2 readings | Readings on those units | Adjacent candidate pairs | Shared metric changed | Shared metrics identical |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| X | 2,521 | 76 | 153 | 77 | 33 | 44 |
| GitHub | 243 | 154 | 410 | 256 | 56 | 200 |
| YouTube | 177 | 82 | 197 | 115 | 34 | 81 |
| Instagram | 165 | 69 | 151 | 82 | 0 | 82 |
| LinkedIn | 526 | 78 | 181 | 103 | 4 | 99 |
| Hacker News | 24 | 2 | 5 | 3 | 0 | 3 |
| Reddit | 21 | 10 | 20 | 10 | 0 | 10 |
| Product Hunt | 18 | 3 | 6 | 3 | 0 | 3 |
| **Total** | **3,695** | **474** | **1,123** | **649** | **127** | **522** |

Comparable families were platform-routed. In particular, X repost/retweet and quote counters remained separate features, while the audit recognized old aggregate diffusion totals when checking whether a later split representation had actually decreased. Of 127 changed transitions, 22 contain at least one decrease after alias normalization: X 3, GitHub 15, LinkedIn 4. These require correction/deletion/source-schema review and cannot be blindly modeled as ordinary growth.

Changed metric counts overlap within a pair:

- X: views 33, reactions 20, replies 11, reshare representation 13 in the initial field audit;
- GitHub: stars 33, forks 19, open issues 18, rolling commits 17;
- YouTube: views 34;
- LinkedIn: reactions 4, replies 1.

Most multi-reading Instagram, Reddit, Product Hunt, and Hacker News rows repeat identical values after import/cleanup. They may represent valid zero growth, but the derived graph does not prove that strongly enough for acceptance.

### Fixed-horizon availability

These are all candidate pairs, followed by the subset with a changed shared counter:

| Horizon window | Candidate pairs | Units | Changed pairs | Platform concentration |
| --- | ---: | ---: | ---: | --- |
| 24h ±6h | 155 | 155 | 10 | 140 GitHub candidates; changed: GitHub 6, YouTube 4 |
| 72h ±12h | 251 | 251 | 3 | 68 Instagram, 64 LinkedIn, 51 YouTube, 38 X; changed only YouTube 1 and LinkedIn 2 |
| 7d ±24h | 5 | 5 | 3 | X 3 candidates/1 changed; YouTube 2/2 |
| 14d ±48h | 10 | 10 | 10 | all X |
| 30d ±72h | 0 | 0 | 0 | none |

These observations are clustered into one or two acquisition waves. For example, many GitHub transitions are from a late-June capture to a July 19/20 capture. Splitting those rows randomly would leak collector wave, calendar state, companies, and near-identical source conditions. There is no honest way to divide them into an older training period, later validation period, and untouched still-later test period.

### Entity and batch breadth

The 474 multi-reading units cover 148 attributed companies and 175 attributed company/founder entities, but breadth is uneven:

- X: 76 units across 42 companies;
- GitHub: 154 units across 41 companies;
- YouTube: 82 units across 39 companies;
- Instagram: 69 units across 17 companies;
- LinkedIn: 78 units across 50 companies;
- Hacker News: 2 units across 2 companies;
- Reddit: 10 units across 7 companies;
- Product Hunt: 3 units from 1 company.

The 1,123 readings on multi-observed units are distributed as 412 S2026, 142 S26, and 569 A16ZSR006 representations. This is not enough for a clean batch-held-out test, and the high A16Z representation count largely reflects repeated import/cleanup timestamps rather than independent changing outcomes.

## Score and benchmark histories

The five benchmark stores contain 56 unique timestamp/model snapshots and 6,557 company snapshot rows:

| Store | Unique snapshots | Span | Model composition | Company rows | Adjacent company score pairs |
| --- | ---: | --- | --- | ---: | ---: |
| A16ZSR006 | 16 | Jul 6–Jul 20 | 11 legacy, 5 V4 | 944 | 885 |
| S2025 | 1 | Jul 1 | 1 legacy | 0 | 0 |
| S2026 | 21 | Jun 29–Jul 20 | 16 legacy, 5 V4 | 4,137 | 3,940 |
| S26 | 17 | Jul 2–Jul 20 | 12 legacy, 5 V4 | 1,475 | 1,356 |
| W2026 | 1 | Jul 1 | 1 legacy | 1 | 0 |

There are 5,841 adjacent company pairs whose model-version label matches. They are still unusable as V5 outcomes because the score is a deterministic V4/legacy transformation of the same evidence V5 is meant to replace. Using future V4 score/rank as label would preserve arbitrary V4 weights, post slots, platform weights, recency, confidence, and batch calibration by target leakage.

The score benchmark stores also change when cohort membership, source coverage, or score model changes. They are suitable for rollback/replay comparison only, not a future company-performance ground truth.

Local experiment/diagnostic outputs embed copies of current evidence and V4 score surfaces. They do not create independent metric observations. The database has a schema for immutable scoring runs, but without a dump/credentials the actual completed-run count and input cutoffs are unknown.

## Leakage and bias risks found

### Timestamp leakage

- `last_updated_at` often denotes native content/repository update or import metadata, not a metric reading.
- production dedupe freshness considers `last_updated_at` and `first_seen_at`; training resolution must not reuse that rule.
- GitHub graph `postedAt` can reflect `pushedAt`; 121 historical appearances had observation earlier than displayed post time.
- source-level `fetchedAt` cannot be applied to a retained last-good row unless the collector proves it was fetched in that run.
- graph `generatedAt` and Git commit author time are artifact times, not counter observation times.

### Target leakage and circularity

- V4 `rawEngagement`, normalized score, contribution score, platform score, recency, confidence, company score, rank, and benchmark delta are derived from current/future evidence and forbidden.
- high-performance thresholds must fit training only.
- current final totals cannot serve as both `t0` feature and label.
- later source-hunt verification or review-state changes cannot enter earlier features.

### Duplicate and attribution leakage

- the same native post may be attached to a founder, company, or Top Voice and appear in multiple filtered/static graphs;
- base and Top-Voice graphs duplicate the same physical readings;
- source-hunt candidates, targeted evidence, public evidence, and graph evidence overlap;
- company-scoped evidence IDs are not physical-post identity;
- content-fingerprint fallback can merge or split uncertain objects and is unacceptable as the sole supervised identity.

### Selection and survivorship bias

- cohorts contain accelerator companies rather than a representative platform sample;
- discovery favors public, accessible, high-signal, official, or manually targeted accounts;
- deleted/private/blocked posts are underrepresented;
- verified positive-only graph snapshots omit zero/missing objects and failures;
- logged-in and source-hunt collection intensity differs by platform and company;
- current X coverage dominates, while several platforms have fewer than 25 objects;
- retention of last-good rows makes freshness missing-not-at-random.

### Schema and measurement changes

- X older rows may aggregate reposts and quotes while newer rows split them;
- LinkedIn uses both `likes` and `reactions`, and four changed transitions show large decreases consistent with schema/collector correction;
- GitHub issue aliases vary (`issues`, `openIssues`, `open_issues`);
- Instagram exposes likes broadly but views/plays sparsely;
- follower/account-size fields are available only for selected sources and would encode collector/account bias.

## Achievable targets now

| Platform | Internally achievable today | Decision |
| --- | --- | --- |
| X | qualitative 14-day growth pilot on 10 changed pairs | far below support; no training/validation/test |
| GitHub | descriptive late-June→late-July star/fork change; 56 changed graph transitions | one acquisition wave, no 28-day pairs, repository age bug risk; unsupported |
| YouTube | descriptive view growth; 34 changed graph transitions | too small and no temporal test; unsupported |
| LinkedIn | no registered impressions outcome; 4 changed reaction transitions all include decreases | unsupported |
| Instagram | no changed graph-history counters; views/plays sparse | unsupported |
| HN, Reddit, Product Hunt | only 15 adjacent pairs combined, all graph-shared metrics identical | unsupported |
| Bilibili, Bluesky, TikTok | no internal longitudinal pairs | unsupported |
| Company aggregation | only V4-derived score histories | circular; unsupported |

Thus the only scientifically valid immediate use of internal histories is pipeline development, identity/timestamp tests, negative-result reporting, and prospective collector design. They cannot validate a V5 production scorer.

## Required data remediation

1. Export or query append-only `metric_observations`, `evidence_items`, attributions, ingestion runs, and immutable source manifests under authorized read-only credentials.
2. Persist a content hash for every raw collector artifact before graph construction.
3. Record one metric observation per real collection, including zero/unchanged values, source schema revision, and retained-last-good status.
4. Separate link check, import, first seen, native publication/update, metric observation, and graph-build timestamps.
5. Preserve GitHub `createdAt` as repository age; keep `pushedAt` as an as-of activity feature only.
6. Schedule registered `t1` captures rather than relying on opportunistic refreshes.
7. Capture deleted/private/unavailable outcomes as censoring states.
8. Collect non-selected posts or document the sampling frame to quantify survivorship/selection bias.
9. Rebuild the static graph manifest only after active canonical-evidence work stops, then validate every manifest hash.
10. Do not open final-test outcomes until the target, feature schema, candidate grid, and report code are frozen.

## Current input hashes

These SHA-256 values identify the exact committed `HEAD` blobs used at the audit cutoff (and the then-current unmodified base graph/benchmark files). Dirty collector work that changed concurrently was not substituted into the counts. These are audit fingerprints, not an accepted training-data manifest:

```text
17ac092622e9f801320ac6401c74d2d00b7e4d89b108d58de569ec0aa71e8285  public/graph/s2026.json
c8fd0c76429088900bd342ef2871f52d1635e38805f1cc88e9df92851b2a5180  public/graph/s26.json
9264fb166cdac49e59672b30160c161bab0a8d0ec68cdd2a49912cb119d8390f  public/graph/a16zsr006.json
d99750e7185e8420f3fe98c264866b1431509b26ab6734ff5ec53bf6498b89ba  public/graph/manifest.json
91d559da2fd9720a4ab9758b51a5d69d0f5154a0e33669ceacabe21726139153  src/lib/social/public-evidence-current.json
269a2ae743d5df52921726d3fefaef44f3ad8ebda59389ec5faf1a555ee734b9  src/lib/social/logged-in-evidence-current.json
4b7f2194726ea56bea467db30a4438dbf0a58771085e21974d533919005c5f9a  src/lib/social/targeted-evidence-current.json
07da09e11fd0b41730a54bfda2579a91eef860746fa2788c6e1d24d4ead014e5  src/lib/social/a16z-speedrun-006-social-evidence.json
1ba193059850cd423b0c610ca1041980f44ef40cb4d4bf8617be430286fe0d6e  src/lib/social/eden-robotics-verified-native-evidence.json
4b242a25386d71f8787c1a2241823f241b6d237611bb236726fcea7acc2eb2d0  src/lib/social/github-traction.json
bdc76127c349fd7569854c650b681b1bf934536ba3952f216bbbc1955fecfb76  src/lib/social/github-traction-summer-2026.json
d85314eb5f3cd7e8bb70dcc0390119749fff24b96d384818e811c491516d52c7  src/lib/social/github-traction-a16z-speedrun-006.json
790e78f737025ea65ac5bc6863fa21f2fd8ab82c6a696b8930fc92f545f4bf7b  outputs/benchmarks/a16zsr006-score-benchmarks.json
9a4400ed3a471b5fdfb64aa2f44d0d56b875cf585b1d4817dcca59b7ec2c9fb2  outputs/benchmarks/s2025-score-benchmarks.json
fc5b4219727136505e5080be72081043dbce59e8ec2810636bbffea319991b32  outputs/benchmarks/s2026-score-benchmarks.json
7dd9b0c2292c383f2bc13c04385cf65ad7f25ee465b6302068c4170959f7bc42  outputs/benchmarks/s26-score-benchmarks.json
6f0fdd6bafe85d7d29172ff4278a013d68e97cd8f53acd5025e2d3e84ad1617d  outputs/benchmarks/w2026-score-benchmarks.json
```

## Reproduction commands

Environment and inventory:

```bash
pwd
git status --short
git branch --show-current
git log --oneline -15
git diff --stat
git diff --check
find outputs -maxdepth 3 -type f -print | sort
find src/lib -maxdepth 4 -type f -name '*.json' -print | sort
rg -n --glob 'supabase/**' --glob 'src/**' --glob 'scripts/**' \
  'metric_observations|scoring_runs|first_seen_at|observedAt|metricsCheckedAt|last_checked_at'
```

Credential-presence check (prints no secret values):

```bash
export PATH='/Users/allenxu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:'"$PATH"
node -e 'for (const k of ["NEXT_PUBLIC_SUPABASE_URL","SUPABASE_SERVICE_ROLE_KEY","NEXT_PUBLIC_SUPABASE_ANON_KEY"]) console.log(`${k}=${process.env[k]?"set":"unset"}`)'
```

Current graph/source counts:

```bash
for f in public/graph/s2026.json public/graph/s26.json public/graph/a16zsr006.json; do
  jq -c '{generatedAt,scoringContext,evidence:(.evidence|length),companies:([.nodes[]|select(.entityType=="company")]|length)}' "$f"
done
jq -c '{source,evidence:(.evidence|length),needsReview:(.needsReview|length),failures:(.failures|length)}' src/lib/social/public-evidence-current.json
jq -c '{source,evidence:(.evidence|length),needsReview:(.needsReview|length),failures:(.failures|length)}' src/lib/social/logged-in-evidence-current.json
jq -c '{source,evidence:(.evidence|length),needsReview:(.needsReview|length)}' src/lib/social/targeted-evidence-current.json
```

Git history scope:

```bash
for f in public/graph/s2026.json public/graph/s26.json public/graph/a16zsr006.json; do
  git rev-list --reverse HEAD -- "$f" | wc -l
done
```

The longitudinal audit used an inline Node script with `git rev-list --reverse HEAD -- <file>` and `git show <revision>:<file>`, the timestamp priority and rejection rules documented above, stable native-ID/URL keys, and maps keyed by `(canonical audit key, observed timestamp)`. It then sorted readings by timestamp and counted adjacent transitions; horizon matches used absolute differences of 24h±6h, 72h±12h, 7d±24h, 14d±48h, and 30d±72h. No source file was written or changed by the script.

Benchmark counts were reproduced with:

```bash
export PATH='/Users/allenxu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:'"$PATH"
node <<'NODE'
const fs = require('fs');
for (const file of fs.readdirSync('outputs/benchmarks').filter(x => x.endsWith('.json')).sort()) {
  const data = JSON.parse(fs.readFileSync(`outputs/benchmarks/${file}`));
  const snapshots = [...(data.daily || []), ...(data.weekly || [])];
  const unique = new Map(snapshots.map(x => [`${x.recordedAt}|${x.scoringModelVersion || 'legacy'}`, x]));
  const byCompany = new Map();
  for (const snapshot of unique.values()) for (const company of snapshot.companies || []) {
    byCompany.set(company.companyId, [...(byCompany.get(company.companyId) || []), snapshot]);
  }
  console.log(file, unique.size,
    [...unique.values()].reduce((n, x) => n + (x.companies || []).length, 0),
    [...byCompany.values()].reduce((n, x) => n + Math.max(0, x.length - 1), 0));
}
NODE
```

Hashes:

```bash
shasum -a 256 \
  public/graph/s2026.json public/graph/s26.json public/graph/a16zsr006.json public/graph/manifest.json \
  src/lib/social/public-evidence-current.json src/lib/social/logged-in-evidence-current.json \
  src/lib/social/targeted-evidence-current.json src/lib/social/a16z-speedrun-006-social-evidence.json \
  src/lib/social/eden-robotics-verified-native-evidence.json src/lib/social/github-traction.json \
  src/lib/social/github-traction-summer-2026.json src/lib/social/github-traction-a16z-speedrun-006.json \
  outputs/benchmarks/*.json
```

## Final conclusion

The repository is ready to **collect** scientifically usable longitudinal data, but the accessible local data is not ready to **validate** V5. The honest release decision is:

- preserve V4 unchanged as baseline and rollback;
- implement and test deterministic provenance/dataset plumbing;
- prospectively capture the registered `t0/t1` windows;
- keep every current platform V5-unscored unless compatible external benchmark data independently passes the source, feature, split, and held-out gates;
- do not learn company aggregation from V4 score histories;
- do not use current graph snapshots as though 649 candidate transitions were 649 independent training examples.
