# AI Workstation Setup Report

Date: 2026-06-27

## Executive Summary

Agent Reach is installed and usable as a health checker/router, but this workstation should not treat every green `agent-reach doctor` item as account-safe. The safe default is:

- Use official APIs and public feeds/readers first.
- Keep OpenCLI installed but stopped by default.
- Use OpenCLI only for explicit, low-volume, read-only, one-off browser tasks.
- Do not automate likes, follows, DMs, comments, posts, connection requests, saves, deletes, or bulk profile/post collection.
- Use Instagram only for public, unauthenticated web content. Do not use Instagram login/session automation.

## Installed Locations

- Agent Reach venv: `C:\Users\swimd\.agent-reach-venv`
- Agent Reach tools/config: `C:\Users\swimd\.agent-reach`
- mcporter config: `C:\Users\swimd\config\mcporter.json`
- yt-dlp active config: `C:\Users\swimd\.config\yt-dlp\config`
- Secondary yt-dlp config created by earlier installer guidance: `C:\Users\swimd\AppData\Roaming\yt-dlp\config`

User PATH was updated to include:

- `C:\Users\swimd\.agent-reach-venv\Scripts`
- `C:\Users\swimd\AppData\Roaming\npm`
- `C:\Users\swimd\AppData\Local\Microsoft\WinGet\Packages\GitHub.cli_Microsoft.Winget.Source_8wekyb3d8bbwe\bin`

Restarting terminals/Codex may be needed before those PATH entries are visible everywhere.

## Installed Tools

- `agent-reach` 1.5.0
- `gh` 2.95.0
- `mcporter` 0.9.0
- `opencli` 1.8.4, installed but stopped by default
- `yt-dlp` 2026.06.09
- `ffmpeg` available
- `bili` / `bilibili-cli` 0.6.2
- `twitter-cli` installed
- `rdt-cli` installed
- `linkedin-scraper-mcp` / `mcp-server-linkedin` installed
- Python API libraries: `praw` 8.0.2, `tweepy` 4.16.0, `PyGithub` 2.9.1

## Working Commands

Health:

```powershell
agent-reach doctor
agent-reach doctor --json
agent-reach watch
```

Web and search:

```powershell
curl.exe -L https://r.jina.ai/http://example.com
mcporter call exa.web_search_exa 'query: your search query' 'numResults: 5'
mcporter call exa.web_fetch_exa 'urls: ["https://example.com"]'
```

YouTube:

```powershell
yt-dlp --list-subs --skip-download https://www.youtube.com/watch?v=VIDEO_ID
yt-dlp --skip-download --write-subs --sub-langs en --sub-format vtt https://www.youtube.com/watch?v=VIDEO_ID
```

Bilibili public search:

```powershell
$env:PYTHONIOENCODING='utf-8'
bili search '人工智能' --type video -n 5 --json
bili hot --json
bili video BV_ID --json
```

GitHub:

```powershell
gh auth status
gh repo view OWNER/REPO --json nameWithOwner,description
gh search repos QUERY
```

OpenCLI status only:

```powershell
opencli daemon status
opencli daemon stop
```

## Verification Results

Passed:

- Arbitrary webpages: Jina Reader returned `example.com` content.
- RSS: `feedparser` parsed `https://hnrss.org/frontpage` with 20 entries.
- Semantic web search: Exa via `mcporter` returned live search results.
- YouTube subtitles: `yt-dlp` downloaded a VTT transcript for `jNQXAC9IVRw`.
- GitHub CLI: authenticated as `allenbuild`; `gh repo view cli/cli` returned live repo data.
- Bilibili public search: `bili search '人工智能' --type video -n 1 --json` returned a video result.
- OpenCLI daemon: confirmed stopped after safety reset.

Notes:

- yt-dlp initially warned about YouTube JS challenge solving. The active config now includes:

```text
--js-runtimes node
--remote-components ejs:github
```

- `agent-reach doctor` may report OpenCLI-backed sites as OK when the bridge is available. That is capability status, not a terms-of-service or account-risk endorsement.

## Authenticated Services

### GitHub

Status: configured and recommended.

- Method: official GitHub CLI browser OAuth.
- Account: `allenbuild`
- Credential storage: Windows keyring.
- Scopes observed: `gist`, `read:org`, `repo`, `workflow`
- Test: `gh repo view cli/cli --json nameWithOwner,viewerPermission`

### Twitter/X

Status: OpenCLI browser access was verified, but should not be the default.

- Verified OpenCLI session: `allenxtech`
- Verified test: read-only `opencli twitter search`
- Recommended safer method: official X API with approved developer account and declared use case.
- Needed for safer API route: X developer account, app credentials, and API plan appropriate for the intended use.
- Do not use: automated follows, likes, DMs, replies, posting, bulk timeline/profile collection, multi-account automation, high-frequency scraping.

### Reddit

Status: OpenCLI browser access was verified, but official API is preferred for ongoing use.

- Verified OpenCLI session: `u/Fuzzy-Breakfast5039`
- Verified test: read-only `opencli reddit search`
- Safer installed alternative: `praw`
- Needed for safer API route: Reddit developer app, client ID, client secret, user agent, and OAuth approval if required by Reddit's current process.
- Do not use: high-volume HTML scraping, automated votes/comments/messages, or bulk data collection outside approved API terms.

### LinkedIn

Status: OpenCLI browser access was verified, but disabled-by-default because LinkedIn explicitly restricts third-party automation.

- Verified OpenCLI session: `Allen Xu`
- Verified test: read-only job search.
- Dedicated LinkedIn MCP installed but did not import Chrome's session.
- Recommended policy: avoid logged-in automation. Use manual browser use, public pages through normal browsing, or official LinkedIn APIs/partner access where available.
- Do not use: profile scraping, people-search harvesting, automated messages, connection requests, follower/contact export, or repeated browsing automation.

### Instagram

Status: public-web only.

- Allowed: public Instagram pages and public metadata that are accessible without logging in, preferably via normal browser/manual review or public web readers/search.
- Not allowed: OpenCLI Instagram commands, logged-in session automation, saved posts, private/account data, DMs, followers/following exports, automated engagement, or any action that requires Instagram login.
- Reason: Instagram login automation created account-risk friction, and Meta's terms restrict unauthorized automated collection. Public-only access keeps the boundary much cleaner.

### Xiaohongshu

Status: installed via OpenCLI capability but not authenticated and not recommended by default.

- Tests: `whoami` and search were blocked behind login.
- Recommended policy: do not automate logged-in Xiaohongshu unless you explicitly accept the risk for a small read-only task.
- Do not use: creator automation, publishing, comments, private notifications, mass search scraping, or bulk note/comment collection.

### Bilibili Subtitles

Status: Bilibili public search works; subtitles are unresolved under the conservative policy.

- Public `bili` search/video commands work without login.
- Agent Reach says Bilibili subtitles need OpenCLI.
- Recommended policy: avoid logged-in Bilibili automation unless explicitly needed for a one-off read-only subtitle extraction.
- Safer public route: use `bili` public metadata and normal browser/manual download where available.

## Account-Safety Policy

Allowed by default:

- GitHub through `gh`
- RSS feeds
- Jina Reader for arbitrary webpages
- Exa semantic search through `mcporter`
- YouTube transcript extraction through `yt-dlp`
- Bilibili public search through `bili`
- Instagram public pages only, without login/session automation
- Manual browser use by the human user

Requires explicit per-task approval:

- Any OpenCLI command against X, Reddit, LinkedIn, Xiaohongshu, Bilibili logged-in pages, or other logged-in platforms.

Disallowed by default:

- Instagram login/session automation, saved posts, private data, and account actions
- Automated posting, liking, following, voting, commenting, DMs, replies, connection requests
- Bulk profile scraping or bulk post/comment harvesting
- High-frequency or 24/7 automation
- Multi-account automation
- Circumventing rate limits, CAPTCHAs, login walls, or platform technical controls

## Remaining Setup Steps

Optional safer API setup:

- X API: create/approve an X developer account and provide API keys/tokens for `tweepy`.
- Reddit API: create a Reddit developer app and provide client ID, client secret, redirect URI, and user agent for `praw`.
- Groq API: configure `agent-reach configure groq-key gsk_xxxxx` if Xiaoyuzhou podcast transcription is desired.

Optional cleanup:

- Disable or remove the OpenCLI Chrome extension when not actively using it.
- Keep `opencli daemon stop` as the default state.

## Source Notes

- Agent Reach install guide: https://raw.githubusercontent.com/Panniantong/agent-reach/main/docs/install.md
- LinkedIn automated activity policy: https://www.linkedin.com/help/linkedin/answer/a1340567
- X Developer Policy: https://docs.x.com/developer-terms/policy
- Reddit Data API Terms: https://redditinc.com/policies/data-api-terms
- Instagram Terms of Use: https://help.instagram.com/581066165581870/
- Bilibili user agreement: https://www.bilibili.com/protocal/licence.html
- Xiaohongshu user agreement: https://agree.xiaohongshu.com/h5/terms/ZXXY20220331001/-1
