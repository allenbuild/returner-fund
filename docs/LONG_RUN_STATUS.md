# Long Run Status

## Run Identity

- Objective: 6-hour autonomous deep-work cycle for YC Spring 2026 traction discovery, ingestion, scoring, dedupe, Instagram/X checks, and dashboard explainability.
- Started at: 2026-06-28T02:13:20-05:00.
- Last checkpoint: 2026-06-29T09:32:33.707Z.
- Elapsed: 26h 19m.
- Current status: stopped after six-hour target; resumable from checkpoints.

## Current Baseline

- Company count: 197.
- Evidence count: 3013.
- Non-GitHub scored evidence: 1666.
- Worker tasks: 2167.
- Worker status counts: {"completed":441,"needs_review":229,"blocked_or_empty":622,"queued":875}.
- Live ingestion attempts: 2315.
- Live ingestion attempt statuses: {"done":2234,"failed":81}.
- Live ingestion rows: {"evidence":964,"needs_review":890,"failures":1684}.
- Live ingestion platform rows: {"evidence":{"web":765,"x":31,"linkedin":25,"youtube":74,"hacker_news":49,"rss":20},"needs_review":{"linkedin":548,"x":340,"instagram":2},"failures":{"hacker_news":167,"instagram":197,"linkedin":20,"product_hunt":358,"reddit":197,"rss":3,"web":6,"x":596,"youtube":140}}.
- Duplicate groups: 0.
- Duplicate social-account groups: 0.
- Instagram doctor: needs_attention.
- Logged-in read-only social rows: 1955; platform rows {"instagram":41,"x":1914}; companies by platform {"instagram":1,"x":130}.
- HeyClicky logged-in evidence: {"instagram":41,"x":85}.
- X target coverage: 367 known targets across 164 companies; 367 attempted; 130 companies with X evidence.
- Instagram discovery: 197 companies checked; 0 newly verified; 1 total verified company profiles.
- Scoring recommendation: F-browser-social-v2.
- Anomalies: 198.
- Discovery planned tasks: 1705.
- Discovery planned queries: 7528.
- Latest orchestration log: outputs\longrun\background-2026-06-28T09-11-37-190Z.json (145 events, last event command_started).

## Work Completed

- Created/updated long-run docs.
- Added discovery learning tables.
- Added scoring experiment runner.
- Added anomaly report worker.
- Added recursive discovery planner.
- Added Instagram doctor.
- Added targeted company/platform ingestion command support.
- Added bounded multi-lane public ingestion workers with per-platform concurrency and resumable checkpoints.
- Added `longrun:run:6h` and `longrun:smoke` orchestration commands.
- Added background `longrun:start` / `longrun:status` controls and fixed checkpoint start-time handling for resumed runs.
- Fixed long-run resume timing so future resumed cycles use the original recorded start time for the requested duration window.
- Added a future command-deadline guard so resumed orchestrator runs can stop an overlong child command when the requested duration window elapses, including the child process tree on Windows.
- Added periodic in-command checkpoints so long broad-ingest phases still update status every checkpoint window in resumed runs.
- Added graph-facing recency decay before platform normalization, with regression coverage.
- Moved live graph scoring weights into `src/lib/graph/traction-scoring-config.ts` and aligned public-ingest metric scoring with the recommended experiment families.
- Aligned scoring experiment aggregation and batch calibration with the live graph scoring model so HeyClicky/InsForge sanity checks match the dashboard.
- Added conservative public social post verification for discovered X/Instagram/LinkedIn post URLs; profile URLs remain context/review only.
- Added public-profile post-link extraction: readable profiles can seed verified post checks without scoring profile followers.
- Fixed broad Instagram/X discovery so Instagram `/p/` and `/reel/` URLs are not discarded before post verification, and added post-specific search query variants.
- Expanded `instagram:doctor` with an explicit-session browser probe for cloned profiles or Playwright storage-state files; it still refuses to attach to default Chrome automatically.
- Fixed X/Twitter canonical URL dedupe for `mobile.twitter.com` variants.
- Expanded scoring debug output to include Instagram, Reddit, Hacker News, Web, and RSS contribution context.
- Expanded coverage reports with per-platform backlog examples and next target companies for recursive discovery planning.
- Added compact raw metrics and explicit contribution labels to top evidence cards in the company panel.
- Tightened leaderboard and fastest-gaining contribution cells so they only show positively scoring evidence, not zero-score web/RSS context.
- Aligned node and leaderboard top-platform labels with weighted platform contribution, so tie cases match the score explanation.
- Hardened Product Hunt candidate filtering so unrelated generic pages such as `screen-studio` do not flood needs-review for every company.
- Expanded Product Hunt verification beyond domain-only checks: exact-title pages can now verify through official domain, matching Product Hunt slug, founder context, or company descriptor overlap.
- Updated stale Product Hunt evidence cleanup to reuse the same verifier, dropping old mismatched pages while preserving valid slug/founder/descriptor matches.
- Added a blocked-profile fallback for YC-linked X/Instagram/LinkedIn profiles: if the profile is login-walled, the worker now runs public post-search verification before giving up.
- Added a conservative public search-snippet fallback for real Instagram/X/LinkedIn post URLs when the post page is blocked but the search result itself visibly includes metrics and a strong entity match.
- Made blocked founder social-profile fallbacks founder-aware, adding founder-name plus company-name query variants for X statuses and Instagram posts/reels.
- Preserved founder attribution for public posts discovered through founder-profile fallbacks so the company panel can split founder versus company contribution correctly.
- Added platform cooldown handling for reader blocks such as X/Jina HTTP 451 responses, then recycled the background run so resumed workers use the safer skip-and-log path.
- Verified live UI: 197/197 company nodes, no founder graph legend, company search opens HeyClicky, founder search opens the founder's company with the founder highlighted.
- Added typo-tolerant fuzzy graph search scoped to company and founder names, so misspelled queries still jump to the correct company node.
- Moved deterministic graph layout into `src/lib/graph/layout.ts` with regression coverage that checks all 197 Spring 2026 company circles avoid visual overlap.
- Reduced graph edge visual weight and updated docs so company circles stay circular and founders remain panel/database context only.
- Expanded fullscreen graph label capacity while keeping collision-aware label placement so visible labels still avoid other labels and company circles.
- Changed evidence dedupe to prefer the latest checked/updated metric snapshot, using platform post IDs before normalized URLs when available.
- Updated public evidence ingestion and snapshot loading to carry or derive canonical platform post IDs for X, Instagram, LinkedIn, YouTube, Product Hunt, Reddit, and Hacker News.
- Added duplicate social-account auditing and removed company-panel duplicate account attachments when the same account is already attached to a founder.
- Improved public post verification so exact founder-name matches with YC/founder context can validate founder-authored social evidence for company rollup.
- Added discovery-attempt and source-discovery-path artifacts for recursive discovery learning.
- Expanded recursive discovery planning with post/launch-specific query variants for Instagram reels/posts, X statuses, Product Hunt products/posts, and YouTube videos/shorts.
- Fed prior `sourceDiscoveryPaths` back into missing-social discovery so official-site social links can be retried by platform workers on resume.
- Added GitHub `recent_commits_30d`/recent-push activity into the live scoring config and scoring experiment variants without refetching GitHub.
- Stopped scoring GitHub profile aggregate rows when repo-level evidence exists, preventing account totals from double-counting the same stars/forks as top repositories.
- Added `longrun:report` to generate a consolidated final report from coverage, workers, duplicates, Instagram, discovery, anomaly, and scoring outputs.
- Added `longrun:final-verify` to run the final typecheck/test/build/debug/Instagram/HeyClicky/scoring/report sequence and persist per-command logs.
- Excluded generated outputs from source/config no-secret scan.
- Excluded prior authenticated LinkedIn and X rows from current scoring; only Instagram targeted/public evidence is allowed from the authenticated-era snapshot.
- Fixed public-ingest metric-weight initialization so X/Instagram discovered social tasks can score metrics without `INGEST_METRIC_WEIGHTS` temporal-dead-zone failures on resumed runs.
- Added resumed-run cleanup for stale internal `INGEST_METRIC_WEIGHTS` failure rows while preserving real platform block/cooldown failures.
- Fixed social-profile early returns so missing/wrong-platform public social URL attempts write checkpoints and keep normal pacing in resumed runs.
- Fixed discovery-attempt status classification so zero-useful connector runs are learned as failed/needs-review/skipped patterns instead of successful patterns.
- Applied the same discovery-attempt classifier to YC-linked social profile checks so failure-only social attempts do not train the planner as successes.
- Normalized checkpoint evidence writes so stale Product Hunt false positives are dropped from checkpoint rows the same way they are dropped from dashboard snapshots.
- Tightened Product Hunt review generation so fetched page-title mismatches are skipped instead of flooding needs-review with unrelated popular products.
- Parsed HeyClicky's full visible logged-in read-only Instagram set: 19 company posts plus 22 founder posts, with founder posts rolling up into the company feed and score.
- Parsed HeyClicky's logged-in read-only X set: 33 company posts plus 52 founder posts, including visible views, likes, comments, and reposts.
- Retried all known YC-linked X targets with checkpoint resume; 367/367 known targets were attempted and 130 companies now have scored X evidence.
- Increased live X, LinkedIn, and Instagram metric weights so visible views/likes/comments/reposts materially affect the score when post-level metrics are available.

## Latest Validation Commands

- `npm run typecheck` passed after the latest code changes.
- `npm test` passed 16 test files / 74 tests after the latest code changes.
- `npm run build` passed after the latest UI/reporting changes.
- `npm run debug:coverage` regenerated `outputs/coverage-debug-s2026.json`.
- `npm run debug:workers` regenerated `outputs/workers-debug-s2026.json` with live checkpoint details.
- `npm run debug:duplicates` regenerated `outputs/duplicates-debug-s2026.json`; evidence duplicates and account duplicates are both zero.
- `npm run scoring:experiments` regenerated `outputs/scoring-experiments-s2026.json` with diagnostic slices.
- `npm run debug:anomalies` regenerated `outputs/anomaly-report-s2026.json`.
- `npm run longrun:report` generated `docs/LONG_RUN_FINAL_REPORT.md` as an interim report.
- `npx vitest run tests/graph-search.test.ts tests/graph-builder.test.ts` passed typo-tolerant company/founder search and graph filter coverage.
- `npx vitest run tests/yc-traction-regressions.test.ts tests/graph-builder.test.ts tests/evidence-dedupe.test.ts` passed after the GitHub aggregate de-duplication fix.
- Live browser smoke check passed: dashboard renders 197/197 company nodes, Fullscreen and Move nodes controls are visible, HeyClicky company search opens an Instagram-led panel, and founder search opens the founder's company with the founder chip highlighted.
- `node --check scripts/fetch-public-traction.mjs` passed after the ingestion metric-weight initialization fix.

## Current Blockers

- Playwright is installed, but Instagram public profile fetches still return login-wall/block content for direct profile pages.
- `instagram:doctor` refuses to attach to the default Chrome profile automatically; provide `INSTAGRAM_BROWSER_PROFILE` or `INSTAGRAM_COOKIE_FILE` for an explicit reusable session probe.
- HeyClicky Instagram post enumeration works through the logged-in read-only OpenCLI path, but Instagram grid/reel view counts are visible in Chrome UI and not exposed in readable DOM/meta/script fields during automation.
- Broad Instagram coverage is still limited by verified handles: official-site discovery checked all 197 companies but auto-verified only HeyClicky.
- X/Jina public reader access can return HTTP 451 cooldowns, but the logged-in read-only OpenCLI X timeline path now parses known YC-linked X targets and logs zero-post targets cleanly.
- Logged-in LinkedIn is intentionally disabled.
- npm argument forwarding on this Windows shell has been unreliable for `npm run ingest:* -- --flag=value`; use the direct `node scripts/fetch-public-traction.mjs ...` commands below for precise targeted resumes.

## Next Planned Actions

1. Continue the full autonomous cycle with `npm run longrun:run:6h`.
2. Add an explicit cloned Instagram storage-state/profile path if we want `instagram:doctor` to validate the same logged-in path used by OpenCLI.
3. Improve Instagram verified-handle discovery beyond official website links without auto-promoting ambiguous search results.
4. Continue X zero-post target audits and inspect whether those accounts truly have no accessible posts or need profile-specific selectors.
5. Refresh scoring experiments, anomaly report, coverage, duplicate report, and dashboard verification after each new social batch.

## Resume Commands

```powershell
npm run typecheck
npm test
npm run build
npm run debug:coverage
npm run debug:workers
npm run debug:duplicates
npm run instagram:doctor
npm run longrun:smoke
npm run longrun:start
npm run longrun:status
npm run longrun:run:6h
node scripts/debug-scoring-report.mjs --company=HeyClicky --right=InsForge
node scripts/fetch-public-traction.mjs --social=all --company=HeyClicky --workers=4 --delay-ms=500 --force
node scripts/fetch-public-traction.mjs --social=all --platform=instagram --company=HeyClicky --workers=2 --delay-ms=1500 --force
node scripts/fetch-public-traction.mjs --social=all --platform=x --company=HeyClicky --workers=2 --delay-ms=1500 --force
node scripts/fetch-public-traction.mjs --social=all --max-companies=197 --workers=8 --delay-ms=1200
node scripts/fetch-public-traction.mjs --social=all --platform=x --max-companies=197 --workers=2 --delay-ms=1500 --force --discover-missing-social
node scripts/fetch-public-traction.mjs --social=all --platform=instagram --max-companies=197 --workers=2 --delay-ms=1800 --force --discover-missing-social
node scripts/fetch-logged-in-social-traction.mjs --platforms=x --entities=all --workers=6 --limit=40 --scrolls=12 --timeout-ms=90000 --delay-ms=1200 --retry-empty
node scripts/fetch-logged-in-social-traction.mjs --platforms=instagram --company=HeyClicky --entities=all --workers=1 --limit=40 --scrolls=24 --timeout-ms=120000 --delay-ms=2000 --force
node scripts/discover-instagram-overrides.mjs --write --workers=6
npm run discovery:plan
npm run scoring:experiments
npm run debug:anomalies
npm run longrun:report
npm run longrun:final-verify
npm run longrun:checkpoint
```
