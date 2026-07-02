# UI Design System

## Product Frame

YC Network Intelligence is an operational research dashboard. It should feel dense, legible, and source-aware rather than promotional.

Default first screen:

- Batch selector set to `YC Spring 2026`
- Loaded company count shown against expected count `197`
- Graph and node detail visible without a landing page
- Review queue available as a working surface

## Layout

- Use a compact top bar for app identity, batch selector, snapshot selector, ingest, and refresh.
- Use a single filter band for search, platform filters, edge filters, industry, business model, score range, and review state.
- Keep the main grid split between graph canvas and node detail.
- Keep leaderboard, hottest movers, review queue, and system status in tabs below the graph.
- Avoid nested cards. Use bordered panels for major work areas and simple rows for repeated content.

## Color Tokens

| Token | Use | Color |
| --- | --- | --- |
| `background` | App surface | `#f7f8fb` |
| `foreground` | Primary text | `#172033` |
| `muted` | Secondary text | `#657187` |
| `panel` | Panels | `#ffffff` |
| `panel-border` | Panel borders | `#d9dfeb` |
| `industry-fintech` | Fintech nodes | `#2563eb` |
| `industry-healthcare` | Healthcare nodes | `#16a34a` |
| `industry-developer-tools` | Developer tools nodes | `#7c3aed` |
| `industry-climate` | Climate nodes | `#0f766e` |
| `edge-founder` | Founder relationship | `#314e7d` |
| `edge-industry` | Industry similarity | `#8a6a1f` |
| `edge-group` | Group partner | `#36735c` |
| `review-verified` | Verified ring/badge | `#2f855a` |
| `review-needs` | Needs-review ring/badge | `#b7791f` |
| `review-rejected` | Rejected ring/badge | `#b83232` |

The palette should stay balanced across blue, violet, green, amber, and red accents on a neutral canvas.

## Typography

- Body: system sans or Arial/Helvetica fallback.
- H1: compact product title, not hero-sized.
- Panel headings: small, bold, easy to scan.
- Table headers: uppercase, muted, and compact.
- Labels inside graph nodes should be short and wrap cleanly.

## Controls

- Use icon plus text for primary commands such as ingest and refresh.
- Use select controls for batch and snapshot.
- Use segmented/toggle buttons for platform, edge type, and review state.
- Use a numeric range only for score, not identity/source quality.
- Use badges for `verified`, `needs_review`, and `rejected`.
- Use tooltips for icon-only graph controls when added.

## Review State Presentation

`verified`:

- Green badge or solid green graph ring.
- Included in default graph, scores, and leaderboards.

`needs_review`:

- Amber badge or dashed amber graph ring.
- Included in graph by default, clearly marked in node detail and review queue.

`rejected`:

- Red badge or muted red graph ring.
- Hidden from primary graph by default unless the review-state filter includes it.

Do not show numeric identity/source-quality percentages in node panels, tables, filters, API payload examples, or graph legends.

## Graph Encoding

Node encoding:

- Shape: circle only. Business model appears in metadata and filters, not as a graph shape.
- Size: batch-relative score percentile, with min/max caps.
- Fill: group-partner/industry cluster color with enough palette separation to avoid a blue/purple-heavy map.
- Border/ring: review state.
- Label: company name, placed only when it does not collide with other labels or circles. Hover and search can reveal any hidden label.
- Selection: dark outline plus neighborhood emphasis.

Edge encoding:

- Width: relationship weight.
- Color: relationship type.
- Style: `industry_similarity` subtle thin line, `same_group_partner` subtle dashed cluster cue. Founder-company links are rollup data, not rendered graph edges.
- Opacity: weaker relationships lower opacity; selected neighborhoods higher opacity.
- Arrow: none. Use simple lines only.

Canvas behavior:

- Default layout should fit the complete selected batch.
- Search should dim nonmatching nodes rather than reshaping the full graph.
- Hover should emphasize first-degree neighbors.
- Selecting a node should update the node panel and evidence feed.
- The graph should remain readable at the expected `S2026` scale of exactly 197 company circles.

## Node Panel

The node panel should show:

- Name, entity type, score, score delta, and review state.
- YC profile and website links.
- Batch slug and label.
- Business model, customer type, and pricing model when available.
- Group partner only when source-backed.
- Industries/tags.
- Founders for the selected company, with founder evidence rolled into the company feed and score.
- Social profiles with review badges.
- Platform scores and evidence feed.

## Tables And Tabs

- Leaderboard: rank, company, score, top platform, biggest contributing evidence.
- Hottest: rank, company, score delta, percent delta, rank delta, benchmark comparison.
- Review queue: entity, platform, candidate URL, review state, reason, evidence link.
- System status: connector status, safe default, limitations, and last run.

## Responsive Rules

- On desktop, keep graph and node panel side by side.
- Below tablet width, stack graph, tabs, and node panel.
- Preserve fixed graph height with responsive min/max bounds.
- Keep buttons and labels from reflowing into overlapping text.
- Avoid viewport-scaled font sizes.
