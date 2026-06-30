import fs from "node:fs/promises";
import path from "node:path";

const apiUrl = process.env.GRAPH_API_URL ?? "http://127.0.0.1:3001/api/graph?batch=S2026&includeNonScoring=1";

const [graph, companies, overrides, discovery, publicEvidence, loggedInEvidence, targetedEvidence] = await Promise.all([
  fetchJson(apiUrl),
  readJson(path.join("src", "lib", "yc", "spring-2026-companies.json"), { companies: [] }),
  readJson(path.join("src", "lib", "social", "verified-social-overrides.json"), {}),
  readJson(path.join("outputs", "instagram-discovery-candidates.json"), null),
  readJson(path.join("src", "lib", "social", "public-evidence-current.json"), {}),
  readJson(path.join("src", "lib", "social", "logged-in-evidence-current.json"), {}),
  readJson(path.join("src", "lib", "social", "targeted-evidence-current.json"), {})
]);

const report = buildInstagramCoverageReport({
  graph,
  companies: companies.companies ?? [],
  overrides,
  snapshots: [publicEvidence, loggedInEvidence, targetedEvidence],
  discovery
});

await fs.mkdir("outputs", { recursive: true });
await fs.writeFile(path.join("outputs", "instagram-coverage-debug-s2026.json"), JSON.stringify(report, null, 2));
await updateDocs(report);

console.log(
  JSON.stringify(
    {
      outputPath: "outputs/instagram-coverage-debug-s2026.json",
      companies: report.companyCount,
      verifiedCompanyOverrides: report.profiles.verifiedCompanyOverrides,
      verifiedFounderOverrides: report.profiles.verifiedFounderOverrides,
      instagramEvidenceRows: report.evidence.rows,
      companiesWithScoredInstagram: report.evidence.companiesWithScoredEvidence,
      missingCompanies: report.missingCompanies.length
    },
    null,
    2
  )
);

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

function buildInstagramCoverageReport(input) {
  const evidence = input.graph.evidence.filter((item) => item.platform === "instagram");
  const scored = evidence.filter((item) => item.contributionScore > 0);
  const ownerByEvidenceId = ownerIndex(input.graph);
  const companyIdsWithEvidence = new Set(evidence.map((item) => ownerByEvidenceId.get(item.id)).filter(Boolean));
  const companyIdsWithScored = new Set(scored.map((item) => ownerByEvidenceId.get(item.id)).filter(Boolean));
  const candidates = input.discovery?.candidates ?? [];
  const attempts = input.discovery?.attempts ?? [];

  return {
    generatedAt: new Date().toISOString(),
    companyCount: input.companies.length,
    rootCause: rootCauseFindings(input, evidence),
    profiles: {
      snapshotCompanyProfiles: input.companies.filter((company) => company.socialLinks?.instagram).length,
      snapshotFounderProfiles: input.companies.flatMap((company) => company.founders ?? []).filter((founder) => founder.socialLinks?.instagram).length,
      verifiedCompanyOverrides: Object.values(input.overrides).filter((item) => item?.companySocialLinks?.instagram).length,
      verifiedFounderOverrides: Object.values(input.overrides).flatMap((item) => item?.founders ?? []).filter((founder) => founder?.socialLinks?.instagram).length,
      discoveredCandidates: candidates.length,
      needsReviewCandidates: candidates.filter((item) => item.review_state === "needs_review").length,
      rejectedCandidates: candidates.filter((item) => item.review_state === "rejected").length,
      failedCandidates: candidates.filter((item) => item.review_state === "failed").length,
      discoveryAttempts: attempts.length,
      noResultAttempts: attempts.filter((item) => item.status === "no_results").length,
      failedAttempts: attempts.filter((item) => item.status === "failed").length
    },
    evidence: {
      rows: evidence.length,
      scoredRows: scored.length,
      companiesWithEvidence: companyIdsWithEvidence.size,
      companiesWithScoredEvidence: companyIdsWithScored.size,
      postsWithThumbnails: evidence.filter((item) => item.thumbnailUrl).length,
      realThumbnailRows: evidence.filter((item) => item.thumbnailUrl && !isFallbackThumbnail(item.thumbnailUrl)).length,
      thumbnailSources: countBy(evidence, (item) => item.thumbnailSource ?? "none")
    },
    feedCompanies: input.graph.nodes
      .map((node) => {
        const rows = evidence.filter((item) => node.evidenceIds.includes(item.id));
        return {
          companyName: node.label,
          companyId: node.entityId,
          instagramRows: rows.length,
          scoredRows: rows.filter((item) => item.contributionScore > 0).length,
          thumbnailRows: rows.filter((item) => item.thumbnailUrl).length,
          topPostUrl: rows.sort((left, right) => right.contributionScore - left.contributionScore)[0]?.sourceUrl ?? null
        };
      })
      .filter((row) => row.instagramRows > 0)
      .sort((left, right) => right.scoredRows - left.scoredRows || left.companyName.localeCompare(right.companyName)),
    missingCompanies: input.graph.nodes
      .filter((node) => node.entityType === "company" && !companyIdsWithScored.has(node.entityId))
      .map((node) => ({
        companyName: node.label,
        companyId: node.entityId,
        reason: missingReason(node.entityId, input.overrides, candidates, attempts)
      }))
      .sort((left, right) => left.companyName.localeCompare(right.companyName)),
    attempts
  };
}

function rootCauseFindings(input, evidence) {
  const findings = [];
  if (!input.companies.some((company) => company.socialLinks?.instagram)) {
    findings.push("The YC Spring 2026 snapshot has zero company-level Instagram profile URLs.");
  }
  if (!input.companies.some((company) => (company.founders ?? []).some((founder) => founder.socialLinks?.instagram))) {
    findings.push("The YC Spring 2026 snapshot has zero founder-level Instagram profile URLs.");
  }
  const verifiedOverrideCount = Object.values(input.overrides).filter((item) => item?.companySocialLinks?.instagram).length;
  if (verifiedOverrideCount <= 1) {
    findings.push("Only one verified company Instagram override exists, so logged-in ingestion only has one company target.");
  }
  const hasBroadDiscovery =
    input.discovery?.searched_with_opencli ||
    input.discovery?.searched_with_web ||
    input.discovery?.attempts?.some((attempt) => attempt.source && attempt.source !== "official-website");
  if (input.discovery && !hasBroadDiscovery) {
    findings.push("The last Instagram discovery report did not run broad Instagram search; it only crawled official websites.");
  }
  if (new Set(evidence.map((item) => item.attachedCompanyName ?? item.entityId)).size <= 1) {
    findings.push("Current Instagram evidence is effectively attached to a single company feed.");
  }
  return findings;
}

function missingReason(companyId, overrides, candidates, attempts) {
  const slug = companyId.replace(/^company-/, "");
  if (overrides[slug]?.companySocialLinks?.instagram) {
    return "Verified Instagram profile exists but no scored Instagram post evidence is attached yet.";
  }
  if (candidates.some((candidate) => candidate.companySlug === slug && candidate.review_state === "needs_review")) {
    return "Instagram candidate exists but is still needs_review and does not count toward scoring.";
  }
  if (attempts.some((attempt) => attempt.companySlug === slug && attempt.status === "failed")) {
    return "Instagram discovery attempted and failed; see failure_reason.";
  }
  if (attempts.some((attempt) => attempt.companySlug === slug && attempt.status === "no_results")) {
    return "Instagram discovery attempted but found no useful profile candidates.";
  }
  return "No verified Instagram profile target is known yet.";
}

function ownerIndex(graph) {
  const result = new Map();
  for (const node of graph.nodes) {
    for (const evidenceId of node.evidenceIds ?? []) {
      result.set(evidenceId, node.entityId);
    }
  }
  return result;
}

function isFallbackThumbnail(url) {
  if (!url) return false;
  const normalized = url.toLowerCase();
  return normalized.endsWith(".svg") || normalized.includes("fallback") || normalized.includes("placeholder");
}

function countBy(items, getKey) {
  return items.reduce((counts, item) => {
    const key = getKey(item);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

async function updateDocs(report) {
  const lines = [
    "# Instagram Status",
    "",
    `Generated at: ${report.generatedAt}`,
    "",
    "## Coverage",
    "",
    `- Companies: ${report.companyCount}`,
    `- Snapshot company Instagram profiles: ${report.profiles.snapshotCompanyProfiles}`,
    `- Snapshot founder Instagram profiles: ${report.profiles.snapshotFounderProfiles}`,
    `- Verified company overrides: ${report.profiles.verifiedCompanyOverrides}`,
    `- Verified founder overrides: ${report.profiles.verifiedFounderOverrides}`,
    `- Discovery candidates: ${report.profiles.discoveredCandidates}`,
    `- Needs review candidates: ${report.profiles.needsReviewCandidates}`,
    `- Discovery attempts: ${report.profiles.discoveryAttempts}`,
    `- Instagram evidence rows: ${report.evidence.rows}`,
    `- Scored Instagram rows: ${report.evidence.scoredRows}`,
    `- Companies with scored Instagram: ${report.evidence.companiesWithScoredEvidence}`,
    `- Instagram rows with thumbnails: ${report.evidence.postsWithThumbnails}`,
    "",
    "## Root Cause",
    "",
    ...report.rootCause.map((item) => `- ${item}`),
    "",
    "## Companies With Instagram Evidence",
    "",
    ...(report.feedCompanies.length
      ? report.feedCompanies.map((row) => `- ${row.companyName}: ${row.scoredRows} scored rows, ${row.thumbnailRows} thumbnails.`)
      : ["- None."]),
    "",
    "## Missing Examples",
    "",
    ...report.missingCompanies.slice(0, 40).map((row) => `- ${row.companyName}: ${row.reason}`),
    "",
    "## Resume Commands",
    "",
    "- `npm run instagram:discover -- --search --write --promote-search --promote-founder-search --workers=2`",
    "- `npm run ingest:instagram:all -- --batch=S2026 --workers=2 --delay-ms=2500`",
    "- `npm run thumbnails:backfill -- --platform=instagram --cache-instagram --force --limit=200 --delay-ms=1200`",
    "- `npm run debug:instagram-coverage`",
    ""
  ];
  await fs.mkdir("docs", { recursive: true });
  await fs.writeFile(path.join("docs", "INSTAGRAM_STATUS.md"), lines.join("\n"));
}
