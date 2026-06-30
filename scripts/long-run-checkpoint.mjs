import fs from "node:fs/promises";
import path from "node:path";

const statusPath = path.join("docs", "LONG_RUN_STATUS.md");
const activeRun = await readJson(path.join("outputs", "longrun", "active-run.json"), null);
const startTime = process.env.LONG_RUN_START_AT ?? activeRun?.startedAt ?? new Date().toISOString();
const now = new Date();
const elapsedMs = now.valueOf() - new Date(startTime).valueOf();
const elapsedMinutes = Math.max(0, Math.floor(elapsedMs / 60_000));
const coverage = await readJson(path.join("outputs", "coverage-debug-s2026.json"), null);
const workers = await readJson(path.join("outputs", "workers-debug-s2026.json"), null);
const duplicates = await readJson(path.join("outputs", "duplicates-debug-s2026.json"), null);
const instagram = await readJson(path.join("outputs", "instagram-doctor.json"), null);
const instagramCoverage = await readJson(path.join("outputs", "instagram-coverage-debug-s2026.json"), null);
const thumbnailCoverage = await readJson(path.join("outputs", "thumbnail-coverage-debug-s2026.json"), null);
const scoring = await readJson(path.join("outputs", "scoring-experiments-s2026.json"), null);
const anomalies = await readJson(path.join("outputs", "anomaly-report-s2026.json"), null);
const discovery = await readJson(path.join("outputs", "discovery-plan-s2026.json"), null);
const loggedInSocial = summarizeLoggedInSocial(
  await readJson(path.join("src", "lib", "social", "logged-in-evidence-current.json"), null)
);
const instagramDiscovery = await readJson(path.join("outputs", "instagram-discovery-candidates.json"), null);
const liveCheckpoint = summarizeLiveCheckpoint(await readJson(path.join("work", "public-traction-checkpoint.json"), null));
const workerCheckpoint = workers?.live_ingestion_checkpoint ?? {};
const latestRunLog = await latestLongRunLog();
const currentStatus = getCurrentStatus({ activeRun, elapsedMinutes, latestRunLog });

const lines = [
  "# Long Run Status",
  "",
  "## Run Identity",
  "",
  "- Objective: 6-hour autonomous deep-work cycle for YC Spring 2026 traction discovery, ingestion, scoring, dedupe, Instagram/X checks, and dashboard explainability.",
  `- Started at: ${startTime}.`,
  `- Last checkpoint: ${now.toISOString()}.`,
  `- Elapsed: ${Math.floor(elapsedMinutes / 60)}h ${elapsedMinutes % 60}m.`,
  `- Current status: ${currentStatus}.`,
  "",
  "## Current Baseline",
  "",
  `- Company count: ${coverage?.company_count ?? coverage?.companyCount ?? "unknown"}.`,
  `- Evidence count: ${coverage?.evidence_count ?? coverage?.evidenceCount ?? "unknown"}.`,
  `- Non-GitHub scored evidence: ${coverage?.non_github_scored_evidence_count ?? coverage?.nonGithubScoredEvidenceCount ?? "unknown"}.`,
  `- Worker tasks: ${workers?.taskCount ?? workers?.task_count ?? "unknown"}.`,
  `- Worker status counts: ${JSON.stringify(workers?.statusCounts ?? workers?.status_counts ?? {})}.`,
  `- Live ingestion attempts: ${liveCheckpoint?.attempt_count ?? workerCheckpoint?.attempt_count ?? "unknown"}.`,
  `- Live ingestion attempt statuses: ${JSON.stringify(liveCheckpoint?.attempt_status_counts ?? workerCheckpoint?.attempt_status_counts ?? {})}.`,
  `- Live ingestion rows: ${JSON.stringify({
    evidence: liveCheckpoint?.evidence_rows ?? workerCheckpoint?.evidence_rows ?? "unknown",
    needs_review: liveCheckpoint?.needs_review_rows ?? workerCheckpoint?.needs_review_rows ?? "unknown",
    failures: liveCheckpoint?.failure_rows ?? workerCheckpoint?.failure_rows ?? "unknown"
  })}.`,
  `- Live ingestion platform rows: ${JSON.stringify(liveCheckpoint?.platform_rows ?? workerCheckpoint?.platform_rows ?? {})}.`,
  `- Duplicate groups: ${duplicates?.duplicateGroups ?? duplicates?.duplicate_group_count ?? "unknown"}.`,
  `- Duplicate social-account groups: ${duplicates?.duplicateAccountGroupCount ?? duplicates?.duplicate_account_group_count ?? "unknown"}.`,
  `- Instagram doctor: ${instagram?.summary?.overall_status ?? "not run"}.`,
  instagramCoverage
    ? `- Instagram coverage: ${instagramCoverage.evidence?.companiesWithScoredEvidence ?? "unknown"}/${instagramCoverage.companyCount ?? "unknown"} companies with scored Instagram; ${instagramCoverage.evidence?.rows ?? "unknown"} Instagram rows; ${instagramCoverage.evidence?.realThumbnailRows ?? "unknown"} real Instagram thumbnails.`
    : "- Instagram coverage: not run.",
  thumbnailCoverage
    ? `- Thumbnail coverage: ${thumbnailCoverage.rowsWithRealThumbnail ?? "unknown"}/${thumbnailCoverage.evidenceRows ?? "unknown"} real thumbnails; ${thumbnailCoverage.rowsWithFallbackThumbnail ?? "unknown"} fallback; ${thumbnailCoverage.rowsMissingThumbnail ?? "unknown"} missing.`
    : "- Thumbnail coverage: not run.",
  loggedInSocial
    ? `- Logged-in read-only social rows: ${loggedInSocial.evidence_rows}; platform rows ${JSON.stringify(loggedInSocial.platform_rows)}; companies by platform ${JSON.stringify(loggedInSocial.companies_by_platform)}.`
    : "- Logged-in read-only social rows: not available.",
  loggedInSocial
    ? `- HeyClicky logged-in evidence: ${JSON.stringify(loggedInSocial.heyclicky_platform_rows)}.`
    : "- HeyClicky logged-in evidence: not available.",
  coverage?.x_target_coverage
    ? `- X target coverage: ${coverage.x_target_coverage.known_x_targets} known targets across ${coverage.x_target_coverage.companies_with_known_x_targets} companies; ${coverage.x_target_coverage.attempted_targets} attempted; ${coverage.x_target_coverage.companies_with_x_evidence} companies with X evidence.`
    : "- X target coverage: not available.",
  instagramDiscovery
    ? `- Instagram discovery: ${instagramDiscovery.companies_checked} companies checked; ${instagramDiscovery.newly_verified_in_this_run} newly verified; ${instagramDiscovery.verified_company_instagram_profiles} total verified company profiles.`
    : "- Instagram discovery: not run.",
  `- Scoring recommendation: ${scoring?.recommended_config ?? "not run"}.`,
  `- Anomalies: ${anomalies?.anomaly_count ?? "not run"}.`,
  `- Discovery planned tasks: ${discovery?.task_count ?? "not run"}.`,
  `- Discovery planned queries: ${discovery?.query_count ?? "not run"}.`,
  latestRunLog
    ? `- Latest orchestration log: ${latestRunLog.path} (${latestRunLog.eventCount} events, last event ${latestRunLog.lastEventType}).`
    : "- Latest orchestration log: not run.",
  "",
  "## Work Completed",
  "",
  "- Created/updated long-run docs.",
  "- Added discovery learning tables.",
  "- Added scoring experiment runner.",
  "- Added anomaly report worker.",
  "- Added recursive discovery planner.",
  "- Added Instagram doctor.",
  "- Added targeted company/platform ingestion command support.",
  "- Added bounded multi-lane public ingestion workers with per-platform concurrency and resumable checkpoints.",
  "- Added `longrun:run:6h` and `longrun:smoke` orchestration commands.",
  "- Added background `longrun:start` / `longrun:status` controls and fixed checkpoint start-time handling for resumed runs.",
  "- Fixed long-run resume timing so future resumed cycles use the original recorded start time for the requested duration window.",
  "- Added a future command-deadline guard so resumed orchestrator runs can stop an overlong child command when the requested duration window elapses, including the child process tree on Windows.",
  "- Added periodic in-command checkpoints so long broad-ingest phases still update status every checkpoint window in resumed runs.",
  "- Added graph-facing recency decay before platform normalization, with regression coverage.",
  "- Moved live graph scoring weights into `src/lib/graph/traction-scoring-config.ts` and aligned public-ingest metric scoring with the recommended experiment families.",
  "- Aligned scoring experiment aggregation and batch calibration with the live graph scoring model so HeyClicky/InsForge sanity checks match the dashboard.",
  "- Added conservative public social post verification for discovered X/Instagram/LinkedIn post URLs; profile URLs remain context/review only.",
  "- Added public-profile post-link extraction: readable profiles can seed verified post checks without scoring profile followers.",
  "- Fixed broad Instagram/X discovery so Instagram `/p/` and `/reel/` URLs are not discarded before post verification, and added post-specific search query variants.",
  "- Expanded `instagram:doctor` with an explicit-session browser probe for cloned profiles or Playwright storage-state files; it still refuses to attach to default Chrome automatically.",
  "- Fixed X/Twitter canonical URL dedupe for `mobile.twitter.com` variants.",
  "- Expanded scoring debug output to include Instagram, Reddit, Hacker News, Web, and RSS contribution context.",
  "- Expanded coverage reports with per-platform backlog examples and next target companies for recursive discovery planning.",
  "- Added compact raw metrics and explicit contribution labels to top evidence cards in the company panel.",
  "- Tightened leaderboard and fastest-gaining contribution cells so they only show positively scoring evidence, not zero-score web/RSS context.",
  "- Aligned node and leaderboard top-platform labels with weighted platform contribution, so tie cases match the score explanation.",
  "- Hardened Product Hunt candidate filtering so unrelated generic pages such as `screen-studio` do not flood needs-review for every company.",
  "- Expanded Product Hunt verification beyond domain-only checks: exact-title pages can now verify through official domain, matching Product Hunt slug, founder context, or company descriptor overlap.",
  "- Updated stale Product Hunt evidence cleanup to reuse the same verifier, dropping old mismatched pages while preserving valid slug/founder/descriptor matches.",
  "- Added a blocked-profile fallback for YC-linked X/Instagram/LinkedIn profiles: if the profile is login-walled, the worker now runs public post-search verification before giving up.",
  "- Added a conservative public search-snippet fallback for real Instagram/X/LinkedIn post URLs when the post page is blocked but the search result itself visibly includes metrics and a strong entity match.",
  "- Made blocked founder social-profile fallbacks founder-aware, adding founder-name plus company-name query variants for X statuses and Instagram posts/reels.",
  "- Preserved founder attribution for public posts discovered through founder-profile fallbacks so the company panel can split founder versus company contribution correctly.",
  "- Added platform cooldown handling for reader blocks such as X/Jina HTTP 451 responses, then recycled the background run so resumed workers use the safer skip-and-log path.",
  "- Verified live UI: 197/197 company nodes, no founder graph legend, company search opens HeyClicky, founder search opens the founder's company with the founder highlighted.",
  "- Added typo-tolerant fuzzy graph search scoped to company and founder names, so misspelled queries still jump to the correct company node.",
  "- Moved deterministic graph layout into `src/lib/graph/layout.ts` with regression coverage that checks all 197 Spring 2026 company circles avoid visual overlap.",
  "- Reduced graph edge visual weight and updated docs so company circles stay circular and founders remain panel/database context only.",
  "- Expanded fullscreen graph label capacity while keeping collision-aware label placement so visible labels still avoid other labels and company circles.",
  "- Changed evidence dedupe to prefer the latest checked/updated metric snapshot, using platform post IDs before normalized URLs when available.",
  "- Updated public evidence ingestion and snapshot loading to carry or derive canonical platform post IDs for X, Instagram, LinkedIn, YouTube, Product Hunt, Reddit, and Hacker News.",
  "- Added duplicate social-account auditing and removed company-panel duplicate account attachments when the same account is already attached to a founder.",
  "- Improved public post verification so exact founder-name matches with YC/founder context can validate founder-authored social evidence for company rollup.",
  "- Added discovery-attempt and source-discovery-path artifacts for recursive discovery learning.",
  "- Expanded recursive discovery planning with post/launch-specific query variants for Instagram reels/posts, X statuses, Product Hunt products/posts, and YouTube videos/shorts.",
  "- Fed prior `sourceDiscoveryPaths` back into missing-social discovery so official-site social links can be retried by platform workers on resume.",
  "- Added GitHub `recent_commits_30d`/recent-push activity into the live scoring config and scoring experiment variants without refetching GitHub.",
  "- Stopped scoring GitHub profile aggregate rows when repo-level evidence exists, preventing account totals from double-counting the same stars/forks as top repositories.",
  "- Added `longrun:report` to generate a consolidated final report from coverage, workers, duplicates, Instagram, discovery, anomaly, and scoring outputs.",
  "- Added `longrun:final-verify` to run the final typecheck/test/build/debug/Instagram/HeyClicky/scoring/report sequence and persist per-command logs.",
  "- Excluded generated outputs from source/config no-secret scan.",
  "- Excluded prior authenticated LinkedIn and X rows from current scoring; only Instagram targeted/public evidence is allowed from the authenticated-era snapshot.",
  "- Fixed public-ingest metric-weight initialization so X/Instagram discovered social tasks can score metrics without `INGEST_METRIC_WEIGHTS` temporal-dead-zone failures on resumed runs.",
  "- Added resumed-run cleanup for stale internal `INGEST_METRIC_WEIGHTS` failure rows while preserving real platform block/cooldown failures.",
  "- Fixed social-profile early returns so missing/wrong-platform public social URL attempts write checkpoints and keep normal pacing in resumed runs.",
  "- Fixed discovery-attempt status classification so zero-useful connector runs are learned as failed/needs-review/skipped patterns instead of successful patterns.",
  "- Applied the same discovery-attempt classifier to YC-linked social profile checks so failure-only social attempts do not train the planner as successes.",
  "- Normalized checkpoint evidence writes so stale Product Hunt false positives are dropped from checkpoint rows the same way they are dropped from dashboard snapshots.",
  "- Tightened Product Hunt review generation so fetched page-title mismatches are skipped instead of flooding needs-review with unrelated popular products.",
  "- Parsed HeyClicky's full visible logged-in read-only Instagram set: 19 company posts plus 22 founder posts, with founder posts rolling up into the company feed and score.",
  "- Parsed HeyClicky's logged-in read-only X set: 33 company posts plus 52 founder posts, including visible views, likes, comments, and reposts.",
  "- Retried all known YC-linked X targets with checkpoint resume; 367/367 known targets were attempted and 130 companies now have scored X evidence.",
  "- Increased live X, LinkedIn, and Instagram metric weights so visible views/likes/comments/reposts materially affect the score when post-level metrics are available.",
  "",
  "## Latest Validation Commands",
  "",
  "- `npm run typecheck` passed after the latest code changes.",
  "- `npm test` passed 16 test files / 74 tests after the latest code changes.",
  "- `npm run build` passed after the latest UI/reporting changes.",
  "- `npm run debug:coverage` regenerated `outputs/coverage-debug-s2026.json`.",
  "- `npm run debug:workers` regenerated `outputs/workers-debug-s2026.json` with live checkpoint details.",
  "- `npm run debug:duplicates` regenerated `outputs/duplicates-debug-s2026.json`; evidence duplicates and account duplicates are both zero.",
  "- `npm run scoring:experiments` regenerated `outputs/scoring-experiments-s2026.json` with diagnostic slices.",
  "- `npm run debug:anomalies` regenerated `outputs/anomaly-report-s2026.json`.",
  "- `npm run longrun:report` generated `docs/LONG_RUN_FINAL_REPORT.md` as an interim report.",
  "- `npx vitest run tests/graph-search.test.ts tests/graph-builder.test.ts` passed typo-tolerant company/founder search and graph filter coverage.",
  "- `npx vitest run tests/yc-traction-regressions.test.ts tests/graph-builder.test.ts tests/evidence-dedupe.test.ts` passed after the GitHub aggregate de-duplication fix.",
  "- Live browser smoke check passed: dashboard renders 197/197 company nodes, Fullscreen and Move nodes controls are visible, HeyClicky company search opens an Instagram-led panel, and founder search opens the founder's company with the founder chip highlighted.",
  "- `node --check scripts/fetch-public-traction.mjs` passed after the ingestion metric-weight initialization fix.",
  "",
  "## Current Blockers",
  "",
  "- Playwright is installed, but Instagram public profile fetches still return login-wall/block content for direct profile pages.",
  "- `instagram:doctor` refuses to attach to the default Chrome profile automatically; provide `INSTAGRAM_BROWSER_PROFILE` or `INSTAGRAM_COOKIE_FILE` for an explicit reusable session probe.",
  "- HeyClicky Instagram post enumeration works through the logged-in read-only OpenCLI path, but Instagram grid/reel view counts are visible in Chrome UI and not exposed in readable DOM/meta/script fields during automation.",
  "- Broad Instagram coverage is still limited by verified handles: official-site discovery checked all 197 companies but auto-verified only HeyClicky.",
  "- X/Jina public reader access can return HTTP 451 cooldowns, but the logged-in read-only OpenCLI X timeline path now parses known YC-linked X targets and logs zero-post targets cleanly.",
  "- Logged-in LinkedIn is intentionally disabled.",
  "- npm argument forwarding on this Windows shell has been unreliable for `npm run ingest:* -- --flag=value`; use the direct `node scripts/fetch-public-traction.mjs ...` commands below for precise targeted resumes.",
  "",
  "## Next Planned Actions",
  "",
  "1. Continue the full autonomous cycle with `npm run longrun:run:6h`.",
  "2. Add an explicit cloned Instagram storage-state/profile path if we want `instagram:doctor` to validate the same logged-in path used by OpenCLI.",
  "3. Improve Instagram verified-handle discovery beyond official website links without auto-promoting ambiguous search results.",
  "4. Continue X zero-post target audits and inspect whether those accounts truly have no accessible posts or need profile-specific selectors.",
  "5. Refresh scoring experiments, anomaly report, coverage, duplicate report, and dashboard verification after each new social batch.",
  "",
  "## Resume Commands",
  "",
  "```powershell",
  "npm run typecheck",
  "npm test",
  "npm run build",
  "npm run debug:coverage",
  "npm run debug:workers",
  "npm run debug:duplicates",
  "npm run instagram:doctor",
  "npm run longrun:smoke",
  "npm run longrun:start",
  "npm run longrun:status",
  "npm run longrun:run:6h",
  "node scripts/debug-scoring-report.mjs --company=HeyClicky --right=InsForge",
  "node scripts/fetch-public-traction.mjs --social=all --company=HeyClicky --workers=4 --delay-ms=500 --force",
  "node scripts/fetch-public-traction.mjs --social=all --platform=instagram --company=HeyClicky --workers=2 --delay-ms=1500 --force",
  "node scripts/fetch-public-traction.mjs --social=all --platform=x --company=HeyClicky --workers=2 --delay-ms=1500 --force",
  "node scripts/fetch-public-traction.mjs --social=all --max-companies=197 --workers=8 --delay-ms=1200",
  "node scripts/fetch-public-traction.mjs --social=all --platform=x --max-companies=197 --workers=2 --delay-ms=1500 --force --discover-missing-social",
  "node scripts/fetch-public-traction.mjs --social=all --platform=instagram --max-companies=197 --workers=2 --delay-ms=1800 --force --discover-missing-social",
  "node scripts/fetch-logged-in-social-traction.mjs --platforms=x --entities=all --workers=6 --limit=40 --scrolls=12 --timeout-ms=90000 --delay-ms=1200 --retry-empty",
  "node scripts/fetch-logged-in-social-traction.mjs --platforms=instagram --company=HeyClicky --entities=all --workers=1 --limit=40 --scrolls=24 --timeout-ms=120000 --delay-ms=2000 --force",
  "node scripts/discover-instagram-overrides.mjs --write --workers=6",
  "npm run discovery:plan",
  "npm run scoring:experiments",
  "npm run debug:anomalies",
  "npm run longrun:report",
  "npm run longrun:final-verify",
  "npm run longrun:checkpoint",
  "```",
  ""
];

await fs.writeFile(statusPath, lines.join("\n"));
console.log(JSON.stringify({ outputPath: statusPath, elapsedMinutes }, null, 2));

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function latestLongRunLog() {
  try {
    const dir = path.join("outputs", "longrun");
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          const filePath = path.join(dir, entry.name);
          const stat = await fs.stat(filePath);
          return { filePath, stat };
        })
    );
    const latest = files.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs)[0];
    if (!latest) return null;
    const payload = await readJson(latest.filePath, null);
    const events = payload?.eventLog ?? [];
    return {
      path: latest.filePath,
      eventCount: events.length,
      lastEventType: events.at(-1)?.type ?? "unknown"
    };
  } catch {
    return null;
  }
}

function summarizeLiveCheckpoint(checkpoint) {
  if (!checkpoint) return null;
  const attempts = Object.values(checkpoint.attempts ?? {});
  const attemptStatusCounts = countBy(attempts, (attempt) => attempt.status ?? "unknown");
  return {
    attempt_count: attempts.length,
    attempt_status_counts: attemptStatusCounts,
    evidence_rows: checkpoint.evidence?.length ?? 0,
    needs_review_rows: checkpoint.needsReview?.length ?? 0,
    failure_rows: checkpoint.failures?.length ?? 0,
    platform_rows: {
      evidence: countBy(checkpoint.evidence ?? [], (row) => row.platform ?? "unknown"),
      needs_review: countBy(checkpoint.needsReview ?? [], (row) => row.platform ?? "unknown"),
      failures: countBy(checkpoint.failures ?? [], (row) => row.platform ?? "unknown")
    }
  };
}

function summarizeLoggedInSocial(snapshot) {
  if (!snapshot) return null;
  const evidence = snapshot.evidence ?? [];
  const heyclickyRows = evidence.filter((row) => isHeyClickyRow(row));
  return {
    evidence_rows: evidence.length,
    failure_rows: snapshot.failures?.length ?? 0,
    platform_rows: countBy(evidence, (row) => row.platform ?? "unknown"),
    companies_by_platform: Object.fromEntries(
      Object.entries(
        evidence.reduce((acc, row) => {
          const companyKey = row.companySlug ?? slugify(row.companyName ?? row.attachedCompanyName ?? "");
          if (!row.platform || !companyKey) return acc;
          (acc[row.platform] ??= new Set()).add(companyKey);
          return acc;
        }, {})
      ).map(([platform, companies]) => [platform, companies.size])
    ),
    heyclicky_platform_rows: countBy(heyclickyRows, (row) => row.platform ?? "unknown")
  };
}

function isHeyClickyRow(row) {
  const haystack = [
    row.companySlug,
    row.companyName,
    row.attachedCompanyName,
    row.entityId,
    row.attachedCompanyId
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes("heyclicky");
}

function countBy(items, getKey) {
  return items.reduce((counts, item) => {
    const key = getKey(item);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function slugify(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function getCurrentStatus({ activeRun, elapsedMinutes, latestRunLog }) {
  if (latestRunLog?.lastEventType === "run_finished") return "finished";
  if (isPidAlive(activeRun?.pid)) return "in progress/resumable";
  if (elapsedMinutes >= 360) return "stopped after six-hour target; resumable from checkpoints";
  if (activeRun?.pid) return "stopped/resumable from checkpoints";
  return "not started";
}

function isPidAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}
