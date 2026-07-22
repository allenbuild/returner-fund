# Post-topic audit — 2026-07-22

## Dataset and method

This audit used the three committed public graph snapshots because no live
database credentials were present: `s2026.json`, `s26.json`, and
`a16zsr006.json`. They contain 3,242 deduplicated physical posts (deduped by
platform plus native post ID/URL) across GitHub (206), X (2,193), Product Hunt
(6), YouTube (150), Instagram (165), Hacker News (46), LinkedIn (465), and
Reddit (11). Each row had text; no row had `rawVisibleText`.

## Retired taxonomy and observed problem

The July 20 flat taxonomy had 25 labels: Traction, Product Showcase, Product
Launch, YC Acceptance, Company Vision, Humor, Customer Win, Fundraising,
Hiring, Founder Story, Technical Deep Dive, Open Source, Research or Benchmark,
Partnership, Demo Day, Milestone, Product Update, Behind the Scenes, Market
Insight, Community, Press or Media, Awards, Event, Culture, and Other.

Of the 3,242 physical posts, 2,871 (88.6%) were `other`; 22 (0.7%) had more
than one label; none had zero labels only because `other` was always used as a
catch-all. The most material overlaps were Traction/Milestone, Product
Showcase/Product Update/Product Launch, YC Acceptance/Demo Day, Company
Vision/Founder Story/Market Insight, and Research/Technical Deep Dive/Open
Source. Source type was also often mistaken for semantic subject (especially
GitHub and Product Hunt).

## v2 dry-run result

`scripts/reclassify-post-topics.mjs --dry-run` evaluated the same 3,242 posts
using taxonomy `post-topics-2026-07-22` / classifier
`post-topics-rules-2026-07-22.1`. It proposes 3,242 versioned updates because
every snapshot is stamped with the retired taxonomy. The resulting distribution
is: Other 2,468; Corporate Update 247; Product Launch 121; Accelerator &
Program 112; Event, Media & Community 40; Educational & Informational 34;
Fundraising & Financing 28; Customer, Partnership & Deployment 27; Hiring &
Team 11; Traction & Growth 8; Humor & Culture 7; Product Demo & Showcase 3;
Research, Benchmark & Technical Insight 3; Vision & Founder Perspective 3;
Unclassified 130.

The dry run intentionally moves thin but clearly in-scope records to `Other`
rather than fabricating a specific subject. `Unclassified` is reserved for
content too sparse to establish a reliable scope. 3,163 decisions are flagged
for review because the available historical evidence is mostly low-context;
the review set script is therefore a required gate before publishing a bulk
backfill.

## Correctness conclusions

- Runtime/API enrichment replaces retired automatic labels; curated and manual
  decisions retain precedence.
- Topic facets count deduplicated posts after all non-topic filters, then omit
  the current topic selection to preserve useful OR-filter counts.
- Map scores intentionally remain canonical/global; only visible evidence and
  entities are narrowed by topic filters.
- Checked-in graph JSON remains on the retired version until a reviewed
  production backfill and normal artifact publication are approved.
