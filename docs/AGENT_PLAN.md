# Multi-Agent Build Plan

## Project

Build a production-quality, read-only intelligence dashboard that maps YC startups and founders as an interactive weighted network graph.

Default target batch: YC Spring 2026 (`S2026`), expected company count `197`. The app must support alternate batches through a dropdown.

## Non-Negotiable Safety Policy

- This is a read-only intelligence dashboard.
- Never like, follow, comment, DM, post, subscribe, star, fork, vote, or mutate external accounts.
- Never bypass access controls, CAPTCHAs, paywalls, login walls, private accounts, or technical restrictions.
- Use authenticated sessions only when explicitly provided by the user and only through documented credential strategy.
- Never commit cookies, tokens, secrets, passwords, session files, or browser profiles.
- Every profile match must carry a `review_state`.
- Plausible but unverified matches must be routed to `needs_review`.
- Every score must be explainable from stored evidence.
- Manual refresh only. No scheduled scraping in this MVP.
- Instagram policy for this project: public unauthenticated web content only. No OpenCLI Instagram, no logged-in Instagram sessions, no saved posts/private data.

## Agent Roles

### 1. Main Orchestrator Agent

Owns contracts, repo coordination, integration, branch discipline, and final verification.

Primary files:

- `docs/*`
- `README.md`
- cross-agent integration changes

### 2. Agent Reach and Tooling Agent

Owns Agent Reach status, internet tooling, and platform availability reporting.

Primary files:

- `docs/STATUS_BOARD.md`
- `src/lib/tooling/*`

### 3. Architecture and Database Agent

Owns Supabase schema, migrations, database types, and upsert contracts.

Primary files:

- `supabase/migrations/*`
- `src/lib/db/*`
- `src/types/database.ts`

### 4. YC Batch Ingestion Agent

Owns batch adapter, YC directory/search fallback, source reliability, and ingestion parsing.

Primary files:

- `src/lib/ingestion/yc/*`
- tests under `tests/ingestion/*`

### 5. Identity Resolution Agent

Owns website crawling, official-link extraction, rule-based profile review, and `needs_review`.

Primary files:

- `src/lib/identity/*`
- tests under `tests/identity/*`

### 6. Social Connector Agents

Own platform connector abstraction and per-platform read-only connectors.

Primary files:

- `src/lib/connectors/*`
- tests under `tests/connectors/*`

### 7. Scoring and Baselines Agent

Owns scoring formulas, baseline reliability seed structure, snapshots, and explanations.

Primary files:

- `src/lib/scoring/*`
- `supabase/seed/*`
- tests under `tests/scoring/*`

### 8. Graph and Network Agent

Owns graph node/edge construction, industry similarity, node sizing, and graph API data shape.

Primary files:

- `src/lib/graph/*`
- `src/app/api/graph/*`
- tests under `tests/graph/*`

### 9. Frontend Dashboard Agent

Owns Next.js dashboard UI, graph visualization, tabs, node panel, evidence feed, filters, demo mode UX.

Primary files:

- `src/app/*`
- `src/components/*`
- `src/styles/*`

### 10. Worker and Refresh Pipeline Agent

Owns manual ingest/refresh job orchestration, ingestion run logs, idempotent upserts, and API routes.

Primary files:

- `src/app/api/ingest/batch/*`
- `src/app/api/jobs/*`
- `src/lib/workers/*`

### 11. QA, Security, and Documentation Agent

Owns tests, safety guardrails, env docs, final runbook, and no-secret checks.

Primary files:

- `tests/*`
- `README.md`
- `.env.example`
- `.gitignore`

## Branch / Worktree Policy

Preferred branches:

- `agent/tooling-agentreach`
- `agent/db-schema`
- `agent/yc-ingestion`
- `agent/identity-resolution`
- `agent/social-connectors`
- `agent/scoring`
- `agent/graph-ui`
- `agent/frontend-dashboard`
- `agent/workers`
- `agent/qa-docs`

Because native subagents are available in this Codex environment, subagents may work in parallel in their own forked workspaces. They must not revert changes from other agents. Integration happens on `main` after interface checks and tests.

## Phases

### Phase 0: Contracts

- Create docs and status board.
- Define database schema.
- Define connector abstraction.
- Define scoring config shape.
- Define graph API shape.
- Define safety policy.

### Phase 1: Parallel Foundations

- Tooling: Agent Reach status and platform availability.
- Database: Supabase migrations and types.
- Frontend: demo dashboard shell.
- Scoring: formulas and tests.
- YC ingestion: adapter and parser.

### Phase 2: Parallel Feature Slices

- Connectors: GitHub, web/search, Product Hunt, YouTube, RSS/news. X/LinkedIn browser paths are explicit-per-task only.
- Identity resolution: profile review_state and needs-review.
- Graph: nodes, edges, similarity.
- Worker: manual ingest and refresh pipeline.

### Phase 3: Integration

- Wire ingestion to database.
- Wire scoring to graph node sizes.
- Wire evidence feed, leaderboard, fastest-gaining, needs-review.
- Ensure demo mode works without credentials.

### Phase 4: QA

- Run lint, typecheck, tests, and build.
- Verify no secrets are committed.
- Final report.

## Immediate MVP Definition

The first production-shaped MVP must include:

- Next.js App Router app.
- Demo mode with seed YC-like companies/founders.
- Supabase migrations.
- Manual ingest API.
- Connector abstraction with initial read-only connectors.
- Scoring engine with explanations and tests.
- Graph API and graph visualization.
- Node panel with evidence feed.
- Leaderboard, hottest movers, needs review tabs.
- Safety/auth status settings section.
- README and `.env.example`.
