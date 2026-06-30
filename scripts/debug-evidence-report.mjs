import fs from "node:fs/promises";
import path from "node:path";

const apiUrl =
  process.env.GRAPH_API_URL ?? "http://127.0.0.1:3001/api/graph?batch=S2026&includeNonScoring=1&includeWhy=1";
const companyName = argValue("--company") ?? positionalValue(0) ?? "Runtime";
const graph = await fetchJson(apiUrl);
const company = graph.nodes.find(
  (node) => node.entityType === "company" && node.label.toLowerCase() === companyName.toLowerCase()
);

if (!company) {
  throw new Error(`Company not found: ${companyName}`);
}

const allowedEvidenceIds = new Set(company.evidenceIds);
for (const founder of graph.nodes.filter(
  (node) => node.entityType === "founder" && company.relatedEntityIds.includes(node.entityId)
)) {
  for (const evidenceId of founder.evidenceIds) {
    allowedEvidenceIds.add(evidenceId);
  }
}

const rows = graph.evidence
  .filter((item) => allowedEvidenceIds.has(item.id))
  .sort((left, right) => right.contributionScore - left.contributionScore)
  .map((item) => ({
    post_id: item.id,
    post_url: item.sourceUrl,
    platform: item.platform,
    score: item.contributionScore,
    raw_engagement: item.rawEngagement ?? 0,
    normalized_score: item.normalizedScore ?? item.contributionScore,
    attached_company_id: item.attachedCompanyId ?? "",
    attached_company_name: item.attachedCompanyName ?? "",
    entity_id: item.entityId,
    social_account_id: item.socialAccountId ?? "",
    account_url: item.accountUrl ?? "",
    match_reason: item.matchReason ?? item.why,
    review_state: item.review_state ?? "verified"
  }));

const smolLeakCount = rows.filter((row) => /smol machines/i.test(`${row.attached_company_name} ${row.post_id}`)).length;
const report = {
  generated_at: new Date().toISOString(),
  api_url: apiUrl,
  company: {
    id: company.entityId,
    name: company.label,
    score: company.score,
    related_founder_ids: company.relatedEntityIds
  },
  evidence_count: rows.length,
  smol_machines_leak_count: smolLeakCount,
  rows
};

const outputPath = path.join("outputs", `evidence-debug-${slug(company.label)}.json`);
await fs.mkdir("outputs", { recursive: true });
await fs.writeFile(outputPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ outputPath, evidenceCount: rows.length, smolLeakCount }, null, 2));

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
