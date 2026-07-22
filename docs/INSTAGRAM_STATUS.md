# Instagram Status

## Latest Doctor Run

- Generated at: 2026-07-22T05:57:52.753Z.
- Overall status: needs_attention.
- Passing checks: 5/14.
- Important distinction: `instagram:doctor` checks direct public fetches and explicit Playwright storage-state/profile configuration. The authenticated OpenCLI read-only browser path is working when a verified profile is provided to `fetch-logged-in-social-traction.mjs`.

## OpenCLI Read-Only Session Result

- Stored logged-in read-only social rows: 2545; platform rows {"instagram":86,"x":2157,"linkedin":302}; companies by platform {"instagram":5,"x":145,"linkedin":42}.
- Verified `_heyclicky` through the logged-in OpenCLI browser/session as the company Instagram profile.
- Verified `farza954` as founder Farza Majeed's Instagram profile; the visible bio links him to `_heyclicky`.
- Parsed 19/19 visible `_heyclicky` Instagram posts and 22/22 visible `farza954` Instagram posts in the logged-in evidence artifact.
- Instagram grid views are visible in Chrome UI but were not exposed in readable DOM/meta fields during this pass; current stored Instagram metrics are likes/comments, not reel views.

## Batch Discovery Result

- Added `npm run instagram:discover` for safe verified-handle discovery.
- Latest discovery checked 1 companies, produced 13 candidates, auto-verified 0 new profiles, and has 13 total verified company Instagram profiles.
- Official-site discovery can auto-promote Instagram links. OpenCLI Instagram search is a candidate generator only unless explicitly promoted later.

## Check Results

- playwright_installed: pass - Playwright package is importable.
- opencli_installed: pass - OpenCLI resolved through /Users/allenxu/Library/Caches/pnpm/dlx/c2f76477f34fcad739a82f0859f07e679601804ef1c640cb107612ad98a4af32/19f45eece19-7bcb/node_modules/.bin/opencli.
- browser_profile_available: fail - No browser profile/session path found.
- logged_in_session_configured: fail - No explicit reusable Instagram browser profile/cookie file configured for safe logged-in read-only checks.
- logged_in_session_browser_probe: fail - Skipped: set INSTAGRAM_BROWSER_PROFILE to a cloned browser profile or INSTAGRAM_COOKIE_FILE to a Playwright storage-state JSON file to run the read-only logged-in probe.
- known-public-profile: fail - HTTP 200; blocked_or_login_wall=true; post_links_visible=false.
- heyclicky-candidate: fail - HTTP 200; blocked_or_login_wall=true; post_links_visible=false.
- heyclicky-underscore-candidate: fail - HTTP 200; blocked_or_login_wall=true; post_links_visible=false.
- public-profile-post-listing: fail - Recent Instagram posts/reels were not visible from the direct public profile fetch; profile appears login-walled or post markup is hidden.
- known-heyclicky-reel: fail - HTTP 200; blocked_or_login_wall=true; visible_metric_text=true.
- targeted_evidence_metrics: pass - Stored targeted HeyClicky reel metrics: 217 likes, 19 comments, 0 views.
- url_normalization: pass - Instagram /p/ and /reel/ URL normalization works.
- app_feed_instagram_evidence: fail - Graph check failed: fetch failed.
- storage_writable: pass - Wrote outputs/instagram-doctor-storage-check.json.

## HeyClicky

- YC lists HeyClicky website and X, but no Instagram URL.
- The doctor probes `https://www.instagram.com/heyclicky/` read-only as a candidate only; the verified working profile is `https://www.instagram.com/_heyclicky/`.
- Current graph feed check is recorded in `outputs/instagram-doctor.json`.
- Targeted public discovery found `https://www.instagram.com/_heyclicky/` as a strong HeyClicky profile candidate.
- OpenCLI read-only ingestion found the full visible company/founder Instagram set: 19 company posts plus 22 founder posts.
- Top stored Instagram evidence includes Farza's `https://www.instagram.com/reel/DXk3VriDylM/` with 123K+ likes and 30K+ comments, plus `_heyclicky`'s `https://www.instagram.com/reel/DZEX2WRgyMu/` with 19K+ likes.
- The evidence is stored in `src/lib/social/logged-in-evidence-current.json`, appears in the HeyClicky feed, and rolls founder posts into the company score.
- A DailyDropout public web article is stored as non-scoring context because it reports viral traction but does not expose the underlying social post metrics directly.
- Public ingestion now has a conservative search-result snippet fallback for real Instagram post/reel URLs when the post page is blocked, but only if the snippet itself exposes visible metrics and a strong HeyClicky/company/founder match.

## Blockers / Next Fixes

- No browser profile/session path was found through INSTAGRAM_BROWSER_PROFILE, CHROME_USER_DATA_DIR, or default Chrome User Data.
- No explicit INSTAGRAM_BROWSER_PROFILE or INSTAGRAM_COOKIE_FILE was provided. Default Chrome User Data exists, but the doctor does not attach to it automatically to avoid disturbing the user's live account.
- To run the logged-in read-only probe safely, use a cloned browser profile or Playwright storage-state JSON, then rerun `npm run instagram:doctor`.
- Example profile command: `$env:INSTAGRAM_BROWSER_PROFILE="C:\\path\\to\\cloned-instagram-profile"; npm run instagram:doctor`.
- Example storage-state command: `$env:INSTAGRAM_COOKIE_FILE="C:\\path\\to\\instagram.storage-state.json"; npm run instagram:doctor`.

Machine-readable output: `outputs/instagram-doctor.json`.
