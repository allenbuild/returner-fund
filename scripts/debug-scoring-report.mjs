import fs from "node:fs/promises";
import path from "node:path";

const apiUrl = process.env.GRAPH_API_URL ?? "http://127.0.0.1:3001/api/graph?batch=S2026&includeWhy=1";
const leftName = argValue("--company") ?? argValue("--left") ?? positionalValue(0) ?? "InsForge";
const rightName = argValue("--right") ?? positionalValue(1) ?? (argValue("--company") ? "InsForge" : "Interfaze");
const graph = await fetchJson(apiUrl);
const left = companyReport(leftName);
const right = companyReport(rightName);
const report = {
  generated_at: new Date().toISOString(),
  api_url: apiUrl,
  comparison: [left, right],
  ranking_summary: `${left.company_name} score ${left.total_score}; ${right.company_name} score ${right.total_score}.`
};
const outputPath = path.join("outputs", `scoring-debug-${slug(leftName)}-vs-${slug(rightName)}.json`);

await fs.mkdir("outputs", { recursive: true });
await fs.writeFile(outputPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ outputPath, rankingSummary: report.ranking_summary }, null, 2));

function companyReport(name) {
  const node = graph.nodes.find(
    (candidate) => candidate.entityType === "company" && candidate.label.toLowerCase() === name.toLowerCase()
  );

  if (!node) {
    throw new Error(`Company not found: ${name}`);
  }

  const evidence = graph.evidence.filter((item) => node.evidenceIds.includes(item.id));
  const platformTotals = aggregatePlatformMetrics(evidence);

  return {
    company_id: node.entityId,
    company_name: node.label,
    total_score: node.score,
    top_platform: node.topPlatform,
    platform_scores: node.platformScores,
    score_breakdown: node.scoreBreakdown,
    github_stars: platformTotals.github.stars,
    github_forks: platformTotals.github.forks,
    github_watchers: platformTotals.github.watchers,
    instagram_metrics: platformTotals.instagram,
    x_views: platformTotals.x.views,
    x_likes: platformTotals.x.likes,
    x_reposts: platformTotals.x.reposts,
    linkedin_metrics: platformTotals.linkedin,
    product_hunt_metrics: platformTotals.product_hunt,
    youtube_metrics: platformTotals.youtube,
    reddit_metrics: platformTotals.reddit,
    hacker_news_metrics: platformTotals.hacker_news,
    context_counts: {
      web: platformTotals.web.count ?? 0,
      rss: platformTotals.rss.count ?? 0
    },
    evidence_count: evidence.length,
    top_10_evidence: evidence
      .filter((item) => item.contributionScore > 0)
      .sort((left, right) => right.contributionScore - left.contributionScore)
      .slice(0, 10)
      .map((item) => ({
        post_id: item.id,
        platform: item.platform,
        score: item.contributionScore,
        raw_engagement: item.rawEngagement ?? 0,
        normalized_score: item.normalizedScore ?? item.contributionScore,
        post_url: item.sourceUrl,
        metrics: item.metrics,
        contribution_reason: item.why
      }))
  };
}

function aggregatePlatformMetrics(evidence) {
  const empty = () => ({});
  const totals = {
    github: empty(),
    instagram: empty(),
    x: empty(),
    linkedin: empty(),
    product_hunt: empty(),
    youtube: empty(),
    reddit: empty(),
    hacker_news: empty(),
    web: empty(),
    rss: empty()
  };

  for (const item of evidence) {
    const bucket = totals[item.platform];
    if (!bucket) {
      continue;
    }
    for (const [metric, value] of Object.entries(item.metrics ?? {})) {
      const numericValue = Number.isFinite(value) ? Number(value) : 0;
      if (item.platform === "github" && ["stars", "forks", "watchers"].includes(metric)) {
        bucket[metric] = Math.max(bucket[metric] ?? 0, numericValue);
      } else {
        bucket[metric] = (bucket[metric] ?? 0) + numericValue;
      }
    }
    bucket.count = (bucket.count ?? 0) + 1;
  }

  return totals;
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Graph API failed with ${response.status}`);
  }
  return response.json();
}

function argValue(name) {
  const equalsValue = process.argv.find((arg) => arg.startsWith(`${name}=`))?.split("=").slice(1).join("=");
  if (equalsValue !== undefined) return equalsValue;
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function positionalValue(index) {
  return process.argv.slice(2).filter((arg) => !arg.startsWith("--"))[index];
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
