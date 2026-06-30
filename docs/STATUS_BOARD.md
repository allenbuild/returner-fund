# Status Board

Last updated: 2026-06-29

## Global Status

| Area | Status | Notes |
| --- | --- | --- |
| Repository | Active dashboard implementation | Working tree is untracked in this checkout; treat all existing files as shared work. |
| Default batch | Updated contract | `S2026` now means `YC Spring 2026`; expected company count is `197`. |
| Contracts | Active | Runtime graph, evidence, review queues, and debug reports use `review_state`; graph has exactly 197 company nodes and 0 founder nodes. |
| Safety posture | Active | Read-only only. Logged-in LinkedIn is disabled. Instagram/X logged-in evidence is opt-in read-only and never mutates accounts. |
| App | Working local dashboard | API quality audit reports 0 critical/high/medium findings; remaining findings are low coverage/setup limitations. |
| Tests | Working | `npm run typecheck`, full `npm run test`, `npm run build`, `npm run debug:duplicates`, `npm run debug:coverage`, `npm run scoring:experiments`, and strict quality audit pass. |

## Current Contract Deltas

- `batches.company_count_expected` added for loaded/expected progress.
- Default batch language updated to Spring 2026.
- `companies.business_model`, `companies.customer_type`, and `companies.pricing_model` added.
- Database reviewability now uses `review_state` with `verified`, `needs_review`, and `rejected`.
- Database numeric identity/source-quality columns were removed from the migration and database types.
- Graph design now has an explicit visual encoding contract in `docs/UI_DESIGN_SYSTEM.md`.

## Agent Updates

### Main Orchestrator Agent

- Assigned scope: contracts, integration, final verification.
- Files touched: `README.md`, `docs/ARCHITECTURE.md`, `docs/DATA_CONTRACTS.md`, `docs/INGESTION_STRATEGY.md`, `docs/SCORING_MODEL.md`, `docs/STATUS_BOARD.md`, `docs/UI_DESIGN_SYSTEM.md`, `supabase/migrations/001_initial_schema.sql`, `src/types/database.ts`.
- Assumptions: Preserve app runtime code outside this ownership slice; use docs/schema/types as the revised source of truth.
- Blockers: Runtime UI/API/domain files still contain legacy numeric review-quality fields and filters. Those files were intentionally not edited in this slice.
- Test status: Targeted search over requested docs/schema/types found no legacy numeric review-quality fields. `npx tsc --noEmit --skipLibCheck --target ES2020 --module commonjs src/types/database.ts` passed. Full `npm run typecheck` is blocked by runtime files outside this ownership slice.
- Integration notes: A follow-up implementation pass should update `src/types/domain.ts`, graph types/builders, API filters, demo data, and UI labels to consume `review_state`.

### Architecture and Database Agent

- Assigned scope: Supabase schema and database types.
- Files touched: `supabase/migrations/001_initial_schema.sql`, `src/types/database.ts`, `docs/STATUS_BOARD.md`.
- Assumptions: UUID primary keys, Postgres JSONB for raw/explanation payloads, scores as 0..100 values, and polymorphic references in `social_accounts`/`graph_edges` are validated by application code because Postgres cannot express cross-table foreign keys directly.
- Blockers: Migration was not applied locally in this slice.
- Test status: `src/types/database.ts` compiles in isolation.
- Integration notes: `review_state` is indexed on companies, founders, and social accounts. Snapshot tables carry `review_state` so score outputs can be held for review without exposing internal ranking values.

### YC Batch Ingestion Agent

- Assigned scope: YC batch adapter and review-state storage contract.
- Files touched: `docs/INGESTION_STRATEGY.md`, `docs/DATA_CONTRACTS.md`, `docs/STATUS_BOARD.md`.
- Assumptions: Official YC directory may be dynamic/blocked; parser accepts structured official payloads when available and uses web/search fallback only as review-required reconstruction.
- Blockers: Runtime adapter code still maps source quality through legacy implementation names; a follow-up code pass is required.
- Test status: Not run here; docs/schema/type checks only.
- Integration notes: Default ingest should upsert `S2026`, `YC Spring 2026`, and `company_count_expected = 197`.

### Graph and Frontend Contract Agent

- Assigned scope: graph visual encoding and UI contract.
- Files touched: `docs/ARCHITECTURE.md`, `docs/UI_DESIGN_SYSTEM.md`, `docs/DATA_CONTRACTS.md`, `README.md`, `docs/STATUS_BOARD.md`.
- Assumptions: Cytoscape.js remains the graph library chosen in `docs/ARCHITECTURE.md`; dashboard uses demo-mode data until database-backed graph reads are integrated.
- Blockers: Runtime dashboard still has legacy labels and a numeric quality filter; not edited because ownership was docs plus Supabase migration/types only.
- Test status: Browser verification not run for this docs/schema slice.
- Integration notes: Modern graph encoding should use entity shape/color, score-based size, review-state rings, weighted edge width, semantic edge styles, and loaded/expected batch progress.

## Platform Capability Board

| Platform | Status | Safe default | Notes |
| --- | --- | --- | --- |
| GitHub | Working | `gh` / API | Read-only in app. |
| Web pages | Working | Public fetch/search | Public pages only. |
| RSS/blogs | Working | Public feeds | Public feeds only. |
| YouTube | Working | Public transcripts/metadata | Public access only. |
| Exa semantic search | Available | Semantic search | Optional ingestion aid. |
| Bilibili | Partial | Public search | Logged-in subtitles are explicit-per-task only. |
| X/Twitter | Installed/risky | Official X API preferred | Browser automation disabled by default. |
| Reddit | Installed/API preferred | Official API when configured | Browser automation disabled by default. |
| LinkedIn | Installed/risky | Manual or official/partner API | Browser automation disabled by default. |
| Instagram | Public-only | Public unauthenticated pages | No login/session automation. |
| Xiaohongshu | Installed/risky | Manual or explicit one-off read-only | Login/search not configured. |
| Product Hunt | Connector implemented; no verified S2026 evidence yet | Public pages/search | Public connector normalizes product/post URLs and metrics. Batch snapshot prunes unrelated repeated candidates such as `screen-studio`; verified launch URLs are still needed before scoring. |
