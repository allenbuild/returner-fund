# Long Run Status

Generated at: 2026-06-30T12:12:56.934Z

## Run Identity

- Objective: 6-hour remediation cycle focused on Instagram coverage and thumbnails across all 197 YC Spring 2026 companies.
- Active goal elapsed at final verification: 6h 31m (23471 seconds when last sampled).
- Current status: completed and checkpointed.

## Final Baseline

- Company count: 197.
- Graph API nodes: 197 company nodes, 0 founder nodes.
- Evidence rows: 3049.
- Non-GitHub scored evidence: 1707.
- Logged-in read-only social rows: 1996 (1914 X, 82 Instagram).
- Instagram coverage: 4/197 companies with scored Instagram; 82 Instagram rows; 82 real Instagram thumbnails.
- Thumbnail coverage: 3049/3049 rows have thumbnails; 0 missing; 8 fallback.
- Duplicate evidence groups: 0.
- Duplicate social account groups: 0.
- Instagram doctor: needs_attention (7/14).

## What Changed

- Added strict Instagram public-discovery pruning through `scripts/prune-instagram-identity-mismatches.mjs` and `npm run instagram:prune:mismatches`.
- Ran broad Instagram discovery across all 197 companies and preserved 591 candidates for review/debug.
- Ran logged-in read-only Instagram ingestion for all verified profiles with 1-2 worker behavior, checkpointing, and conservative delays.
- Accepted Instagram evidence only when the profile identity matched and the post had recent scored traction.
- Rejected 47 identity-mismatched Instagram overrides from the latest checkpoint, bringing rejected Instagram entries to 54.
- Backfilled covers/previews so every evidence row has a thumbnail or clean preview; X and Instagram logged-in rows all have real captured/media thumbnails.
- Added command aliases for all-company and per-company Instagram ingestion.
- Fixed the debug Instagram coverage type/model so rejected and pruned override entries are valid audit data rather than type errors.
- Removed the Turbopack trace warning from the Instagram debug page by narrowing its filesystem read to a static outputs path.

## Validation Commands

- `node --check scripts/prune-instagram-identity-mismatches.mjs`: passed.
- `node --check scripts/backfill-evidence-thumbnails.mjs`: passed.
- `node --check scripts/discover-instagram-overrides.mjs`: passed.
- `node --check scripts/fetch-logged-in-social-traction.mjs`: passed.
- `node --check scripts/debug-instagram-coverage.mjs`: passed.
- `npm run typecheck`: passed.
- `npm test`: passed, 30 test files / 123 tests.
- `npx vitest run tests/instagram-coverage-debug.test.ts`: passed.
- `npm run build`: passed; static `/` emitted.
- `npm run debug:coverage`: passed.
- `npm run debug:instagram-coverage`: passed.
- `npm run debug:thumbnails`: passed.
- `npm run debug:duplicates`: passed.
- `npm run instagram:doctor`: completed with needs_attention, 7/14 checks.
- Local `http://127.0.0.1:3001/`: HTTP 200.
- Local `/api/graph?batch=S2026`: HTTP 200, 197 nodes, 0 founders.

## Current Blockers And Limits

- Instagram doctor still needs an explicit reusable browser profile/cookie path to mark the session checks fully green, even though the read-only logged-in path parsed the four accepted companies.
- Only 4 companies currently have scored Instagram evidence because most discovered profiles are either needs_review, identity mismatches, or have no recent visible scored posts.
- Remaining 8 thumbnail fallbacks are web/link-preview cases where the source blocks image fetches; no evidence row is missing a thumbnail.
- Logged-in LinkedIn scraping remains intentionally disabled.

## Resume Commands

```powershell
npm run instagram:discover:public
npm run ingest:instagram:all -- --workers=2 --limit=20 --scrolls=6 --delay-ms=2500
npm run ingest:instagram:company -- --company="HeyClicky" --limit=40 --scrolls=24 --delay-ms=2000 --force
npm run instagram:prune:mismatches
npm run thumbnails:instagram
npm run thumbnails:x
npm run thumbnails:links
npm run debug:instagram-coverage
npm run debug:thumbnails
npm run debug:duplicates
npm run typecheck
npm test
npm run build
```
