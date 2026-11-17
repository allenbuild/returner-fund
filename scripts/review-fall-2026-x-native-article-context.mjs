import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_X_ARTICLE_CONTEXT_PROVENANCE, NATIVE_X_ARTICLE_CONTEXT_VALIDATION, nativeXArticleContextReasons } from "../src/lib/graph/x-native-article-context-receipt.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const hash = (value) => sha(JSON.stringify(value));
const slug = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const defaults = {
  archivePath: "outputs/fall-2026/browser-checkpoints/x-ui-base-1794862008501.json",
  archiveSha256: "446d7a5645c9249f15c8d9bb4bc11913239155b20ad09fafd2d75cf8bbb69211",
  outerPostArchivePath: "outputs/fall-2026/collection/x-native-sealed-1794860843531.json",
  outerPostArchiveSha256: "81c68891bcf671b65a61c35b90952e2c71d247198b8d8e78c31327c7c34dff55",
  rosterPath: "src/lib/yc/fall-2026-companies.json",
};
function identity(value) {
  try {
    const url = new URL(value), match = url.pathname.match(/^\/([a-z0-9_]+)(?:\/status\/(\d+))?\/?$/i);
    return url.protocol === "https:" && ["x.com", "www.x.com", "twitter.com"].includes(url.hostname) && !url.username && !url.password && !url.port && !url.hash && match ? { handle: match[1].toLowerCase(), postId: match[2] ?? null } : null;
  } catch { return null; }
}

/** GET-free physical review. Returns held body contexts; it never imports posts,
 * assigns a native Article ID, replaces outer captions, or writes canonical. */
export async function physicallyReviewNativeXArticleContexts(options = {}) {
  const config = { ...defaults, ...options }, rootDir = resolve(config.rootDir ?? process.cwd());
  const load = async (path, expectedSha) => {
    const bytes = await readFile(resolve(rootDir, path)), actualSha = sha(bytes);
    if (expectedSha !== undefined && (!/^[a-f0-9]{64}$/.test(expectedSha) || actualSha !== expectedSha)) throw new Error(`Physical archive SHA mismatch: ${path}`);
    return { value: JSON.parse(bytes), sha256: actualSha, path };
  };
  const archive = await load(config.archivePath, config.archiveSha256), outerArchive = await load(config.outerPostArchivePath, config.outerPostArchiveSha256), roster = await load(config.rosterPath);
  const owners = new Map();
  for (const company of roster.value.companies) for (const founder of company.founders) {
    const native = identity(founder.socialLinks?.x);
    if (native && !native.postId) owners.set(native.handle, [...(owners.get(native.handle) ?? []), { company, founder }]);
  }
  const contexts = [], audit = [], held = [];
  for (const key of ["nativeArticleBodies", "nativeArticleBodiesAfterControlReset"]) for (const [index, nativeRecord] of (archive.value.source[key] ?? []).entries()) {
    const sourceRecordPointer = `/source/${key}/${index}`, sourceUrl = nativeRecord.sourceUrl ?? nativeRecord.pageUrl, native = identity(sourceUrl), ownerCandidates = owners.get(native?.handle) ?? [];
    if (!native?.postId || ownerCandidates.length !== 1) { held.push({ sourceRecordPointer, reason: "exact_official_founder_mapping_not_unique" }); continue; }
    const { company, founder } = ownerCandidates[0], entityId = `founder-${company.slug}-${slug(founder.name)}-${founder.id}`;
    const outerMatches = ["evidence", "candidates"].flatMap((collection) => (outerArchive.value[collection] ?? []).flatMap((outerPost, outerIndex) => outerPost.platform === "x" && outerPost.platformPostId === native.postId && outerPost.entityId === entityId && outerPost.companySlug === company.slug ? [{ outerPost, pointer: `/${collection}/${outerIndex}` }] : []));
    if (outerMatches.length !== 1) { held.push({ sourceRecordPointer, reason: "exact_frozen_outer_post_not_unique" }); continue; }
    const { outerPost, pointer } = outerMatches[0], body = nativeRecord.body ?? nativeRecord.bodyText;
    const postedAt = nativeRecord.nativePublishedAt ?? nativeRecord.times?.find((time) => identity(time.href)?.postId === native.postId)?.datetime;
    const raw = { source: "authorized_native_x_article_context_v1", nativeRecord, outerPost, sourceArchivePath: archive.path, sourceArchiveSha256: archive.sha256, sourceRecordPointer, outerPostArchivePath: outerArchive.path, outerPostArchiveSha256: outerArchive.sha256, outerPostRecordPointer: pointer, rosterPath: roster.path, rosterSha256: roster.sha256, exportedAt: archive.value.source.exportedAt, validation: { source: NATIVE_X_ARTICLE_CONTEXT_VALIDATION, archiveHashesVerified: true, nativeArticleRecordSha256: hash(nativeRecord), outerPostRecordSha256: hash(outerPost), nativeBodySha256: sha(body ?? "") }, admissionStatus: "held_pending_article_context_namespace_review" };
    const row = { batchSlug: "F26", companySlug: company.slug, companyName: company.name, entityType: "founder", entityId, founderId: String(founder.id), authorName: founder.name, authorHandle: native.handle, accountUrl: `https://x.com/${native.handle}`, platform: "x", contextObjectType: "native_x_article_body", contentKind: "native_x_article", outerNativePostId: native.postId, articleNativeId: null, nativeArticleUrl: sourceUrl, sourceUrl, outerPostText: outerPost.text, title: nativeRecord.title, text: body, originalText: body, postedAt, observedAt: nativeRecord.observedAt, bodyTruncated: false, captionAbsent: false, metrics: {}, contributionScore: 0, tractionStatus: "unscored", review_state: "needs_review", attributionStatus: "needs_review", attributionProvenance: NATIVE_X_ARTICLE_CONTEXT_PROVENANCE, identitySourceUrl: company.ycProfileUrl, rawVisibleText: JSON.stringify(raw) };
    const entity = { entityId, companySlug: company.slug, companyName: company.name, founderName: founder.name, socialAccounts: { x: founder.socialLinks.x } }, reasons = nativeXArticleContextReasons(row, entity);
    if (reasons.length) { held.push({ sourceRecordPointer, outerNativePostId: native.postId, reasons }); continue; }
    contexts.push(row);
    audit.push({ outerNativePostId: native.postId, nativeArticleId: null, nativeArticleUrl: sourceUrl, sourceRecordPointer, outerPostRecordPointer: pointer, nativeBodySha256: sha(body), outerCaptionSha256: sha(outerPost.text), outerCaptionCharacters: outerPost.text.length, articleBodyCharacters: body.length, receiptHelperReasons: [], admission: "held_pending_namespace_review" });
  }
  return { source: { mechanism: "physical_native_x_article_body_review_v1", sourceArchivePath: archive.path, sourceArchiveSha256: archive.sha256, outerPostArchivePath: outerArchive.path, outerPostArchiveSha256: outerArchive.sha256, rosterPath: roster.path, rosterSha256: roster.sha256, canonicalWritten: false, admissionStatus: "held_pending_article_context_namespace_review", nativeArticleIdsIndependentlyObserved: false, nativeUrlMeaning: "The observed native status permalink rendered twitterArticleReadView. Its outer post identity/caption remain distinct from this body context." }, summary: { nativeRecordsReviewed: audit.length + held.length, physicallyVerifiedHeldContexts: contexts.length, recordsNeedingFurtherProof: held.length, nativeBodyCharacters: contexts.reduce((sum, row) => sum + row.text.length, 0), canonicalAccepted: 0 }, audit, needsReview: held, candidates: contexts };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), value = (flag, fallback) => args.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1) ?? fallback;
  const rootDir = process.cwd(), outputDir = resolve(rootDir, value("--output-dir", "outputs/fall-2026/collection/x-native-article-six-review"));
  if (!outputDir.startsWith(`${resolve(rootDir, "outputs")}/`)) throw new Error("Review outputs must stay under outputs/; canonical writes are unsupported.");
  const result = await physicallyReviewNativeXArticleContexts({ rootDir, archivePath: value("--archive", defaults.archivePath), archiveSha256: value("--archive-sha256", defaults.archiveSha256), outerPostArchivePath: value("--outer-input", defaults.outerPostArchivePath), outerPostArchiveSha256: value("--outer-sha256", defaults.outerPostArchiveSha256) });
  await mkdir(outputDir, { recursive: true });
  const outputPath = resolve(outputDir, "contexts.json"), auditPath = resolve(outputDir, "audit.json");
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(auditPath, `${JSON.stringify({ source: result.source, summary: result.summary, audit: result.audit, needsReview: result.needsReview }, null, 2)}\n`);
  console.log(JSON.stringify({ output: relative(rootDir, outputPath), sha256: sha(await readFile(outputPath)), audit: relative(rootDir, auditPath), ...result.summary }));
}
