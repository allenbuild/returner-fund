import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

const apiUrl =
  argValue("--api-url") ??
  process.env.GRAPH_API_URL ??
  "http://127.0.0.1:3001/api/graph?batch=S2026&includeRaw=1&includeNonScoring=1";
const graphSampleCount = integerArg("--graph-samples", 2, { min: 1, max: 5 });
const graph = await timedFetchJson(apiUrl, { samples: graphSampleCount });
const attribution = await readJson(path.join("outputs", "evidence-attribution-audit-s2026.json"), null);
const coverage = await readJson(path.join("outputs", "coverage-debug-s2026.json"), null);
const duplicates = await readJson(path.join("outputs", "duplicates-debug-s2026.json"), null);
const scoring = await readJson(path.join("outputs", "scoring-experiments-s2026.json"), null);
const instagram = await readJson(path.join("outputs", "instagram-doctor.json"), null);
const attributionLoop = await readJson(path.join("outputs", "attribution-feedback-loop-latest.json"), null);

const evidenceById = new Map(graph.payload.evidence.map((item) => [item.id, item]));
const scoredEvidence = graph.payload.evidence.filter((item) => Number(item.contributionScore) > 0);
const findings = [
  ...graphIntegrityFindings(graph.payload),
  ...evidenceMetadataFindings(graph.payload.evidence),
  ...attributionFindings(attribution, scoredEvidence),
  ...duplicateFindings(graph.payload.evidence, duplicates),
  ...nearDuplicateFindings(graph.payload.evidence),
  ...scoreInflationFindings(graph.payload, evidenceById),
  ...coverageFindings(coverage),
  ...performanceFindings(graph),
  ...observabilityFindings({ attribution, coverage, duplicates, scoring, instagram, attributionLoop })
].sort((left, right) => severityRank(right.severity) - severityRank(left.severity));

const report = {
  generated_at: new Date().toISOString(),
  api_url: apiUrl,
  summary: {
    status: findings.some((item) => item.severity === "critical") ? "fail" : "pass_with_findings",
    critical: findings.filter((item) => item.severity === "critical").length,
    high: findings.filter((item) => item.severity === "high").length,
    medium: findings.filter((item) => item.severity === "medium").length,
    low: findings.filter((item) => item.severity === "low").length,
    info: findings.filter((item) => item.severity === "info").length
  },
  metrics: {
    company_nodes: graph.payload.nodes.filter((node) => node.entityType === "company").length,
    founder_nodes: graph.payload.nodes.filter((node) => node.entityType === "founder").length,
    evidence_rows: graph.payload.evidence.length,
    scored_evidence_rows: scoredEvidence.length,
    graph_api_ms: Math.round(graph.elapsedMs),
    graph_api_timings_ms: graph.timingsMs.map((value) => Math.round(value)),
    graph_api_sample_count: graph.timingsMs.length,
    graph_payload_bytes: graph.bytes,
    attribution_loop_status: attributionLoop?.status ?? "not_run",
    attribution_loop_elapsed_minutes: attributionLoop?.elapsed_minutes ?? null
  },
  findings
};

await fs.mkdir("outputs", { recursive: true });
await fs.writeFile(path.join("outputs", "quality-audit-latest.json"), JSON.stringify(report, null, 2));
await writeMarkdown(report);

console.log(
  JSON.stringify(
    {
      outputPath: "outputs/quality-audit-latest.json",
      docPath: "docs/QUALITY_AUDIT.md",
      status: report.summary.status,
      findings: report.summary,
      graphApiMs: report.metrics.graph_api_ms,
      graphApiTimingsMs: report.metrics.graph_api_timings_ms,
      payloadBytes: report.metrics.graph_payload_bytes
    },
    null,
    2
  )
);

if (booleanArg("--strict") && (report.summary.critical > 0 || report.summary.high > 0 || report.summary.medium > 0)) {
  process.exitCode = 1;
}

function graphIntegrityFindings(graph) {
  const findings = [];
  const companyNodes = graph.nodes.filter((node) => node.entityType === "company");
  const founderNodes = graph.nodes.filter((node) => node.entityType === "founder");

  if (companyNodes.length !== 197) {
    findings.push(finding("critical", "graph.company_count", `Expected 197 company nodes, found ${companyNodes.length}.`));
  }
  if (founderNodes.length > 0) {
    findings.push(finding("critical", "graph.founder_nodes", `Founder nodes leaked into graph: ${founderNodes.length}.`));
  }
  if (new Set(companyNodes.map((node) => node.entityId)).size !== companyNodes.length) {
    findings.push(finding("critical", "graph.duplicate_company_nodes", "Duplicate company entity IDs exist in graph nodes."));
  }
  if (!graph.leaderboard?.length) {
    findings.push(finding("high", "ui.leaderboard_empty", "Leaderboard is empty."));
  }
  if (!graph.platformStatus?.length) {
    findings.push(finding("medium", "observability.platform_status_missing", "Platform status list is missing from graph response."));
  }

  return findings;
}

function evidenceMetadataFindings(evidence) {
  const findings = [];
  const scoredMissingSource = evidence.filter((item) => item.contributionScore > 0 && !validUrl(item.sourceUrl));
  const scoredMissingTimestamp = evidence.filter((item) => item.contributionScore > 0 && !item.last_checked_at && !item.last_updated_at && !item.postedAt);
  const scoredNeedsReview = evidence.filter((item) => item.contributionScore > 0 && item.review_state && item.review_state !== "verified");
  const scoredGuardedHighRisk = evidence.filter(
    (item) => item.contributionScore > 0 && /Attribution guard:\s*(high|medium) risk/i.test(`${item.why ?? ""} ${item.matchReason ?? ""}`)
  );
  const scoredProfileRows = evidence.filter((item) => item.contributionScore > 0 && isProfileOrContextOnlyEvidence(item));

  if (scoredMissingSource.length) {
    findings.push(finding("critical", "evidence.scored_missing_source", `${scoredMissingSource.length} scored rows lack valid source URLs.`, examples(scoredMissingSource)));
  }
  if (scoredMissingTimestamp.length) {
    findings.push(finding("high", "evidence.scored_missing_timestamp", `${scoredMissingTimestamp.length} scored rows lack checked/updated/posted timestamps.`, examples(scoredMissingTimestamp)));
  }
  if (scoredNeedsReview.length) {
    findings.push(finding("critical", "evidence.scored_needs_review", `${scoredNeedsReview.length} non-verified rows are still scored.`, examples(scoredNeedsReview)));
  }
  if (scoredGuardedHighRisk.length) {
    findings.push(finding("critical", "evidence.scored_guarded_risk", `${scoredGuardedHighRisk.length} scored rows are marked medium/high risk by attribution guard.`, examples(scoredGuardedHighRisk)));
  }
  if (scoredProfileRows.length) {
    findings.push(finding("critical", "evidence.profile_rows_scored", `${scoredProfileRows.length} profile/context rows are still scored.`, examples(scoredProfileRows)));
  }

  return findings;
}

function attributionFindings(attribution, scoredEvidence) {
  const findings = [];

  if (!attribution) {
    findings.push(finding("critical", "attribution.audit_missing", "Attribution audit output is missing."));
    return findings;
  }
  if (attribution.high_risk_scored_count > 0) {
    findings.push(finding("critical", "attribution.high_risk_scored", `${attribution.high_risk_scored_count} high-risk scored rows remain.`, attribution.high_risk_scored?.slice(0, 10)));
  }
  if (attribution.medium_risk_scored_count > 0) {
    findings.push(finding("high", "attribution.medium_risk_scored", `${attribution.medium_risk_scored_count} medium-risk scored rows remain.`, attribution.medium_risk_scored?.slice(0, 10)));
  }
  if (attribution.scored_evidence_count !== scoredEvidence.length) {
    findings.push(
      finding(
        "medium",
        "attribution.audit_stale",
        `Attribution audit scored ${attribution.scored_evidence_count} rows, but graph currently has ${scoredEvidence.length} scored rows.`
      )
    );
  }
  const firstPartyHighPriorityReviews = attribution.first_party_social_review_priority_counts?.high ?? 0;
  if (firstPartyHighPriorityReviews > 0) {
    findings.push(
      finding(
        "low",
        "attribution.first_party_social_review_queue",
        `${firstPartyHighPriorityReviews} high-priority first-party social posts need off-topic review before founder/social weighting is increased.`,
        attribution.first_party_social_review?.filter((item) => item.reviewPriority === "high").slice(0, 10)
      )
    );
  }

  return findings;
}

function duplicateFindings(evidence, duplicates) {
  const findings = [];
  const postKeys = new Map();

  for (const item of evidence) {
    const key = canonicalPostKey(item);
    if (!key) continue;
    postKeys.set(key, [...(postKeys.get(key) ?? []), item]);
  }

  const scoredMultiCompany = [...postKeys.values()].filter((rows) => {
    const companies = new Set(rows.filter((row) => row.contributionScore > 0).map((row) => row.attachedCompanyId ?? row.entityId));
    return companies.size > 1;
  });

  if ((duplicates?.duplicate_group_count ?? duplicates?.duplicateGroups ?? 0) > 0) {
    findings.push(finding("high", "duplicates.exact_groups", "Exact duplicate evidence groups remain in duplicate report."));
  }
  if ((duplicates?.duplicate_account_group_count ?? duplicates?.duplicateAccountGroups ?? 0) > 0) {
    findings.push(finding("medium", "duplicates.account_groups", "Duplicate social account attachments remain in duplicate report."));
  }
  if (scoredMultiCompany.length) {
    findings.push(finding("critical", "duplicates.scored_post_cross_company", `${scoredMultiCompany.length} scored canonical posts are attached to multiple companies.`, scoredMultiCompany.slice(0, 10).map((rows) => rows.map(exampleRow))));
  }

  return findings;
}

function nearDuplicateFindings(evidence) {
  const scoredRows = evidence.filter((item) => item.contributionScore > 0);
  const byFingerprint = new Map();

  for (const item of scoredRows) {
    const fp = textFingerprint(item.text);
    if (!fp || fp.length < 28) continue;
    byFingerprint.set(fp, [...(byFingerprint.get(fp) ?? []), item]);
  }

  const crossCompanyNearDuplicates = [...byFingerprint.values()].filter((rows) => {
    const platforms = new Set(rows.map((row) => row.platform));
    const companies = new Set(rows.map((row) => row.attachedCompanyId ?? row.entityId));
    return rows.length > 1 && companies.size > 1 && platforms.size <= 2;
  });

  if (crossCompanyNearDuplicates.length) {
    return [
      finding(
        "high",
        "near_duplicates.cross_company_scored",
        `${crossCompanyNearDuplicates.length} near-duplicate scored text groups span multiple companies.`,
        crossCompanyNearDuplicates.slice(0, 10).map((rows) => rows.map(exampleRow))
      )
    ];
  }

  return [];
}

function scoreInflationFindings(graph, evidenceById) {
  const findings = [];
  const sparseHigh = graph.nodes
    .filter((node) => node.entityType === "company" && node.score >= 70)
    .map((node) => ({
      node,
      scoredEvidence: (node.evidenceIds ?? []).map((id) => evidenceById.get(id)).filter((item) => item?.contributionScore > 0)
    }))
    .filter(({ scoredEvidence }) => scoredEvidence.length <= 2);
  const onePlatformHigh = graph.nodes
    .filter((node) => node.entityType === "company" && node.score >= 80)
    .filter((node) => Object.values(node.platformScores ?? {}).filter((score) => Number(score) > 0).length <= 1);
  const zeroContributionLeaderboard = (graph.leaderboard ?? []).filter((row) => row.biggestContribution && row.biggestContribution.contributionScore <= 0);

  if (sparseHigh.length) {
    findings.push(finding("medium", "scoring.high_score_sparse_evidence", `${sparseHigh.length} high-score companies have two or fewer scored rows.`, sparseHigh.slice(0, 10).map(({ node, scoredEvidence }) => ({ company: node.label, score: node.score, rows: scoredEvidence.length }))));
  }
  if (onePlatformHigh.length) {
    findings.push(finding("medium", "scoring.high_score_one_platform", `${onePlatformHigh.length} high-score companies are dominated by one platform.`, onePlatformHigh.slice(0, 10).map((node) => ({ company: node.label, score: node.score, platformScores: node.platformScores }))));
  }
  if (zeroContributionLeaderboard.length) {
    findings.push(finding("critical", "ui.leaderboard_zero_contribution", `${zeroContributionLeaderboard.length} leaderboard rows show zero-score biggest contribution.`, zeroContributionLeaderboard.slice(0, 10)));
  }

  return findings;
}

function coverageFindings(coverage) {
  const findings = [];
  if (!coverage) {
    return [finding("high", "coverage.report_missing", "Coverage report output is missing.")];
  }

  const instagram = coverage.platform_coverage?.find((row) => row.platform === "instagram");
  const x = coverage.platform_coverage?.find((row) => row.platform === "x");
  const productHunt = coverage.platform_coverage?.find((row) => row.platform === "product_hunt");

  const xScoredCompanies = x?.companies_with_scored_evidence ?? 0;
  const xEvidenceCompanies = x?.companies_with_evidence ?? 0;
  if (xScoredCompanies < 125) {
    findings.push(finding("medium", "coverage.x_regression", `X scored company coverage dropped below 125: ${xScoredCompanies}.`));
  } else if (xScoredCompanies < 130 && xEvidenceCompanies >= 130) {
    findings.push(
      finding(
        "low",
        "coverage.x_strict_attribution_gap",
        `X has evidence for ${xEvidenceCompanies} companies, with ${xScoredCompanies} still scoring after stricter attribution guards.`
      )
    );
  }
  if ((instagram?.companies_with_scored_evidence ?? 0) <= 1) {
    findings.push(finding("low", "coverage.instagram_sparse", "Instagram remains sparse; only verified HeyClicky evidence is currently scored."));
  }
  if ((productHunt?.companies_with_scored_evidence ?? 0) === 0) {
    findings.push(finding("low", "coverage.product_hunt_empty", "Product Hunt has no scored evidence; needs reviewed verified launch URLs."));
  }

  return findings;
}

function performanceFindings(graph) {
  const findings = [];
  const timingNote =
    graph.timingsMs.length > 1
      ? ` Samples: ${graph.timingsMs.map((value) => `${Math.round(value)}ms`).join(", ")}; using the best warmed sample.`
      : "";
  if (graph.elapsedMs > 5_000) {
    findings.push(finding("high", "performance.graph_api_slow", `Graph API took ${Math.round(graph.elapsedMs)}ms.${timingNote}`));
  } else if (graph.elapsedMs > 2_000) {
    findings.push(finding("medium", "performance.graph_api_slowish", `Graph API took ${Math.round(graph.elapsedMs)}ms; watch as evidence grows.${timingNote}`));
  }
  if (graph.bytes > 15_000_000) {
    findings.push(finding("medium", "performance.graph_payload_large", `Graph API payload is ${graph.bytes} bytes.`));
  }
  return findings;
}

function observabilityFindings(outputs) {
  const findings = [];
  for (const [name, value] of Object.entries(outputs)) {
    if (!value) {
      findings.push(finding("medium", `observability.${name}_missing`, `${name} output is missing.`));
    }
  }
  if (outputs.attributionLoop?.status !== "running" && outputs.attributionLoop?.status !== "finished") {
    findings.push(finding("medium", "observability.attribution_loop_not_running", "Attribution feedback loop is not currently running or finished."));
  }
  if (outputs.instagram?.summary?.overall_status === "needs_attention") {
    findings.push(finding("low", "instagram.doctor_needs_attention", "Instagram doctor still needs explicit reusable session config for browser probe."));
  }
  return findings;
}

async function writeMarkdown(report) {
  const lines = [
    "# Quality Audit",
    "",
    "## Latest Run",
    "",
    `- Generated at: ${report.generated_at}.`,
    `- Status: ${report.summary.status}.`,
    `- Findings: ${report.summary.critical} critical, ${report.summary.high} high, ${report.summary.medium} medium, ${report.summary.low} low, ${report.summary.info} info.`,
    `- Company nodes: ${report.metrics.company_nodes}; founder nodes: ${report.metrics.founder_nodes}.`,
    `- Evidence rows: ${report.metrics.evidence_rows}; scored evidence rows: ${report.metrics.scored_evidence_rows}.`,
    `- Graph API: ${report.metrics.graph_api_ms}ms, ${report.metrics.graph_payload_bytes} bytes.`,
    `- Graph API samples: ${report.metrics.graph_api_timings_ms.join("ms, ")}ms.`,
    `- Attribution loop: ${report.metrics.attribution_loop_status}, elapsed ${report.metrics.attribution_loop_elapsed_minutes ?? "n/a"} minutes.`,
    "",
    "## Findings",
    "",
    ...(report.findings.length ? report.findings.map(markdownFinding) : ["- None."]),
    "",
    "## Notes",
    "",
    "- Critical findings should block score publication.",
    "- `--strict` exits non-zero for critical, high, or medium findings.",
    "- High findings should be resolved before expanding ingestion.",
    "- Low coverage findings are tracked but expected while platform discovery is intentionally conservative.",
    "",
    "Machine-readable output: `outputs/quality-audit-latest.json`.",
    ""
  ];
  await fs.mkdir("docs", { recursive: true });
  await fs.writeFile(path.join("docs", "QUALITY_AUDIT.md"), lines.join("\n"));
}

function markdownFinding(item) {
  const sampleText = item.examples?.length ? ` Examples: ${formatFindingExamples(item.examples)}.` : "";
  return `- [${item.severity}] ${item.id}: ${item.message}${sampleText}`;
}

function formatFindingExamples(examples) {
  return examples
    .slice(0, 3)
    .map((item) => {
      if (Array.isArray(item)) {
        return item.slice(0, 2).map(formatFindingExample).join(" / ");
      }
      return formatFindingExample(item);
    })
    .join(" | ");
}

function formatFindingExample(item) {
  const company = item.company ?? item.attachedCompanyName ?? item.companyName ?? item.attachedCompanyId ?? item.entityId ?? "unknown";
  const platform = item.platform ? `${item.platform} ` : "";
  const title = item.title ?? item.text ?? item.reviewReason ?? "";
  const url = item.url ?? item.sourceUrl ?? "";
  return `${company}: ${platform}${truncateInline(title, 90)}${url ? ` (${url})` : ""}`;
}

function finding(severity, id, message, examples = []) {
  return { severity, id, message, examples };
}

function examples(rows) {
  return rows.slice(0, 10).map(exampleRow);
}

function exampleRow(item) {
  return {
    id: item.id,
    company: item.attachedCompanyName ?? item.companyName ?? item.attachedCompanyId ?? item.entityId,
    platform: item.platform,
    score: item.contributionScore,
    url: item.sourceUrl,
    text: String(item.text ?? "").replace(/\s+/g, " ").slice(0, 120)
  };
}

function truncateInline(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function canonicalPostKey(item) {
  if (item.platformPostId) return `${item.platform}:post:${String(item.platformPostId).toLowerCase()}`;
  if (!item.sourceUrl) return "";
  try {
    const url = new URL(item.sourceUrl);
    url.hash = "";
    url.search = "";
    url.hostname = url.hostname.replace(/^www\./, "").toLowerCase();
    if (["twitter.com", "mobile.twitter.com"].includes(url.hostname)) url.hostname = "x.com";
    return `${item.platform}:url:${url.toString().replace(/\/$/, "").toLowerCase()}`;
  } catch {
    return "";
  }
}

function isProfileOrContextOnlyEvidence(item) {
  const why = `${item.why ?? ""}`;
  if (/Stored as context only|identity context|Profile pages are not counted as post-level traction/i.test(why)) {
    return true;
  }

  if (!["x", "instagram", "linkedin"].includes(item.platform)) {
    return false;
  }

  if (item.platformPostId) {
    return false;
  }

  try {
    const url = new URL(item.sourceUrl);
    const pathAndHash = `${url.pathname}${url.hash}`.toLowerCase();
    if (item.platform === "x") {
      return !/\/status\/\d+/.test(pathAndHash);
    }
    if (item.platform === "instagram") {
      return !(/^\/(p|reel|tv)\//.test(pathAndHash) || /#post-\d+/.test(pathAndHash));
    }
    if (item.platform === "linkedin") {
      return !/\/feed\/update\/|\/posts\/|\/recent-activity\/all\/#post-/.test(pathAndHash);
    }
  } catch {
    return true;
  }

  return false;
}

function textFingerprint(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((token) => token.length > 2)
    .slice(0, 28)
    .join(" ");
}

function validUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function severityRank(severity) {
  return { critical: 4, high: 3, medium: 2, low: 1, info: 0 }[severity] ?? 0;
}

async function timedFetchJson(url, { samples = 1 } = {}) {
  const attempts = [];

  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    const response = await fetch(url, { cache: "no-store" });
    const text = await response.text();
    const elapsedMs = performance.now() - started;
    if (!response.ok) {
      throw new Error(`Graph API failed with ${response.status}`);
    }
    attempts.push({
      payload: JSON.parse(text),
      elapsedMs,
      bytes: Buffer.byteLength(text)
    });
  }

  const best = attempts.reduce((winner, attempt) => (attempt.elapsedMs < winner.elapsedMs ? attempt : winner), attempts[0]);
  return {
    ...best,
    timingsMs: attempts.map((attempt) => attempt.elapsedMs)
  };
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function argValue(name) {
  const equalsValue = process.argv.find((arg) => arg.startsWith(`${name}=`))?.split("=").slice(1).join("=");
  if (equalsValue !== undefined) return equalsValue;
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function booleanArg(name) {
  return process.argv.includes(name) || process.argv.some((arg) => arg === `${name}=true`);
}

function integerArg(name, fallback, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = argValue(name);
  const parsed = raw === undefined ? fallback : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}
