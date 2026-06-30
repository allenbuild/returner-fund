# YC Network Intelligence

Read-only Next.js dashboard for mapping YC startups and founders as a weighted network graph. The app is designed around manual ingest/refresh runs, auditable evidence, review-state identity matching, and demo mode that works without credentials.

Default batch:

- `S2026`
- `YC Spring 2026`
- Expected companies: `197`

## Safety Policy

- Read-only only: never like, follow, comment, DM, post, subscribe, star, fork, vote, or mutate external accounts.
- Do not bypass CAPTCHAs, paywalls, login walls, private profiles, robots restrictions, or access controls.
- Do not send cookies, tokens, passwords, session data, or API keys to `/api/ingest/batch`.
- Store credentials only in `.env.local`, OS keychains, or approved local tool config. Never commit credentials.
- Instagram is public unauthenticated web only. No logged-in Instagram automation.
- X, LinkedIn, Reddit, Xiaohongshu, and logged-in Bilibili are explicit-per-task only unless official APIs are configured.

## Setup

```powershell
npm install
Copy-Item .env.example .env.local
npm run typecheck
npm run test
npm run dev
```

Open `http://localhost:3000`.

## Available Commands

- `npm run dev` starts the local Next.js server.
- `npm run typecheck` runs TypeScript checks.
- `npm run test` runs Vitest.
- `npm run build` builds the app.
- `npm run check` runs typecheck, tests, and build.

## Agent Reach

Agent Reach is the workstation-level internet and social capability layer, not the dashboard itself.

Current local workstation status:

- Agent Reach installed at `C:\Users\swimd\.agent-reach-venv`.
- `agent-reach doctor` was run during workstation setup.
- Public web reading, RSS, YouTube transcripts, Exa semantic search, Bilibili public search, and GitHub CLI were verified at the workstation level.
- OpenCLI/browser automation is stopped by default and should not be used by this app without explicit approval.

Useful checks:

```powershell
agent-reach doctor
gh auth status
```

## Supabase

Demo mode does not require Supabase. Database mode is prepared through migrations and run-store hooks, but live database ingest is intentionally blocked until the YC adapter, connector persistence, and scoring persistence are fully wired together.

Supabase setup path:

1. Create a Supabase project.
2. Copy project values into `.env.local`.
3. Apply migrations from `supabase/migrations`.
4. Run `npm run typecheck` and `npm run test`.
5. Call `/api/ingest/batch` first with `options.demo=true`.
6. Only use `options.demo=false` after the real persistence adapters are completed.

## Environment Variables

Required for demo:

- `NEXT_PUBLIC_APP_MODE=demo`

Required for database mode:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

Optional tooling/API variables:

- `AGENT_REACH_CONFIG_PATH`
- `BROWSER_PROFILE_PATH`
- `GITHUB_TOKEN`
- `X_BEARER_TOKEN`
- `REDDIT_CLIENT_ID`
- `REDDIT_CLIENT_SECRET`
- `REDDIT_USER_AGENT`
- `EXA_API_KEY`
- `YOUTUBE_COOKIES_PATH`
- `PLATFORM_COOKIES_PATH`

Never paste secret values into API requests or commit `.env.local`.

## Ingest And Refresh

Manual ingest and refresh use the same route:

`POST /api/ingest/batch`

Demo request:

```powershell
$body = @{
  batchSlug = "YC Spring 2026"
  options = @{
    demo = $true
    refreshProfiles = $true
    refreshPosts = $true
    maxCompanies = 3
  }
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/ingest/batch" -ContentType "application/json" -Body $body
```

Behavior:

- Creates a local ingestion run.
- Normalizes the batch slug, for example `YC Spring 2026` to `S2026`.
- Tracks the default expected company count of `197`.
- Rebuilds deterministic demo companies, founders, evidence, scores, leaderboard, fastest-gaining rows, and review queue items.
- Returns a graph payload for UI/API integration.

Real database mode:

```json
{
  "batchSlug": "S2026",
  "options": { "demo": false }
}
```

This currently fails closed with a clear error unless Supabase is configured and real adapters are complete.

## Platform Auth Safety

- GitHub: prefer `gh auth login` or `GITHUB_TOKEN` in `.env.local`; use read-only repo/user/org calls only.
- X/Twitter: prefer official X API with `X_BEARER_TOKEN`; no browser automation by default.
- Reddit: prefer official API credentials with PRAW-style app credentials; no browser automation by default.
- LinkedIn: manual review or approved official/partner API only by default; no automated browsing, messaging, connecting, following, or reacting.
- Instagram: public unauthenticated pages only; no cookies, saved posts, private data, DMs, or logged-in automation.
- Xiaohongshu: not configured by default; any logged-in read-only browser use requires explicit approval.
- Bilibili: public search is acceptable; logged-in subtitles require explicit approval and should not be scheduled.

## Scoring

The scoring model is transparent and explainable:

- Post raw engagement uses documented weights.
- Scores use log scaling, recency decay, engagement-rate context when available, and percentile normalization.
- Platform scores aggregate top posts, consistency, and account metrics.
- Company scores combine company accounts and founder accounts, then normalize relative to the selected batch.
- Missing platforms are re-normalized and recorded in score limitations.
- Review state uses `verified`, `needs_review`, and `rejected`.
- Baseline seeds are platform-local hints only; the app does not claim one Instagram like equals one GitHub star or one LinkedIn reaction.

## Current Limitations

- Demo ingest is working; live database ingest is still gated behind future persistence adapters.
- YC live batch fetching, connector persistence, and end-to-end Supabase writes are not complete in the worker route yet.
- Product Hunt, YouTube, RSS, web, GitHub, X, LinkedIn, and Instagram connectors are registered conservatively, but several are placeholders or public-only until credentials/API design is complete.
- No scheduled scraping exists.
- Browser automation is intentionally not part of the default app pipeline.
- Runtime UI/API files may still need a follow-up pass to replace old numeric review-quality controls and labels with `review_state` controls.

## Troubleshooting

- If ingest rejects your request, remove any token/cookie/session fields from the JSON body.
- If real ingest fails, set `options.demo=true` or configure Supabase and wait for real adapter wiring.
- If `gh` fails, run `gh auth status` and re-authenticate with `gh auth login`.
- If TypeScript cannot find generated route/component types, run `npm run typecheck` once after installing dependencies.
- If the graph canvas fails to render, confirm `react-cytoscapejs` and `cytoscape` are installed and then run `npm run build`.
