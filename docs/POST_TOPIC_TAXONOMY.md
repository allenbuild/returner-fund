# Post topic taxonomy

Taxonomy `post-topics-2026-07-23` has one primary topic per physical post. A secondary topic is exceptional and appears only when two announcements have equal, high-confidence evidence. Source platform and format are metadata, never topics.

| Primary topic | Include | Exclude / boundary |
| --- | --- | --- |
| Traction & Growth | Quantified revenue, users, growth, retention, usage, or deployment milestone | A number alone, engagement counts, or planned targets |
| Product Launch | Newly available product, feature, release, beta, or version | A demo of an existing product |
| Product Demo | Walkthrough, screenshot, demo, use case, or capability in action | “Book a demo” or Demo Day |
| Customers & Partners | Named customer, contract, pilot, deployment, integration, or formal partner | Generic mention of customers |
| Fundraising | Funding round, grant, investment, debt financing | Fundraising advice or a historical investor bio |
| Accelerator | Authored acceptance, participation, or Demo Day announcement | Merely being a YC company or congratulating someone else |
| Hiring & Team | Roles, recruiting CTA, team addition | Generic culture language |
| Founder Perspective | Mission, thesis, founder origin/lesson, strategic perspective | Product description without a perspective |
| Research & Technical | Benchmark result, research, paper, technical explanation, substantive OSS release | A GitHub repository alone |
| Events & Media | Event, interview, press, award, webinar, community activity | A product launch occurring at an event |
| Educational | Tutorial, guide, explainer, primer | Promotional feature announcement |
| Humor & Culture | Meme/joke or entertainment-first culture content | Humorous phrasing around a real launch |
| Corporate Update | Meaningful general announcement | A better-evidenced topic |
| Unclassified | Insufficient reliable content for any topic | Never silently hidden; reviewable in diagnostics |

Secondary signals independently record facts such as a quantified metric, named customer, funding amount, release availability, benchmark, accelerator reference, author type, event, or press. They do not add extra primary labels.

## Classification and review

The deterministic classifier normalizes title, visible text, structured visible snippets, hashtags, format, platform, and author type; extracts signals; scores candidates; validates boundary exclusions; then publishes high-confidence results. Low-confidence, co-primary, and Unclassified decisions carry `needsReview`. The persisted row contains the taxonomy/classifier version, confidence, concise reasoning, quoted matching text, alternatives, and prior decision metadata—never hidden reasoning.

Manual overrides are immutable classification rows with `manual_override=true`; they supersede an automated row and survive later automated backfills. Retire a row to roll back instead of changing raw evidence.

## Count and filtering semantics

Topic counts are deduplicated physical posts, not companies. Facet counts are computed from the same evidence set after every non-topic filter (batch, platform, vertical, industry, partner, score, search, and top-voice scope). Selecting a topic keeps an entity when it has at least one qualifying post. The map preserves global score semantics but narrows evidence/contribution display; it does not claim a newly recomputed canonical score.

## Review set and evaluation

The checked-in graph snapshots contain 3,242 deduplicated physical posts across
GitHub, X, Product Hunt, YouTube, Instagram, Hacker News, LinkedIn, and Reddit.
Create a deterministic stratified set of 300 real records with:

```sh
npm run topics:review-set
```

The generated `work/post-topic-review-set.json` has blank expected labels by
design. A maintainer must review it before it becomes a benchmark; predicted
labels are never treated as ground truth. After review, run:

```sh
npm run topics:evaluate
```

This reports accuracy, macro F1, per-topic precision/recall/F1, a confusion
matrix, false positives, the Unclassified rate, and review-queue rate. Do not
promote a classifier where a category lacks sufficient reviewed examples or
where the reviewed false-positive rate increases. The current deterministic
rules use `Corporate Update` for substantive company-authored fallback content
and `Founder Perspective` for substantive founder-authored fallback content;
content too thin to establish scope is `Unclassified`.

## Backfill

`npm run topics:backfill:dry-run` creates a checkpointed plan without modifying evidence or a database. Use `--write-plan --output=work/topic-backfill-plan.json` only after review. The database migration adds append-only, indexed classification rows; a production worker must insert a new row and retire/supersede the old active row in the same transaction. A partial unique index permits exactly one active decision per evidence record, preventing concurrent workers from publishing conflicting results. Roll back by retiring the latest versioned row and restoring the prior row; raw evidence is never touched.

## Adding or correcting a category

Add a canonical slug and group in `src/lib/graph/post-topics.ts`, document its
positive evidence and exclusions here, add boundary tests, generate/review new
examples, then increment both taxonomy and classifier versions. Manual
corrections are represented as `manual_override` rows in
`evidence_topic_classifications`; an automated worker must skip an active manual
row and write its previous decision through `supersedes_id` when an override is
removed. This leaves a complete audit trail.
