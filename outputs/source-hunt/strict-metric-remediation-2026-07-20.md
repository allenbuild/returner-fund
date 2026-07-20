# Strict metric remediation allowlist — 2026-07-20

Scope: read-only remediation audit of the 164 current graph-visible rows identified in canonical-evidence-audit-2026-07-20.md. This artifact does not modify canonical evidence, scoring formulas or weights, UI/taxonomy files, or public snapshots.

## Outcome

- Exact flagged rows: **164**.
- Rows retaining at least one positive supported scoring metric after metadata removal/alias normalization: **164**.
- Rows rendered metricless and requiring quarantine for this reason: **0**.
- Native URL-derived post/repository ID matches supplied platformPostId: **164/164**.
- Batch-roster entity attribution and founder-to-company attachment match: **164/164**.
- Canonical rows implicated: **30** in targeted-evidence-current.json; **134** in a16z-speedrun-006-social-evidence.json.
- No claim of a fresh network re-fetch is made here. Native ID match is a structural URL-to-ID check; attribution match means the canonical row selected by URL+ID+metrics resolves to the graph entity in the declared batch roster.

## Counts by batch and platform

| Batch | Platform | Rows |
| --- | --- | ---: |
| S2026 | github | 8 |
| S26 | linkedin | 15 |
| S26 | github | 7 |
| A16ZSR006 | x | 25 |
| A16ZSR006 | youtube | 16 |
| A16ZSR006 | github | 11 |
| A16ZSR006 | linkedin | 4 |
| A16ZSR006 | instagram | 78 |
| **Total** |  | **164** |

## Unsupported metadata keys

| Key currently inside metrics | Rows | Deterministic destination outside metrics |
| --- | ---: | --- |
| authorFollowers | 19 | sourceMetadata.authorFollowers |
| commits | 1 | sourceMetadata.totalCommits (do not alias to recent_commits_30d without bounded-window proof) |
| language | 9 | sourceMetadata.repositoryLanguage |
| lastActivityAt | 11 | sourceMetadata.lastActivityAt |
| metricSource | 119 | sourceMetadata.metricSource |
| network | 3 | sourceMetadata.network |
| repository_size_kb | 2 | sourceMetadata.repositorySizeKb |
| sizeKb | 3 | sourceMetadata.repositorySizeKb |

The row count is 164 while metadata-key occurrences total 167: the three S2026 Zenbu/DripPay GitHub rows each contain both network and sizeKb.

Canonical-source correction: four A16Z graph rows exposed `followers`, but their exact canonical rows contain `language` instead. This source-only remediation therefore moves all nine canonical `language` values to `sourceMetadata.repositoryLanguage` and never synthesizes a `followers` value. The graph also showed `issues=9` for `github:modaic-ai/modaic`, while the pinned canonical row has `openIssues=10`, `open_issues=10`, and `issues=10`; canonical alias normalization retains `issues=10`. These five graph/source discrepancies do not change the 164-row allowlist or the 167 metadata-field total.

## Deterministic source-only cleanup procedure

1. Freeze canonical writers and verify the canonical and graph SHA-256 values recorded below before acting; abort on drift and regenerate this allowlist from the settled files.
2. Mutate only the exact canonical JSON pointers in the allowlist. Guard each mutation with canonical file, URL-derived physical identity, entity attribution, current metric key/value set, and canonical id where present; abort rather than fall back to array index alone.
3. Normalize accepted aliases only: plays to views, points to upvotes, retweets to reposts, openIssues/open_issues to issues, X comments to replies, X saves to bookmarks, and LinkedIn likes to reactions. When aliases collide, retain the maximum verified numeric observation.
4. Copy each listed metadata field to the indicated sourceMetadata field, preserving its value verbatim, then remove it from metrics. Do not reinterpret total commits as recent_commits_30d; do not turn followers, repository size, language, or timestamps into scoring signals.
5. Re-run native URL-to-post-ID validation, batch/entity attribution, canonical physical-identity dedupe, and positive supported scoring-metric validation. A row with no positive supported scoring metric must move to needsReview, set review_state=needs_review, contribute zero, and record no_positive_supported_metric_after_metadata_cleanup.
6. For the settled files audited here, the expected result is 164 retained and zero metricless quarantines. Any other result is a fail-closed drift signal.
7. Run focused source-ingestion/graph eligibility tests. Regenerate public snapshots only after canonical writers are idle and through the existing release workflow.

The follow-up remediation is implemented by `scripts/remediate-strict-metrics.mjs`, which consumes this exact allowlist and implements the fail-closed guards above. It does not scan-and-rewrite arbitrary metric keys globally.

## Input fingerprints

| File | SHA-256 / generatedAt |
| --- | --- |
| src/lib/social/public-evidence-current.json | e17ae962cd0da5db29b9bbd9d7fe3d409a5396e8ab5b7aa202ac5a1b38196d16 |
| src/lib/social/logged-in-evidence-current.json | 269a2ae743d5df52921726d3fefaef44f3ad8ebda59389ec5faf1a555ee734b9 |
| src/lib/social/targeted-evidence-current.json | f0ea272ff51359124da86a65c26a254e83bd6a33103f3db4d94be787836ef461 |
| src/lib/social/a16z-speedrun-006-social-evidence.json | 52d478ca7c3662cae7fad30235e75a04e46e991901e4c7fcefa920c8c8814d71 |
| public/graph/s2026.json | 17ac092622e9f801320ac6401c74d2d00b7e4d89b108d58de569ec0aa71e8285; generatedAt 2026-07-20T08:27:39.302Z |
| public/graph/s26.json | c8fd0c76429088900bd342ef2871f52d1635e38805f1cc88e9df92851b2a5180; generatedAt 2026-07-20T08:27:41.765Z |
| public/graph/a16zsr006.json | 9264fb166cdac49e59672b30160c161bab0a8d0ec68cdd2a49912cb119d8390f; generatedAt 2026-07-20T08:27:42.886Z |

## Exact row allowlist

JSON pointers are zero-based and bind to the input fingerprints above. Canonical ID is the source row id; A16Z rows currently have no canonical id, so their JSON pointer plus physical identity is the exact guard. I/A=match/match means native URL-derived identity and roster attribution both passed. Every row disposition is keep after moving metadata because every row retains positive supported scoring metrics.

| # | Batch | Platform | Canonical JSON pointer | Canonical ID | Graph ID | Entity | Physical identity | Positive supported scoring metrics remaining | Move outside metrics | I/A | Disposition |
| ---: | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | S2026 | github | src/lib/social/targeted-evidence-current.json#/evidence/51 | github-ninth-pass-s2026-company-zenbu-2-zenbu-labs-zenbu-labs-zenbu-js | ev-4w | company-zenbu-2 | github:zenbu-labs/zenbu.js | stars=250, forks=25, issues=29, recent_commits_30d=1 | network, sizeKb | match/match | keep |
| 2 | S2026 | github | src/lib/social/targeted-evidence-current.json#/evidence/18 | github-all_batches_nonx_nonlinkedin_sol_ultra-s2026-company-advanced-metal-research-gradient-industrial-robotics-gradient-industrial-robotics-gradientos | ev-ds | company-advanced-metal-research | github:gradient-industrial-robotics/GradientOS | stars=23, forks=8 | lastActivityAt | match/match | keep |
| 3 | S2026 | github | src/lib/social/targeted-evidence-current.json#/evidence/50 | github-ninth-pass-s2026-company-zenbu-2-zenbu-labs-zenbu-labs-zenbu-release | ev-iu | company-zenbu-2 | github:zenbu-labs/zenbu-release | stars=12, forks=5, issues=3 | network, sizeKb | match/match | keep |
| 4 | S2026 | github | src/lib/social/targeted-evidence-current.json#/evidence/11 | github-ninth-pass-s2026-company-drippay-dripycx26-dripycx26-drip-sdk | ev-ky | company-drippay | github:DripYCx26/drip-sdk | stars=21, forks=2, issues=4 | network, sizeKb | match/match | keep |
| 5 | S2026 | github | src/lib/social/targeted-evidence-current.json#/evidence/3 | github-all_batches_nonx_nonlinkedin_sol_ultra-s2026-company-ara-aradotso-aradotso-security-skills | ev-rq | company-ara | github:Aradotso/security-skills | stars=7, forks=1 | lastActivityAt | match/match | keep |
| 6 | S2026 | github | src/lib/social/targeted-evidence-current.json#/evidence/2 | github-all_batches_nonx_nonlinkedin_sol_ultra-s2026-company-ara-aradotso-aradotso-data-skills | ev-12c | company-ara | github:Aradotso/data-skills | stars=2, forks=1 | lastActivityAt | match/match | keep |
| 7 | S2026 | github | src/lib/social/targeted-evidence-current.json#/evidence/46 | github-all_batches_nonx_nonlinkedin_sol_ultra-s2026-company-tolmo-tolmohq-tolmohq-tolmo | ev-14x | company-tolmo | github:tolmohq/tolmo | stars=4 | lastActivityAt | match/match | keep |
| 8 | S2026 | github | src/lib/social/targeted-evidence-current.json#/evidence/1 | github-source-hunt-company-ara-aradotso-ara-mcp | ev-1o4 | company-ara | github:Aradotso/ara-mcp | recent_commits_30d=1 | commits | match/match | keep |
| 9 | S26 | linkedin | src/lib/social/targeted-evidence-current.json#/evidence/248 | linkedin-ninth-pass-s26-founder-alloovium-zander-schweitzer-1a0651205-7467337043484790785 | ev-p | founder-alloovium-zander-schweitzer-3047254 | linkedin:7467337043484790785 | reactions=480, comments=194 | authorFollowers | match/match | keep |
| 10 | S26 | linkedin | src/lib/social/targeted-evidence-current.json#/evidence/347 | linkedin-ninth-pass-s26-founder-6thsense-james-baek1-7476073924280348672 | ev-14 | founder-6thsense-james-baek-3429291 | linkedin:7476073924280348672 | reactions=271, comments=84 | authorFollowers | match/match | keep |
| 11 | S26 | linkedin | src/lib/social/targeted-evidence-current.json#/evidence/266 | linkedin-ninth-pass-s26-founder-flowmanual-shijoonbae-7469855846215229440 | ev-17 | founder-flowmanual-david-shijoon-bae-3655483 | linkedin:7469855846215229440 | reactions=325, comments=85 | authorFollowers | match/match | keep |
| 12 | S26 | linkedin | src/lib/social/targeted-evidence-current.json#/evidence/390 | linkedin-ninth-pass-s26-founder-alloovium-cielo-nicolosi-7482524277809020930 | ev-18 | founder-alloovium-cielo-nicolosi-3650351 | linkedin:7482524277809020930 | reactions=261, comments=36 | authorFollowers | match/match | keep |
| 13 | S26 | linkedin | src/lib/social/targeted-evidence-current.json#/evidence/350 | linkedin-ninth-pass-s26-founder-edviro-hursh-shah-7476448773238325248 | ev-1g | founder-edviro-hursh-shah-3164154 | linkedin:7476448773238325248 | reactions=254, comments=59 | authorFollowers | match/match | keep |
| 14 | S26 | linkedin | src/lib/social/targeted-evidence-current.json#/evidence/388 | linkedin-ninth-pass-s26-founder-alloovium-zander-schweitzer-1a0651205-7482524117519454208 | ev-1i | founder-alloovium-zander-schweitzer-3047254 | linkedin:7482524117519454208 | reactions=234, comments=31 | authorFollowers | match/match | keep |
| 15 | S26 | linkedin | src/lib/social/targeted-evidence-current.json#/evidence/336 | linkedin-ninth-pass-s26-founder-atlas-discovery-shaamilkarim-7475279336908943361 | ev-21 | founder-atlas-discovery-shaamil-karim-774885 | linkedin:7475279336908943361 | reactions=160, comments=38 | authorFollowers | match/match | keep |
| 16 | S26 | linkedin | src/lib/social/targeted-evidence-current.json#/evidence/249 | linkedin-ninth-pass-s26-company-alloovium-alloovium-7467348701171200000 | ev-37 | company-alloovium | linkedin:7467348701171200000 | reactions=152, comments=9 | authorFollowers | match/match | keep |
| 17 | S26 | linkedin | src/lib/social/targeted-evidence-current.json#/evidence/270 | linkedin-ninth-pass-s26-founder-care-gp-melvinchen-7470676175162482688 | ev-38 | founder-care-gp-melvin-chen-1162884 | linkedin:7470676175162482688 | reactions=136, comments=13 | authorFollowers | match/match | keep |
| 18 | S26 | linkedin | src/lib/social/targeted-evidence-current.json#/evidence/351 | linkedin-ninth-pass-s26-founder-6thsense-james-baek1-7476595024709775360 | ev-3m | founder-6thsense-james-baek-3429291 | linkedin:7476595024709775360 | reactions=73, comments=16 | authorFollowers | match/match | keep |
| 19 | S26 | github | src/lib/social/targeted-evidence-current.json#/evidence/35 | github-all_batches_nonx_nonlinkedin_sol_ultra-s26-company-screenpipe-screenpipe-screenpipe-audiopipe | ev-41 | company-screenpipe | github:screenpipe/audiopipe | stars=27, forks=9 | lastActivityAt | match/match | keep |
| 20 | S26 | github | src/lib/social/targeted-evidence-current.json#/evidence/19 | github-all_batches_nonx_nonlinkedin_sol_ultra-s26-company-inkbox-inkbox-ai-inkbox-ai-hermes-agent-plugin | ev-4i | company-inkbox | github:inkbox-ai/hermes-agent-plugin | stars=26, forks=7, issues=4 | lastActivityAt | match/match | keep |
| 21 | S26 | github | src/lib/social/targeted-evidence-current.json#/evidence/20 | github-all_batches_nonx_nonlinkedin_sol_ultra-s26-company-inkbox-inkbox-ai-inkbox-ai-inkbox | ev-4m | company-inkbox | github:inkbox-ai/inkbox | stars=29, forks=3, issues=2 | lastActivityAt | match/match | keep |
| 22 | S26 | linkedin | src/lib/social/targeted-evidence-current.json#/evidence/241 | linkedin-ninth-pass-s26-company-care-gp-caregp-7467033690557030400 | ev-52 | company-care-gp | linkedin:7467033690557030400 | reactions=66, comments=7 | authorFollowers | match/match | keep |
| 23 | S26 | github | src/lib/social/targeted-evidence-current.json#/evidence/36 | github-all_batches_nonx_nonlinkedin_sol_ultra-s26-company-screenpipe-screenpipe-screenpipe-sck-rs | ev-5a | company-screenpipe | github:screenpipe/sck-rs | stars=16, forks=6, issues=1 | lastActivityAt | match/match | keep |
| 24 | S26 | linkedin | src/lib/social/targeted-evidence-current.json#/evidence/349 | linkedin-ninth-pass-s26-company-flowmanual-flowmanual-7476435685877514240 | ev-5g | company-flowmanual | linkedin:7476435685877514240 | reactions=37, comments=7 | authorFollowers | match/match | keep |
| 25 | S26 | linkedin | src/lib/social/targeted-evidence-current.json#/evidence/342 | linkedin-ninth-pass-s26-company-6thsense-6thsenseai-7475926279578361856 | ev-5r | company-6thsense | linkedin:7475926279578361856 | reactions=49, comments=2 | authorFollowers | match/match | keep |
| 26 | S26 | linkedin | src/lib/social/targeted-evidence-current.json#/evidence/389 | linkedin-ninth-pass-s26-founder-edviro-hursh-shah-7482524117611589634 | ev-5s | founder-edviro-hursh-shah-3164154 | linkedin:7482524117611589634 | reactions=32, comments=5 | authorFollowers | match/match | keep |
| 27 | S26 | github | src/lib/social/targeted-evidence-current.json#/evidence/37 | github-all_batches_nonx_nonlinkedin_sol_ultra-s26-company-screenpipe-screenpipe-screenpipe-screenleak | ev-6j | company-screenpipe | github:screenpipe/screenleak | stars=21 | lastActivityAt | match/match | keep |
| 28 | S26 | linkedin | src/lib/social/targeted-evidence-current.json#/evidence/271 | linkedin-ninth-pass-s26-company-care-gp-caregp-7470676358583742465 | ev-8d | company-care-gp | linkedin:7470676358583742465 | reactions=21, comments=2 | authorFollowers | match/match | keep |
| 29 | S26 | github | src/lib/social/targeted-evidence-current.json#/evidence/25 | github-all_batches_nonx_nonlinkedin_sol_ultra-s26-company-nebula-security-nebusec-nebusec-vega-skill | ev-9w | company-nebula-security | github:NebuSec/vega-skill | stars=4, forks=1 | lastActivityAt | match/match | keep |
| 30 | S26 | github | src/lib/social/targeted-evidence-current.json#/evidence/6 | github-all_batches_nonx_nonlinkedin_sol_ultra-s26-company-coasty-coasty-ai-coasty-ai-computer-use-cookbook | ev-cz | company-coasty | github:coasty-ai/computer-use-cookbook | stars=3 | lastActivityAt | match/match | keep |
| 31 | A16ZSR006 | x | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/228 | — | ev-0 | a16z-speedrun-006-oasis-founder-stefano-fantini-delmanto | x:2078180286441955781 | views=2137921, likes=2402, replies=619, reposts=359, quotes=73 | metricSource | match/match | keep |
| 32 | A16ZSR006 | youtube | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/238 | — | ev-6 | a16z-speedrun-006-snag | youtube:7LtqePPA4-c | views=182238, likes=27 | metricSource | match/match | keep |
| 33 | A16ZSR006 | youtube | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/233 | — | ev-c | a16z-speedrun-006-snag | youtube:-WlUGwSyjM0 | views=81698, likes=77 | metricSource | match/match | keep |
| 34 | A16ZSR006 | github | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/12 | — | ev-k | a16z-speedrun-006-modaic | github:modaic-ai/gepa-viz | stars=417, forks=29 | language | match/match | keep |
| 35 | A16ZSR006 | linkedin | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/120 | — | ev-l | a16z-speedrun-006-taxnova-founder-george-nichkov | linkedin:7424452124068970496 | reactions=792, comments=272 | authorFollowers | match/match | keep |
| 36 | A16ZSR006 | x | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/210 | — | ev-o | a16z-speedrun-006-mirror-mirror-ai-founder-yusan-lin | x:2036116119900262418 | views=234637, likes=868, replies=113, reposts=63, quotes=37 | metricSource | match/match | keep |
| 37 | A16ZSR006 | linkedin | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/121 | — | ev-q | a16z-speedrun-006-taxnova-founder-maria-malykh | linkedin:7424466196000894977 | reactions=625, comments=157 | authorFollowers | match/match | keep |
| 38 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/42 | — | ev-s | a16z-speedrun-006-mirror-mirror-ai-founder-yusan-lin | instagram:Da9FP68vX_n | likes=384, comments=5, views=18174 | metricSource | match/match | keep |
| 39 | A16ZSR006 | x | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/202 | — | ev-19 | a16z-speedrun-006-mirror-mirror-ai-founder-yusan-lin | x:1977766975901401156 | views=75105, likes=438, replies=63, reposts=15, quotes=7 | metricSource | match/match | keep |
| 40 | A16ZSR006 | x | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/190 | — | ev-1b | a16z-speedrun-006-mirror-mirror-ai-founder-yusan-lin | x:1792971280188318068 | views=80513, likes=205, replies=17, reposts=8, quotes=6 | metricSource | match/match | keep |
| 41 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/56 | — | ev-1g | a16z-speedrun-006-idilio | instagram:Daxohh-CNMT | likes=135, comments=23 | metricSource | match/match | keep |
| 42 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/105 | — | ev-1h | a16z-speedrun-006-mirror-mirror-ai | instagram:DZaUqGAB-5G | likes=286, comments=16 | metricSource | match/match | keep |
| 43 | A16ZSR006 | github | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/6 | — | ev-1k | a16z-speedrun-006-safeworld | github:firetix/vibe-coding-penetration-tester | stars=172, forks=34, issues=12 | language | match/match | keep |
| 44 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/18 | — | ev-1l | a16z-speedrun-006-idilio | instagram:Da0f3QakSvB | likes=139, comments=14 | metricSource | match/match | keep |
| 45 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/103 | — | ev-1m | a16z-speedrun-006-clair-health | instagram:DZ8Wf2FErOl | likes=183, comments=20 | metricSource | match/match | keep |
| 46 | A16ZSR006 | x | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/191 | — | ev-1o | a16z-speedrun-006-mirror-mirror-ai | x:1924612293234720996 | views=51972, likes=38, replies=2, reposts=5, quotes=1 | metricSource | match/match | keep |
| 47 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/50 | — | ev-1p | a16z-speedrun-006-clair-health | instagram:DaRapnJFMaP | likes=167, comments=8 | metricSource | match/match | keep |
| 48 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/109 | — | ev-1q | a16z-speedrun-006-mirror-mirror-ai | instagram:DZqrQQdCJOa | likes=232, comments=8 | metricSource | match/match | keep |
| 49 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/46 | — | ev-1u | a16z-speedrun-006-antihero-studios | instagram:DakwYe7jCHj | likes=148, comments=9 | metricSource | match/match | keep |
| 50 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/100 | — | ev-1v | a16z-speedrun-006-antihero-studios | instagram:DYXDbsODCi8 | likes=270, comments=18 | metricSource | match/match | keep |
| 51 | A16ZSR006 | youtube | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/264 | — | ev-1y | a16z-speedrun-006-antihero-studios | youtube:HwKIvuXrMaY | views=973, likes=87 | metricSource | match/match | keep |
| 52 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/102 | — | ev-1z | a16z-speedrun-006-clair-health | instagram:DZ_Ltqxj_bu | likes=148, comments=12 | metricSource | match/match | keep |
| 53 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/106 | — | ev-20 | a16z-speedrun-006-clair-health | instagram:DZK7spYkVmJ | likes=184, comments=13 | metricSource | match/match | keep |
| 54 | A16ZSR006 | x | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/200 | — | ev-25 | a16z-speedrun-006-syncere-founder-aaron-tan | x:1964813707369931048 | views=19910, likes=164, replies=19, reposts=3, quotes=1 | metricSource | match/match | keep |
| 55 | A16ZSR006 | youtube | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/239 | — | ev-26 | a16z-speedrun-006-antihero-studios | youtube:7MIxbkStjMQ | views=1537, likes=56 | metricSource | match/match | keep |
| 56 | A16ZSR006 | youtube | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/249 | — | ev-27 | a16z-speedrun-006-antihero-studios | youtube:Chy4Uh_tPFU | views=1956, likes=42 | metricSource | match/match | keep |
| 57 | A16ZSR006 | github | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/13 | — | ev-28 | a16z-speedrun-006-modaic | github:modaic-ai/microcode | stars=60, forks=5 | language | match/match | keep |
| 58 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/60 | — | ev-29 | a16z-speedrun-006-snag-founder-selin-sonmez | instagram:DIkJC8Vp-Gl | likes=152, comments=95 | metricSource | match/match | keep |
| 59 | A16ZSR006 | linkedin | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/117 | — | ev-2a | a16z-speedrun-006-sentra-founder-ashwin-gopinath | linkedin:7422324732504686593 | reactions=159, comments=22 | authorFollowers | match/match | keep |
| 60 | A16ZSR006 | x | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/197 | — | ev-2c | a16z-speedrun-006-syncere-founder-aaron-tan | x:1959722867030933791 | views=24081, likes=48, replies=6, reposts=5, quotes=3 | metricSource | match/match | keep |
| 61 | A16ZSR006 | youtube | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/247 | — | ev-2d | a16z-speedrun-006-snag | youtube:CaWO2pxLA4w | views=3696, likes=5 | metricSource | match/match | keep |
| 62 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/51 | — | ev-2e | a16z-speedrun-006-idilio | instagram:DatkRrHEtdI | likes=96, comments=4 | metricSource | match/match | keep |
| 63 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/71 | — | ev-2g | a16z-speedrun-006-omi-health | instagram:DUT7XpEDXA0 | likes=263, comments=18 | metricSource | match/match | keep |
| 64 | A16ZSR006 | linkedin | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/149 | — | ev-2k | a16z-speedrun-006-sentra-founder-andrey-starenky | linkedin:7449968966829236224 | reactions=114, comments=10 | authorFollowers | match/match | keep |
| 65 | A16ZSR006 | x | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/193 | — | ev-2n | a16z-speedrun-006-syncere-founder-aaron-tan | x:1950380257925878142 | views=12042, likes=65, replies=7, reposts=2, quotes=1 | metricSource | match/match | keep |
| 66 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/53 | — | ev-2o | a16z-speedrun-006-idilio | instagram:DavT0h0ic9f | likes=81 | metricSource | match/match | keep |
| 67 | A16ZSR006 | x | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/192 | — | ev-2r | a16z-speedrun-006-mirror-mirror-ai | x:1940430145229308160 | views=12008, likes=10, replies=2, reposts=2 | metricSource | match/match | keep |
| 68 | A16ZSR006 | x | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/206 | — | ev-2s | a16z-speedrun-006-antihero-studios | x:2021632259972014138 | views=4152, likes=107, replies=11, reposts=14 | metricSource | match/match | keep |
| 69 | A16ZSR006 | github | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/15 | — | ev-2t | a16z-speedrun-006-modaic | github:modaic-ai/modaic | stars=27, forks=1, issues=10 | language | match/match | keep |
| 70 | A16ZSR006 | github | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/11 | — | ev-2u | a16z-speedrun-006-modaic | github:modaic-ai/gepa-rpc | stars=36, forks=2 | language | match/match | keep |
| 71 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/21 | — | ev-2v | a16z-speedrun-006-antihero-studios | instagram:Da2ss8zDD9W | likes=54, comments=5 | metricSource | match/match | keep |
| 72 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/64 | — | ev-2w | a16z-speedrun-006-antihero-studios | instagram:DPTAEA5jM-q | likes=220, comments=8 | metricSource | match/match | keep |
| 73 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/70 | — | ev-2x | a16z-speedrun-006-smart-bricks | instagram:DUlQf7Njex- | likes=92, comments=26 | metricSource | match/match | keep |
| 74 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/86 | — | ev-2y | a16z-speedrun-006-snag-founder-selin-sonmez | instagram:DWw6UJXEkHJ | likes=98, comments=20 | metricSource | match/match | keep |
| 75 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/59 | — | ev-33 | a16z-speedrun-006-omi-health | instagram:DayUb-QJ4Ir | likes=52, comments=3 | metricSource | match/match | keep |
| 76 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/81 | — | ev-34 | a16z-speedrun-006-snag-founder-selin-sonmez | instagram:DWnexjOAqgi | likes=98, comments=16 | metricSource | match/match | keep |
| 77 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/66 | — | ev-37 | a16z-speedrun-006-omi-health | instagram:DT8-cKRAbmO | likes=130, comments=12 | metricSource | match/match | keep |
| 78 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/98 | — | ev-38 | a16z-speedrun-006-omi-health | instagram:DYN19WEjZjI | likes=90, comments=5 | metricSource | match/match | keep |
| 79 | A16ZSR006 | x | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/201 | — | ev-39 | a16z-speedrun-006-antihero-studios | x:1966276406813536426 | views=5585, likes=65, replies=2, reposts=6, quotes=1 | metricSource | match/match | keep |
| 80 | A16ZSR006 | youtube | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/245 | — | ev-3b | a16z-speedrun-006-antihero-studios | youtube:BrT0gZvHDcg | views=944, likes=24 | metricSource | match/match | keep |
| 81 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/31 | — | ev-3e | a16z-speedrun-006-clair-health | instagram:Da5-2-DB_4L | likes=36, comments=4, views=1599 | metricSource | match/match | keep |
| 82 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/77 | — | ev-3f | a16z-speedrun-006-syncere | instagram:DW4VYvfidcr | likes=76, comments=10 | metricSource | match/match | keep |
| 83 | A16ZSR006 | x | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/198 | — | ev-3j | a16z-speedrun-006-quo-labs | x:1961702586953994634 | views=6722, likes=15, replies=4, reposts=1 | metricSource | match/match | keep |
| 84 | A16ZSR006 | x | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/205 | — | ev-3k | a16z-speedrun-006-antihero-studios | x:1982515750805086351 | views=3900, likes=40, replies=11, reposts=4, quotes=3 | metricSource | match/match | keep |
| 85 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/36 | — | ev-3p | a16z-speedrun-006-sun-founder-artin-bogdanov | instagram:Da5r6ONJJvs | likes=41, comments=1, views=911 | metricSource | match/match | keep |
| 86 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/48 | — | ev-3q | a16z-speedrun-006-snag | instagram:DaoRb1hyxy9 | likes=38, comments=3 | metricSource | match/match | keep |
| 87 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/69 | — | ev-3r | a16z-speedrun-006-antihero-studios | instagram:DUlJzPSDG69 | likes=94, comments=8 | metricSource | match/match | keep |
| 88 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/85 | — | ev-3s | a16z-speedrun-006-snag-founder-selin-sonmez | instagram:DWVTVmPglfx | likes=87, comments=7 | metricSource | match/match | keep |
| 89 | A16ZSR006 | x | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/204 | — | ev-3u | a16z-speedrun-006-mirror-mirror-ai | x:1981770810454159840 | views=6155, likes=15, replies=2, reposts=3 | metricSource | match/match | keep |
| 90 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/23 | — | ev-3v | a16z-speedrun-006-idilio | instagram:Da3Im_6kdC3 | likes=42, views=4338 | metricSource | match/match | keep |
| 91 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/90 | — | ev-3w | a16z-speedrun-006-mirror-mirror-ai | instagram:DXfsUKHkewR | likes=62, comments=5 | metricSource | match/match | keep |
| 92 | A16ZSR006 | x | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/211 | — | ev-40 | a16z-speedrun-006-sentra | x:2036513220857352289 | views=2202, likes=28, replies=5, reposts=8 | metricSource | match/match | keep |
| 93 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/52 | — | ev-47 | a16z-speedrun-006-snag | instagram:DatncUayTn1 | likes=32, comments=1 | metricSource | match/match | keep |
| 94 | A16ZSR006 | x | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/207 | — | ev-4a | a16z-speedrun-006-sirius-technology | x:2029014985108754794 | views=2572, likes=16, replies=5, reposts=2, quotes=1 | metricSource | match/match | keep |
| 95 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/22 | — | ev-4d | a16z-speedrun-006-idilio | instagram:Da3IjF5ALWH | likes=34, views=3049 | metricSource | match/match | keep |
| 96 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/24 | — | ev-4e | a16z-speedrun-006-idilio | instagram:Da3IzIwAGDD | likes=34, views=2784 | metricSource | match/match | keep |
| 97 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/47 | — | ev-4f | a16z-speedrun-006-snapp-stats | instagram:DalUCOXh2AB | likes=6, comments=7 | metricSource | match/match | keep |
| 98 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/38 | — | ev-4g | a16z-speedrun-006-idilio | instagram:Da6PkazmxSj | likes=26, comments=1, views=1987 | metricSource | match/match | keep |
| 99 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/92 | — | ev-4h | a16z-speedrun-006-smart-bricks | instagram:DXoH_HXDVU5 | likes=20, comments=7 | metricSource | match/match | keep |
| 100 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/111 | — | ev-4i | a16z-speedrun-006-belong | instagram:DZXqQBLloOO | likes=18, comments=5 | metricSource | match/match | keep |
| 101 | A16ZSR006 | youtube | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/265 | — | ev-4l | a16z-speedrun-006-sun | youtube:HWO_-A7oWDc | views=729, likes=7 | metricSource | match/match | keep |
| 102 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/25 | — | ev-4m | a16z-speedrun-006-idilio | instagram:Da3JPClkfF4 | likes=29, views=1994 | metricSource | match/match | keep |
| 103 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/27 | — | ev-4n | a16z-speedrun-006-idilio | instagram:Da3JQo0lUgh | likes=29, views=2145 | metricSource | match/match | keep |
| 104 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/29 | — | ev-4o | a16z-speedrun-006-snapp-stats | instagram:Da3q_PqSmkm | likes=28, views=1432 | metricSource | match/match | keep |
| 105 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/104 | — | ev-4p | a16z-speedrun-006-sun-founder-artin-bogdanov | instagram:DZ9gf9bpUnR | likes=25, comments=2 | metricSource | match/match | keep |
| 106 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/35 | — | ev-4w | a16z-speedrun-006-idilio | instagram:Da5ng7iEaag | likes=26, views=2612 | metricSource | match/match | keep |
| 107 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/55 | — | ev-4x | a16z-speedrun-006-snapp-stats | instagram:DawPU49AJVj | likes=18, comments=2 | metricSource | match/match | keep |
| 108 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/93 | — | ev-4y | a16z-speedrun-006-smart-bricks | instagram:DXXAQxyDYFu | likes=25, comments=4 | metricSource | match/match | keep |
| 109 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/99 | — | ev-4z | a16z-speedrun-006-mirror-mirror-ai | instagram:DYOElNRkaXA | likes=29, comments=2 | metricSource | match/match | keep |
| 110 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/54 | — | ev-50 | a16z-speedrun-006-snag | instagram:Davtco5ygP5 | likes=26 | metricSource | match/match | keep |
| 111 | A16ZSR006 | x | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/222 | — | ev-53 | a16z-speedrun-006-sentra | x:2058986907850223963 | views=1086, likes=8 | metricSource | match/match | keep |
| 112 | A16ZSR006 | x | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/225 | — | ev-54 | a16z-speedrun-006-emanate | x:2070522000079208849 | views=459, likes=6, reposts=2, quotes=1 | metricSource | match/match | keep |
| 113 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/49 | — | ev-57 | a16z-speedrun-006-snag | instagram:DaqYuESyfKn | likes=24 | metricSource | match/match | keep |
| 114 | A16ZSR006 | github | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/7 | — | ev-5a | a16z-speedrun-006-quinn | github:MeetQuinn/anima | stars=3, issues=12 | repository_size_kb | match/match | keep |
| 115 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/75 | — | ev-5c | a16z-speedrun-006-pluvo | instagram:DVrIqwBk_4B | likes=31, comments=1 | metricSource | match/match | keep |
| 116 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/32 | — | ev-5d | a16z-speedrun-006-idilio | instagram:Da5-KPTDnVJ | likes=18, views=2116 | metricSource | match/match | keep |
| 117 | A16ZSR006 | x | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/221 | — | ev-5f | a16z-speedrun-006-sentra | x:2058221010642415640 | views=898, likes=4 | metricSource | match/match | keep |
| 118 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/30 | — | ev-5i | a16z-speedrun-006-snag | instagram:Da3twqGSBl6 | likes=3, comments=3, views=2397 | metricSource | match/match | keep |
| 119 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/65 | — | ev-5j | a16z-speedrun-006-pluvo | instagram:DRmKTMUgN6y | likes=24, comments=1 | metricSource | match/match | keep |
| 120 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/72 | — | ev-5k | a16z-speedrun-006-pluvo | instagram:DV0vcQEFHRI | likes=18, comments=2 | metricSource | match/match | keep |
| 121 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/78 | — | ev-5l | a16z-speedrun-006-belong | instagram:DW4ygJDDRCz | likes=21, comments=1 | metricSource | match/match | keep |
| 122 | A16ZSR006 | youtube | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/237 | — | ev-5o | a16z-speedrun-006-sun | youtube:42eSvpyKiJk | views=71, likes=6 | metricSource | match/match | keep |
| 123 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/58 | — | ev-5q | a16z-speedrun-006-snapp-stats | instagram:Dayg4sHv_hv | likes=10, comments=1 | metricSource | match/match | keep |
| 124 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/67 | — | ev-5r | a16z-speedrun-006-smart-bricks | instagram:DU-bMeijRUU | likes=25 | metricSource | match/match | keep |
| 125 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/79 | — | ev-5s | a16z-speedrun-006-belong | instagram:DW4yVpdjYgm | likes=15, comments=2 | metricSource | match/match | keep |
| 126 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/26 | — | ev-5v | a16z-speedrun-006-idilio | instagram:Da3JQ0njmn9 | likes=13, views=915 | metricSource | match/match | keep |
| 127 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/57 | — | ev-5w | a16z-speedrun-006-snapp-stats | instagram:DayD95hJKb- | likes=4, comments=2 | metricSource | match/match | keep |
| 128 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/74 | — | ev-5x | a16z-speedrun-006-pluvo | instagram:DVPISu_kn0U | likes=24 | metricSource | match/match | keep |
| 129 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/76 | — | ev-5y | a16z-speedrun-006-picpet | instagram:DW-AN_JATf- | likes=20 | metricSource | match/match | keep |
| 130 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/44 | — | ev-61 | a16z-speedrun-006-idilio | instagram:Da9Upd2jDqN | likes=12, views=903 | metricSource | match/match | keep |
| 131 | A16ZSR006 | youtube | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/302 | — | ev-64 | a16z-speedrun-006-sun | youtube:weMHJD_lQ_Y | views=76, likes=4 | metricSource | match/match | keep |
| 132 | A16ZSR006 | github | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/9 | — | ev-65 | a16z-speedrun-006-modaic | github:modaic-ai/ds.ts | stars=4 | language | match/match | keep |
| 133 | A16ZSR006 | github | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/10 | — | ev-66 | a16z-speedrun-006-modaic | github:modaic-ai/dspy-intellisense | stars=4 | language | match/match | keep |
| 134 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/34 | — | ev-67 | a16z-speedrun-006-snapp-stats | instagram:Da57Q5cBmsS | likes=6, comments=1, views=215 | metricSource | match/match | keep |
| 135 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/80 | — | ev-68 | a16z-speedrun-006-belong | instagram:DWhATrQjTYQ | likes=12, comments=1 | metricSource | match/match | keep |
| 136 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/87 | — | ev-69 | a16z-speedrun-006-picpet | instagram:DWXQ0BlEnuD | likes=12, comments=1 | metricSource | match/match | keep |
| 137 | A16ZSR006 | youtube | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/280 | — | ev-6d | a16z-speedrun-006-sun | youtube:PwRToG-32Jg | views=50, likes=4 | metricSource | match/match | keep |
| 138 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/39 | — | ev-6f | a16z-speedrun-006-snapp-stats | instagram:Da6PULkj2OH | likes=4, comments=1 | metricSource | match/match | keep |
| 139 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/88 | — | ev-6g | a16z-speedrun-006-picpet | instagram:DWXQwT-jibA | likes=8, comments=1 | metricSource | match/match | keep |
| 140 | A16ZSR006 | x | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/227 | — | ev-6i | a16z-speedrun-006-emanate | x:2075229899754004846 | views=89, likes=1, reposts=1 | metricSource | match/match | keep |
| 141 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/28 | — | ev-6j | a16z-speedrun-006-snapp-stats | instagram:Da3JzWVBJKQ | likes=3, comments=1, views=148 | metricSource | match/match | keep |
| 142 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/33 | — | ev-6k | a16z-speedrun-006-snapp-stats | instagram:Da526dyv09U | likes=3, comments=1, views=178 | metricSource | match/match | keep |
| 143 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/41 | — | ev-6l | a16z-speedrun-006-snag | instagram:Da8DniaARMi | likes=3, comments=1, views=3131 | metricSource | match/match | keep |
| 144 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/89 | — | ev-6m | a16z-speedrun-006-picpet | instagram:DWXQXxvlcNF | likes=7, comments=1 | metricSource | match/match | keep |
| 145 | A16ZSR006 | x | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/199 | — | ev-6n | a16z-speedrun-006-quo-labs | x:1963795435489026326 | views=92, likes=3, replies=2 | metricSource | match/match | keep |
| 146 | A16ZSR006 | x | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/203 | — | ev-6s | a16z-speedrun-006-quo-labs | x:1980194411410821223 | views=39, likes=6, replies=1 | metricSource | match/match | keep |
| 147 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/37 | — | ev-6w | a16z-speedrun-006-snapp-stats | instagram:Da6NVouSjPN | likes=2, comments=1, views=222 | metricSource | match/match | keep |
| 148 | A16ZSR006 | youtube | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/267 | — | ev-6z | a16z-speedrun-006-mirror-mirror-ai | youtube:iLH9o7Dwonc | views=121, likes=2 | metricSource | match/match | keep |
| 149 | A16ZSR006 | x | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/196 | — | ev-78 | a16z-speedrun-006-syncere-founder-angus-fung | x:1951039098954850773 | views=226, likes=1 | metricSource | match/match | keep |
| 150 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/40 | — | ev-7b | a16z-speedrun-006-snag | instagram:Da6ZEZvSOiJ | likes=3, views=1828 | metricSource | match/match | keep |
| 151 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/43 | — | ev-7c | a16z-speedrun-006-snag | instagram:Da9k4VbyCs8 | likes=3, views=574 | metricSource | match/match | keep |
| 152 | A16ZSR006 | github | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/14 | — | ev-7h | a16z-speedrun-006-modaic | github:modaic-ai/mo-reach | stars=1 | language | match/match | keep |
| 153 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/19 | — | ev-7i | a16z-speedrun-006-snag | instagram:Da1toCqARGL | likes=3, views=1729 | metricSource | match/match | keep |
| 154 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/20 | — | ev-7j | a16z-speedrun-006-snag | instagram:Da1ZmfzymHv | likes=3, views=48725 | metricSource | match/match | keep |
| 155 | A16ZSR006 | github | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/16 | — | ev-7l | a16z-speedrun-006-modaic | github:modaic-ai/optiglot | stars=1 | language | match/match | keep |
| 156 | A16ZSR006 | x | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/194 | — | ev-7n | a16z-speedrun-006-syncere-founder-angus-fung | x:1950405185270141333 | views=94, likes=1 | metricSource | match/match | keep |
| 157 | A16ZSR006 | x | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/195 | — | ev-7p | a16z-speedrun-006-syncere-founder-angus-fung | x:1950801793077657953 | views=33, likes=2 | metricSource | match/match | keep |
| 158 | A16ZSR006 | youtube | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/279 | — | ev-7t | a16z-speedrun-006-sun | youtube:pHTVgy_HSS0 | views=3, likes=1 | metricSource | match/match | keep |
| 159 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/107 | — | ev-80 | a16z-speedrun-006-hammock | instagram:DZn2wfVvxp7 | likes=1 | metricSource | match/match | keep |
| 160 | A16ZSR006 | instagram | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/110 | — | ev-81 | a16z-speedrun-006-hammock | instagram:DZsqbruRg1e | likes=1 | metricSource | match/match | keep |
| 161 | A16ZSR006 | github | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/8 | — | ev-85 | a16z-speedrun-006-quinn | github:MeetQuinn/quinn-sdk | issues=1 | repository_size_kb | match/match | keep |
| 162 | A16ZSR006 | youtube | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/296 | — | ev-8a | a16z-speedrun-006-smart-bricks | youtube:Tx9zc1vmvs8 | views=16 | metricSource | match/match | keep |
| 163 | A16ZSR006 | youtube | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/303 | — | ev-8c | a16z-speedrun-006-smart-bricks | youtube:xw36vMbixHo | views=12 | metricSource | match/match | keep |
| 164 | A16ZSR006 | youtube | src/lib/social/a16z-speedrun-006-social-evidence.json#/evidence/235 | — | ev-8d | a16z-speedrun-006-smart-bricks | youtube:2m6UZutFGe0 | views=5 | metricSource | match/match | keep |

## Validation performed

- Parsed all three current graph snapshots and all four loaded canonical evidence files.
- Selected each canonical source row by platform + canonical URL + normalized post ID; when the Care GP LinkedIn identity existed in both public and targeted evidence, exact metric equality selected targeted-evidence-current.json#/evidence/270 for the recorded fingerprint.
- Confirmed 164 exact canonical matches, 164 URL-to-ID matches, 164 roster-attribution matches, and 164 rows with a positive supported scoring metric after removing only the listed metadata.
- The original audit confirmed zero canonical evidence or public snapshot writes. The follow-up source-only remediation wrote only the two allowlisted canonical evidence files and did not regenerate a public snapshot.

## Remediation execution

- Exact guarded rows: **164** (**30** targeted, **134** A16Z); native identity, unique physical identity, batch/entity attribution, graph-roster attachment, and supported-metric guards passed **164/164**.
- Result: **164 retained**, **0 metricless**, **0 quarantined**.
- Metadata preservation: **167** verbatim values moved to the documented `sourceMetadata` destinations: `authorFollowers` 19, `commits` 1, `language` 9, `lastActivityAt` 11, `metricSource` 119, `network` 3, `repository_size_kb` 2, and `sizeKb` 3.
- Alias normalization: **83** documented source-key occurrences normalized: `openIssues` 24, `open_issues` 15, LinkedIn `likes` 19, `plays` 24, and `retweets` 1. No `points`, X `comments`, or X `saves` aliases occurred in the allowlisted rows. Alias collisions retained the maximum verified numeric observation.
- Targeted canonical SHA-256: `f0ea272ff51359124da86a65c26a254e83bd6a33103f3db4d94be787836ef461` → `17613c38ed0c9e80341e490ec78f10652fdeee199c03068fc6f0b3ce21379f6a`.
- A16Z canonical SHA-256: `52d478ca7c3662cae7fad30235e75a04e46e991901e4c7fcefa920c8c8814d71` → `423681da6acfb9ae62470169be4dd54a7c776f6904c990db8a54a1663cee56b6`.
- The strict post-write rerun was idempotent: **0** pending rows, metadata moves, aliases, or quarantines.
- Public graph snapshot hashes remained `17ac092622e9f801320ac6401c74d2d00b7e4d89b108d58de569ec0aa71e8285` (S2026), `c8fd0c76429088900bd342ef2871f52d1635e38805f1cc88e9df92851b2a5180` (S26), and `9264fb166cdac49e59672b30160c161bab0a8d0ec68cdd2a49912cb119d8390f` (A16ZSR006).
- Machine-readable audit: `outputs/source-hunt/strict-metric-remediation-audit-2026-07-20.json`.
