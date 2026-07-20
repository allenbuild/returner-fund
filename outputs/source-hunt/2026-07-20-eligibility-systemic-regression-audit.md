# Eligibility systemic regression audit — 2026-07-20

## Scope and result

This audit is limited to canonical source loading for YC Spring 2026 (`S2026`), YC Summer 2026 (`S26`), and a16z Speedrun 006 (`A16ZSR006`). It does not change scoring formulas, weights, taxonomies, verticals, UI, graph types, or snapshots.

One deterministic loader defect was proven and fixed: LinkedIn activity classification treated the prose phrase `comments on` in a title, match reason, or full page capture as proof that the row itself was a comment. A native post could therefore lose its post ID and positive contribution merely because its evidence prose described an engagement counter. Earendil activity `7442570736751374336` reproduced that failure before its source reason was reworded. The loader now requires either a stable native comment locator or explicit adjudication language such as `Native LinkedIn comment` or `comment-level`; ordinary engagement prose is inert.

The current Earendil source string had already been rewritten from `comments on` to `comments for`, so this structural fix intentionally changes no current materialized count.

## Materialized inventory after the fix

| Batch | Evidence | Positive contribution |
| --- | ---: | ---: |
| S2026 | 2,848 | 2,247 |
| S26 | 994 | 719 |
| A16ZSR006 | 307 | 303 |

Named visibility checks:

- Vestris: exactly 2 eligible native founder posts (`7467251847137939459`, `7467271346683801600`).
- Earendil Robotics: exactly 1 eligible native company post (`7442570736751374336`); third-party activity `7478895855991775232` remains excluded.
- Hexa: exactly 1 canonical eligible physical post (`7452780945771966465`), attributed to roster founder Ishaan Makkar.
- Quanto: exactly 1 eligible founder LinkedIn post (`7453449486699290624`); the Product Hunt product root remains context-only with contribution `0` and `upstream_excluded` eligibility.
- Sidekick (`company-textsidekick` and its colliding founder ID): 0 materialized evidence rows. The two old HN items are S20/W23 entities and remain fail-closed across S2026/S26.

## Exhaustive source-to-loader reconciliation

For YC, the sweep read all verified rows from public, logged-in, and targeted evidence, required a current roster entity, non-invalid link state, positive supported native metrics, strict native URL/post identity, and the loader's batch-scope rules.

- 3,645 raw candidate observations collapsed to 3,459 batch-scoped physical identities.
- 3,350 physical identities are materialized.
- 186 duplicate observations collapse without losing a physical identity.
- 109 physical identities are not materialized, all accounted for below:
  - 37 Hacker News identities: 35 S2026 candidates lack required current Spring/P26 proof; the other 2 are the same old Sidekick S20/W23 items considered under S26 and deliberately quarantined.
  - 33 public-LinkedIn identities: no candidate author handle matches a roster-linked company/founder account or a known Top Voice. This set includes the expected third-party Earendil activity.
  - 38 logged-in-LinkedIn-only identities: canonical `feed/update/urn:li:activity` URLs exist, but the legacy captures do not carry stable native author account metadata. They are held rather than assigning parent-post/repost metrics to the roster entity.
  - 1 targeted LinkedIn identity: Libra Robotics activity `7482265767493779456`; the stored roster proof explicitly says `exactProfileMatch: false`, and the roster has no company LinkedIn account, so it remains unresolved.

All 81 positive Top Voice source identities are accounted for: 80 retain their native post/comment ID, and the Andrew Miklas/InsForge parent-post claim remains present as rejected context with its parent ID removed. No Top Voice row disappears because of handle/name matching.

For A16Z, 305 seeded rows yielded 291 verified positive roster-attributed candidates. All 285 strict-native candidates are visible. Four Simula commit observations are intentionally normalized to four repository evidence rows, rather than disappearing. Product-root URLs are retained only as zero-contribution context. No A16Z physical post is lost to URL aliases, entity attribution, or dedupe.

## Remaining uncertain source rows

Thirty-eight raw rows over 37 physical identities still need stronger native author proof before they can be safely admitted: 37 legacy logged-in rows over the 36 activity IDs below, plus the Libra Robotics row. Four other logged-in physical IDs (`7454936810092269569`, `7475023296363892736`, `7478044365819670528`, `7480289533234696193`) contain explicit repost evidence and are not uncertain eligible posts.

Legacy logged-in activity IDs requiring a stable native author/account locator:

`7005969222245752832`, `7117622343383879680`, `7207775095824470021`, `7345843680987049986`, `7430291037849423872`, `7434522468272328704`, `7435612609061486592`, `7442607437074956288`, `7447311669086679040`, `7455648546252435456`, `7465844561836269568`, `7465876037395009536`, `7470497879732748288`, `7470602324256780288`, `7473420760439484416`, `7473857558684975104`, `7475206613054832642`, `7475223428757815296`, `7475271593498349568`, `7475434306400796673`, `7476028718105395201`, `7477260374233276416`, `7477746940504330242`, `7478070046641201152`, `7478192291392696321`, `7478851845885435904`, `7478960728188608512`, `7479760199155609600`, `7479927233340702722`, `7479953325698768896`, `7480081248711782400`, `7480262099412295680`, `7480660471797174273`, `7480743874253078528`, `7480757450569289728`, `7481021882171871233`.

Libra Robotics unresolved activity: `7482265767493779456`.

## Verification

- `tests/yc-spring-2026-dataset.test.ts`
- `tests/yc-traction-regressions.test.ts`
- `tests/a16z-speedrun-006-dataset.test.ts`
- 66 focused tests passed.
- TypeScript `--noEmit` passed.
