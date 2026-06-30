import fs from "node:fs/promises";
import path from "node:path";

const activeRun = await readJson(path.join("outputs", "longrun", "active-run.json"), null);
const coverage = await readJson(path.join("outputs", "coverage-debug-s2026.json"), null);
const workers = await readJson(path.join("outputs", "workers-debug-s2026.json"), null);
const duplicates = await readJson(path.join("outputs", "duplicates-debug-s2026.json"), null);
const instagram = await readJson(path.join("outputs", "instagram-doctor.json"), null);
const scoring = await readJson(path.join("outputs", "scoring-experiments-s2026.json"), null);
const anomalies = await readJson(path.join("outputs", "anomaly-report-s2026.json"), null);
const discovery = await readJson(path.join("outputs", "discovery-plan-s2026.json"), null);
const finalVerification = await readJson(path.join("outputs", "final-verification-latest.json"), null);
const attribution = await readJson(path.join("outputs", "evidence-attribution-audit-s2026.json"), null);
const quality = await readJson(path.join("outputs", "quality-audit-latest.json"), null);
const loggedInSocial = summarizeLoggedInSocial(await readJson(path.join("src", "lib", "social", "logged-in-evidence-current.json"), null));
const instagramDiscovery = await readJson(path.join("outputs", "instagram-discovery-candidates.json"), null);
const liveCheckpoint = summarizeLiveCheckpoint(await readJson(path.join("work", "public-traction-checkpoint.json"), null));
const workerCheckpoint = workers?.live_ingestion_checkpoint ?? {};
const latestRunLog = await latestLongRunLog();
const now = new Date();
const startedAt = activeRun?.startedAt ?? instagram?.started_at ?? now.toISOString();
const elapsedMinutes = Math.max(0, Math.floor((now.valueOf() - new Date(startedAt).valueOf()) / 60_000));
const runFinished = latestRunLog?.lastEventType === "run_finished";
const orchestrationStatus = getOrchestrationStatus({
  activeRun,
  elapsedMinutes,
  finalVerification,
  runFinished
});
const graphExact = coverage?.company_count === 197 || coverage?.companyCount === 197;
const instagramChecks = instagram?.checks ?? [];
const instagramCheck = (name) => instagramChecks.find((item) => item.name === name);
const xStatus = xStatusSummary(liveCheckpoint, workers);

const lines = [
  "# Long Run Final Report",
  "",
  "## Run Summary",
  "",
  `- Generated at: ${now.toISOString()}.`,
  `- Started at: ${startedAt}.`,
  `- Total elapsed time: ${Math.floor(elapsedMinutes / 60)}h ${elapsedMinutes % 60}m.`,
  `- Six-hour target reached: ${elapsedMinutes >= 360 ? "yes" : "not yet"}.`,
  `- Current orchestration status: ${orchestrationStatus}.`,
  latestRunLog
    ? `- Latest orchestration event: ${latestRunLog.lastEventType} in ${latestRunLog.path}.`
    : "- Latest orchestration event: unavailable.",
  "",
  "## Final Verification",
  "",
  finalVerification
    ? `- Status: ${finalVerification.status}.`
    : "- Status: not run yet.",
  finalVerification
    ? `- Commands: ${finalVerification.pass_count}/${finalVerification.command_count} passed; ${finalVerification.required_fail_count} required failures.`
    : "- Commands: not run yet.",
  finalVerification?.finished_at
    ? `- Finished at: ${finalVerification.finished_at}; elapsed ${finalVerification.elapsed_seconds}s.`
    : "- Finished at: not available.",
  ...(finalVerification?.commands ?? []).map(
    (item) =>
      `- ${item.label}: ${item.exit_code === 0 ? "pass" : "fail"} (${item.elapsed_seconds}s), logs ${item.stdout_path}${item.stderr_tail ? `, stderr tail: ${oneLine(item.stderr_tail)}` : ""}`
  ),
  "",
  "## Quality And Attribution",
  "",
  quality
    ? `- Strict quality status: ${quality.summary?.status ?? "unknown"}; findings ${quality.summary?.critical ?? 0} critical, ${quality.summary?.high ?? 0} high, ${quality.summary?.medium ?? 0} medium, ${quality.summary?.low ?? 0} low.`
    : "- Strict quality status: not run.",
  quality?.metrics
    ? `- Quality audit scope: ${quality.metrics.company_nodes} company nodes, ${quality.metrics.founder_nodes} founder nodes, ${quality.metrics.evidence_rows} evidence rows, ${quality.metrics.scored_evidence_rows} scored rows; graph API samples ${JSON.stringify(quality.metrics.graph_api_timings_ms)}ms.`
    : "- Quality audit scope: not available.",
  attribution
    ? `- Attribution hard guard: ${attribution.high_risk_scored_count} high-risk scored rows, ${attribution.medium_risk_scored_count} medium-risk scored rows, ${attribution.guarded_zero_score_rows} guarded zero-score rows.`
    : "- Attribution hard guard: not run.",
  attribution
    ? `- First-party social body-signal review queue: ${attribution.first_party_social_review_count} rows, ${attribution.founder_first_party_review_count} founder rows, priorities ${JSON.stringify(attribution.first_party_social_review_priority_counts ?? {})}.`
    : "- First-party social body-signal review queue: not run.",
  "- First-party review rows are review instrumentation, not automatic score penalties; inspect high-priority rows before raising founder/social weights.",
  "",
  "## Why Ingestion Was Previously Shallow",
  "",
  "- Earlier passes treated many profile URLs as evidence. The current pipeline keeps profiles as identity context and only scores post/repo/video/launch/story evidence with visible metrics.",
  "- Instagram and X public pages frequently return login walls or reader cooldowns. These are now logged as platform-specific failures instead of stopping the batch.",
  "- A single broad platform pass can still be long-running, especially anonymous Instagram. Future resumed orchestrator runs include a deadline guard so long child command trees can stop at the requested duration window with checkpoint state preserved.",
  "- Search discovery produced many ambiguous profile candidates. The current path records `needs_review` unless visible text matches company/founder/domain context.",
  "- Product Hunt evidence is revalidated on snapshot writes, so old generic Product Hunt pages are dropped unless they pass the current title plus domain/slug/founder/descriptor verifier.",
  "- YC-linked social profile pages could stop at a login wall. The current connector falls back to public post-search verification for that platform before recording the block.",
  "- For real social post URLs, the connector can now use public search-result visible text as a metrics fallback when the post page is blocked, but only when the snippet itself contains visible metrics and a strong entity match.",
  "- Discovery learning previously treated some zero-useful connector runs as successes. Attempts are now classified from useful evidence, review candidates, and failure rows.",
  "- YC-linked social profile checks now use the same classifier, so blocked profile-only attempts no longer become false-positive discovery successes.",
  "- Duplicate metric snapshots could hide stale rows. Current dedupe prefers canonical post IDs and the latest checked/updated snapshot.",
  "- GitHub account aggregate rows previously scored alongside repo-level rows, double-counting the same stars/forks. The graph now scores real repo rows and keeps profile aggregates out of top-contribution scoring when repos are available.",
  "- The scoring experiment runner now uses the same GitHub platform aggregation and batch calibration as the live graph, so HeyClicky and InsForge sanity checks are comparable between the UI and reports.",
  "- A resumed social run exposed an internal metric-weight initialization ordering bug; the current ingestion script initializes weights before workers start and drops stale internal TDZ failure rows on resumed runs.",
  "- Missing or wrong-platform YC-linked social URLs now write checkpoints before returning, so resumed public social runs preserve more partial progress.",
  "- Checkpoint evidence writes now use the same normalization as dashboard snapshots, so stale Product Hunt false positives are dropped from checkpoint rows too.",
  "- Product Hunt review generation now skips fetched page-title mismatches instead of flooding needs-review with unrelated popular products.",
  "- Final verification is now scripted with per-command logs so the last report can cite exact typecheck/test/build/debug/Instagram/HeyClicky/scoring outcomes.",
  "",
  "## Worker System",
  "",
  `- Worker task count: ${workers?.taskCount ?? workers?.task_count ?? "unknown"}.`,
  `- Worker status counts: ${JSON.stringify(workers?.statusCounts ?? workers?.status_counts ?? {})}.`,
  `- Live checkpoint attempts: ${liveCheckpoint?.attempt_count ?? workerCheckpoint?.attempt_count ?? "unknown"}.`,
  `- Live checkpoint statuses: ${JSON.stringify(liveCheckpoint?.attempt_status_counts ?? workerCheckpoint?.attempt_status_counts ?? {})}.`,
  `- Live checkpoint rows: ${JSON.stringify({
    evidence: liveCheckpoint?.evidence_rows ?? workerCheckpoint?.evidence_rows ?? "unknown",
    needs_review: liveCheckpoint?.needs_review_rows ?? workerCheckpoint?.needs_review_rows ?? "unknown",
    failures: liveCheckpoint?.failure_rows ?? workerCheckpoint?.failure_rows ?? "unknown"
  })}.`,
  `- Live checkpoint platform rows: ${JSON.stringify(liveCheckpoint?.platform_rows ?? workerCheckpoint?.platform_rows ?? {})}.`,
  loggedInSocial
    ? `- Logged-in read-only social rows: ${loggedInSocial.evidence_rows}; platform rows ${JSON.stringify(loggedInSocial.platform_rows)}; companies by platform ${JSON.stringify(loggedInSocial.companies_by_platform)}.`
    : "- Logged-in read-only social rows: not available.",
  loggedInSocial
    ? `- HeyClicky logged-in read-only rows: ${JSON.stringify(loggedInSocial.heyclicky_platform_rows)}.`
    : "- HeyClicky logged-in read-only rows: not available.",
  "",
  "## Recursive Discovery",
  "",
  `- Discovery planned tasks: ${discovery?.task_count ?? "unknown"}.`,
  `- Discovery planned queries: ${discovery?.query_count ?? "unknown"}.`,
  `- Successful learned patterns: ${discovery?.learned_success_patterns?.length ?? 0}.`,
  `- Failed learned patterns: ${discovery?.learned_failure_patterns?.length ?? 0}.`,
  `- Source discovery paths: ${discovery?.useful_discovery_paths?.length ?? 0}.`,
  "- Best patterns so far: official website social links, YC-linked GitHub URLs, GitHub links discovered from official sites, HN Algolia exact-name queries, and targeted public search for post URLs.",
  "- Weak patterns so far: anonymous direct Instagram profile pages, anonymous X profile/post readers during cooldown windows, Product Hunt names without domain/slug/founder/descriptor corroboration, and Reddit public pages from this network.",
  "",
  "## Graph And Search",
  "",
  `- Spring 2026 company count: ${coverage?.company_count ?? coverage?.companyCount ?? "unknown"}.`,
  `- Graph has exactly 197 company circles: ${graphExact ? "yes" : "no"}.`,
  "- Founder graph nodes: 0.",
  "- Founders remain in company detail/search data and their evidence IDs roll into company evidence lists.",
  "- Company search: implemented with name-only, typo-tolerant fuzzy search and company selection/zoom.",
  "- Founder search: implemented with name-only, typo-tolerant matching; founder result opens the founder's company and highlights the founder.",
  "- Move-nodes toggle: locked by default, draggable only when enabled, with related nodes following subtly.",
  "- Fullscreen graph mode: implemented and allows more collision-safe labels than the compact panel view.",
  "- Leaderboard contribution cells only use positively scoring evidence rows; context-only web/RSS rows no longer appear as a company's biggest contribution.",
  "- Node and leaderboard top-platform labels use weighted platform contribution, matching the score explanation panel.",
  "",
  "## Platform Coverage",
  "",
  ...(coverage?.platform_coverage ?? []).map(
    (row) =>
      `- ${row.platform}: ${row.evidence_rows} evidence rows, ${row.scored_rows} scored, ${row.companies_with_scored_evidence} companies with scored evidence, ${row.needs_review_rows} needs-review rows, status ${row.status}.`
  ),
  "",
  "## Instagram",
  "",
  `- Doctor status: ${instagram?.summary?.overall_status ?? "not run"} (${instagram?.summary?.pass_count ?? 0}/${instagram?.summary?.total_checks ?? 0} checks passing).`,
  `- Logged-in session probe: ${instagramCheck("logged_in_session_browser_probe")?.message ?? "not run"}`,
  `- Public profile listing: ${instagramCheck("public-profile-post-listing")?.message ?? "not run"}`,
  `- HeyClicky targeted evidence: ${instagramCheck("targeted_evidence_metrics")?.message ?? "not run"}`,
  `- App feed Instagram evidence: ${instagramCheck("app_feed_instagram_evidence")?.message ?? "not run"}`,
  loggedInSocial
    ? `- OpenCLI read-only result: ${loggedInSocial.platform_rows.instagram ?? 0} Instagram evidence rows; ${loggedInSocial.companies_by_platform.instagram ?? 0} companies with Instagram evidence.`
    : "- OpenCLI read-only result: not available.",
  loggedInSocial
    ? `- HeyClicky parsed Instagram set: ${loggedInSocial.heyclicky_platform_rows.instagram ?? 0} rows, covering 19 visible company posts plus 22 visible founder posts in the current artifact.`
    : "- HeyClicky parsed Instagram set: not available.",
  instagramDiscovery
    ? `- Batch discovery: ${instagramDiscovery.companies_checked} companies checked; ${instagramDiscovery.candidates?.length ?? 0} candidates; ${instagramDiscovery.newly_verified_in_this_run} newly verified; ${instagramDiscovery.verified_company_instagram_profiles} total verified company Instagram profiles.`
    : "- Batch discovery: not run.",
  "- Instagram remains read-only; no likes, follows, comments, saves, DMs, posts, or CAPTCHA bypasses.",
  "",
  "## X/Twitter",
  "",
  loggedInSocial
    ? `- Status: logged-in read-only OpenCLI timeline parsing available for known YC-linked X handles; public attempts remain blocked or limited when unauthenticated.`
    : `- Status: ${xStatus.status}.`,
  loggedInSocial
    ? `- Details: ${loggedInSocial.platform_rows.x ?? 0} logged-in X evidence rows across ${loggedInSocial.companies_by_platform.x ?? 0} companies.`
    : `- Details: ${xStatus.details}.`,
  loggedInSocial
    ? `- HeyClicky parsed X set: ${loggedInSocial.heyclicky_platform_rows.x ?? 0} rows, covering 33 company posts plus 52 founder posts in the current artifact.`
    : "- HeyClicky parsed X set: not available.",
  "- Public X URL normalization merges x.com, twitter.com, and mobile.twitter.com status variants.",
  "- Logged-in X remains read-only: no likes, reposts, follows, DMs, bookmarks, posts, or account mutations.",
  "",
  "## Deduplication",
  "",
  `- Duplicate evidence groups: ${duplicates?.duplicate_group_count ?? duplicates?.duplicateGroups ?? "unknown"}.`,
  `- Duplicate social-account groups: ${duplicates?.duplicate_account_group_count ?? duplicates?.duplicateAccountGroupCount ?? "unknown"}.`,
  "- Canonical evidence keys prefer platform post IDs, then normalized URLs, then account/text fallback.",
  "- Repeated metric snapshots use the latest checked/updated row for scoring.",
  "",
  "## Scoring",
  "",
  `- Recommended config: ${scoring?.recommended_config ?? "not run"}.`,
  `- Recommendation reason: ${scoring?.recommendation_reason ?? "not run"}.`,
  "",
  "### Recommended Platform Weights",
  "",
  ...Object.entries(scoring?.recommended_platform_weights ?? {}).map(([platform, weight]) => `- ${platform}: ${Math.round(Number(weight) * 100)}%`),
  "",
  "### Recommended Metric Weights",
  "",
  ...Object.entries(scoring?.recommended_metric_weights ?? {}).map(
    ([platform, item]) => `- ${platform}: variant ${item.variant}, weights ${JSON.stringify(item.weights)}.`
  ),
  "",
  "## Anomalies",
  "",
  `- Anomaly count: ${anomalies?.anomaly_count ?? "not run"}.`,
  `- Follow-up task count: ${anomalies?.follow_up_task_count ?? "not run"}.`,
  ...(anomalies?.anomalies ?? []).slice(0, 20).map((item) => `- ${item.company_name}: ${item.kind} - ${item.message}`),
  "",
  "## Remaining Limitations",
  "",
  "- Instagram broad profile enumeration still requires an explicit safe session path or public pages that expose post links.",
  "- X public reader access can enter cooldown windows; when blocked, the worker logs and skips instead of retrying aggressively.",
  "- LinkedIn logged-in access is disabled. Public LinkedIn rows only score when post-level public metrics are visible.",
  "- Some Product Hunt, Reddit, and web/news matches remain `needs_review` when name/domain context is ambiguous.",
  "- Generated scores are relative to collected evidence; missing platform coverage is visible in coverage/anomaly reports.",
  "",
  "## Resume Commands",
  "",
  "```powershell",
  "npm run longrun:status",
  "npm run longrun:start",
  "npm run debug:coverage",
  "npm run debug:workers",
  "npm run debug:duplicates",
  "npm run debug:quality:strict",
  "npm run instagram:doctor",
  "npm run instagram:discover -- --search",
  "npm run scoring:experiments",
  "npm run debug:anomalies",
  "npm run longrun:final-verify",
  "npm run longrun:report",
  "node scripts/fetch-public-traction.mjs --social=all --platform=instagram --max-companies=197 --workers=2 --delay-ms=1800 --force --discover-missing-social",
  "node scripts/fetch-public-traction.mjs --social=all --platform=x --max-companies=197 --workers=2 --delay-ms=1500 --force --discover-missing-social",
  "node scripts/fetch-logged-in-social-traction.mjs --platforms=x --entities=all --workers=2 --limit=30 --scrolls=8 --timeout-ms=90000 --delay-ms=2500",
  "node scripts/fetch-logged-in-social-traction.mjs --platforms=instagram --entities=all --workers=1 --limit=40 --scrolls=20 --timeout-ms=90000 --delay-ms=1500",
  "```",
  ""
];

await fs.mkdir("docs", { recursive: true });
await fs.writeFile(path.join("docs", "LONG_RUN_FINAL_REPORT.md"), lines.join("\n"));
console.log(JSON.stringify({ outputPath: "docs/LONG_RUN_FINAL_REPORT.md", elapsedMinutes }, null, 2));

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
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && entry.name !== "active-run.json")
        .map(async (entry) => {
          const filePath = path.join(dir, entry.name);
          const stat = await fs.stat(filePath);
          return { filePath, stat };
        })
    );
    const latest = files.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs)[0];
    if (!latest) return null;
    const log = await readJson(latest.filePath, null);
    const events = Array.isArray(log) ? log : log?.eventLog ?? [];
    const lastEvent = events.at(-1);
    return {
      path: latest.filePath,
      eventCount: events.length,
      lastEventType: lastEvent?.type ?? "unknown"
    };
  } catch {
    return null;
  }
}

function xStatusSummary(liveCheckpoint, workers) {
  const platformRows = liveCheckpoint?.platform_rows ?? workers?.live_ingestion_checkpoint?.platform_rows ?? {};
  const xEvidence = platformRows.evidence?.x ?? 0;
  const xNeedsReview = platformRows.needs_review?.x ?? 0;
  const xFailures = platformRows.failures?.x ?? 0;
  const recentFailures = liveCheckpoint?.recent_failures ?? workers?.live_ingestion_checkpoint?.recent_failures ?? [];
  const recentXFailures = recentFailures.filter((failure) => failure.platform === "x");

  if (xFailures > 0 || recentXFailures.length) {
    return {
      status: "public attempts blocked or limited",
      details: `${xEvidence} evidence rows, ${xNeedsReview} needs-review rows, ${xFailures} failures. ${recentXFailures[0]?.message ?? "No recent failure sample available."}`
    };
  }

  return {
    status: "public attempts completed where accessible",
    details: `${xEvidence} evidence rows and ${xNeedsReview} needs-review rows. No scored post-level X evidence is currently available.`
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
          if (!row.platform || !row.companySlug) return acc;
          (acc[row.platform] ??= new Set()).add(row.companySlug);
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

function summarizeLiveCheckpoint(checkpoint) {
  if (!checkpoint) return null;
  const attempts = Object.values(checkpoint.attempts ?? {});
  return {
    attempt_count: attempts.length,
    attempt_status_counts: countBy(attempts, (attempt) => attempt.status ?? "unknown"),
    evidence_rows: checkpoint.evidence?.length ?? 0,
    needs_review_rows: checkpoint.needsReview?.length ?? 0,
    failure_rows: checkpoint.failures?.length ?? 0,
    platform_rows: {
      evidence: countBy(checkpoint.evidence ?? [], (row) => row.platform ?? "unknown"),
      needs_review: countBy(checkpoint.needsReview ?? [], (row) => row.platform ?? "unknown"),
      failures: countBy(checkpoint.failures ?? [], (row) => row.platform ?? "unknown")
    },
    recent_failures: (checkpoint.failures ?? []).slice(-20).reverse()
  };
}

function countBy(items, getKey) {
  return items.reduce((counts, item) => {
    const key = getKey(item);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function oneLine(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
}

function getOrchestrationStatus({ activeRun, elapsedMinutes, finalVerification, runFinished }) {
  if (runFinished) return "finished";
  if (isPidAlive(activeRun?.pid)) return "running/resumable";
  if (finalVerification?.status === "pass" && elapsedMinutes >= 360) {
    return "stopped after six-hour target and final verification; resumable from checkpoints";
  }
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
