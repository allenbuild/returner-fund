# Long Run Final Report

## Run Summary

- Generated at: 2026-06-29T09:32:35.010Z.
- Started at: 2026-06-28T02:13:20-05:00.
- Total elapsed time: 26h 19m.
- Six-hour target reached: yes.
- Current orchestration status: stopped after six-hour target and final verification; resumable from checkpoints.
- Latest orchestration event: command_started in outputs\longrun\background-2026-06-28T09-11-37-190Z.json.

## Final Verification

- Status: pass.
- Commands: 14/14 passed; 0 required failures.
- Finished at: 2026-06-29T09:31:49.664Z; elapsed 243s.
- typecheck: pass (3s), logs outputs\final-verification\2026-06-29T09-27-46-343Z\typecheck.stdout.log
- tests: pass (49s), logs outputs\final-verification\2026-06-29T09-27-46-343Z\tests.stdout.log
- build: pass (79s), logs outputs\final-verification\2026-06-29T09-27-46-343Z\build.stdout.log
- coverage_report: pass (2s), logs outputs\final-verification\2026-06-29T09-27-46-343Z\coverage-report.stdout.log
- workers_report: pass (1s), logs outputs\final-verification\2026-06-29T09-27-46-343Z\workers-report.stdout.log
- duplicates_report: pass (1s), logs outputs\final-verification\2026-06-29T09-27-46-343Z\duplicates-report.stdout.log
- instagram_doctor: pass (3s), logs outputs\final-verification\2026-06-29T09-27-46-343Z\instagram-doctor.stdout.log
- heyclicky_instagram_targeted_check: pass (77s), logs outputs\final-verification\2026-06-29T09-27-46-343Z\heyclicky-instagram-targeted-check.stdout.log
- heyclicky_x_targeted_check: pass (2s), logs outputs\final-verification\2026-06-29T09-27-46-343Z\heyclicky-x-targeted-check.stdout.log
- heyclicky_vs_insforge_scoring: pass (21s), logs outputs\final-verification\2026-06-29T09-27-46-343Z\heyclicky-vs-insforge-scoring.stdout.log
- scoring_experiments: pass (3s), logs outputs\final-verification\2026-06-29T09-27-46-343Z\scoring-experiments.stdout.log
- anomaly_report: pass (2s), logs outputs\final-verification\2026-06-29T09-27-46-343Z\anomaly-report.stdout.log
- longrun_checkpoint: pass (1s), logs outputs\final-verification\2026-06-29T09-27-46-343Z\longrun-checkpoint.stdout.log
- longrun_final_report: pass (1s), logs outputs\final-verification\2026-06-29T09-27-46-343Z\longrun-final-report.stdout.log

## Quality And Attribution

- Strict quality status: pass_with_findings; findings 0 critical, 0 high, 0 medium, 5 low.
- Quality audit scope: 197 company nodes, 0 founder nodes, 3013 evidence rows, 1754 scored rows; graph API samples [909,138]ms.
- Attribution hard guard: 0 high-risk scored rows, 0 medium-risk scored rows, 1259 guarded zero-score rows.
- First-party social body-signal review queue: 972 rows, 778 founder rows, priorities {"high":1,"medium":511,"low":460}.
- First-party review rows are review instrumentation, not automatic score penalties; inspect high-priority rows before raising founder/social weights.

## Why Ingestion Was Previously Shallow

- Earlier passes treated many profile URLs as evidence. The current pipeline keeps profiles as identity context and only scores post/repo/video/launch/story evidence with visible metrics.
- Instagram and X public pages frequently return login walls or reader cooldowns. These are now logged as platform-specific failures instead of stopping the batch.
- A single broad platform pass can still be long-running, especially anonymous Instagram. Future resumed orchestrator runs include a deadline guard so long child command trees can stop at the requested duration window with checkpoint state preserved.
- Search discovery produced many ambiguous profile candidates. The current path records `needs_review` unless visible text matches company/founder/domain context.
- Product Hunt evidence is revalidated on snapshot writes, so old generic Product Hunt pages are dropped unless they pass the current title plus domain/slug/founder/descriptor verifier.
- YC-linked social profile pages could stop at a login wall. The current connector falls back to public post-search verification for that platform before recording the block.
- For real social post URLs, the connector can now use public search-result visible text as a metrics fallback when the post page is blocked, but only when the snippet itself contains visible metrics and a strong entity match.
- Discovery learning previously treated some zero-useful connector runs as successes. Attempts are now classified from useful evidence, review candidates, and failure rows.
- YC-linked social profile checks now use the same classifier, so blocked profile-only attempts no longer become false-positive discovery successes.
- Duplicate metric snapshots could hide stale rows. Current dedupe prefers canonical post IDs and the latest checked/updated snapshot.
- GitHub account aggregate rows previously scored alongside repo-level rows, double-counting the same stars/forks. The graph now scores real repo rows and keeps profile aggregates out of top-contribution scoring when repos are available.
- The scoring experiment runner now uses the same GitHub platform aggregation and batch calibration as the live graph, so HeyClicky and InsForge sanity checks are comparable between the UI and reports.
- A resumed social run exposed an internal metric-weight initialization ordering bug; the current ingestion script initializes weights before workers start and drops stale internal TDZ failure rows on resumed runs.
- Missing or wrong-platform YC-linked social URLs now write checkpoints before returning, so resumed public social runs preserve more partial progress.
- Checkpoint evidence writes now use the same normalization as dashboard snapshots, so stale Product Hunt false positives are dropped from checkpoint rows too.
- Product Hunt review generation now skips fetched page-title mismatches instead of flooding needs-review with unrelated popular products.
- Final verification is now scripted with per-command logs so the last report can cite exact typecheck/test/build/debug/Instagram/HeyClicky/scoring outcomes.

## Worker System

- Worker task count: 2167.
- Worker status counts: {"completed":441,"needs_review":229,"blocked_or_empty":622,"queued":875}.
- Live checkpoint attempts: 2315.
- Live checkpoint statuses: {"done":2234,"failed":81}.
- Live checkpoint rows: {"evidence":964,"needs_review":890,"failures":1684}.
- Live checkpoint platform rows: {"evidence":{"web":765,"x":31,"linkedin":25,"youtube":74,"hacker_news":49,"rss":20},"needs_review":{"linkedin":548,"x":340,"instagram":2},"failures":{"hacker_news":167,"instagram":197,"linkedin":20,"product_hunt":358,"reddit":197,"rss":3,"web":6,"x":596,"youtube":140}}.
- Logged-in read-only social rows: 1955; platform rows {"instagram":41,"x":1914}; companies by platform {"instagram":1,"x":130}.
- HeyClicky logged-in read-only rows: {"instagram":41,"x":85}.

## Recursive Discovery

- Discovery planned tasks: 1705.
- Discovery planned queries: 7528.
- Successful learned patterns: 3.
- Failed learned patterns: 30.
- Source discovery paths: 3.
- Best patterns so far: official website social links, YC-linked GitHub URLs, GitHub links discovered from official sites, HN Algolia exact-name queries, and targeted public search for post URLs.
- Weak patterns so far: anonymous direct Instagram profile pages, anonymous X profile/post readers during cooldown windows, Product Hunt names without domain/slug/founder/descriptor corroboration, and Reddit public pages from this network.

## Graph And Search

- Spring 2026 company count: 197.
- Graph has exactly 197 company circles: yes.
- Founder graph nodes: 0.
- Founders remain in company detail/search data and their evidence IDs roll into company evidence lists.
- Company search: implemented with name-only, typo-tolerant fuzzy search and company selection/zoom.
- Founder search: implemented with name-only, typo-tolerant matching; founder result opens the founder's company and highlights the founder.
- Move-nodes toggle: locked by default, draggable only when enabled, with related nodes following subtly.
- Fullscreen graph mode: implemented and allows more collision-safe labels than the compact panel view.
- Leaderboard contribution cells only use positively scoring evidence rows; context-only web/RSS rows no longer appear as a company's biggest contribution.
- Node and leaderboard top-platform labels use weighted platform contribution, matching the score explanation panel.

## Platform Coverage

- github: 209 evidence rows, 88 scored, 23 companies with scored evidence, 0 needs-review rows, status working.
- x: 1892 evidence rows, 1559 scored, 128 companies with scored evidence, 340 needs-review rows, status working.
- linkedin: 0 evidence rows, 0 scored, 0 companies with scored evidence, 548 needs-review rows, status public_only.
- instagram: 41 evidence rows, 40 scored, 1 companies with scored evidence, 3 needs-review rows, status working.
- product_hunt: 0 evidence rows, 0 scored, 0 companies with scored evidence, 0 needs-review rows, status public_only.
- youtube: 74 evidence rows, 56 scored, 47 companies with scored evidence, 0 needs-review rows, status working.
- rss: 20 evidence rows, 0 scored, 0 companies with scored evidence, 0 needs-review rows, status working.
- web: 766 evidence rows, 0 scored, 0 companies with scored evidence, 0 needs-review rows, status disabled.
- reddit: 0 evidence rows, 0 scored, 0 companies with scored evidence, 0 needs-review rows, status public_only.
- hacker_news: 11 evidence rows, 11 scored, 10 companies with scored evidence, 0 needs-review rows, status working.
- bilibili: 0 evidence rows, 0 scored, 0 companies with scored evidence, 0 needs-review rows, status needs_config.

## Instagram

- Doctor status: needs_attention (7/14 checks passing).
- Logged-in session probe: Skipped: set INSTAGRAM_BROWSER_PROFILE to a cloned browser profile or INSTAGRAM_COOKIE_FILE to a Playwright storage-state JSON file to run the read-only logged-in probe.
- Public profile listing: Recent Instagram posts/reels were not visible from the direct public profile fetch; profile appears login-walled or post markup is hidden.
- HeyClicky targeted evidence: Stored targeted HeyClicky reel metrics: 217 likes, 19 comments, 0 views.
- App feed Instagram evidence: 40 Instagram evidence rows, 40 scored, 40 attached to HeyClicky.
- OpenCLI read-only result: 41 Instagram evidence rows; 1 companies with Instagram evidence.
- HeyClicky parsed Instagram set: 41 rows, covering 19 visible company posts plus 22 visible founder posts in the current artifact.
- Batch discovery: 197 companies checked; 0 candidates; 0 newly verified; 1 total verified company Instagram profiles.
- Instagram remains read-only; no likes, follows, comments, saves, DMs, posts, or CAPTCHA bypasses.

## X/Twitter

- Status: logged-in read-only OpenCLI timeline parsing available for known YC-linked X handles; public attempts remain blocked or limited when unauthenticated.
- Details: 1914 logged-in X evidence rows across 130 companies.
- HeyClicky parsed X set: 85 rows, covering 33 company posts plus 52 founder posts in the current artifact.
- Public X URL normalization merges x.com, twitter.com, and mobile.twitter.com status variants.
- Logged-in X remains read-only: no likes, reposts, follows, DMs, bookmarks, posts, or account mutations.

## Deduplication

- Duplicate evidence groups: 0.
- Duplicate social-account groups: 0.
- Canonical evidence keys prefer platform post IDs, then normalized URLs, then account/text fallback.
- Repeated metric snapshots use the latest checked/updated row for scoring.

## Scoring

- Recommended config: F-browser-social-v2.
- Recommendation reason: Selected by maximizing cross-platform social signal, penalizing sparse/high-view anomalies, and preserving HeyClicky/InsForge sanity-check visibility without reverting to a GitHub leaderboard..

### Recommended Platform Weights

- x: 34%
- instagram: 22%
- github: 14%
- linkedin: 14%
- product_hunt: 7%
- youtube: 5%
- hacker_news: 4%

### Recommended Metric Weights

- instagram: variant B, weights {"views":0.05,"likes":1.1,"comments":5,"shares":5,"reposts":5,"saves":5}.
- x: variant B, weights {"views":0.06,"likes":1.5,"replies":5.5,"comments":5.5,"reposts":8,"shares":8,"quotes":8}.
- linkedin: variant B, weights {"views":0.06,"likes":1.5,"reactions":1.5,"comments":5.5,"reposts":8,"shares":8}.
- github: variant A, weights {"stars":1.5,"forks":4,"watchers":2,"issues":0.5,"open_issues":0.5,"recent_commits_30d":1}.
- product_hunt: variant A, weights {"upvotes":2,"comments":3}.
- youtube: variant A, weights {"views":0.02,"likes":1,"comments":3}.
- hacker_news: variant A, weights {"upvotes":2,"comments":3}.

## Anomalies

- Anomaly count: 198.
- Follow-up task count: 333.
- jo: high_raw_views_low_score - Visible views 423376 but score 33.
- Napkin Math: high_raw_views_low_score - Visible views 67939 but score 39.
- primitive: high_raw_views_low_score - Visible views 71883 but score 38.
- 9 Mothers: high_social_low_score - 13 scored social rows but score 38.
- AgentPhone: high_social_low_score - 46 scored social rows but score 43.
- Akkari: high_social_low_score - 8 scored social rows but score 19.
- Alchemize: high_social_low_score - 9 scored social rows but score 33.
- Allowance: high_social_low_score - 14 scored social rows but score 40.
- Andco: high_social_low_score - 21 scored social rows but score 30.
- Andustry: high_social_low_score - 10 scored social rows but score 32.
- Archer: high_social_low_score - 16 scored social rows but score 39.
- Arlo Industries: high_social_low_score - 11 scored social rows but score 38.
- Atrisa: high_social_low_score - 10 scored social rows but score 22.
- Autostep: high_social_low_score - 7 scored social rows but score 36.
- Auxos: high_social_low_score - 22 scored social rows but score 37.
- BentoLabs AI: high_social_low_score - 43 scored social rows but score 39.
- Callab AI: high_social_low_score - 6 scored social rows but score 34.
- CharacterQuilt: high_social_low_score - 12 scored social rows but score 13.
- Cignara: high_social_low_score - 19 scored social rows but score 19.
- Clara: high_social_low_score - 3 scored social rows but score 33.

## Remaining Limitations

- Instagram broad profile enumeration still requires an explicit safe session path or public pages that expose post links.
- X public reader access can enter cooldown windows; when blocked, the worker logs and skips instead of retrying aggressively.
- LinkedIn logged-in access is disabled. Public LinkedIn rows only score when post-level public metrics are visible.
- Some Product Hunt, Reddit, and web/news matches remain `needs_review` when name/domain context is ambiguous.
- Generated scores are relative to collected evidence; missing platform coverage is visible in coverage/anomaly reports.

## Resume Commands

```powershell
npm run longrun:status
npm run longrun:start
npm run debug:coverage
npm run debug:workers
npm run debug:duplicates
npm run debug:quality:strict
npm run instagram:doctor
npm run instagram:discover -- --search
npm run scoring:experiments
npm run debug:anomalies
npm run longrun:final-verify
npm run longrun:report
node scripts/fetch-public-traction.mjs --social=all --platform=instagram --max-companies=197 --workers=2 --delay-ms=1800 --force --discover-missing-social
node scripts/fetch-public-traction.mjs --social=all --platform=x --max-companies=197 --workers=2 --delay-ms=1500 --force --discover-missing-social
node scripts/fetch-logged-in-social-traction.mjs --platforms=x --entities=all --workers=2 --limit=30 --scrolls=8 --timeout-ms=90000 --delay-ms=2500
node scripts/fetch-logged-in-social-traction.mjs --platforms=instagram --entities=all --workers=1 --limit=40 --scrolls=20 --timeout-ms=90000 --delay-ms=1500
```
