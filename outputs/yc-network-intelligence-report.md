# YC Network Intelligence Final Report

Date: 2026-06-27

## Built

- Next.js App Router + TypeScript dashboard for YC startup/founder network intelligence.
- Required planning docs:
  - `docs/AGENT_PLAN.md`
  - `docs/STATUS_BOARD.md`
  - `docs/ARCHITECTURE.md`
  - `docs/DATA_CONTRACTS.md`
  - `docs/SCORING_MODEL.md`
  - `docs/INGESTION_STRATEGY.md`
  - `docs/UI_DESIGN_SYSTEM.md`
- Supabase/Postgres migration with the requested tables, indexes, constraints, JSONB evidence/explanation payloads, and updated-at triggers.
- Official-snapshot dashboard with default `YC Spring 2026`, observed company count `197`, batch selector, ingest/refresh buttons, platform/edge/industry/business-model filters, score filter, Cytoscape graph, node panel, evidence feed, leaderboard, fastest-gaining tab, needs-review tab, and settings/platform status.
- Public YC Spring 2026 dataset generated from unauthenticated YC directory/detail pages:
  - `197` companies.
  - `396` public founder records.
  - `593` graph nodes.
  - Official company/founder profile URLs and YC-linked public GitHub/LinkedIn/X URLs only.
  - No cookies, sessions, CSRF tokens, emails, signed image URLs, or private account data stored.
- Manual worker route at `POST /api/ingest/batch`.
- Official graph route at `GET /api/graph`.
- Read-only connector abstraction and safe initial connectors/placeholders for GitHub, web/search, Product Hunt, YouTube, RSS, Instagram public-only, X official API, and LinkedIn manual/approved-access.
- Transparent scoring and identity modules with explanation objects, `review_state`, `sourceReliability`, and needs-review handling. Numeric identity-quality fields are not emitted by app APIs.
- Modern graph encoding: node size = traction, node color = primary industry, founder nodes inherit company industry color, business model uses shape/border, group partner influences layout clusters, and all edges are simple arrowless lines.
- README, `.env.example`, and safety/troubleshooting docs.

## How To Run

```powershell
npm install
Copy-Item .env.example .env.local
npm run dev -- --hostname 127.0.0.1 --port 3001
```

Open:

```text
http://127.0.0.1:3001
```

Current dev server verified at:

```text
http://127.0.0.1:3001
```

## Verification

- `npm run typecheck` passed.
- `npm run test` passed: 7 test files, 36 tests.
- `npm run build` passed.
- `GET /api/graph?batch=S2026` returned official snapshot data with mode `official_snapshot`, 197 companies, 396 founders, 593 nodes, 856 edges, 593 evidence items, and 197 leaderboard rows.
- `POST /api/ingest/batch` with `options.demo=true` completed and returned demo ingest logs; a bounded 2-company demo request returned 4 nodes, 2 edges, and 1 needs-review item.
- Browser-control verification hit plugin timeouts after the larger graph was loaded, but production build and live API verification passed. The UI was also adjusted to avoid overflowing partner-cluster legends on the full batch.
- Contract checks confirm graph and ingest JSON do not contain numeric identity-quality fields.

## Working Platforms

- GitHub: local workstation `gh` verified earlier; app connector is read-only.
- Public web pages: app/web connector and workstation web reading available.
- RSS/blogs: public feed path available.
- YouTube: public metadata/transcript path available at workstation level; app connector scaffolded.
- Exa semantic search: workstation semantic search verified earlier; app supports `EXA_API_KEY` for direct API search.
- Bilibili: public search verified earlier; logged-in subtitles are explicit-per-task only.
- Instagram: public unauthenticated only. No login, cookies, saved posts, DMs, private profiles, or browser automation.

## Needs Login Or Config

- Supabase database mode: add Supabase env vars and apply `supabase/migrations/001_initial_schema.sql`.
- GitHub higher read limits: optional `GITHUB_TOKEN`.
- X/Twitter: official API credentials only by default via `X_BEARER_TOKEN`.
- Reddit: official API credentials only by default.
- LinkedIn: manual/approved-access only by default; no automated browsing in the app.
- Xiaohongshu: not configured in the app.
- Bilibili logged-in subtitles: explicit per-task approval only.

## Limitations

- The current score is a transparent public-YC metadata proxy based on official YC fields, public profile links, team size, founder depth, and description depth. It is not yet true cross-platform social traction.
- Live platform enrichment is not yet persisted into the graph. GitHub, X, LinkedIn, YouTube, RSS, Reddit, Bilibili, and other platform evidence should be connected through official APIs or explicitly public read-only sources before treating scores as production social intelligence.
- `options.demo=false` intentionally fails closed until live YC persistence, connector persistence, scoring writes, snapshots, and graph edge writes are fully wired.
- Supabase migration was created but not applied locally because Supabase CLI/psql are not installed on PATH.
- Product Hunt, YouTube, RSS, and web connectors are conservative initial scaffolds and need deeper live fetch/normalize work before production scoring.
- No scheduled scraping exists.
- Browser automation is intentionally outside the default pipeline for account safety.

## Recommended Next Improvements

1. Apply the Supabase migration and wire database-backed graph reads.
2. Persist the official YC Spring 2026 snapshot into Supabase once database mode is configured.
3. Persist connector evidence, metrics, scores, snapshots, and graph edges.
4. Expand public Product Hunt, YouTube, RSS, GitHub, and web/search connectors.
5. Add a review workflow that records accept/reject decisions locally without mutating external accounts.
