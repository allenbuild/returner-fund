# Company Timeline

Company Timeline is the chronological, evidence-backed company history shown inside the existing company panel. It is deliberately separate from traction scoring: events are ordered by their supported calendar date, and social engagement never changes chronology or major-event status by itself.

## Product behavior

- Posts remains the default company-panel view.
- The header keeps the company name and score visible while a URL-backed `view=timeline` state replaces everything below the first divider.
- Timeline filters use `timelineFrom`, `timelineTo`, and `timelineCategories` query parameters. They are shareable, refresh-safe, and compatible with browser back and forward navigation.
- Cards show one exact date, a neutral title, one factual sentence, a category, materiality hierarchy, and a visible expansion control.
- Expansion fetches the complete evidence payload lazily. Initial company artifacts contain at most three source previews per event.
- The desktop date rail and mobile horizontal date row contain only months present after filters are applied.
- Public trust is communicated through inspectable sources and conflict warnings. Numeric model confidence is never public.

## Public artifacts and APIs

The request path never crawls, searches, clusters, or invokes a model. A deterministic backfill writes:

```text
public/timelines/coverage.json
public/timelines/companies/{company-slug}.json
public/timelines/events/{event-id}.json
```

The same publication writes the private operational manifest to
`artifacts/company-timeline/coverage.json`; it is bundled only into server
routes and is not hosted as a static asset.

The public endpoints are:

```text
GET /api/companies/{slug}/timeline?from=YYYY-MM-DD&to=YYYY-MM-DD&categories=funding,product_launch&cursor=...&limit=50
GET /api/timeline/events/{eventId}
```

Company responses are bounded, cursor-paginated, ETag-enabled, and served with stale-while-revalidate caching. Event details expose source metadata, short evidence excerpts, existing Returner post metadata, and conflicts; they never expose raw crawled text, prompts, classifier internals, review notes, or confidence scores.

Artifact schemas are versioned in `src/lib/timeline/contracts.ts`:

- `company-timeline.v1`
- `company-timeline-event.v1`
- `company-timeline-coverage.v1`

The directly served `public/timelines/coverage.json` is a deliberately minimal public index with aggregate company and published-event counts only. Operational source coverage, candidates, unresolved states, failures, and diagnostics live in the non-public `artifacts/company-timeline/coverage.json` manifest used by protected admin APIs. The internal manifest records both batch-scoped inventory rows and unique canonical companies. Repeated entities across cohorts are merged by stable entity ID, with evidence unioned deterministically.

## Event and evidence rules

Published events must pass every gate:

1. A verified company association exists.
2. The source URL is direct, canonical, and inspectable; a search snippet is never evidence.
3. The source supports an exact `YYYY-MM-DD` event, announcement, or publication date.
4. The title, one-sentence summary, category, date, and quantitative claims are supported by linked evidence.
5. The event is meaningful under the stable taxonomy in `src/lib/timeline/contracts.ts`.
6. Duplicate and conflict rules have run.

`eventDateType` records provenance, not a guess: native event records use
`occurrence_date`, direct company or founder announcements use
`announcement_date`, and third-party page timestamps remain
`publication_date`. A third-party publication timestamp is never promoted to
the company's event or announcement date.

Candidates with a missing exact date, uncertain identity, unsupported claim, weak sole source, or core existence conflict remain private and enter review. A batch label, year, month, quarter, metric collection time, website fetch time, or model guess is never converted to an event date.

Source quality tiers guide automatic publication:

- Tier 1: official company/founder/account, accelerator, investor, customer/partner, government, GitHub, research, and press-release sources.
- Tier 2: reputable news, trade publications, direct interviews, and established institutional sources.
- Tier 3: directories, syndication, aggregators, and databases used primarily for discovery.

One event may link many sources and existing posts. Deterministic merge keys combine company, category, named entities, quantitative values, normalized title tokens, canonical URLs, and nearby exact dates. Semantic or AI similarity may propose a merge but cannot override safeguards for recurring rounds, versions, customers, or milestones. Conflicting field claims are preserved; publishable conflicts receive a public warning and complete evidence detail.

## Source discovery and classification

Discovery is provider-based and asynchronous. Supported source classes include existing Returner evidence, official websites and feeds, founder sources, accelerator/investor/customer/partner pages, GitHub, Product Hunt, research and regulatory pages, public web search, and historical archives.

Search configuration is optional and adapter-specific. The deterministic existing-evidence pass, official-site/internal-link crawl, accelerator profile fetch, and Internet Archive CDX/replay path work without paid credentials or an authenticated social account. Provider failures create terminal per-source coverage states and never erase the last-good artifact.

With Supabase configured, the autonomous publication runner enqueues all eight `TIMELINE_SOURCE_CLASSES` for every canonical company through the existing leased ingestion-task store. Without Supabase, it uses a validated file-backed cache and processes at most 12 companies per invocation with two concurrent companies, a shared four-minute budget, 6-second page fetches, and oldest-first resumption. That fallback covers official sites (plus at most four bounded same-domain announcement/blog links), institutional profiles, and up to three immutable Internet Archive captures; configured Exa, Brave, Serper, or Tavily results remain discovery-only until each result page is safely fetched and attributed. It never invokes authenticated LinkedIn or another logged-in social session. Budget exhaustion, absent search credentials, no source, and fetch failures remain distinct coverage states.

Fetched content is untrusted. The source layer enforces HTTP(S), redirect limits, DNS/IP private-network blocking, timeouts, MIME and size bounds, canonical URL cleanup, content hashing, sanitized excerpts, and per-domain concurrency. Crawled text is data only: it cannot change instructions, invoke tools, request secrets, or relax evidence rules.

AI classification is an optional OpenAI-compatible strict-JSON provider enabled only when `TIMELINE_AI_API_KEY` (or `OPENAI_API_KEY`) and `TIMELINE_AI_MODEL` are both configured. The endpoint, model, prompt, and schema are versioned; source text is isolated as inert JSON; requests have short timeouts and finite retries. Invalid JSON, enums, source IDs, dates, quantities, multi-sentence summaries, or free-form output become private review candidates and cannot publish. AI may veto a candidate, but only the deterministic company/date/evidence extraction can supply publishable claims. The source content hash plus composite rules/model/prompt/schema version is the idempotency key, so terminal content is not billed or processed again without a version/content change.

## Database model and access

Migration `supabase/migrations/017_company_timeline.sql` adds normalized source documents, timeline events, entity/evidence/post links, candidates, company state, admin audit history, and indexes for company/date/category/status/canonical URL/content hash/review queues. Migrations `018_timeline_candidate_identity.sql`, `019_timeline_verified_post_links.sql`, and `020_timeline_entity_attribution_invariants.sql` add deterministic candidate identity, verified post attribution, and same-company entity/evidence enforcement. They extend the existing ingestion runtime rather than replacing runs, tasks, leases, retries, coverage, failures, or dead letters.

Public read policies expose only published events and bounded public source metadata. Candidates, raw snapshots, audit history, processing state, and diagnostics remain admin-only. Service-role writes and existing admin authentication patterns are reused.

Apply migrations `017` through `020` in numerical order using the repository's normal Supabase deployment process. The migrations are additive and do not delete or rewrite existing evidence.

## Backfill and incremental operation

Commands:

```bash
npm run timeline:backfill:dry-run
npm run timeline:backfill
npm run timeline:discover:public
npm run timeline:validate
npm run timeline:audit
npm run timeline:audit:links
npm run timeline:benchmark -- --base-url=http://127.0.0.1:3000
```

The backfill enumerates the base graph inventory at runtime, groups repeated canonical entities, and checkpoints outside `public/`. It is deterministic, resumable, idempotent, and safe to rerun. The optional `work/timeline-public-discovery-current.json` cache is inventory-hash bound, schema validated, stripped of page metadata, and included in checkpoint compatibility before its direct sources and terminal coverage are overlaid. The cache contains fetched source text and operational coverage, so it is local/private, gitignored, and never staged by autonomous publication. Every canonical company receives a terminal coverage row and an artifact, including legitimate zero-event timelines. Sparse histories are not filled with low-signal content.

When service-role Supabase access and migrations 017 through 020 are available, the backfill reads only the safe published event/source projections, maps batch-scoped database UUIDs back to canonical company `source_key`, unions repeated cohort rows, and merges verified evidence into the public artifacts. The database snapshot and file-backed public-discovery hashes both participate in resume compatibility. Missing database credentials no longer force graph-only discovery: the bounded public cache can supply directly fetched official, institutional, archive, and optionally searched evidence. An explicitly configured but unmigrated database still fails before publication so existing durable events cannot be silently dropped.

Recommended scheduling:

- Regular ingestion: classify new evidence, attach stronger sources, reconcile candidates, and invalidate only affected company artifacts.
- Daily: bounded official-site/feed/search discovery with source-specific concurrency.
- Periodic: historical gaps, aliases, archives, unresolved dates, and conflicts.

Future companies are enrolled automatically because each run derives inventory from canonical graph artifacts instead of an allowlist.

## Admin workflow

`/admin/timeline` and `/api/admin/timeline` use constant-time authentication with the dedicated server-only `ADMIN_TIMELINE_SECRET`. Ingestion and refresh credentials are intentionally not accepted because Timeline administration includes publication and evidence mutations. In production, immutable audit attribution comes from `ADMIN_TIMELINE_ACTOR_ID` and optional `ADMIN_TIMELINE_ACTOR_EMAIL`; caller-supplied actor headers are ignored. The protected interface shows coverage, incremental and deep scan freshness, event/candidate/conflict/date counts, failed-source and dead-letter totals, source states, and artifact cache state. Supported audited actions include rerunning discovery or one source, reclassification, cache rebuild, publishing/rejecting/editing/unpublishing, merge/split, evidence attachment/removal, and conflict resolution.

Every mutation records the actor, timestamp, prior value, new value, and reason where appropriate. Admin responses are no-store and never expose secrets.

## Validation, performance, and failure recovery

`timeline:validate` fails on inventory omissions, nonterminal coverage, missing or mismatched hashes, unsupported or future dates, missing evidence, duplicate IDs, incorrect chronology/groups, unsafe URLs, tracking parameters, confidence/internal field leakage, missing detail artifacts, or payload limits.

`timeline:audit` deterministically samples at least 30 diverse companies and 150 published events. `timeline:audit:links` additionally performs bounded read-only link checks. `timeline:benchmark` reports timeline and detail API p50/p95 plus payload sizes and cache outcomes.

Initial timeline artifacts are capped at 100 KB; detail artifacts are bounded and lazy. The last-good artifacts remain in place when a refresh fails. A failed discovery task is observable through coverage and admin diagnostics without taking the public timeline offline.

Run the full regression gate before publication:

```bash
npm run lint
npm run typecheck
npm run test
npm run timeline:validate
npm run timeline:audit
npm run build
```

Mobile QA covers 320×568, 375×667, 390×844, 414×896, and 430×932. Verify the header toggle, filters, sticky date navigation, expansion, long source wrapping, focus states, screen-reader labels, reduced motion, and absence of horizontal overflow.
