# Next Actions

## Immediate

1. Continue the full autonomous run with `npm run longrun:run:6h`.
2. Use `npm run longrun:smoke` before large changes to verify the checkpoint/report pipeline.
3. Use `npm run longrun:start` to keep the six-hour run detached in the background, then `npm run longrun:status` to inspect logs without interrupting it.
4. Continue the direct resumable batch with `node scripts/fetch-public-traction.mjs --social=all --max-companies=197 --workers=8 --delay-ms=1200 --discover-missing-social` when a one-off ingestion phase is preferred.
5. Use direct `node` commands for parameterized debug checks on this Windows shell, for example `node scripts/debug-scoring-report.mjs --company=HeyClicky --right=InsForge`.
6. Refresh logged-in read-only X only when new handles are added or metrics need updating: `node scripts/fetch-logged-in-social-traction.mjs --platforms=x --entities=all --workers=2 --limit=30 --scrolls=8 --timeout-ms=90000 --delay-ms=2500`. Do not pass `--allow-x-adapter-fallback` unless deliberately testing the rate-limited adapter.
7. Run safe Instagram discovery with `npm run instagram:discover -- --search` to produce review candidates, or `npm run instagram:discover -- --write` to auto-promote only official-site Instagram links.
8. After adding verified Instagram overrides, run `node scripts/fetch-logged-in-social-traction.mjs --platforms=instagram --entities=all --workers=1 --limit=40 --scrolls=20 --timeout-ms=90000 --delay-ms=1500`.
9. Force-refresh post-capable public lanes after the verifier patch: `node scripts/fetch-public-traction.mjs --social=all --platform=x --max-companies=197 --workers=2 --delay-ms=1500 --force --discover-missing-social` and `node scripts/fetch-public-traction.mjs --social=all --platform=instagram --max-companies=197 --workers=2 --delay-ms=1800 --force --discover-missing-social`. If X/Jina returns HTTP 451, let the cooldown-aware worker skip X until the stated expiry.
10. Force-refresh Product Hunt with the stricter candidate filter: `node scripts/fetch-public-traction.mjs --social=none --platform=product_hunt --max-companies=197 --workers=2 --delay-ms=1000 --force`. If the command times out, flush the clean checkpoint with `node scripts/fetch-public-traction.mjs --max-companies=0 --platform=product_hunt --workers=1 --delay-ms=0`.
11. Re-run `npm run discovery:plan`, `npm run scoring:experiments`, `npm run debug:anomalies`, and `npm run longrun:checkpoint` after each ingestion phase.
12. At the end of the run, use `npm run longrun:final-verify` and then `npm run longrun:report` to produce the auditable final state.

## Follow-Up

1. Persist learned query patterns into database tables, not just JSON artifacts.
2. Reuse successful platform queries across similar companies.
3. Continue improving company panel score explanation for founder/company contribution split and per-evidence raw metric visibility.
4. Expand tests for Instagram/X URL normalization, latest-metric scoring, worker task creation, scoring experiments, and recency-sensitive score explanations.
5. Extend the browser-session Instagram doctor mode with explicit read-only selectors and a no-mutation action guard after a reusable session path is provided.
6. Find verified Product Hunt launch/product URLs through company websites, founder posts, or official announcements; do not score generic Product Hunt search candidates.
7. Review `docs/EVIDENCE_ATTRIBUTION_AUDIT.md` before increasing social/founder weighting. The first-party body-signal queue currently separates hard attribution failures from softer off-topic risk; start with the high-priority rows and mark/zero only clear non-traction posts.
