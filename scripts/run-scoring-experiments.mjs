import fs from "node:fs/promises";
import path from "node:path";

const apiUrl = process.env.GRAPH_API_URL ?? "http://127.0.0.1:3001/api/graph?batch=S2026";
const graph = await fetchJson(apiUrl);
const evidenceById = new Map(graph.evidence.map((item) => [item.id, item]));
const companyEvidence = graph.nodes.map((node) => ({
  node,
  evidence: (node.evidenceIds ?? []).map((id) => evidenceById.get(id)).filter(Boolean)
}));

const METRIC_VARIANTS = {
  instagram: {
    A: { views: 0.02, likes: 1, comments: 3, shares: 4, reposts: 4, saves: 4 },
    B: { views: 0.05, likes: 1.1, comments: 5, shares: 5, reposts: 5, saves: 5 },
    C: { views: 0.01, likes: 1.5, comments: 4, shares: 4, reposts: 4, saves: 4 },
    D: { views: 0.06, likes: 0.8, comments: 4, shares: 5, reposts: 5, saves: 5 }
  },
  x: {
    A: { views: 0.02, likes: 1, replies: 3, comments: 3, reposts: 4, shares: 4, quotes: 4 },
    B: { views: 0.06, likes: 1.5, replies: 5.5, comments: 5.5, reposts: 8, shares: 8, quotes: 8 },
    C: { views: 0.01, likes: 1.5, replies: 3, comments: 3, reposts: 4, shares: 4, quotes: 4 }
  },
  linkedin: {
    A: { views: 0.02, likes: 1, reactions: 1, comments: 3, reposts: 4, shares: 4 },
    B: { views: 0.06, likes: 1.5, reactions: 1.5, comments: 5.5, reposts: 8, shares: 8 },
    C: { views: 0.01, likes: 1.5, reactions: 1.5, comments: 3, reposts: 4, shares: 4 }
  },
  github: {
    A: { stars: 1.5, forks: 4, watchers: 2, issues: 0.5, open_issues: 0.5, recent_commits_30d: 1 },
    B: { stars: 1, forks: 5, watchers: 1, issues: 0.5, open_issues: 0.5, recent_commits_30d: 2 },
    C: { stars: 2, forks: 3, watchers: 1, issues: 0.25, open_issues: 0.25, recent_commits_30d: 0.5 }
  },
  product_hunt: {
    A: { upvotes: 2, comments: 3 },
    B: { upvotes: 1.5, comments: 5 },
    C: { upvotes: 3, comments: 2 }
  },
  youtube: {
    A: { views: 0.02, likes: 1, comments: 3 },
    B: { views: 0.03, likes: 1, comments: 4 },
    C: { views: 0.01, likes: 1.5, comments: 4 }
  },
  hacker_news: {
    A: { upvotes: 2, comments: 3 }
  }
};

const DEFAULT_METRIC_VARIANTS = {
  instagram: "B",
  x: "B",
  linkedin: "B",
  github: "A",
  product_hunt: "A",
  youtube: "A",
  hacker_news: "A"
};

const configs = [
  config("A-balanced-social", { instagram: 0.25, x: 0.25, github: 0.2, product_hunt: 0.15, youtube: 0.1, linkedin: 0.03, hacker_news: 0.02 }),
  config("B-social-heavy", { instagram: 0.3, x: 0.3, github: 0.15, product_hunt: 0.1, youtube: 0.1, linkedin: 0.03, hacker_news: 0.02 }),
  config("C-developer-heavy", { github: 0.35, x: 0.2, instagram: 0.15, product_hunt: 0.15, youtube: 0.1, linkedin: 0.03, hacker_news: 0.02 }),
  config("D-launch-attention", { product_hunt: 0.25, x: 0.25, instagram: 0.2, github: 0.15, youtube: 0.1, linkedin: 0.03, hacker_news: 0.02 }),
  config("F-browser-social-v2", { x: 0.34, instagram: 0.22, github: 0.14, linkedin: 0.14, product_hunt: 0.07, youtube: 0.05, hacker_news: 0.04 }),
  learnedConfig()
];

const experiments = configs.map(runConfig);
const baselineRanks = rankMap(graph.nodes.map((node) => ({ companyId: node.entityId, score: node.score })));
const reports = experiments.map((experiment) => experimentReport(experiment, baselineRanks));
const recommended = chooseRecommended(reports);
const recommendedReport = reports.find((reportItem) => reportItem.name === recommended.name) ?? reports[0];
const metricVariantReports = runMetricVariantExperiments(recommendedReport.platformWeights);
const recommendedMetricWeights = chooseRecommendedMetricWeights(metricVariantReports);
const report = {
  generated_at: new Date().toISOString(),
  api_url: apiUrl,
  baseline: {
    node_count: graph.nodes.length,
    evidence_count: graph.evidence.length,
    top_25: graph.leaderboard.slice(0, 25).map((row) => ({ company: row.companyName, score: row.score, platform: row.topPlatform }))
  },
  experiments: reports,
  metric_variant_results: metricVariantReports,
  recommended_config: recommended.name,
  recommended_platform_weights: recommendedReport.platformWeights,
  recommended_metric_weights: recommendedMetricWeights,
  recommendation_reason: recommended.reason,
  formula_notes: [
    "Raw engagement is computed from platform metric weights.",
    "Raw engagement is multiplied by platform-specific recency decay before log normalization.",
    "Scores are log-normalized within platform, combined by available platform weights, then adjusted for coverage.",
    "Experiment totals use an evidence-depth confidence factor, then blend absolute score with peer spread instead of forcing the batch maximum to 100."
  ]
};

await fs.mkdir("outputs", { recursive: true });
await fs.writeFile(path.join("outputs", "scoring-experiments-s2026.json"), JSON.stringify(report, null, 2));
await updateScoringDocs(report);

console.log(
  JSON.stringify(
    {
      outputPath: "outputs/scoring-experiments-s2026.json",
      configs: reports.length,
      recommended: report.recommended_config
    },
    null,
    2
  )
);

function config(name, platformWeights) {
  return {
    name,
    platformWeights,
    metricWeights: defaultMetricWeights()
  };
}

function defaultMetricWeights() {
  return Object.fromEntries(
    Object.entries(DEFAULT_METRIC_VARIANTS).map(([platform, variant]) => [
      platform,
      METRIC_VARIANTS[platform][variant]
    ])
  );
}

function learnedConfig() {
  const platformStats = {};
  for (const platform of ["instagram", "x", "github", "product_hunt", "youtube", "linkedin", "hacker_news"]) {
    const rows = graph.evidence.filter((item) => item.platform === platform && item.contributionScore > 0);
    const companyCount = new Set(rows.map((item) => item.attachedCompanyId ?? item.entityId)).size;
    const variance = varianceOf(rows.map((item) => Math.log1p(rawEngagement(item, defaultMetricWeights()))));
    platformStats[platform] = Math.sqrt(companyCount + 1) * Math.sqrt(variance + 1);
  }
  const total = Object.values(platformStats).reduce((sum, value) => sum + value, 0) || 1;
  const platformWeights = Object.fromEntries(
    Object.entries(platformStats).map(([platform, value]) => [platform, round(value / total, 4)])
  );
  return { ...config("E-learned-tuned", platformWeights), learnedSignals: platformStats };
}

function runMetricVariantExperiments(platformWeights) {
  const rows = [];
  for (const [platform, variants] of Object.entries(METRIC_VARIANTS)) {
    for (const [variantName, weights] of Object.entries(variants)) {
      const metricWeights = { ...defaultMetricWeights(), [platform]: weights };
      const experiment = runConfig({
        name: `metric-${platform}-${variantName}`,
        platformWeights,
        metricWeights
      });
      const report = experimentReport(experiment, rankMap(graph.nodes.map((node) => ({ companyId: node.entityId, score: node.score }))));
      rows.push({
        platform,
        variant: variantName,
        weights,
        top25: report.top25,
        bottom25: report.bottom25,
        biggestMovers: report.biggestMovers.slice(0, 10),
        dominatedByOnePlatform: report.dominatedByOnePlatform.length,
        strongCrossPlatform: report.strongCrossPlatform.length,
        sparseDataWarnings: report.sparseDataWarnings.length,
        heyClicky: report.heyClicky,
        insForge: report.insForge,
        score: metricVariantQualityScore(report)
      });
    }
  }
  return rows;
}

function metricVariantQualityScore(report) {
  const heyClickyScore = report.heyClicky?.score ?? 0;
  const insForgeScore = report.insForge?.score ?? 0;
  return (
    report.strongCrossPlatform.length * 2 -
    report.sparseDataWarnings.length * 1.5 -
    report.dominatedByOnePlatform.length * 0.25 +
    Math.min(heyClickyScore, 60) / 15 +
    Math.min(insForgeScore, 80) / 20
  );
}

function chooseRecommendedMetricWeights(metricReports) {
  const bestByPlatform = {};
  for (const platform of Object.keys(METRIC_VARIANTS)) {
    const reports = metricReports
      .filter((row) => row.platform === platform)
      .sort((left, right) => right.score - left.score);
    const best = reports[0];
    const preferred = reports.find((row) => row.variant === DEFAULT_METRIC_VARIANTS[platform]);
    const chosen =
      preferred && best && Math.abs(best.score - preferred.score) <= 0.5
        ? preferred
        : best;
    bestByPlatform[platform] = {
      variant: chosen?.variant ?? DEFAULT_METRIC_VARIANTS[platform] ?? "A",
      weights: chosen?.weights ?? METRIC_VARIANTS[platform][DEFAULT_METRIC_VARIANTS[platform] ?? "A"],
      rationale:
        chosen?.platform === "linkedin"
          ? "Use only when public post-level reactions/comments/reposts are visible; profile-only rows remain non-scoring."
          : preferred && chosen?.variant === preferred.variant && best?.variant !== preferred.variant
            ? "Sensitivity score was effectively tied, so the recommendation keeps the live social-heavy default for consistency."
            : "Selected by the batch sensitivity score that rewards cross-platform signal and penalizes sparse high rankings."
    };
  }
  return bestByPlatform;
}

function runConfig(scoringConfig) {
  const scoredEvidence = scoreEvidence(graph.evidence, scoringConfig.metricWeights);
  const scoredById = new Map(scoredEvidence.map((item) => [item.id, item]));
  const rawRows = companyEvidence.map(({ node, evidence }) => {
    const scoredRows = evidence.map((item) => scoredById.get(item.id)).filter(Boolean);
    const breakdown = aggregateCompanyScore(scoredRows, scoringConfig.platformWeights);
    return {
      companyId: node.entityId,
      companyName: node.label,
      score: breakdown.totalScore,
      baselineScore: node.score,
      topPlatform: topPlatform(breakdown.platformScores),
      platformScores: breakdown.platformScores,
      weightedPlatforms: breakdown.weightedPlatforms,
      evidenceCount: scoredRows.filter((item) => item.score > 0).length,
      totalViews: scoredRows.reduce((sum, item) => sum + (Number(item.metrics?.views) || 0), 0),
      githubStars: scoredRows
        .filter((item) => item.platform === "github")
        .reduce((sum, item) => Math.max(sum, Number(item.metrics?.stars) || 0), 0),
      socialPlatforms: [
        ...new Set(
          scoredRows
            .filter((item) => item.score > 0 && ["instagram", "x", "linkedin", "youtube", "product_hunt"].includes(item.platform))
            .map((item) => item.platform)
        )
      ],
      latestEvidenceAt: latestDate(scoredRows.map((item) => item.last_checked_at ?? item.last_updated_at ?? item.postedAt))
    };
  });
  const rows = calibrateExperimentRows(rawRows);
  return { config: scoringConfig, rows: rows.sort((a, b) => b.score - a.score) };
}

function scoreEvidence(evidence, metricWeights) {
  const scored = evidence.map((item) => ({
    ...item,
    raw: rawEngagement(item, metricWeights),
    recencyWeight: recencyWeight(item),
    eligible: item.contributionScore > 0
  }));
  const byPlatform = new Map();
  for (const item of scored.filter((row) => row.eligible && row.raw * row.recencyWeight > 0)) {
    byPlatform.set(item.platform, [...(byPlatform.get(item.platform) ?? []), Math.log1p(item.raw * item.recencyWeight)]);
  }
  return scored.map((item) => ({
    ...item,
    score:
      item.eligible && item.raw * item.recencyWeight > 0
        ? logNormalize(byPlatform.get(item.platform) ?? [], Math.log1p(item.raw * item.recencyWeight))
        : 0
  }));
}

function rawEngagement(item, metricWeights) {
  const weights = metricWeights[item.platform] ?? {};
  let total = 0;
  for (const [metric, value] of Object.entries(item.metrics ?? {})) {
    total += (Number(value) || 0) * (weights[metric] ?? 0);
  }
  return total;
}

function recencyWeight(item) {
  const postedAt = parseDate(item.postedAt);
  if (!postedAt) return 0.75;
  const collectedAt = parseDate(item.last_checked_at ?? item.last_updated_at ?? item.first_seen_at) ?? new Date();
  const ageDays = Math.max(0, (collectedAt.getTime() - postedAt.getTime()) / 86_400_000);
  const halfLifeDays =
    {
      github: 180,
      product_hunt: 90,
      youtube: 120,
      linkedin: 60,
      instagram: 45,
      x: 45,
      hacker_news: 45
    }[item.platform] ?? 60;
  return Math.pow(0.5, ageDays / Math.max(halfLifeDays, 1));
}

function parseDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function aggregateCompanyScore(items, platformWeights) {
  const grouped = new Map();
  for (const item of items.filter((candidate) => candidate.score > 0 && platformWeights[candidate.platform] > 0)) {
    grouped.set(item.platform, [...(grouped.get(item.platform) ?? []), item.score]);
  }
  const platformScores = {};
  for (const [platform, scores] of grouped.entries()) {
    scores.sort((a, b) => b - a);
    if (platform === "github") {
      const primarySignal = scores[0];
      const topThreeAverage = average(scores.slice(0, 3));
      const repoDepth = Math.min(100, (Math.log1p(scores.length) / Math.log1p(20)) * 100);
      platformScores[platform] = Math.round(primarySignal * 0.78 + topThreeAverage * 0.17 + repoDepth * 0.05);
      continue;
    }

    const topScores = scores.slice(0, 5);
    const topAverage = average(topScores);
    const allAverage = average(scores);
    const consistency = Math.min(100, (scores.length / 5) * 100);
    platformScores[platform] = Math.round(topAverage * 0.7 + allAverage * 0.2 + consistency * 0.1);
  }
  const available = Object.entries(platformScores);
  const availableWeight = available.reduce((sum, [platform]) => sum + (platformWeights[platform] ?? 0), 0);
  const weightedAvailableScore =
    availableWeight > 0
      ? available.reduce((sum, [platform, score]) => sum + score * (platformWeights[platform] ?? 0), 0) / availableWeight
      : 0;
  const supportedPlatforms = Object.keys(platformWeights).length || 1;
  const coverageFactor = available.length ? 0.85 + 0.15 * Math.sqrt(available.length / supportedPlatforms) : 0;
  return {
    totalScore: Math.round(weightedAvailableScore * coverageFactor),
    platformScores,
    weightedPlatforms: available
      .map(([platform, score]) => ({
        platform,
        score,
        configuredWeight: platformWeights[platform] ?? 0,
        appliedWeight: availableWeight ? (platformWeights[platform] ?? 0) / availableWeight : 0,
        contribution: availableWeight ? score * ((platformWeights[platform] ?? 0) / availableWeight) : 0
      }))
      .sort((a, b) => b.contribution - a.contribution || b.score - a.score)
  };
}

function calibrateExperimentRows(rows) {
  const confidenceRows = rows.map((row) => {
    const confidenceFactor = evidenceDepthConfidenceFactor(row.evidenceCount);
    const confidenceAdjustedScore = row.score * confidenceFactor;

    return {
      row,
      confidenceFactor,
      confidenceAdjustedScore
    };
  });
  const positiveScores = confidenceRows.map((row) => row.confidenceAdjustedScore).filter((score) => score > 0);
  if (!positiveScores.length) {
    return rows.map((row) => ({ ...row, rawScore: row.score }));
  }
  const min = Math.min(...positiveScores);
  const max = Math.max(...positiveScores);
  if (min === max) {
    return rows.map((row) => ({ ...row, rawScore: row.score }));
  }

  return confidenceRows.map(({ row, confidenceFactor, confidenceAdjustedScore }) => {
    const spreadScore =
      confidenceAdjustedScore <= 0
        ? 0
        : Math.round(Math.pow((confidenceAdjustedScore - min) / (max - min), 1.18) * 100);

    return {
      ...row,
      rawScore: row.score,
      confidenceAdjustedScore: round(confidenceAdjustedScore),
      confidenceFactor: round(confidenceFactor),
      score: confidenceAdjustedScore <= 0 ? 0 : Math.round(confidenceAdjustedScore * 0.82 + spreadScore * 0.18)
    };
  });
}

function evidenceDepthConfidenceFactor(evidenceCount) {
  if (evidenceCount <= 0) {
    return 0;
  }

  const depth = Math.min(1, Math.sqrt(evidenceCount / 5));
  return 0.72 + 0.28 * depth;
}

function experimentReport(experiment, baselineRanks) {
  const ranks = rankMap(experiment.rows);
  const top25 = experiment.rows.slice(0, 25);
  const bottom25 = experiment.rows.slice(-25).reverse();
  const movers = experiment.rows
    .map((row) => ({
      company: row.companyName,
      score: row.score,
      baselineScore: row.baselineScore,
      rankDelta: (baselineRanks.get(row.companyId) ?? 999) - (ranks.get(row.companyId) ?? 999),
      topPlatform: row.topPlatform
    }))
    .sort((a, b) => Math.abs(b.rankDelta) - Math.abs(a.rankDelta))
    .slice(0, 25);

  return {
    name: experiment.config.name,
    platformWeights: experiment.config.platformWeights,
    top25,
    bottom25,
    biggestMovers: movers,
    dominatedByOnePlatform: experiment.rows
      .filter((row) => row.weightedPlatforms[0]?.appliedWeight >= 0.85)
      .slice(0, 25),
    strongCrossPlatform: experiment.rows
      .filter((row) => Object.keys(row.platformScores).length >= 3)
      .slice(0, 25),
    sparseDataWarnings: experiment.rows
      .filter((row) => row.score >= 50 && row.evidenceCount <= 2)
      .slice(0, 25),
    highViewsLowScore: experiment.rows
      .filter((row) => row.totalViews >= 50_000 && row.score < 50)
      .sort((a, b) => b.totalViews - a.totalViews)
      .slice(0, 25),
    highGithubLowSocial: experiment.rows
      .filter((row) => (row.platformScores.github ?? 0) >= 70 && socialScore(row) < 30)
      .slice(0, 25),
    viralSocialLowGithub: experiment.rows
      .filter((row) => socialScore(row) >= 60 && (row.platformScores.github ?? 0) < 30)
      .slice(0, 25),
    highGithubLowTotal: experiment.rows
      .filter((row) => row.githubStars >= 1_000 && row.score < 45)
      .slice(0, 25),
    likelyFormulaIssues: formulaIssueRows(experiment.rows),
    heyClicky: experiment.rows.find((row) => row.companyName === "HeyClicky") ?? null,
    insForge: experiment.rows.find((row) => row.companyName === "InsForge") ?? null
  };
}

function formulaIssueRows(rows) {
  return rows
    .filter(
      (row) =>
        (row.score >= 70 && row.evidenceCount <= 1) ||
        (row.totalViews >= 100_000 && row.score < 40) ||
        (row.githubStars >= 5_000 && (row.platformScores.github ?? 0) < 65)
    )
    .slice(0, 30)
    .map((row) => ({
      companyName: row.companyName,
      score: row.score,
      evidenceCount: row.evidenceCount,
      totalViews: row.totalViews,
      githubStars: row.githubStars,
      platformScores: row.platformScores,
      reason:
        row.score >= 70 && row.evidenceCount <= 1
          ? "high score with sparse evidence"
          : row.totalViews >= 100_000 && row.score < 40
            ? "large visible view count but low total score"
            : "large GitHub star count but weak GitHub platform score"
    }));
}

function socialScore(row) {
  const social = ["instagram", "x", "linkedin", "youtube", "product_hunt"]
    .map((platform) => row.platformScores[platform])
    .filter((score) => Number.isFinite(score));
  return average(social);
}

function chooseRecommended(reports) {
  const scored = reports.map((report) => {
    const crossPlatformCount = report.strongCrossPlatform.length;
    const sparsePenalty = report.sparseDataWarnings.length;
    const highViewsLowScorePenalty = report.highViewsLowScore.length;
    const dominatedPenalty = report.dominatedByOnePlatform.length;
    const heyClickyScore = report.heyClicky?.score ?? 0;
    const insForgeScore = report.insForge?.score ?? 0;
    const prioritySocialWeight =
      (report.platformWeights.x ?? 0) * 14 +
      (report.platformWeights.linkedin ?? 0) * 14 +
      (report.platformWeights.instagram ?? 0) * 6 +
      (report.platformWeights.product_hunt ?? 0) * 2 +
      (report.platformWeights.youtube ?? 0) * 2 -
      (report.platformWeights.github ?? 0) * 5;
    return {
      name: report.name,
      score:
        crossPlatformCount * 2 -
        sparsePenalty -
        highViewsLowScorePenalty * 0.2 -
        dominatedPenalty * 0.1 +
        Math.min(heyClickyScore, 85) / 10 +
        Math.min(insForgeScore, 75) / 30 +
        prioritySocialWeight
    };
  });
  const best = scored.sort((a, b) => b.score - a.score)[0];
  return {
    name: best.name,
    reason:
      "Selected by maximizing cross-platform social signal, penalizing sparse/high-view anomalies, and preserving HeyClicky/InsForge sanity-check visibility without reverting to a GitHub leaderboard."
  };
}

async function updateScoringDocs(report) {
  const lines = [
    "# Scoring Experiments",
    "",
    "## Latest Run",
    "",
    `- Generated at: ${report.generated_at}.`,
    `- Baseline evidence rows: ${report.baseline.evidence_count}.`,
    `- Recommended config: ${report.recommended_config}.`,
    `- Recommendation reason: ${report.recommendation_reason}`,
    `- Formula notes: ${report.formula_notes.join(" ")}`,
    "",
    "## Recommended Platform Weights",
    "",
    ...Object.entries(report.recommended_platform_weights).map(([platform, weight]) => `- ${platform}: ${Math.round(weight * 100)}%`),
    "",
    "## Recommended Metric Weights",
    "",
    ...Object.entries(report.recommended_metric_weights).map(
      ([platform, item]) => `- ${platform}: variant ${item.variant}, weights ${JSON.stringify(item.weights)}.`
    ),
    "",
    "## Config Summary",
    "",
    ...report.experiments.map(
      (item) =>
        `- ${item.name}: HeyClicky ${item.heyClicky?.score ?? "n/a"}, InsForge ${item.insForge?.score ?? "n/a"}, sparse warnings ${item.sparseDataWarnings.length}, high-views/low-score ${item.highViewsLowScore.length}, high-GitHub/low-social ${item.highGithubLowSocial.length}, viral-social/low-GitHub ${item.viralSocialLowGithub.length}.`
    ),
    "",
    "## Diagnostics",
    "",
    ...report.experiments.flatMap((item) => [
      `- ${item.name} dominated-by-one-platform examples: ${item.dominatedByOnePlatform.slice(0, 5).map((row) => row.companyName).join(", ") || "none"}.`,
      `- ${item.name} high-views/low-score examples: ${item.highViewsLowScore.slice(0, 5).map((row) => `${row.companyName} (${row.totalViews} views, score ${row.score})`).join(", ") || "none"}.`,
      `- ${item.name} high-GitHub/low-social examples: ${item.highGithubLowSocial.slice(0, 5).map((row) => `${row.companyName} (${row.githubStars} stars, score ${row.score})`).join(", ") || "none"}.`,
      `- ${item.name} viral-social/low-GitHub examples: ${item.viralSocialLowGithub.slice(0, 5).map((row) => `${row.companyName} (score ${row.score})`).join(", ") || "none"}.`,
      `- ${item.name} likely formula issues: ${item.likelyFormulaIssues.slice(0, 5).map((row) => `${row.companyName}: ${row.reason}`).join(", ") || "none"}.`
    ]),
    "",
    "## Metric Sensitivity",
    "",
    ...report.metric_variant_results
      .map(
        (item) =>
          `- ${item.platform} ${item.variant}: HeyClicky ${item.heyClicky?.score ?? "n/a"}, InsForge ${item.insForge?.score ?? "n/a"}, sparse warnings ${item.sparseDataWarnings}, score ${round(item.score, 2)}.`
      )
      .slice(0, 30),
    "",
    "Full machine-readable output: `outputs/scoring-experiments-s2026.json`.",
    ""
  ];
  await fs.writeFile(path.join("docs", "SCORING_EXPERIMENTS.md"), lines.join("\n"));
}

function rankMap(rows) {
  return new Map([...rows].sort((a, b) => b.score - a.score).map((row, index) => [row.companyId, index + 1]));
}

function logNormalize(samples, value) {
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return 0;
  if (min === max) return 50;
  return Math.round(5 + ((value - min) / (max - min)) * 95);
}

function topPlatform(platformScores) {
  return Object.entries(platformScores).sort(([, a], [, b]) => b - a)[0]?.[0] ?? null;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function latestDate(values) {
  return values
    .filter(Boolean)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
}

function varianceOf(values) {
  if (!values.length) return 0;
  const mean = average(values);
  return average(values.map((value) => (value - mean) ** 2));
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Graph API failed with ${response.status}`);
  return response.json();
}
