import fs from "node:fs/promises";
import path from "node:path";

const apiUrl = process.env.GRAPH_API_URL ?? "http://127.0.0.1:3001/api/graph?batch=S2026&includeNonScoring=1";
const graph = await fetchJson(apiUrl);
const liveCheckpoint = summarizeLiveCheckpoint(await readJson(path.join("work", "public-traction-checkpoint.json"), null));
const loggedInSocial = summarizeLoggedInSocial(await readJson(path.join("src", "lib", "social", "logged-in-evidence-current.json"), null));
const loggedInCheckpoint = await readJson(path.join("work", "logged-in-social-checkpoint.json"), null);
const ycSnapshot = await readJson(path.join("src", "lib", "yc", "spring-2026-companies.json"), null);
const verifiedSocialOverrides = await readJson(path.join("src", "lib", "social", "verified-social-overrides.json"), {});
const xTargetCoverage = summarizeXTargetCoverage(ycSnapshot, verifiedSocialOverrides, loggedInCheckpoint);
const instagramDiscovery = await readJson(path.join("outputs", "instagram-discovery-candidates.json"), null);
const platforms = ["github", "x", "linkedin", "instagram", "product_hunt", "youtube", "rss", "web", "reddit", "hacker_news", "bilibili"];
const evidenceById = new Map(graph.evidence.map((item) => [item.id, item]));
const evidenceOwner = new Map();
for (const node of graph.nodes) {
  for (const evidenceId of node.evidenceIds ?? []) {
    evidenceOwner.set(evidenceId, node.entityId);
  }
}

const platformCoverage = platforms.map((platform) => {
  const rows = graph.evidence.filter((item) => item.platform === platform);
  const scored = rows.filter((item) => item.contributionScore > 0);
  return {
    platform,
    status: graph.platformStatus.find((item) => item.platform === platform)?.status ?? "queued",
    evidence_rows: rows.length,
    scored_rows: scored.length,
    companies_with_evidence: new Set(rows.map((item) => evidenceOwner.get(item.id)).filter(Boolean)).size,
    companies_with_scored_evidence: new Set(scored.map((item) => evidenceOwner.get(item.id)).filter(Boolean)).size,
    needs_review_rows: graph.needsReview.filter((item) => item.platform === platform).length
  };
});

const companyCoverage = graph.nodes.map((node) => {
  const evidence = (node.evidenceIds ?? []).map((id) => evidenceById.get(id)).filter(Boolean);
  const scored = evidence.filter((item) => item.contributionScore > 0);
  return {
    company_id: node.entityId,
    company_name: node.label,
    score: node.score,
    top_platform: node.topPlatform,
    evidence_rows: evidence.length,
    scored_rows: scored.length,
    non_github_scored_rows: scored.filter((item) => item.platform !== "github").length,
    scored_platforms: [...new Set(scored.map((item) => item.platform))].sort()
  };
});
const missingByPlatform = platforms
  .filter((platform) => !["web", "rss", "bilibili"].includes(platform))
  .map((platform) => {
    const rows = companyCoverage.filter((company) => !company.scored_platforms.includes(platform));
    return {
      platform,
      companies_missing_scored_evidence: rows.length,
      examples: rows
        .sort((a, b) => a.scored_rows - b.scored_rows || a.company_name.localeCompare(b.company_name))
        .slice(0, 12)
        .map((company) => company.company_name)
    };
  });

const report = {
  generated_at: new Date().toISOString(),
  api_url: apiUrl,
  company_count: graph.nodes.length,
  evidence_count: graph.evidence.length,
  non_github_scored_evidence_count: graph.evidence.filter(
    (item) => item.platform !== "github" && item.contributionScore > 0
  ).length,
  live_ingestion_checkpoint: liveCheckpoint,
  logged_in_social: loggedInSocial,
  x_target_coverage: xTargetCoverage,
  instagram_discovery: instagramDiscovery
    ? {
        companies_checked: instagramDiscovery.companies_checked,
        candidates: instagramDiscovery.candidates?.length ?? 0,
        newly_verified: instagramDiscovery.newly_verified_in_this_run,
        total_verified_company_instagram_profiles: instagramDiscovery.verified_company_instagram_profiles
      }
    : null,
  platform_coverage: platformCoverage,
  weakest_non_github_coverage: [...companyCoverage]
    .sort((a, b) => a.non_github_scored_rows - b.non_github_scored_rows || a.score - b.score)
    .slice(0, 75),
  missing_by_platform: missingByPlatform,
  next_target_companies: [...companyCoverage]
    .filter((company) => company.scored_rows === 0 || company.non_github_scored_rows === 0)
    .sort((a, b) => a.scored_rows - b.scored_rows || a.score - b.score)
    .slice(0, 25)
};

const outputPath = path.join("outputs", "coverage-debug-s2026.json");
await fs.mkdir("outputs", { recursive: true });
await fs.writeFile(outputPath, JSON.stringify(report, null, 2));
await updateCoverageDocs(report);
console.log(JSON.stringify({ outputPath, companyCount: report.company_count, evidenceCount: report.evidence_count }, null, 2));

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Graph API failed with ${response.status}`);
  }
  return response.json();
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function summarizeLiveCheckpoint(checkpoint) {
  if (!checkpoint) return null;
  return {
    evidence_rows: checkpoint.evidence?.length ?? 0,
    needs_review_rows: checkpoint.needsReview?.length ?? 0,
    failure_rows: checkpoint.failures?.length ?? 0,
    discovery_attempt_rows: checkpoint.discoveryAttempts?.length ?? 0,
    source_discovery_path_rows: checkpoint.sourceDiscoveryPaths?.length ?? 0,
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
    )
  };
}

function summarizeXTargetCoverage(snapshot, overrides, checkpoint) {
  if (!snapshot || !checkpoint) return null;
  const targets = collectXTargets(snapshot.companies ?? [], overrides ?? {});
  const attempts = checkpoint.attempts ?? {};
  const evidence = checkpoint.evidence ?? [];
  const evidenceCompanies = new Set(evidence.filter((row) => row.platform === "x").map((row) => row.companySlug).filter(Boolean));
  const targetsWithAttempts = targets.map((target) => {
    const attempt = attempts[target.key] ?? null;
    return {
      ...target,
      status: attempt?.status ?? "not_attempted",
      count: attempt?.count ?? null,
      error: attempt?.error ?? null
    };
  });
  const companiesWithTargets = new Set(targets.map((target) => target.companySlug));
  const companiesAttempted = new Set(targetsWithAttempts.filter((target) => target.status !== "not_attempted").map((target) => target.companySlug));
  const companiesWithZeroOnly = [...companiesAttempted].filter(
    (slug) =>
      targetsWithAttempts.some((target) => target.companySlug === slug && target.status === "done") &&
      !evidenceCompanies.has(slug)
  );

  return {
    known_x_targets: targets.length,
    companies_with_known_x_targets: companiesWithTargets.size,
    attempted_targets: targetsWithAttempts.filter((target) => target.status !== "not_attempted").length,
    not_attempted_targets: targetsWithAttempts.filter((target) => target.status === "not_attempted").length,
    zero_post_targets: targetsWithAttempts.filter((target) => target.status === "done" && target.count === 0).length,
    failed_targets: targetsWithAttempts.filter((target) => target.status === "failed").length,
    companies_with_x_evidence: evidenceCompanies.size,
    companies_with_known_x_but_no_evidence: [...companiesWithTargets].filter((slug) => !evidenceCompanies.has(slug)).length,
    companies_with_zero_only: companiesWithZeroOnly.length,
    examples_not_attempted: targetsWithAttempts
      .filter((target) => target.status === "not_attempted")
      .slice(0, 12)
      .map((target) => `${target.companyName} / ${target.entityName}`),
    examples_zero_post: targetsWithAttempts
      .filter((target) => target.status === "done" && target.count === 0)
      .slice(0, 12)
      .map((target) => `${target.companyName} / ${target.entityName}`),
    examples_failed: targetsWithAttempts
      .filter((target) => target.status === "failed")
      .slice(0, 12)
      .map((target) => `${target.companyName} / ${target.entityName}: ${target.error}`)
  };
}

function collectXTargets(companies, overrides) {
  const targets = [];
  for (const company of companies) {
    if (company.socialLinks?.x) {
      targets.push(xTarget(company, company, "company", company.socialLinks.x, companyId(company)));
    }
    for (const founder of company.founders ?? []) {
      if (founder.socialLinks?.x) {
        targets.push(xTarget(company, founder, "founder", founder.socialLinks.x, founderId(company, founder)));
      }
    }
    const override = overrides[company.slug] ?? {};
    if (override.companySocialLinks?.x) {
      targets.push(xTarget(company, company, "company", override.companySocialLinks.x, companyId(company)));
    }
    for (const founder of override.founders ?? []) {
      if (founder.socialLinks?.x) {
        targets.push(xTarget(company, founder, "founder", founder.socialLinks.x, manualFounderId(company, founder)));
      }
    }
  }
  return [...new Map(targets.map((target) => [target.key, target])).values()];
}

function xTarget(company, entity, entityType, url, entityId) {
  return {
    companySlug: company.slug,
    companyName: company.name,
    entityType,
    entityName: entityType === "company" ? company.name : entity.name,
    url,
    key: `x:${entityId}:${url}`
  };
}

function countBy(items, getKey) {
  return items.reduce((counts, item) => {
    const key = getKey(item);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function companyId(company) {
  return `company-${company.slug}`;
}

function founderId(company, founder) {
  return `founder-${company.slug}-${slugify(founder.name)}-${founder.id}`;
}

function manualFounderId(company, founder) {
  return `founder-${company.slug}-${slugify(founder.name)}-${founder.id}`;
}

function slugify(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function updateCoverageDocs(report) {
  const lines = [
    "# Coverage Report",
    "",
    "## Latest Snapshot",
    "",
    `- Generated at: ${report.generated_at}.`,
    `- Graph nodes: ${report.company_count} company nodes.`,
    "- Founder graph nodes: 0.",
    `- Evidence rows: ${report.evidence_count}.`,
    `- Non-GitHub scored evidence rows: ${report.non_github_scored_evidence_count}.`,
    report.live_ingestion_checkpoint
      ? `- Live ingestion checkpoint: ${report.live_ingestion_checkpoint.evidence_rows} evidence rows, ${report.live_ingestion_checkpoint.needs_review_rows} needs-review rows, ${report.live_ingestion_checkpoint.failure_rows} failures, ${report.live_ingestion_checkpoint.discovery_attempt_rows} discovery attempts.`
      : "- Live ingestion checkpoint: not available.",
    report.logged_in_social
      ? `- Logged-in read-only social artifact: ${report.logged_in_social.evidence_rows} evidence rows, platform rows ${JSON.stringify(report.logged_in_social.platform_rows)}, companies by platform ${JSON.stringify(report.logged_in_social.companies_by_platform)}.`
      : "- Logged-in read-only social artifact: not available.",
    report.x_target_coverage
      ? `- X target coverage: ${report.x_target_coverage.known_x_targets} known X targets across ${report.x_target_coverage.companies_with_known_x_targets} companies; ${report.x_target_coverage.attempted_targets} attempted, ${report.x_target_coverage.not_attempted_targets} not yet attempted, ${report.x_target_coverage.zero_post_targets} zero-post, ${report.x_target_coverage.companies_with_x_evidence} companies with X evidence.`
      : "- X target coverage: not available.",
    report.instagram_discovery
      ? `- Instagram discovery: ${report.instagram_discovery.companies_checked} companies checked, ${report.instagram_discovery.candidates} candidates, ${report.instagram_discovery.newly_verified} newly verified, ${report.instagram_discovery.total_verified_company_instagram_profiles} total verified company Instagram profiles.`
      : "- Instagram discovery: not run.",
    "",
    "## Platform Coverage",
    "",
    ...report.platform_coverage.map(
      (row) =>
        `- ${row.platform}: ${row.evidence_rows} evidence rows, ${row.scored_rows} scored rows, ${row.companies_with_evidence} companies with evidence, ${row.companies_with_scored_evidence} companies with scored evidence, ${row.needs_review_rows} needs-review candidates, status ${row.status}.`
    ),
    "",
    "## Known Coverage Gaps",
    "",
    "- Instagram direct public profile pages are still login-walled/blocking direct public post enumeration. The authenticated OpenCLI read-only scraper works once a profile is verified, but broad coverage still depends on verified Instagram handles.",
    "- X public profile links are discovered as identity context; logged-in read-only OpenCLI timeline parsing now stores visible post metrics for known YC-linked X accounts.",
    "- Product Hunt currently produces needs-review candidates until both company name and official domain can be verified.",
    "- Reddit is frequently blocked or empty from unauthenticated public access.",
    "- LinkedIn logged-in access is disabled for this run. Public LinkedIn search candidates are rejected from scoring unless the post author matches a known YC-linked company/founder LinkedIn handle.",
    "",
    "## X Target Coverage",
    "",
    ...(report.x_target_coverage
      ? [
          `- Known X targets: ${report.x_target_coverage.known_x_targets}.`,
          `- Companies with known X targets: ${report.x_target_coverage.companies_with_known_x_targets}/197.`,
          `- Attempted X targets: ${report.x_target_coverage.attempted_targets}.`,
          `- Not yet attempted X targets: ${report.x_target_coverage.not_attempted_targets}.`,
          `- Zero-post X targets: ${report.x_target_coverage.zero_post_targets}.`,
          `- Failed X targets: ${report.x_target_coverage.failed_targets}.`,
          `- Companies with X evidence: ${report.x_target_coverage.companies_with_x_evidence}.`,
          `- Companies with known X but no evidence: ${report.x_target_coverage.companies_with_known_x_but_no_evidence}.`,
          `- Not-yet-attempted examples: ${report.x_target_coverage.examples_not_attempted.join(", ") || "none"}.`,
          `- Zero-post examples: ${report.x_target_coverage.examples_zero_post.join(", ") || "none"}.`,
          `- Failed examples: ${report.x_target_coverage.examples_failed.join(", ") || "none"}.`
        ]
      : ["- X target checkpoint not available."]),
    "",
    "## Live Ingestion Platform Rows",
    "",
    ...(report.live_ingestion_checkpoint
      ? [
          `- Evidence: ${JSON.stringify(report.live_ingestion_checkpoint.platform_rows.evidence)}.`,
          `- Needs review: ${JSON.stringify(report.live_ingestion_checkpoint.platform_rows.needs_review)}.`,
          `- Failures: ${JSON.stringify(report.live_ingestion_checkpoint.platform_rows.failures)}.`
        ]
      : ["- No live checkpoint file found."]),
    "",
    "## Platform Backlog",
    "",
    ...report.missing_by_platform.map(
      (row) =>
        `- ${row.platform}: ${row.companies_missing_scored_evidence} companies missing scored evidence. Examples: ${row.examples.join(", ")}.`
    ),
    "",
    "## Next Target Companies",
    "",
    ...report.next_target_companies.map(
      (row) =>
        `- ${row.company_name}: ${row.scored_rows} scored rows, ${row.non_github_scored_rows} non-GitHub scored rows, scored platforms ${row.scored_platforms.join(", ") || "none"}.`
    ),
    "",
    "## Reports",
    "",
    "- Coverage JSON: `outputs/coverage-debug-s2026.json`",
    "- Worker JSON: `outputs/workers-debug-s2026.json`",
    "- Duplicate JSON: `outputs/duplicates-debug-s2026.json`",
    ""
  ];
  await fs.writeFile(path.join("docs", "COVERAGE_REPORT.md"), lines.join("\n"));
}
