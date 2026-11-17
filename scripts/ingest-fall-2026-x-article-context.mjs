import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, open, rename, unlink } from "node:fs/promises";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { physicallyReviewNativeXArticleContexts } from "./review-fall-2026-x-native-article-context.mjs";
import { nativeXArticleContextReasons } from "../src/lib/graph/x-native-article-context-receipt.mjs";

export const NATIVE_ARTICLE_LEDGER_KIND = "fall_2026_native_article_body_context_ledger_v1";
const ledgerPath = "src/lib/social/native-article-context-fall-2026.json";
const targetedPath = "src/lib/social/targeted-evidence-current.json";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hash = (value) => sha(JSON.stringify(value));
const slug = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const key = (row) => JSON.stringify([row.batchSlug, row.entityId, row.outerNativePostId, sha(row.text)]);
export const nativeArticleLocalContextId = (row) => `local-body-context-${sha(key(row))}`;
const readOptional = async (path) => { try { return await readFile(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };
const byteState = (bytes) => bytes === null ? "missing" : sha(bytes);
function pointer(value, path, pattern) {
  if (typeof path !== "string" || !pattern.test(path)) throw new Error("Unsupported native Article receipt pointer.");
  return path.split("/").filter(Boolean).reduce((current, part) => current?.[part], value);
}
function contained(rootDir, path) {
  const absolute = resolve(rootDir, path);
  if (!absolute.startsWith(`${rootDir}/`)) throw new Error("Article archive path must stay under its archive root.");
  return absolute;
}

/** Rehash native, outer-post and roster bytes, including a frozen-by-SHA reader.
 * readArchive(path, expectedSha) returns bytes, never parsed trusted objects. */
export async function verifyNativeXArticleContextLedger(ledger, { rootDir = process.cwd(), readArchive } = {}) {
  rootDir = resolve(rootDir);
  if (ledger?.source?.kind !== NATIVE_ARTICLE_LEDGER_KIND || ledger.source.batchSlug !== "F26" || ledger.source.namespace !== "local_body_context" || ledger.source.countsAsNativePosts !== false || !Array.isArray(ledger.contexts) || "evidence" in ledger) throw new Error("Not a separate native Article body-context ledger.");
  const cache = new Map(), identities = new Set(), ids = new Set();
  const load = async (path, expectedSha) => {
    if (typeof path !== "string" || !/^[a-f0-9]{64}$/.test(expectedSha ?? "")) throw new Error("Physical Article archive path/SHA required.");
    contained(rootDir, path);
    const existing = cache.get(path);
    if (existing) { if (existing.sha256 !== expectedSha) throw new Error("Conflicting archive SHA references."); return existing.value; }
    const bytes = readArchive ? Buffer.from(await readArchive(path, expectedSha)) : await readFile(contained(rootDir, path));
    if (sha(bytes) !== expectedSha) throw new Error(`Article archive SHA mismatch: ${path}`);
    const value = JSON.parse(bytes); cache.set(path, { sha256: expectedSha, value }); return value;
  };
  for (const row of ledger.contexts) {
    if (row.contextId !== nativeArticleLocalContextId(row) || ids.has(row.contextId) || identities.has(key(row)) || row.countsAsNativePost !== false || row.admissionStatus !== "verified_separate_article_body_context" || row.review_state !== "verified" || row.attributionStatus !== "verified" || Object.hasOwn(row, "platformPostId") || row.articleNativeId !== null) throw new Error("Invalid, duplicate or post-conflating local Article context identity.");
    ids.add(row.contextId); identities.add(key(row));
    const raw = JSON.parse(row.rawVisibleText);
    if (raw.admissionStatus !== "verified_separate_article_body_context") throw new Error("Article context admission receipt missing.");
    const nativeArchive = await load(raw.sourceArchivePath, raw.sourceArchiveSha256), outerArchive = await load(raw.outerPostArchivePath, raw.outerPostArchiveSha256), roster = await load(raw.rosterPath, raw.rosterSha256);
    const nativeRecord = pointer(nativeArchive, raw.sourceRecordPointer, /^\/source\/nativeArticleBodies(?:AfterControlReset)?\/\d+$/), outerPost = pointer(outerArchive, raw.outerPostRecordPointer, /^\/(?:evidence|candidates)\/\d+$/);
    if (!nativeRecord || !outerPost || hash(nativeRecord) !== hash(raw.nativeRecord) || hash(outerPost) !== hash(raw.outerPost) || raw.exportedAt !== nativeArchive.source?.exportedAt) throw new Error("Article native/outer record differs from the exact archived pointer.");
    const company = roster.companies?.find((company) => company.slug === row.companySlug), founder = company?.founders.find((founder) => String(founder.id) === row.founderId);
    const entityId = founder ? `founder-${company.slug}-${slug(founder.name)}-${founder.id}` : null;
    if (!founder || entityId !== row.entityId || outerPost.entityId !== entityId || outerPost.companySlug !== company.slug || row.identitySourceUrl !== company.ycProfileUrl) throw new Error("Article owner is not its exact archived official company-payload founder source.");
    const reasons = nativeXArticleContextReasons(row, { entityId, companySlug: company.slug, companyName: company.name, founderName: founder.name, socialAccounts: { x: founder.socialLinks.x } });
    if (reasons.length) throw new Error(`Article receipt rejected: ${reasons.join(", ")}`);
  }
  return { ok: true, archives: [...cache].map(([path, value]) => ({ path, sha256: value.sha256 })), contexts: ledger.contexts.length };
}

export async function ingestNativeXArticleContexts({ rootDir = process.cwd(), mode = "dry-run", expectedTargetSha256, observedAt = new Date().toISOString(), reviewOptions = {}, readArchive } = {}) {
  rootDir = resolve(rootDir);
  if (!["dry-run", "write"].includes(mode)) throw new Error("Choose dry-run or write.");
  if (!Number.isFinite(Date.parse(observedAt)) || new Date(observedAt).toISOString() !== observedAt) throw new Error("Exact UTC observedAt required.");
  if (mode === "write" && expectedTargetSha256 !== "missing" && !/^[a-f0-9]{64}$/.test(expectedTargetSha256 ?? "")) throw new Error("Write requires expected target SHA or explicit missing.");
  const target = resolve(rootDir, ledgerPath), targeted = resolve(rootDir, targetedPath);
  const targetedBefore = await readFile(targeted), targetedSha = sha(targetedBefore), beforeBytes = await readOptional(target), beforeSha = byteState(beforeBytes);
  if (expectedTargetSha256 !== undefined && expectedTargetSha256 !== beforeSha) throw new Error("Article target CAS precondition failed.");
  const existing = beforeBytes ? JSON.parse(beforeBytes) : { source: { kind: NATIVE_ARTICLE_LEDGER_KIND, batchSlug: "F26", namespace: "local_body_context", countsAsNativePosts: false }, contexts: [] };
  await verifyNativeXArticleContextLedger(existing, { rootDir, readArchive });
  const reviewed = await physicallyReviewNativeXArticleContexts({ ...reviewOptions, rootDir });
  if (reviewed.needsReview.length) throw new Error("Physical Article review has held proof conflicts.");
  const contexts = [...existing.contexts], known = new Set(contexts.map(key));
  let duplicates = 0;
  for (const candidate of reviewed.candidates) {
    if (known.has(key(candidate))) { duplicates++; continue; }
    const raw = JSON.parse(candidate.rawVisibleText); raw.admissionStatus = "verified_separate_article_body_context";
    const row = { ...candidate, contextId: nativeArticleLocalContextId(candidate), countsAsNativePost: false, admissionStatus: "verified_separate_article_body_context", review_state: "verified", attributionStatus: "verified", rawVisibleText: JSON.stringify(raw) };
    contexts.push(row); known.add(key(row));
  }
  const appended = contexts.length - existing.contexts.length;
  const ledger = { ...existing, source: { ...existing.source, contextCount: contexts.length, lastReviewedAt: observedAt, nativePostsAdded: 0 }, contexts };
  const verification = await verifyNativeXArticleContextLedger(ledger, { rootDir, readArchive });
  if (sha(await readFile(targeted)) !== targetedSha) throw new Error("Targeted-evidence byte guard changed during Article review.");
  const outputBytes = Buffer.from(`${JSON.stringify(ledger, null, 2)}\n`), proposedSha = sha(outputBytes);
  let written = false, afterSha = beforeSha;
  if (mode === "write" && appended > 0) {
    await mkdir(dirname(target), { recursive: true });
    const lockPath = `${target}.lock`, temporary = `${target}.${randomUUID()}.next`;
    let lock;
    try {
      lock = await open(lockPath, "wx");
      if (byteState(await readOptional(target)) !== beforeSha) throw new Error("Article target changed before commit.");
      await writeFile(temporary, outputBytes, { flag: "wx" });
      if (byteState(await readOptional(target)) !== expectedTargetSha256 || sha(await readFile(targeted)) !== targetedSha) throw new Error("Article CAS or targeted-evidence guard changed before commit.");
      await rename(temporary, target); written = true; afterSha = sha(await readFile(target));
    } finally {
      await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
      if (lock) { await lock.close(); await unlink(lockPath); }
    }
  }
  const targetedAfterSha = sha(await readFile(targeted));
  if (targetedAfterSha !== targetedSha) throw new Error("Targeted-evidence byte guard changed after Article review/write.");
  return { ledger, audit: { target: ledgerPath, mode, beforeSha256: beforeSha, expectedTargetSha256: expectedTargetSha256 ?? null, proposedSha256: proposedSha, afterSha256: afterSha, existingContexts: existing.contexts.length, reviewed: reviewed.candidates.length, appended, duplicates, nativePostsAdded: 0, written, targetedEvidenceSha256: targetedSha, targetedEvidenceBytesUnchanged: true, verification, canonicalTargetedWritten: false } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), value = (flag, fallback) => args.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1) ?? fallback;
  if (args.includes("--write") === args.includes("--dry-run")) throw new Error("Choose exactly one of --dry-run or --write.");
  const outputDir = resolve(value("--audit-dir", "outputs/fall-2026/collection/x-native-article-ledger-preflight"));
  if (!outputDir.startsWith(`${resolve("outputs")}/`)) throw new Error("Audit outputs must stay under outputs/.");
  const result = await ingestNativeXArticleContexts({ mode: args.includes("--write") ? "write" : "dry-run", expectedTargetSha256: value("--expected-target-sha256"), observedAt: value("--observed-at", new Date().toISOString()) });
  await mkdir(outputDir, { recursive: true });
  await writeFile(resolve(outputDir, "audit.json"), `${JSON.stringify(result.audit, null, 2)}\n`);
  await writeFile(resolve(outputDir, "prepared-ledger.json"), `${JSON.stringify(result.ledger, null, 2)}\n`);
  console.log(JSON.stringify({ audit: relative(process.cwd(), resolve(outputDir, "audit.json")), ...result.audit }));
}
