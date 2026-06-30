# Ingestion Strategy

## Goals

- Given a batch slug like `S2026`, fetch YC companies and founders automatically.
- Treat `S2026` as `YC Spring 2026`.
- Expect 197 companies for the default `S2026` batch.
- Prefer official YC sources when accessible.
- Use web/search fallback only when official source is blocked or unavailable.
- Store source URLs, evidence, business model fields, and `review_state` for extracted facts.
- Never infer group partner without a reliable source.
- Manual refresh only.

## Batch Ingestion Order

1. Normalize batch slug:
   - `S2026`, `Spring 2026`, `YC Spring 2026` -> `S2026`
   - `W2026`, `Winter 2026`, `YC Winter 2026` -> `W2026`
2. Upsert batch metadata:
   - `slug = "S2026"`
   - `label = "YC Spring 2026"`
   - `company_count_expected = 197`
3. Try official YC directory/profile sources.
4. If official source fails, use semantic/web search:
   - `site:ycombinator.com/companies "Spring 2026" "Y Combinator"`
   - `"YC S2026" startup founder`
   - `"Y Combinator Spring 2026" company founder`
5. Extract fields:
   - company name
   - batch
   - YC profile URL
   - website URL
   - tagline
   - description
   - industries/tags
   - business model
   - customer type
   - pricing model
   - founder names
   - founder YC profile URLs if available
   - founder personal websites if available
   - group partner if publicly available
6. Upsert records with `review_state`.
7. Log run, source URLs, evidence, and loaded count versus expected count.

## Review-State Mapping

`verified`:

- official YC profile page
- official company website linked from a YC profile
- founder listed on official YC/company page
- business model explicitly stated by YC or the company

`needs_review`:

- multiple independent public sources agree but no official source was captured
- strong search result snippets with exact batch/company/founder context
- business model inferred from product copy and needs human review

`rejected`:

- contradicted source
- ambiguous company or founder name
- stale result from another YC batch
- inaccessible page with no corroborating source

Uncertain matches must remain `needs_review`; do not promote them through scoring alone.

## Identity Resolution Order

For each company/founder:

1. Crawl official website.
2. Extract social links from homepage/footer/about/contact/team pages.
3. Use search for missing profiles.
4. Score candidates internally for ranking only.
5. Canonicalize only source-backed candidates.
6. Store uncertain candidates as `needs_review`.
7. Store rejected candidates with evidence when rejection explains why a URL was not used.

Any internal ranking value is implementation detail and must not be stored or shown as a product/API field.

## Connector Order

Safe/default:

1. GitHub
2. Web/search
3. Product Hunt public web/search
4. YouTube
5. RSS/blogs/news
6. Bilibili public search if relevant

Explicit-per-task only:

1. X/Twitter browser automation
2. LinkedIn browser automation
3. Reddit browser automation
4. Xiaohongshu browser automation
5. Bilibili logged-in subtitle automation

Instagram:

- Public unauthenticated pages only.
- No logged-in automation.

## Refresh Pipeline

`POST /api/ingest/batch`:

1. Create `ingestion_run`.
2. Fetch/upsert batch and expected company count.
3. Fetch/upsert companies/founders.
4. Discover social accounts.
5. Fetch recent posts and metrics where allowed.
6. Run scoring.
7. Create snapshots.
8. Rebuild graph edges.
9. Return logs, review queue, loaded/expected count, and graph payload.

## Demo Mode

Demo mode seeds deterministic fake YC-like entities and evidence. It must:

- require no credentials
- require no Supabase
- default to `S2026` / `YC Spring 2026`
- display expected company count `197`
- show every UI state
- include review queue examples
- include at least two snapshots for fastest-gaining
