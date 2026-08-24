# Midas Returner.Fund API

Midas can fetch a company's current published Returner.Fund score and its best
scored source posts from one bounded JSON endpoint.

## Request

```http
GET /api/v1/companies/{company}/returner-fund?batch={batch}&limit={limit}
```

- `company` is the YC slug (for example `atlia`) or graph company ID (for
  example `company-atlia`).
- `batch` is required and must be `S2026`, `S26`, or `A16ZSR006`. Company IDs
  are batch-scoped; the same company slug can occur in more than one batch.
- `limit` is optional, defaults to `5`, and must be between `1` and `20`.

Example:

```bash
curl 'https://www.returner.fund/api/v1/companies/atlia/returner-fund?batch=S26&limit=5'
```

The endpoint is read-only and public when `RETURNER_API_KEY` is unset. To use a
pre-shared key, configure that environment variable on Returner.Fund and send
one of these headers (Bearer is preferred):

```http
Authorization: Bearer <key>
X-Returner-Api-Key: <key>
```

## Response contract

The response has schema version `returner-fund-company-v1` and includes:

- canonical company identity and profile links;
- the current 0–100 published score, score model/version, confidence, platform
  components, evidence timestamp, and batch rank;
- a separately labeled, descriptive batch percentile derived with tie-aware
  midranks over all published companies in the requested batch;
- best eligible posts with display text, platform, author, post score, metrics,
  date, and a direct source URL;
- completeness and truncation metadata for the post list.

`returnerFund.cohort.derivedPercentile` is descriptive ranking metadata. It is
not a model percentile or an outcome probability. The current score model
deliberately does not use a cohort percentile.

## Midas rendering

Use `returnerFund.score` for the Returner.Fund line in the two-minute drill.
Render `bestPosts` in order beneath it. Make each row link to its `url`; useful
inline fields are `score`, `platform`, `title`, `authorName`, `publishedAt`, and
`metrics`.

The endpoint returns structured errors with these codes:

- `invalid_request` (400)
- `unauthorized` (401)
- `company_not_found` (404)
- `company_ambiguous` (409)
- `insights_out_of_sync` or `insights_unavailable` (503)
