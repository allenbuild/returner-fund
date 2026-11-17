import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { load } from "cheerio";
import { officialWebsiteArticleContextReasons } from "../src/lib/graph/official-website-context-receipt.mjs";

const args = process.argv.slice(2);
const value = (name, fallback) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
const write = args.includes("--write");
if (write === args.includes("--dry-run")) throw new Error("Pass exactly one of --write or --dry-run.");
const inputPath = value("--input", "outputs/source-hunt/2026-11-15-fall-2026-public-history-context.json");
const output = value("--output", `outputs/fall-2026/collection/website-context-${Date.now()}`);
const targetPath = value("--target", "src/lib/social/targeted-evidence-current.json");
const cacheRoot = resolve("outputs/fall-2026/public-history-cache");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const [inputText, beforeText, catalog] = await Promise.all([readFile(inputPath, "utf8"), readFile(targetPath, "utf8"), readJson("src/lib/yc/fall-2026-companies.json")]);
const input = JSON.parse(inputText);
const before = JSON.parse(beforeText);
await mkdir(output, { recursive: false });
await writeFile(resolve(output, "source-context-frozen.json"), inputText);
const companies = new Map(catalog.companies.map((company) => [company.slug, company]));
const archives = new Map();
async function verifiedArchive(path, expectedSha) {
  const absolute = resolve(path);
  if (!absolute.startsWith(`${cacheRoot}${sep}`)) throw new Error("archive_outside_fall_public_history_cache");
  if (!archives.has(absolute)) {
    const bytes = await readFile(absolute);
    archives.set(absolute, { sha256: sha(bytes), html: bytes.toString("utf8") });
  }
  const archived = archives.get(absolute);
  if (archived.sha256 !== expectedSha) throw new Error("original_html_hash_conflict");
  return archived.html;
}
const physicalKey = (row) => {
  try {
    const url = new URL(row.sourceUrl);
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, ""); url.hash = "";
    return `${row.batchSlug}:${row.entityId}:${url.href.replace(/\/$/, "")}`;
  } catch { return null; }
};
const existing = new Map(before.evidence.map((row) => [physicalKey(row), row]));
const additions = [], duplicates = [], rejected = [];
const normalizeText = (value) => value.normalize("NFKC").replace(/\s/gu, "");
for (const row of input.context ?? []) {
  const company = companies.get(row.companySlug);
  const reasons = officialWebsiteArticleContextReasons(row, company);
  let raw;
  try { raw = typeof row.rawVisibleText === "string" ? JSON.parse(row.rawVisibleText) : row.rawVisibleText; } catch { /* Reported by receipt preflight. */ }
  if (!reasons.length) {
    try {
      for (const hop of raw.officialDomainLineage.chain) await verifiedArchive(hop.bodyArchivePath, hop.sha256);
      const html = await verifiedArchive(row.fullOriginalHtmlArchivePath, row.sourceHtmlSha256);
      const htmlText = normalizeText(load(html).root().text());
      if (row.text.split(/\n+/).some((line) => normalizeText(line).length >= 12 && !htmlText.includes(normalizeText(line)))) reasons.push("original_body_fragment_not_present_in_archived_html");
    } catch (error) { reasons.push(error.code === "ENOENT" ? "original_html_archive_missing" : error.message); }
  }
  if (reasons.length) { rejected.push({ companySlug: row.companySlug, sourceUrl: row.sourceUrl, reasons: [...new Set(reasons)] }); continue; }
  const key = physicalKey(row);
  if (existing.has(key)) { duplicates.push({ sourceUrl: row.sourceUrl, existingId: existing.get(key).id }); continue; }
  const postedAt = /^(?:unknown|unavailable)$/i.test(String(row.postedAt ?? "")) ? null : row.postedAt ?? null;
  const precision = postedAt ? /^\d{4}-\d{2}-\d{2}$/.test(postedAt) || row.publicationPrecision === "day" ? "day" : "exact" : "unknown";
  const body = row.text;
  const checkedAt = new Date(row.observedAt).toISOString();
  const evidence = {
    ...row, id: `web-f26-original-${sha(key).slice(0, 24)}`,
    text: body, originalText: body, platformPostId: row.sourceUrl,
    postedAt, publishedAtPrecision: precision, metrics: {}, contributionScore: 0,
    tractionStatus: "unscored", tractionLimitations: ["Official company article retained as original context; no native social engagement metrics are attached."],
    rawVisibleText: JSON.stringify({ ...raw, validation: { source: "fall_2026_official_article_ingestion_v1", originalHtmlSha256: row.sourceHtmlSha256, originalBodySha256: sha(body), archiveHashesVerified: true, originalBodyFragmentsVerified: true } }),
    review_state: "verified", attributionVersion: 3, attributionStatus: "verified", attributionMode: "author",
    attributionProvenance: "official_company_website_article_v1", attributionSignals: ["official_company_domain_lineage", "original_html_archive_sha256_verified"],
    linkStatus: "verified", linkCheckedAt: checkedAt, accountUrl: company.websiteUrl,
    matchReason: "Native article URL and exact original body are bound to the official company domain lineage and on-disk source HTML receipt. Context only; zero traction score.",
    first_seen_at: checkedAt, last_checked_at: checkedAt, last_updated_at: postedAt ?? checkedAt
  };
  additions.push(evidence); existing.set(key, evidence);
}
const previousRows = before.evidence.filter((row) => row.batchSlug !== "F26");
const latestObservation = Math.max(Date.parse(before.source?.fetchedAt ?? "") || 0, ...additions.map((row) => Date.parse(row.last_checked_at)));
const next = { ...before, source: { ...before.source, ...(latestObservation ? { fetchedAt: new Date(latestObservation).toISOString() } : {}), evidenceCount: before.evidence.length + additions.length }, evidence: [...before.evidence, ...additions] };
if (sha(JSON.stringify(previousRows)) !== sha(JSON.stringify(next.evidence.filter((row) => row.batchSlug !== "F26")))) throw new Error("Earlier cohort rows changed.");
const audit = { status: write && !rejected.length ? "written" : "dry_run", source: inputPath, sourceSha256: sha(inputText), before: before.evidence.length, received: (input.context ?? []).length, accepted: additions.length, duplicates: duplicates.length, rejected: rejected.length, after: next.evidence.length, archiveFilesVerified: archives.size, fullHistoryComplete: false, rejectedRows: rejected, duplicateRows: duplicates };
await writeFile(resolve(output, "audit.json"), `${JSON.stringify(audit, null, 2)}\n`);
if (rejected.length) { console.log(JSON.stringify({ ...audit, rejectedRows: rejected.slice(0, 10), duplicateRows: undefined })); process.exitCode = 1; }
else {
  if (write) {
    if (await readFile(targetPath, "utf8") !== beforeText) throw new Error("Canonical evidence changed during article preflight.");
    const temporary = `${targetPath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`); await rename(temporary, targetPath);
    await writeFile(resolve(output, "targeted-after.json"), `${JSON.stringify(next, null, 2)}\n`);
  }
  console.log(JSON.stringify({ ...audit, duplicateRows: undefined }));
}
