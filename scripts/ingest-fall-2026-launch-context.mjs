import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const write = process.argv.includes("--write");
const readJson = async (file) => JSON.parse(await readFile(resolve(root, file), "utf8"));
const catalog = await readJson("src/lib/yc/fall-2026-companies.json");
const archive = await readJson("outputs/source-hunt/2026-11-15-fall-2026-web-context.json");
const targetPath = resolve(root, "src/lib/social/targeted-evidence-current.json");
const targetBytes = await readFile(targetPath, "utf8");
const target = JSON.parse(targetBytes);
const observedAt = archive.source.observedAt;
const observedMs = Date.parse(observedAt);
if (!Number.isFinite(observedMs)) throw new Error("Archive must have an explicit observation timestamp.");
const companies = new Map(catalog.companies.map((company) => [company.slug, company]));
const additions = [];
const knownIds = new Set(target.evidence.map((row) => row.id));
const existingById = new Map(target.evidence.map((row) => [row.id, row]));
const canonicalIdentityRepairs = new Map();
let duplicates = 0;
for (const entry of archive.companies) {
  const company = companies.get(entry.companySlug);
  if (!company || company.name !== entry.companyName || company.ycProfileUrl !== entry.sourceUrl) {
    throw new Error(`Unresolved official company: ${entry.companySlug}`);
  }
  for (const launch of entry.launches) {
    const url = new URL(launch.ycdc_launch_url ?? launch.url);
    const publishedMs = Date.parse(launch.created_at);
    if (url.origin !== "https://www.ycombinator.com" || !url.pathname.startsWith("/launches/") ||
      launch.state !== "public" || !Number.isSafeInteger(launch.id) ||
      !Number.isFinite(publishedMs) || publishedMs > observedMs ||
      typeof launch.body !== "string" || !launch.body.trim()) {
      throw new Error(`Invalid public launch: ${entry.companySlug}/${launch.id}`);
    }
    const id = `web-f26-yc-launch-${launch.id}`;
    if (knownIds.has(id)) {
      const existing = existingById.get(id);
      if (existing?.platformPostId === `yc-launch-${launch.id}`) {
        if (existing.batchSlug !== "F26" || existing.platform !== "web" ||
          existing.entityType !== "company" || existing.entityId !== `company-${company.slug}` ||
          existing.attributionProvenance !== "official_yc_launch_context_v1" ||
          existing.sourceUrl !== url.href || existing.text !== launch.body || existing.originalText !== launch.body ||
          existing.contributionScore !== 0 || Object.keys(existing.metrics ?? {}).length > 0) {
          throw new Error(`Conflicting existing launch context identity: ${id}`);
        }
        canonicalIdentityRepairs.set(id, { ...existing, platformPostId: url.href });
      }
      duplicates += 1;
      continue;
    }
    knownIds.add(id);
    additions.push({
      id, batchSlug: "F26", entityType: "company", entityId: `company-${company.slug}`,
      companySlug: company.slug, companyName: company.name, platform: "web",
      title: launch.title, text: launch.body, originalText: launch.body,
      sourceUrl: url.href, platformPostId: url.href,
      authorName: launch.authorName ?? null, authorHandle: null,
      accountUrl: company.ycProfileUrl, postedAt: launch.created_at,
      publishedAtPrecision: "exact", metrics: {}, contributionScore: 0,
      tractionStatus: "unscored", tractionLimitations: ["YC launch context; no supported native social engagement metrics."],
      rawVisibleText: JSON.stringify({
        source: "official_yc_launch_context_v1", officialYcProfileUrl: company.ycProfileUrl,
        sourceHtmlSha256: entry.sourceHtmlSha256, launch,
        scoringEligible: false
      }),
      linkStatus: "verified", linkCheckedAt: observedAt, review_state: "verified",
      attributionVersion: 3, attributionStatus: "verified", attributionMode: "subject",
      attributionProvenance: "official_yc_launch_context_v1",
      attributionSignals: ["official_yc_company_launch_object"],
      matchReason: "Public launch object attached to the company's official YC profile. Preserved as context with zero traction score.",
      first_seen_at: observedAt, last_checked_at: observedAt, last_updated_at: observedAt
    });
  }
}
const audit = {
  status: write ? "written" : "dry_run", batchSlug: "F26", observedAt,
  source: "outputs/source-hunt/2026-11-15-fall-2026-web-context.json",
  target: "src/lib/social/targeted-evidence-current.json",
  archiveSha256: createHash("sha256").update(JSON.stringify(archive)).digest("hex"),
  previousTargetSha256: createHash("sha256").update(targetBytes).digest("hex"),
  received: additions.length + duplicates, added: additions.length, duplicates,
  canonicalIdentityRepairs: canonicalIdentityRepairs.size,
  before: target.evidence.length, after: target.evidence.length + additions.length,
  companiesWithLaunches: archive.companies.filter((entry) => entry.launches.length).length,
  scoringEligible: false
};
const sourceNeedsRefresh = !Number.isFinite(Date.parse(target.source?.fetchedAt)) || Date.parse(target.source.fetchedAt) < observedMs;
if (write && (additions.length || sourceNeedsRefresh || canonicalIdentityRepairs.size)) {
  // Do not update any existing row or replace ledgers owned by other collectors.
  if (await readFile(targetPath, "utf8") !== targetBytes) throw new Error("Target changed during ingestion.");
  const next = {
    ...target,
    source: {
      ...target.source,
      fetchedAt: sourceNeedsRefresh ? observedAt : target.source.fetchedAt,
      evidenceCount: target.evidence.length + additions.length
    },
    evidence: [...target.evidence.map((row) => canonicalIdentityRepairs.get(row.id) ?? row), ...additions]
  };
  const temporary = `${targetPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`);
  await rename(temporary, targetPath);
}
await writeFile(resolve(root, `outputs/fall-2026/launch-context-${write ? "write" : "dry-run"}-audit.json`), `${JSON.stringify(audit, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(audit)}\n`);
