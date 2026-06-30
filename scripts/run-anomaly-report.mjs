import fs from "node:fs/promises";
import path from "node:path";

const apiUrl = process.env.GRAPH_API_URL ?? "http://127.0.0.1:3001/api/graph?batch=S2026&includeNonScoring=1";
const graph = await fetchJson(apiUrl);
const evidenceById = new Map(graph.evidence.map((item) => [item.id, item]));
const rows = graph.nodes.map((node) => {
  const evidence = (node.evidenceIds ?? []).map((id) => evidenceById.get(id)).filter(Boolean);
  const scored = evidence.filter((item) => item.contributionScore > 0);
  const platformMetrics = aggregateByPlatform(scored);
  return {
    node,
    evidence,
    scored,
    platformMetrics,
    totalRawViews: scored.reduce((sum, item) => sum + (item.metrics?.views ?? 0), 0),
    githubStars: scored.filter((item) => item.platform === "github").reduce((sum, item) => Math.max(sum, item.metrics?.stars ?? 0), 0),
    socialRows: scored.filter((item) => ["x", "instagram", "linkedin", "youtube", "product_hunt"].includes(item.platform))
  };
});

const anomalies = [
  ...highRawViewsLowScore(rows),
  ...highGithubLowScore(rows),
  ...highSocialLowScore(rows),
  ...manyPostsLowScore(rows),
  ...noEvidence(rows),
  ...missingLikelyInstagram(rows),
  ...missingLikelyX(rows),
  ...crossCompanyAttribution(rows)
];

const followUpTasks = anomalies.flatMap((item) => item.followUpTasks);
const report = {
  generated_at: new Date().toISOString(),
  api_url: apiUrl,
  anomaly_count: anomalies.length,
  follow_up_task_count: followUpTasks.length,
  anomalies,
  follow_up_tasks: followUpTasks
};

await fs.mkdir("outputs", { recursive: true });
await fs.writeFile(path.join("outputs", "anomaly-report-s2026.json"), JSON.stringify(report, null, 2));
await updateResearchNotes(report);
await updateDiscoveryLearnings(report);

console.log(JSON.stringify({ outputPath: "outputs/anomaly-report-s2026.json", anomalies: anomalies.length, followUpTasks: followUpTasks.length }, null, 2));

function highRawViewsLowScore(items) {
  return items
    .filter((row) => row.totalRawViews >= 50_000 && row.node.score < 40)
    .map((row) => anomaly(row, "high_raw_views_low_score", `Visible views ${row.totalRawViews} but score ${row.node.score}.`, ["scoring_worker", "metric_worker"]));
}

function highGithubLowScore(items) {
  return items
    .filter((row) => row.githubStars >= 1_000 && row.node.score < 45)
    .map((row) => anomaly(row, "high_github_low_score", `GitHub stars ${row.githubStars} but score ${row.node.score}.`, ["scoring_worker", "discovery_worker"]));
}

function highSocialLowScore(items) {
  return items
    .filter((row) => row.socialRows.length >= 3 && row.node.score < 45)
    .map((row) => anomaly(row, "high_social_low_score", `${row.socialRows.length} scored social rows but score ${row.node.score}.`, ["scoring_worker"]));
}

function manyPostsLowScore(items) {
  return items
    .filter((row) => row.scored.length >= 10 && row.node.score < 35)
    .map((row) => anomaly(row, "many_posts_low_score", `${row.scored.length} scored rows but score ${row.node.score}.`, ["dedupe_worker", "scoring_worker"]));
}

function noEvidence(items) {
  return items
    .filter((row) => row.scored.length === 0)
    .map((row) => anomaly(row, "no_scored_evidence", "No scored GitHub/social evidence.", ["discovery_worker", "website_worker"]));
}

function missingLikelyInstagram(items) {
  return items
    .filter((row) => {
      const text = `${row.node.label} ${row.node.tagline ?? ""} ${row.node.description ?? ""}`.toLowerCase();
      return !row.evidence.some((item) => item.platform === "instagram") && /(consumer|creator|video|design|game|social|media|assistant)/.test(text);
    })
    .slice(0, 50)
    .map((row) => anomaly(row, "missing_likely_instagram", "Consumer/creator-ish company with no Instagram evidence.", ["instagram_worker", "discovery_worker"]));
}

function missingLikelyX(items) {
  return items
    .filter((row) => row.node.socialAccounts.some((account) => account.platform === "x") && !row.scored.some((item) => item.platform === "x"))
    .map((row) => anomaly(row, "missing_x_posts", "Company has X account but no scored X posts.", ["profile_worker", "platform_post_worker"]));
}

function crossCompanyAttribution(items) {
  return items.flatMap((row) =>
    row.evidence
      .filter((item) => item.attachedCompanyId && item.attachedCompanyId !== row.node.entityId)
      .map(() => anomaly(row, "cross_company_attribution", "Evidence attached company does not match selected company.", ["dedupe_worker", "profile_worker"]))
  );
}

function anomaly(row, kind, message, workers) {
  return {
    kind,
    company_id: row.node.entityId,
    company_name: row.node.label,
    score: row.node.score,
    top_platform: row.node.topPlatform,
    message,
    followUpTasks: workers.map((worker) => ({
      worker,
      company_id: row.node.entityId,
      company_name: row.node.label,
      priority: kind.includes("instagram") || row.node.label === "HeyClicky" ? "high" : "normal",
      query_seed: `${row.node.label} YC Spring 2026`
    }))
  };
}

function aggregateByPlatform(evidence) {
  const grouped = {};
  for (const item of evidence) {
    grouped[item.platform] ??= { count: 0, views: 0, stars: 0 };
    grouped[item.platform].count += 1;
    grouped[item.platform].views += item.metrics?.views ?? 0;
    grouped[item.platform].stars = Math.max(grouped[item.platform].stars, item.metrics?.stars ?? 0);
  }
  return grouped;
}

async function updateResearchNotes(report) {
  const attribution = await readJson(path.join("outputs", "evidence-attribution-audit-s2026.json"), null);
  const lines = [
    "# Research Notes",
    "",
    "## Latest Anomaly Pass",
    "",
    `- Generated at: ${report.generated_at}.`,
    `- Anomalies: ${report.anomaly_count}.`,
    `- Follow-up tasks: ${report.follow_up_task_count}.`,
    "",
    "## Long-Run Root Cause Notes",
    "",
    "- Shallow social evidence was mostly caused by profile/context collection without post-level promotion. Profile URLs stay identity context only; discovered public post URLs now get a separate verification step.",
    "- Instagram remains the most blocked public source: direct profile pages still return login-wall/block content in the doctor and broad public runs. Targeted HeyClicky reel evidence remains the known working Instagram path.",
    "- X public search/profile paths discover many candidates, but post text/metrics are often blocked. The next resumed broad run should force-refresh X/Instagram after the new post verifier so `/status/` and `/reel/` candidates can be retried.",
    "- Long-run observation: Jina Reader can return HTTP 451 cooldowns for anonymous `x.com` access. Cooldowns should be logged once per platform window and subsequent X tasks skipped until the stated expiry.",
    attribution?.first_party_social_review_count !== undefined
      ? `- Attribution review update: the hard guard reports ${attribution.high_risk_scored_count ?? "n/a"} high and ${attribution.medium_risk_scored_count ?? "n/a"} medium scored attribution failures. The first-party social body-signal queue has ${attribution.first_party_social_review_count} scored rows, including ${attribution.founder_first_party_review_count ?? 0} founder rows and ${attribution.first_party_social_review_priority_counts?.high ?? 0} high-priority probable off-topic rows. Keep this as review instrumentation before changing founder/social scoring weights.`
      : "- Attribution review update: attribution audit output is missing; run `npm run debug:attribution` before changing founder/social scoring weights.",
    "",
    "## Highest Priority Anomalies",
    "",
    ...report.anomalies.slice(0, 40).map((item) => `- ${item.company_name}: ${item.kind} - ${item.message}`),
    "",
    "Full machine-readable output: `outputs/anomaly-report-s2026.json`.",
    ""
  ];
  await fs.writeFile(path.join("docs", "RESEARCH_NOTES.md"), lines.join("\n"));
}

async function updateDiscoveryLearnings(report) {
  const highInstagram = report.follow_up_tasks.filter((task) => task.worker === "instagram_worker").length;
  const lines = [
    "# Discovery Learnings",
    "",
    "## Latest Learning Pass",
    "",
    `- Generated at: ${report.generated_at}.`,
    `- Instagram follow-up tasks generated: ${highInstagram}.`,
    "- Missing X posts are often caused by a profile URL existing on YC but public post pages not being clearly readable.",
    "- Missing Instagram is common when YC does not list an Instagram URL; website and search discovery should run before profile scraping.",
    "- Cross-company attribution anomalies should be treated as hard dedupe/profile-review tasks.",
    "- Long-run update: profile URLs stay identity context only; search-discovered X `/status/`, Instagram `/p/` or `/reel/`, and LinkedIn feed/post URLs can be promoted only after public readable text matches company/domain plus YC/startup context.",
    "- Long-run update: canonical discovery should merge `mobile.twitter.com`, `twitter.com`, and `x.com` status URL variants before dedupe/scoring.",
    "- Long-run update: when a public reader returns an explicit platform cooldown, record the block and avoid retrying that platform until the cooldown expires.",
    "- Product Hunt update: public search can repeat generic popular products across many companies. Keep Product Hunt candidates out of review/scoring unless the Product Hunt URL/title matches the target slug/name or is corroborated by official domain, founder, or descriptor context.",
    "- Product Hunt update: the repeated `screen-studio` candidate is a known false-positive pattern and should remain pruned from S2026 review queues unless a company has direct official evidence linking to it.",
    "",
    "## Query Seeds To Reuse",
    "",
    ...[...new Set(report.follow_up_tasks.slice(0, 60).map((task) => task.query_seed))].map((query) => `- ${query}`),
    ""
  ];
  await fs.writeFile(path.join("docs", "DISCOVERY_LEARNINGS.md"), lines.join("\n"));
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Graph API failed with ${response.status}`);
  return response.json();
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}
