import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, open, rename, unlink } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_ARTICLE_LEDGER_KIND, verifyNativeXArticleContextLedger } from "./ingest-fall-2026-x-article-context.mjs";

const targetPath = "src/lib/social/native-article-context-fall-2026.json";
const targetedPath = "src/lib/social/targeted-evidence-current.json";
const rosterPath = "src/lib/yc/fall-2026-companies.json";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const hash = (value) => sha(JSON.stringify(value));
const exactOwners = new Map([
  ["2110100931102822530", ["acyclic", "2012796"]],
  ["2078193804763680972", ["adsideai", "406206"]],
  ["2059381458561851599", ["adsideai", "406206"]],
  ["2111159645419270578", ["agent-37", "316679"]],
  ["2042693710127730995", ["agent-37", "316679"]],
  ["2042017042539196688", ["agent-37", "316679"]],
]);
const oldDisplay = (url) => ({ url, source: "name_derived_roster_display_url_v1", verified: false, usedForIdentityAdmission: false });
function withoutDisplayMetadata(row) {
  const result = { ...row };
  delete result.identitySourceUrl;
  delete result.historicalUnverifiedFounderDisplayUrl;
  return result;
}
function exactCompanySource(value, companySlug) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "www.ycombinator.com" && url.pathname === `/companies/${companySlug}` && !url.username && !url.password && !url.port && !url.search && !url.hash;
  } catch { return false; }
}

/** Only these six already-admitted body contexts may receive this display-source
 * correction. Native ownership, body, clock, outer post and raw receipts stay exact. */
export function planNativeXArticleIdentitySourceRepair(ledger, roster) {
  if (ledger?.source?.kind !== NATIVE_ARTICLE_LEDGER_KIND || ledger.source.batchSlug !== "F26" || ledger.source.namespace !== "local_body_context" || ledger.source.countsAsNativePosts !== false || ledger.contexts?.length !== exactOwners.size || Object.hasOwn(ledger, "evidence")) throw new Error("Repair is restricted to the exact six separate Article body contexts.");
  const seen = new Set(), corrections = [];
  const contexts = ledger.contexts.map((row) => {
    const expected = exactOwners.get(row.outerNativePostId);
    if (!expected || seen.has(row.outerNativePostId) || row.companySlug !== expected[0] || String(row.founderId) !== expected[1] || row.batchSlug !== "F26") throw new Error("Unexpected or duplicate Article owner/native outer identity in narrow repair.");
    seen.add(row.outerNativePostId);
    const company = roster.companies?.find((item) => item.slug === expected[0]);
    const founder = company?.founders.find((item) => String(item.id) === expected[1]);
    if (!founder || row.authorName !== founder.name || !exactCompanySource(company.ycProfileUrl, company.slug) || !/^https:\/\/www\.ycombinator\.com\/people\/[^/?#]+$/.test(founder.ycProfileUrl ?? "")) throw new Error("Exact official company-payload founder and historical derived display URL required.");
    const historical = oldDisplay(founder.ycProfileUrl);
    if (row.identitySourceUrl === company.ycProfileUrl) {
      if (hash(row.historicalUnverifiedFounderDisplayUrl) !== hash(historical)) throw new Error("Previously repaired Article lacks its exact unverified historical display metadata.");
      return row;
    }
    if (row.identitySourceUrl !== founder.ycProfileUrl || Object.hasOwn(row, "historicalUnverifiedFounderDisplayUrl")) throw new Error("Article identity source is neither the exact old derived URL nor this completed correction.");
    const corrected = { ...row, identitySourceUrl: company.ycProfileUrl, historicalUnverifiedFounderDisplayUrl: historical };
    if (hash(withoutDisplayMetadata(row)) !== hash(withoutDisplayMetadata(corrected))) throw new Error("Repair changed fields outside the two permitted display-source metadata fields.");
    corrections.push({ contextId: row.contextId, outerNativePostId: row.outerNativePostId, companySlug: row.companySlug, founderId: row.founderId, previousIdentitySourceUrl: row.identitySourceUrl, identitySourceUrl: corrected.identitySourceUrl, unchangedNativeRowSha256: hash(withoutDisplayMetadata(row)), rawReceiptSha256: sha(row.rawVisibleText), nativeBodySha256: sha(row.text), outerCaptionSha256: sha(row.outerPostText) });
    return corrected;
  });
  return { ledger: { ...ledger, contexts }, corrections };
}

export async function repairNativeXArticleIdentitySources({ rootDir = process.cwd(), mode = "dry-run", expectedTargetSha256, expectedTargetedSha256, observedAt = new Date().toISOString(), readArchive } = {}) {
  rootDir = resolve(rootDir);
  if (!["dry-run", "write"].includes(mode)) throw new Error("Choose dry-run or write.");
  if (!Number.isFinite(Date.parse(observedAt)) || new Date(observedAt).toISOString() !== observedAt) throw new Error("Exact UTC observedAt required.");
  if (mode === "write" && !/^[a-f0-9]{64}$/.test(expectedTargetSha256 ?? "")) throw new Error("Write requires the expected existing Article ledger SHA.");
  if (mode === "write" && !/^[a-f0-9]{64}$/.test(expectedTargetedSha256 ?? "")) throw new Error("Write requires the expected unchanged targeted-evidence SHA.");
  const target = resolve(rootDir, targetPath), targeted = resolve(rootDir, targetedPath);
  const beforeBytes = await readFile(target), beforeSha256 = sha(beforeBytes), targetedBefore = await readFile(targeted), targetedSha = sha(targetedBefore);
  if (expectedTargetSha256 !== undefined && beforeSha256 !== expectedTargetSha256) throw new Error("Article repair CAS precondition failed.");
  if (expectedTargetedSha256 !== undefined && targetedSha !== expectedTargetedSha256) throw new Error("Targeted-evidence expected SHA precondition failed.");
  const rosterBytes = await readFile(resolve(rootDir, rosterPath)), rosterSha256 = sha(rosterBytes), before = JSON.parse(beforeBytes);
  for (const row of before.contexts ?? []) {
    const raw = JSON.parse(row.rawVisibleText);
    if (raw.rosterPath !== rosterPath || raw.rosterSha256 !== rosterSha256) throw new Error("Repair roster differs from the physically archived native ownership source.");
  }
  const { ledger, corrections } = planNativeXArticleIdentitySourceRepair(before, JSON.parse(rosterBytes));
  const verification = await verifyNativeXArticleContextLedger(ledger, { rootDir, readArchive });
  const outputBytes = Buffer.from(`${JSON.stringify(ledger, null, 2)}\n`), proposedSha256 = sha(outputBytes);
  let written = false, afterSha256 = beforeSha256;
  if (sha(await readFile(targeted)) !== targetedSha) throw new Error("Targeted-evidence byte guard changed during Article metadata review.");
  if (mode === "write" && corrections.length) {
    const lockPath = `${target}.lock`, temporary = `${target}.${randomUUID()}.next`;
    let lock;
    try {
      lock = await open(lockPath, "wx");
      if (sha(await readFile(target)) !== beforeSha256) throw new Error("Article repair target changed before commit.");
      await writeFile(temporary, outputBytes, { flag: "wx" });
      if (sha(await readFile(target)) !== expectedTargetSha256 || sha(await readFile(targeted)) !== targetedSha) throw new Error("Article repair CAS or targeted-evidence guard changed before commit.");
      await rename(temporary, target); written = true; afterSha256 = sha(await readFile(target));
    } finally {
      await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
      if (lock) { await lock.close(); await unlink(lockPath); }
    }
  }
  if (sha(await readFile(targeted)) !== targetedSha) throw new Error("Targeted-evidence byte guard changed after Article metadata review/write.");
  return { ledger, audit: { mechanism: "exact_six_native_article_company_source_correction_v1", observedAt, target: targetPath, mode, beforeSha256, expectedTargetSha256: expectedTargetSha256 ?? null, proposedSha256, afterSha256, written, corrections, corrected: corrections.length, contexts: ledger.contexts.length, nativePostsAdded: 0, nativeFieldsAndRawReceiptsUnchanged: true, sourceMetadataUnchanged: hash(before.source) === hash(ledger.source), expectedTargetedSha256: expectedTargetedSha256 ?? null, targetedEvidenceSha256: targetedSha, targetedEvidenceBytesUnchanged: true, rosterSha256, verification } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), value = (flag, fallback) => args.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1) ?? fallback;
  if (args.includes("--write") === args.includes("--dry-run")) throw new Error("Choose exactly one of --dry-run or --write.");
  const outputDir = resolve(value("--audit-dir", "outputs/fall-2026/collection/x-article-identity-source-repair-preflight"));
  if (!outputDir.startsWith(`${resolve("outputs")}/`)) throw new Error("Audit outputs must stay under outputs/.");
  const result = await repairNativeXArticleIdentitySources({ mode: args.includes("--write") ? "write" : "dry-run", expectedTargetSha256: value("--expected-target-sha256"), expectedTargetedSha256: value("--expected-targeted-sha256"), observedAt: value("--observed-at", new Date().toISOString()) });
  await mkdir(outputDir, { recursive: true });
  await writeFile(resolve(outputDir, "audit.json"), `${JSON.stringify(result.audit, null, 2)}\n`);
  await writeFile(resolve(outputDir, "prepared-ledger.json"), `${JSON.stringify(result.ledger, null, 2)}\n`);
  console.log(JSON.stringify({ audit: relative(process.cwd(), resolve(outputDir, "audit.json")), ...result.audit }));
}
