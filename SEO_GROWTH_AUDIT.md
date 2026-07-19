# Returner SEO Growth Audit

Audit date: 2026-07-18
Repository: `returner-fund`
Scope: repository and local build artifacts only; no production crawl, Search Console, analytics account, backlink, rank, or keyword-volume data was available.

## Executive assessment

Returner has a strong raw SEO asset: a structured, evidence-backed catalog of accelerator cohorts, 339 companies, 690 founders, industries, group partners, and platform traction. The product remains architecturally a client-heavy graph dashboard, but the current working tree adds server-rendered entity, directory, search, methodology, sources, corrections, FAQ, rankings, metadata, and discovery surfaces. A local production build generated 1,101 pages and a rendered crawl confirmed the representative public and internal route contracts; production deployment and external crawl validation remain manual gates.

The growth strategy should be **entity pages first, programmatic combinations second, editorial pages last**. Company, founder, cohort, industry, platform, and partner pages can answer distinct search intents with first-party structured facts. Arbitrary filter combinations should remain non-indexable until demand and uniqueness are proven.

Current state by area:

| Area | State | Main finding |
| --- | --- | --- |
| Architecture | Mixed | App Router and server components are available, but the graph and most entity detail arrive after client JavaScript and a large JSON fetch. |
| SSR/crawlability | Improving | The working tree adds an SSR discovery block, but the graph itself still SSRs as a loading shell with no initial graph. |
| Indexation | Locally verified | Admin/debug `noindex` and robots exclusions exist; generated public routes were production-built and representative pages were crawled locally. |
| Information architecture | Strong active implementation | Six entity families, their hubs, search, rankings, methodology, sources, FAQ, corrections, and about pages are present in the active tree. |
| Queryability/share | Improving | Active work persists filters and selected node and adds share actions; server parsing and canonical behavior still need parity checks. |
| Metadata/share | Good foundation | Metadata base, canonical, Open Graph, Twitter card, dynamic OG image, manifest, and title template are present in the working tree. |
| Schema | Good foundation | `Organization`, `WebSite`, `Dataset`, directory/entity schema, breadcrumbs, FAQ, and an implemented `/search?q=` `SearchAction` are present; validate rendered output and enrich dataset rights/freshness. |
| Robots/sitemap | Locally verified | The sitemap emits 842 indexable URLs with snapshot `lastModified`; production-domain validation remains a release step. |
| Performance | Material risk | Existing homepage first-load JS is about 670.7 KB raw / 193.8 KB gzip; the default graph adds about 6.0 MB raw / 896.0 KB gzip. |
| On-site search | Split implementation | `/search?q=` is server-rendered, `noindex`, and advertised in WebSite schema; dashboard search remains a separate client-side interaction. |
| Analytics | Good foundation, unverified | One redacted root Vercel Analytics mount and typed dashboard events are present; verify live delivery, consent/privacy requirements, and one event per action. |

## Evidence and assumptions

### Repository facts

- Framework: Next.js App Router, React, TypeScript, Vercel deployment configuration.
- Local build diagnostics identify Next.js `16.2.10`; `package.json` permits the compatible `16.2.x` range.
- Public data is served from nine JSON snapshots in `public/graph/`; the dashboard prefers a static snapshot and then refreshes from `/api/graph`.
- `/api/graph` is `force-dynamic`, Node runtime, internally cached for up to 60 seconds, and returned with `Cache-Control: no-store`.
- The homepage is a server page wrapping a large `"use client"` dashboard. No `initialGraph` is currently passed, despite an unused `buildInitialPageGraph` helper.
- The active SEO work includes six entity route families and hubs; server-rendered search; rankings, methodology, sources, corrections, FAQ, and about pages; catalog helpers; metadata; robots; sitemap; manifest; generic and company OG images; discovery components; analytics helpers; and internal-route `noindex` layouts. These are locally built and crawled but not production-deployed by this audit.

### Assumptions to validate

1. `https://returner.fund` is the intended production canonical host. The code falls back to it, but `.env.example` does not document `NEXT_PUBLIC_SITE_URL`.
2. Public indexing is intended for curated company, founder, cohort, industry, platform, and partner pages only.
3. The project has the right to publish the company metadata, derived traction summaries, and evidence excerpts it exposes.
4. Returner is independent of YC and a16z; the new disclaimer should remain visible on relevant pages.
5. Snapshot `generatedAt` is the appropriate freshness source for page copy, schema, and sitemap `lastModified`.
6. Search engines should not index arbitrary dashboard query combinations, admin pages, debug pages, or APIs.
7. No production behavior is claimed by this audit. DNS, redirects, status codes, rendered HTML, robots headers, Core Web Vitals, and Search Console coverage require manual verification.

## Architecture and rendering model

```text
Next.js App Router
  /                         server page + SSR discovery content + client Dashboard
  /api/graph                dynamic graph builder, no-store response
  /graph/*.json             static graph snapshots used first by the browser
  /admin/*, /debug/*        operational/internal pages
  SEO catalog               server-only filesystem reader over three base snapshots
  active entity URLs        company, founder, cohort, industry, platform, partner
```

The graph is an excellent exploration interface but a weak primary indexation unit. The active tree now supplies stable HTML documents for entities and collections through a server-only catalog that derives deterministic slugs, indexability flags, evidence, and relationships from the same public graph artifacts used by the app. The remaining question is integration quality: successful static generation, unique output, index thresholds, and real deployed responses.

Recommended ownership boundary:

- Keep the graph as the interactive exploration layer.
- Make entity and directory routes server-rendered HTML with optional client enhancements.
- Generate metadata, schema, internal links, and sitemap entries from the same catalog records.
- Keep arbitrary query/filter views `noindex,follow` with a canonical to the nearest stable directory or entity page.
- Do not expose admin/debug routes as acquisition pages; `noindex` is not authentication.

## Measured local snapshot

Measurements were taken from repository files and `.next/diagnostics/route-bundle-stats.json`. Gzip values use local `gzip -c`. The integrated production build completed on 2026-07-18 with Next.js 16.2.10 and generated 1,101 pages.

### Catalog and route opportunity

| Measure | Count |
| --- | ---: |
| Base cohorts | 3 |
| Companies | 339 |
| Companies meeting current catalog indexability rule | 339 |
| Founders | 690 |
| Founders meeting current catalog indexability rule | 452 |
| Exact-name founder collisions | 1 name (`Kyle Wong`, two distinct IDs) |
| Primary-industry groups | 12 |
| Primary-industry groups with at least three companies | 10 |
| Group-partner groups | 18 |
| Groups meeting current partner indexability rule | 17 |
| Evidence-backed platforms | 8 of 13 modeled platforms |
| Base-snapshot evidence rows | 2,593 physical rows / 1,980 unique IDs |
| URLs emitted by the current sitemap logic | 842 including `/` |

The current sitemap total is below the 50,000-URL single-sitemap limit. Splitting is not required now, though entity-specific sitemaps may become operationally useful later.

### Cohort data

| Snapshot | Companies | Founders | Edges | Evidence | Raw | Gzip |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| YC Spring 2026 (`s2026.json`) | 197 | 397 | 327 | 1,980 | 5,979,454 B | 896,031 B |
| YC Summer 2026 (`s26.json`) | 83 | 165 | 115 | 364 | 1,432,319 B | 199,875 B |
| a16z speedrun 006 (`a16zsr006.json`) | 59 | 128 | 113 | 249 | 1,022,930 B | 123,302 B |
| Three base snapshots | 339 | 690 | 555 | 2,593 | 8,434,703 B | 1,219,208 B |
| All nine graph variants | - | - | - | - | 9,560,929 B | 1,372,341 B |

### Frontend and static assets

| Asset | Raw | Gzip | Notes |
| --- | ---: | ---: | --- |
| Homepage first-load JavaScript | 670,657 B | 193,777 B | Eight chunks in the local route-bundle diagnostic. |
| Homepage CSS | 63,209 B | 12,700 B | Main CSS chunk. |
| Default static graph | 5,979,454 B | 896,031 B | Fetched after hydration for the default cohort. |
| JS + CSS + default graph | 6,713,320 B | 1,102,508 B | Excludes HTML, fonts, images, API refresh, and protocol overhead. |
| Evidence thumbnails | 24,979,749 B | not measured | 1,293 files: 1,225 PNG and 68 SVG. |
| Entire `public/` tree | 34,547,275 B | not measured | Includes graph variants, thumbnails, and brand image. |

The graph payload, not HTML, dominates first meaningful use. Even on a warm CDN, parsing and retaining roughly 6 MB of JSON plus Cytoscape state can affect interaction latency and memory on mobile devices.

## Detailed audit

### SSR and crawlability

What works:

- App Router server pages can render entity HTML without a separate service.
- The homepage discovery section exposes crawlable copy and links after the dashboard in document order, without depending on dashboard hydration.
- The catalog reads checked-in snapshots server-side, so entity routes do not need a browser API fetch for their primary content.

Gaps:

- `Dashboard` receives no `initialGraph`; its server output is principally controls and a loading state, not company/entity content.
- Cytoscape nodes, client search results, selected-node details, and most evidence are not useful without JavaScript.
- The graph experience still depends on JavaScript; the server-rendered directories and profiles provide the crawlable entity layer.
- The dashboard `h1` now precedes the discovery `h2` in document order.
- A custom `not-found.tsx` returns a real 404 and links to company, cohort, and search surfaces.

### Indexation controls

What works:

- Query views are being marked `noindex`.
- `admin` and `debug` layouts set `noindex, nofollow, nocache`.
- Robots rules disallow `/admin/`, `/debug/`, and `/api/`.

Gaps and cautions:

- A robots disallow can prevent crawlers from seeing an HTML `noindex`. Prefer route-level `noindex` plus access control for sensitive areas; use disallow mainly to reduce crawl waste.
- `noindex` is not security. Admin diagnostics must remain authenticated at the data/API boundary, and debug pages should not expose secrets or unpublished data.
- Current query detection treats any query parameter as a non-indexable view, which is safe for duplication but should be covered by tests for tracking parameters, invalid batches, and empty values.
- A filtered dashboard canonical should resolve to a real, semantically equivalent 200 page. Never canonicalize to an unimplemented cohort URL.
- Indexability thresholds are explicit: all 339 verified companies pass the content/source rule, while 452 of 690 founders pass through attributable evidence or at least two public accounts. Continue monitoring content uniqueness before expanding the thresholds.

### Information architecture

Implemented durable hierarchy in the active tree:

```text
/
/companies/                 company directory
/companies/[slug]/          company profile and traction evidence
/founders/                  founder directory
/founders/[slug]/           founder profile, company, accounts, evidence
/cohorts/                   cohort directory
/cohorts/[slug]/            cohort overview and ranked companies
/industries/                industry directory
/industries/[slug]/         companies and evidence in an industry
/platforms/                 platform directory
/platforms/[slug]/          traction methodology and companies for a platform
/partners/                  group-partner directory
/partners/[slug]/           associated companies with independence disclaimer
/rankings/                  score-ranked companies with limitations
/search/?q=                 server-rendered catalog search, noindex
/methodology/               scoring, freshness, evidence, limitations
/data-sources/              provenance and source policy
/about/, /faq/, /corrections/
```

The active entity pages link up to directories, across related entities, and into graph views. Validate the rendered graph URLs and breadcrumbs. Directory pages need pagination or bounded server-rendered lists once they grow; avoid sending all 339 companies or 690 founders in one HTML document indefinitely.

Do not create indexable pages for every cross-product such as cohort x industry x platform. Add a combination only when it has distinct intent, enough entities, unique explanatory copy, and internal links.

### Queryability and shareability

The graph API supports more dimensions than the page currently parses: batch, platforms, edge types, minimum score, industries, group partners, business models, `q`, top voices, and response-detail flags. The active dashboard work adds URL persistence for several filters and selected node, plus copy/native-share controls.

Required contract:

- Define a single allowlisted URL-state schema shared by server parsing, client hydration, API requests, sharing, and analytics.
- Round-trip `batch`, `platforms`, `industries`, `groupPartners`, `minScore`, `topVoices`, and `node` without dropping or rewriting valid state unexpectedly.
- Use the implemented `/search?q=` route as the durable server-rendered search state. WebSite schema now points there; keep the dashboard's client-only search contract distinct or intentionally bridge to the same URL.
- Reject or normalize invalid values consistently; do not let arbitrary query text reach metadata or analytics.
- Keep raw entity IDs out of canonical public profile URLs. The graph link may use an ID, while entity pages use stable slugs.
- Preserve a stable shared URL before calling `navigator.share` or clipboard APIs.

### Metadata and social sharing

The working tree provides a solid global foundation: `metadataBase`, title template, description, canonical, robots directives, Open Graph, Twitter card, icons, manifest, and a 1200x630 generated image.

Next requirements:

- Generate unique title, description, canonical, OG URL, and image alt text for every entity and directory page.
- Keep titles descriptive rather than keyword-stuffed: `{Company} traction, founders and public signals | Returner`.
- Pass unsuffixed titles to `publicMetadata` because the root title template appends `| Returner`; rendered representative pages contain one suffix.
- Include a visible freshness date in page content; do not put volatile scores in titles.
- Create entity-specific OG images only after generic sharing is verified. Include entity name, cohort, and a restrained metric summary.
- Verify the generated OG endpoint and social image fetchability without cookies, redirects, or robots blocks.
- `NEXT_PUBLIC_SITE_URL` is documented in `.env.example`; set it explicitly in preview/production. Preview deployments must not emit production canonicals into an accidentally indexable environment.
- Enforce one canonical host with HTTPS and one-hop redirects for `www`, protocol, and trailing-slash variants.

### Structured data

Current schema types are directionally appropriate: `Organization`, `WebSite`, and `Dataset`, with JSON escaped against `<` injection.

Fixes and extensions:

- Validate the current `SearchAction` end to end. It points to the implemented `/search?q={search_term_string}` route; confirm braces are serialized correctly and results render for encoded queries.
- Give stable `@id` values to the site, organization, dataset, and each public entity.
- Add `BreadcrumbList` on directories and entity pages.
- Use `ItemList`/`CollectionPage` for directories and cohort rankings.
- Use `Organization` for companies only when the page identifies a real organization; use `Person` for founders.
- Expand `Dataset` with `dateModified`, `temporalCoverage`, `license` or rights statement, `measurementTechnique`, `creator`, `isAccessibleForFree`, and a truthful `distribution` only if a documented downloadable dataset exists.
- Do not mark traction scores as ratings, reviews, or financial performance.
- Validate representative rendered pages in Schema Markup Validator and relevant eligible types in Rich Results Test. Schema correctness does not guarantee a rich result.

### Robots and sitemap

Current intent is correct: allow public pages, disallow operational/API paths, advertise the sitemap, and use the configured host.

Release requirements:

- Compare every sitemap URL to the actual route inventory and deployed response. All must return one-hop `200`, self-canonicalize, and be indexable.
- Exclude `noindex`, redirects, 404s, API URLs, query URLs, thin entities, and debug/admin pages.
- `lastModified` now comes from the relevant snapshot's `generatedAt`; keep that source of truth and omit fictional dates.
- Reconsider `changeFrequency: daily` for pages backed by snapshots that do not update daily. It is only a hint, but truthful signals are preferable.
- Return an XML content type and a successful response under the production host.
- Keep the sitemap under 50,000 URLs and 50 MB uncompressed. The current rendered count is 842.
- Confirm robots output on both production and preview. Preview deployments should be protected or globally `noindex`.

### Performance and Core Web Vitals

Highest-impact actions:

1. Lazy-load Cytoscape and graph-only UI after the SSR discovery/entity content becomes usable.
2. Stop making the 5.98 MB default graph the minimum data unit. Serve a compact index/summary first, then fetch a selected neighborhood, evidence page, or cohort slice.
3. Consider passing the existing trimmed `buildInitialPageGraph` result only if its serialized RSC payload is materially smaller than the static snapshot and avoids duplicate transfer. Measure, do not assume.
4. Compress JSON at the CDN and verify `Content-Encoding`; local gzip sizes are not proof of production compression.
5. Cache immutable/versioned snapshots for a long TTL. Keep truly live API responses separate from static assets.
6. Split evidence and detailed score breakdowns from graph topology. Fetch detail on selection.
7. Audit the five Poppins weights and remove unused weights.
8. Keep thumbnail dimensions stable, lazy-load below the fold, and prefer optimized image formats where source quality permits.
9. Add real-user monitoring for LCP, INP, CLS, and navigation timing by route family and device class.

Performance budgets for the next release:

- Initial route JS: target under 150 KB gzip; treat the current 193.8 KB as a regression baseline, not a final budget.
- Initial data needed for above-the-fold discovery: target under 200 KB gzip.
- No layout shift when the graph, fonts, or evidence images appear.
- Directory/entity pages should remain useful with JavaScript disabled.

### On-site search

There are now two search experiences: the dashboard's client-side company/founder jump and a server-rendered `/search?q=` catalog search spanning companies, founders, cohorts, industries, platforms, and partners. The server route is correctly `noindex`; the two surfaces still need a shared query contract and analytics behavior.

Recommended behavior:

- Search across company name, founder name, cohort, normalized industry, partner, and verified website domain.
- Return grouped, keyboard-accessible results with stable links to entity pages.
- Keep `/search?q=` pages `noindex,follow` initially and update WebSite schema to advertise that route.
- Track result count and result type, not raw query text.
- Add typo tolerance and aliases only where identity ambiguity is controlled.
- Use zero-result logs to improve synonyms and IA, not to auto-generate pages.

### Analytics

The active work adds Vercel Analytics, a privacy-safe URL redactor, typed property allowlists, and dashboard interaction events. The latest observed tree mounts `Telemetry` once in the root layout; it had briefly been duplicated in the dashboard during integration, so retain a test or source assertion that only one mount exists. Verify one page view and one custom event per semantic action in preview.

Measurement principles:

- Never send raw search strings, social handles, evidence text, full outbound URLs, secrets, or internal entity IDs.
- Use low-cardinality enums and bounded counts.
- Count one semantic user action once; deduplicate keyboard and click paths.
- Define conversion as meaningful research behavior, not raw page views.
- Segment by route family and cohort, but avoid high-cardinality page-specific custom properties when the analytics product already captures path.

## Prioritized backlog

### P0: release blockers

| Work | Acceptance criteria |
| --- | --- |
| Prove sitemap/route integration | Fresh-build every generated route, then verify each emitted URL returns a canonical indexable 200; no sitemap 404s or soft 404s. |
| Fresh build and route verification | Clean install, typecheck, tests, and production build pass after concurrent SEO work settles; route manifest contains all intended public paths. |
| Verify search schema | `SearchAction` resolves to implemented `/search?q={search_term_string}`, encoded queries render results, and the page remains `noindex,follow`. |
| Establish canonical environment | Production sets `NEXT_PUBLIC_SITE_URL=https://returner.fund`; preview is protected/noindex; host redirects are one hop. |
| Verify analytics privacy and delivery | Exactly one Analytics mount uses URL redaction; page views and custom actions fire once without query strings or IDs. |
| Protect internal surfaces | Admin data remains authenticated; debug/admin pages emit `noindex`; no secrets or private records appear in HTML. |
| Validate index quality | Thin/ambiguous entities are `noindex`; both `Kyle Wong` founder pages have unique slugs, canonicals, company context, and titles. |

### P1: launch-quality growth surface

| Work | Acceptance criteria |
| --- | --- |
| Validate six entity families and hubs | Company, founder, cohort, industry, platform, and partner pages/hubs build, are SSR, linked, canonical, and useful without JS. |
| Complete URL-state contract | Server and client round-trip all shareable graph filters and node selection; back/forward and copied links restore the same view. |
| Unique metadata and schema | Representative pages pass metadata snapshots and schema validation; no duplicate titles/descriptions across entity families. |
| Improve sitemap freshness | `lastModified` comes from snapshot generation; only indexable 200 URLs are included. |
| Reduce initial payload | Lazy graph code and compact data bring initial JS/data toward the stated budgets; production Brotli/gzip is verified. |
| Add methodology and sources | Public pages explain scoring, freshness, evidence provenance, limitations, corrections, and independence. |
| Instrument the funnel | Dashboard and entity discovery events are documented, tested, and visible in analytics without PII. |

### P2: compounding growth

| Work | Acceptance criteria |
| --- | --- |
| Build intent-led editorial pages | A small set of pages answers real cohort, industry, platform, and methodology questions with unique analysis. |
| Add entity-specific share images | Company/cohort OG images render reliably and improve share previews without volatile or misleading claims. |
| Publish a documented data distribution | If rights permit, expose a versioned downloadable dataset/API with license, schema, freshness, and `Dataset.distribution`. |
| Add selected combination pages | Only combinations with distinct demand, enough entities, unique copy, and strong internal links become indexable. |
| Monitor content decay | Automated checks flag stale snapshots, missing evidence, empty directories, title duplication, sitemap drift, and rising soft-404 rates. |

## Keyword and entity hypotheses

These are repository-derived hypotheses only. No search-volume, difficulty, CPC, trend, or rank claims are made.

### Core category hypotheses

| Intent | Example hypothesis | Best page |
| --- | --- | --- |
| Product/category | startup traction database; startup intelligence platform; startup traction tracker | Home and methodology |
| Accelerator discovery | YC Spring 2026 companies; YC S26 startups; a16z speedrun 006 companies | Cohort pages |
| Company research | `{company} founders`; `{company} traction`; `{company} YC batch`; `{company} social growth` | Company page |
| Founder research | `{founder} startup`; `{founder} company`; `{founder} YC` | Founder page |
| Industry discovery | YC robotics startups; accelerator healthcare AI companies; developer tools startups in YC | Industry pages, optionally cohort-qualified editorial pages |
| Platform traction | YC startups on GitHub; startup traction on LinkedIn; founder traction on X | Platform pages |
| Network/entity relationship | `{partner} YC companies`; companies in `{partner}` group | Partner pages with clear independence language |
| Methodology/trust | how startup traction is measured; public startup data sources; startup social traction methodology | Methodology and data-sources pages |

### Entity set to model explicitly

- Accelerators/programs: Y Combinator, a16z speedrun.
- Cohorts: YC Spring 2026/P26, YC Summer 2026/S26, a16z speedrun 006.
- Organizations: 339 catalog companies, each attached to one cohort and relevant industries.
- People: 690 founders and 18 group-partner labels, with ambiguity handled by stable IDs and company context.
- Platforms: X, LinkedIn, GitHub, YouTube, Instagram, Hacker News, Reddit, and Product Hunt currently have evidence rows.
- Concepts: traction score, momentum, public evidence, source attribution, review state, scoring limitations, freshness.

### Content rules

- Use the entity's real name and cohort naturally; do not repeat keyword variants mechanically.
- Distinguish observed public signals from claims about revenue, valuation, quality, or investment performance.
- Show source and observation dates near metrics.
- Use generated summaries only when they are fact-bound, reviewed, and materially different across pages.
- Avoid indexable pages for unsupported platforms, single-company thin industries, empty partners, or arbitrary filter combinations.

## Analytics event dictionary

The names below align with the typed events appearing in the active work where possible. `Status` distinguishes observed implementation from recommended coverage; verify all observed events in a live preview.

| Event | Trigger | Allowed properties | Status / purpose |
| --- | --- | --- | --- |
| `page_view` | One route view after consent/policy requirements | Redacted path only; no query string | Platform automatic; ensure one Analytics mount. |
| `search_submitted` | Enter or explicit search submission | `result_count` (0-1,000), `has_results` | Implemented; measures search utility without raw query. |
| `result_opened` | User opens a company/founder search result | `result_type`, `position` | Implemented; measures result relevance. |
| `filter_changed` | Batch/platform/industry/partner/top-voices/min-score changes | `filter`, `action`, `selection_count` | Implemented; measures exploration behavior. |
| `graph_node_opened` | Node selected from graph/search/leaderboard | `node_type`, `source` | Implemented; primary dashboard engagement. |
| `share_copied` | View URL copied successfully | `method=clipboard`, `included_filters`, `included_node` | Implemented; research-share conversion. |
| `social_share` | Native share completes without throwing | `method=native`, `included_filters`, `included_node` | Implemented; do not count cancellations. |
| `evidence_opened` | User opens a source evidence link | `platform`, `entity_type`, `surface` | Recommended; measures trust/depth. Never send URL/title. |
| `entity_page_viewed` | SSR entity page hydrates | `entity_type`, `cohort`, `has_evidence` | Recommended; route-family quality without entity ID. |
| `graph_view_opened` | Entity/directory user opens graph context | `source_entity_type`, `has_filters` | Recommended; bridge from SEO page to product. |
| `correction_initiated` | User opens correction/report flow | `surface` | Typed but verify UI wiring; trust signal. |
| `report_opened` | Methodology/source/data-quality report opened | `report_type` | Typed but verify UI wiring; education signal. |
| `related_entity_clicked` | Related company/founder/voice selected | `entity_type`, `source` | Typed but verify UI wiring; internal discovery. |
| `data_load_failed` | Graph/entity data fails after retries | `surface`, `source`, `cohort_class` | Recommended; operational guardrail, no error text. |
| `zero_result_seen` | Search returns zero after debounce/submission | `query_length_bucket` | Recommended; synonym signal without query content. |

Suggested funnel:

1. Organic landing on entity/directory.
2. Related entity, evidence, or graph view opened.
3. Filter/search interaction.
4. Share, correction, methodology, or source-depth action.

Report engagement rates by landing route family and device class. Do not optimize entity pages solely for page views; evidence opens, related-entity navigation, graph exploration, and shares are stronger indicators of useful research.

## Validation checklist

### Build and automated checks

- [x] Re-run after all concurrent changes settled; confirm only intended files are in the release.
- [ ] Install from the authoritative lockfile and resolve the npm/pnpm dual-lockfile policy.
- [x] Run typecheck, focused SEO/catalog tests, full tests, and production build.
- [ ] Assert every sitemap URL maps to a generated or runtime route.
- [x] Assert sitemap URLs are unique, absolute, HTTPS, indexable, and canonical to themselves in the local production output.
- [ ] Snapshot titles, descriptions, canonicals, robots, OG, and Twitter metadata for each route family.
- [x] Test slug uniqueness, including the two founders named Kyle Wong.
- [x] Test indexability thresholds for thin companies, founders, industries, platforms, and partners.
- [ ] Test invalid/unknown query parameters and unsupported slugs.
- [ ] Test JSON-LD serialization against `<` injection and schema shape.
- [ ] Test analytics property sanitization and verify each interaction sends at most one event.

### Rendered preview checks

- [ ] View source with JavaScript disabled: home, one company, one founder, one cohort, one industry, one platform, and one partner remain useful.
- [ ] Confirm one `h1`, logical heading order, visible breadcrumbs, and crawlable links.
- [x] Confirm representative 200/404 behavior locally; production host redirects remain manual verification.
- [ ] Confirm canonical host, title, description, robots, OG image, Twitter card, manifest, and icon URLs.
- [x] Confirm `/robots.txt`, `/sitemap.xml`, `/manifest.webmanifest`, and `/opengraph-image` return expected content and status.
- [x] Confirm admin/debug HTML has `noindex`; verify authentication independently.
- [ ] Validate schema in Schema Markup Validator and eligible pages in Rich Results Test.
- [ ] Test copied/shared graph URLs in a fresh session and with back/forward navigation.
- [ ] Test client search keyboard behavior, no results, aliases, and ambiguous names.
- [ ] Test mobile at constrained CPU/network; inspect LCP, INP, CLS, memory, JSON transfer, and long tasks.
- [ ] Verify production response compression and caching for versioned graph JSON, JS, CSS, fonts, and images.
- [ ] Use a social preview debugger for generic and entity-specific cards.

## Manual deployment and Search Console steps

### Before production

1. Let concurrent SEO work settle, review the final diff, and ensure the audit is not used as proof that uncommitted files shipped.
2. Set `NEXT_PUBLIC_SITE_URL=https://returner.fund` in the production environment and document it in `.env.example` without a secret value.
3. Decide canonical host (`returner.fund` or `www.returner.fund`) and configure HTTPS plus one-hop redirects from every alternate.
4. Protect preview deployments or emit a global `noindex` there. Confirm preview metadata does not create an indexable duplicate site.
5. Run a fresh production build. Record route output and updated raw/gzip first-load sizes.
6. Crawl the preview from the sitemap. Block release on any 4xx/5xx, redirect URL, missing canonical, `noindex` sitemap URL, duplicate metadata, or blank SSR page.
7. Enable Vercel Analytics for the project, mount it once with URL redaction, and verify a page view plus each custom event in preview/debug tooling.
8. Confirm data rights, independence disclaimer, corrections path, privacy disclosure, and analytics disclosure with the site owner.

### Immediately after deployment

1. Fetch production `/`, representative entity pages, `/robots.txt`, `/sitemap.xml`, `/manifest.webmanifest`, and `/opengraph-image` from outside the authenticated session.
2. Verify production HTML canonicals and OG URLs use the final host, not localhost, a preview URL, or a stale domain.
3. Verify static JSON is compressed and cached as designed; verify `/api/graph` freshness and error behavior separately.
4. Run a bounded production crawl starting from `/` and the sitemap. Compare discovered, indexable, canonical, and sitemap URL sets.
5. Check analytics for duplicate page views, query-string leakage, event cardinality, and successful custom-event delivery.

### Google Search Console

1. Create a Domain property for `returner.fund` and verify it with the DNS TXT record. Keep the record in DNS.
2. Also inspect the canonical HTTPS URL-prefix behavior if operational debugging benefits from it, but use the Domain property as the primary view.
3. Submit `https://returner.fund/sitemap.xml` in **Sitemaps**. Confirm the discovered count is close to the intended indexable count, not merely that submission succeeded.
4. Use **URL Inspection** live tests for the home page and one representative page from every route family. Check crawl allowed, index allowed, selected canonical, rendered text, and loaded resources.
5. Request indexing for the home page and strongest hubs/cohort pages first. Do not manually submit hundreds of thin entity URLs.
6. Monitor **Page indexing** for crawled-currently-not-indexed, discovered-currently-not-indexed, duplicate/canonical conflicts, soft 404s, and blocked-by-robots patterns.
7. Monitor **Core Web Vitals** by mobile and desktop. Correlate poor groups with graph-heavy versus HTML-first route families.
8. Monitor enhancements tied to valid schema, plus **Manual actions** and **Security issues**.
9. Review search queries and pages by route family after enough data accrues. Use impressions and click behavior to validate or reject the hypotheses above; do not infer demand from this repository audit.
10. Reconcile sitemap, crawl, index, and analytics counts after each material route or catalog release.

## Definition of launch-ready

SEO launch is ready when all 842 intended sitemap URLs exist and meet indexability criteria in production; representative pages render useful entity content without JavaScript; metadata/schema/canonicals are unique and valid; internal routes are excluded and protected; search action and results work together; analytics fires once without sensitive URL state; production compression and host redirects are verified; and Search Console accepts the sitemap with representative live tests passing.
