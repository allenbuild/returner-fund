import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { isOfficialInstagramOutboundReceipt } from "./lib/instagram-official-outbound-proof.mjs";
import { isVerifiedInstagramCaptionAbsence } from "./lib/instagram-caption-absence-proof.mjs";
import { isVerifiedLinkedInCaptionAbsence } from "./lib/linkedin-caption-absence-proof.mjs";
import { isVerifiedInstagramFounderSocialIdentity } from "./lib/instagram-founder-social-proof.mjs";
import { isVerifiedInstagramFounderTeamIdentity } from "./lib/instagram-founder-team-proof.mjs";
import { verifiedNativeTikTokReasons } from "../src/lib/graph/tiktok-native-receipt.mjs";
import { facebookNativeIdentity, verifiedNativeFacebookReasons } from "../src/lib/graph/facebook-native-receipt.mjs";
import { nativeThreadsIdentity, verifiedNativeThreadsReasons } from "../src/lib/graph/threads-native-receipt.mjs";
import { isVerifiedNativeXCaptionlessPost, nativeXCaptionlessPostReasons } from "../src/lib/graph/x-caption-absence-receipt.mjs";
import { verifiedNativeYouTubeDomReasons } from "../src/lib/graph/youtube-native-dom-receipt.mjs";
import { verifiedNativeYouTubeUnknownDateReasons, NATIVE_YOUTUBE_UNKNOWN_DATE_SOURCE } from "../src/lib/graph/youtube-native-unknown-date-receipt.mjs";
import { verifiedNativeLinkedInFounderHistoryReasons } from "../src/lib/graph/linkedin-founder-history-receipt.mjs";
import { verifiedNativeLinkedInCompanyDetailReasons } from "../src/lib/graph/linkedin-company-detail-receipt.mjs";
import { verifiedFallLinkedInFounderAccounts } from "../src/lib/graph/linkedin-founder-aliases.mjs";
import {
  publicationTimesCompatible,
  sourceAuthorsCompatible,
  sourceContentIdentity
} from "./lib/source-content-identity.mjs";
import {
  readPublicEvidenceArtifact,
  writePublicEvidenceArtifactPairAtomic
} from "./lib/public-evidence-artifact.mjs";

const DISPLAY_METRICS = {
  github: new Set(["stars", "forks", "recent_commits_30d", "issues", "watchers", "subscribers"]),
  x: new Set(["views", "likes", "replies", "reposts", "quotes", "bookmarks"]),
  linkedin: new Set(["views", "reactions", "comments", "reposts"]),
  instagram: new Set(["views", "likes", "comments", "shares", "saves"]),
  tiktok: new Set(["likes", "comments", "saves"]),
  facebook: new Set(),
  threads: new Set(),
  product_hunt: new Set(["upvotes", "comments"]),
  youtube: new Set(["views", "likes", "comments"]),
  hacker_news: new Set(["upvotes", "comments"]),
  reddit: new Set(["upvotes", "comments"])
};

const SCORING_METRICS = {
  github: new Set(["stars", "forks", "issues"]),
  x: new Set(["views", "likes", "replies", "reposts", "quotes"]),
  linkedin: new Set(["views", "reactions", "comments", "reposts"]),
  instagram: new Set(["views", "likes", "comments", "shares", "saves"]),
  tiktok: new Set(["likes", "comments", "saves"]),
  facebook: new Set(),
  threads: new Set(),
  product_hunt: new Set(["upvotes", "comments"]),
  youtube: new Set(["views", "likes", "comments"]),
  hacker_news: new Set(["upvotes", "comments"]),
  reddit: new Set(["upvotes", "comments"])
};

const root = process.cwd();
const targetArg = stringArg("--target") ?? "yc";
const targetKind = targetArg === "a16z" ? "a16z" : "yc";
const targetPath = resolve(root, targetArg === "yc"
  ? "src/lib/social/targeted-evidence-current.json"
  : targetArg === "a16z"
    ? "src/lib/social/a16z-speedrun-006-social-evidence.json"
    : targetArg);
const canonicalPublicEvidencePath = resolve(
  root,
  "src/lib/social/public-evidence-current.json"
);
const externalEvidenceRoot = resolve(root, stringArg("--external-evidence-root") ?? ".");
const auditPath = stringArg("--audit-output");
const dryRun = process.argv.includes("--dry-run");
const writeMode = process.argv.includes("--write");
const strict = process.argv.includes("--strict");
const appendOnly = process.argv.includes("--append-only");
const refreshGenerated = process.argv.includes("--refresh-generated");
const scopeBatchDedupe = process.argv.includes("--scope-batch-dedupe");
const retainZeroEngagement = process.argv.includes("--retain-zero-engagement");
const inputPaths = valueArgs("--input").map((value) => resolve(root, value));
const observedAt = validTimestamp(stringArg("--observed-at"));
const includedBatches = new Set(
  (stringArg("--include-batches") ?? "")
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean)
);

if (inputPaths.length === 0) {
  throw new Error("Pass at least one --input=<source-hunt.json> file.");
}
if (!observedAt) throw new Error("Pass a deterministic --observed-at=<ISO timestamp>.");
if (dryRun === writeMode) throw new Error("Pass exactly one of --dry-run or --write.");
if (scopeBatchDedupe && includedBatches.size !== 1) {
  throw new Error("--scope-batch-dedupe requires exactly one explicit --include-batches value.");
}
if (retainZeroEngagement && (!scopeBatchDedupe || includedBatches.size !== 1)) {
  throw new Error("--retain-zero-engagement requires --scope-batch-dedupe and exactly one explicit --include-batches value.");
}

const targetPublicArtifact = targetPath === canonicalPublicEvidencePath
  ? await readPublicEvidenceArtifact(targetPath, { rootDir: root })
  : null;
const target = targetPublicArtifact?.snapshot ?? await readJson(targetPath);
const inputs = await Promise.all(inputPaths.map(readJson));
const entitiesById = targetKind === "a16z" ? await knownA16zEntities() : await knownYcEntities();
const existingRows = Array.isArray(target.evidence) ? target.evidence : [];
const externalRows = await existingExternalEvidence(externalEvidenceRoot);
const rowsByIdentity = new Map();
const rowsByUrl = new Map();
const rowsByContent = new Map();
const sourceByRow = new WeakMap();

for (const entry of externalRows) {
  indexEvidenceRow(entry.row, entry.source);
}
for (const [index, row] of existingRows.entries()) {
  indexEvidenceRow(row, `${relativePath(targetPath)}#evidence[${index}]`);
}

const audit = {
  generatedAt: observedAt,
  target: relativePath(targetPath),
  inputs: inputPaths.map(relativePath),
  before: existingRows.length,
  received: 0,
  accepted: 0,
  updated: 0,
  duplicates: 0,
  duplicateRows: [],
  includedBatches: [...includedBatches],
  ...(scopeBatchDedupe ? { batchScopedDedupe: true } : {}),
  ...(retainZeroEngagement ? { retainZeroEngagement: true } : {}),
  skipped: 0,
  skippedRows: [],
  rejected: 0,
  rejectedRows: []
};

for (const [inputIndex, input] of inputs.entries()) {
  const acceptedEnvelope = !Array.isArray(input) && Array.isArray(input.accepted);
  const rows = Array.isArray(input)
    ? input
    : Array.isArray(input.evidence)
      ? input.evidence
      : acceptedEnvelope
        ? input.accepted.map((row) => ({ ...row, review_state: row.review_state ?? "verified" }))
        : [];
  for (const [rowIndex, row] of rows.entries()) {
    audit.received += 1;
    if (includedBatches.size > 0) {
      const rowBatch = cleanString(row?.batchSlug ?? row?.batch)?.toUpperCase();
      if (!rowBatch) {
        audit.rejected += 1;
        audit.rejectedRows.push({
          input: relativePath(inputPaths[inputIndex]),
          row: rowIndex,
          platform: normalizePlatform(row?.platform) ?? row?.platform ?? null,
          sourceUrl: canonicalUrl(row?.sourceUrl ?? row?.url ?? row?.canonicalUrl),
          reasons: ["batch_filter_requires_batch"]
        });
        continue;
      }
      if (!includedBatches.has(rowBatch)) {
        audit.skipped += 1;
        audit.skippedRows.push({
          input: relativePath(inputPaths[inputIndex]),
          row: rowIndex,
          batch: rowBatch,
          platform: normalizePlatform(row?.platform) ?? row?.platform ?? null,
          sourceUrl: canonicalUrl(row?.sourceUrl ?? row?.url ?? row?.canonicalUrl)
        });
        continue;
      }
    }
    const result = normalizeEvidence(row, inputPaths[inputIndex], rowIndex, entitiesById, targetKind);
    if (!result.ok) {
      audit.rejected += 1;
      audit.rejectedRows.push(result.rejection);
      continue;
    }

    const duplicate = findDuplicate(result.row, result.entityId);
    if (duplicate) {
      const existing = duplicate.row;
      audit.duplicates += 1;
      audit.duplicateRows.push({
        input: relativePath(inputPaths[inputIndex]),
        row: rowIndex,
        platform: result.row.platform,
        sourceUrl: result.row.sourceUrl,
        platformPostId: result.row.platformPostId,
        duplicateReason: duplicate.reason,
        existingSource: sourceByRow.get(existing) ?? null,
        existingId: cleanString(existing.id),
        existingEntityId: canonicalEntityId(existing, entitiesById, targetKind),
        existingSourceUrl: canonicalUrl(existing.sourceUrl ?? existing.url ?? existing.canonicalUrl),
        ...(duplicate.contentIdentity
          ? {
              contentBodySha256: duplicate.contentIdentity.bodySha256,
              incomingPublishedAt: duplicate.incomingContentIdentity.publishedAt,
              incomingPublicationPrecision: duplicate.incomingContentIdentity.publicationPrecision,
              existingPublishedAt: duplicate.contentIdentity.publishedAt,
              existingPublicationPrecision: duplicate.contentIdentity.publicationPrecision
            }
          : {})
      });
      const index = existingRows.indexOf(existing);
      if (index < 0) {
        continue;
      }
      if (!sameAttribution(existing, result.entityId, entitiesById, targetKind)) {
        audit.rejected += 1;
        audit.rejectedRows.push({
          input: relativePath(inputPaths[inputIndex]),
          row: rowIndex,
          platform: result.row.platform,
          sourceUrl: result.row.sourceUrl,
          reasons: ["attribution_conflict"]
        });
      } else if (
        duplicate.reason !== "same_platform_author_substantive_body" &&
        !appendOnly &&
        (refreshGenerated
          ? cleanString(existing.id) === cleanString(result.row.id)
          : shouldReplaceObservation(existing, result.row))
      ) {
        if (targetKind === "yc") {
          result.row.first_seen_at = refreshGenerated
            ? earliestTimestamp(existing.first_seen_at, result.row.first_seen_at)
            : existing.first_seen_at ?? result.row.first_seen_at;
        }
        existingRows[index] = result.row;
        indexEvidenceRow(result.row, `${relativePath(targetPath)}#evidence[${index}]`);
        audit.updated += 1;
      }
      continue;
    }

    const index = existingRows.length;
    existingRows.push(result.row);
    indexEvidenceRow(
      result.row,
      `${relativePath(inputPaths[inputIndex])}#row[${rowIndex}] -> ${relativePath(targetPath)}#evidence[${index}]`
    );
    audit.accepted += 1;
  }
}

target.evidence = appendOnly ? existingRows : existingRows.sort(compareEvidence);
target.source = target.source && typeof target.source === "object" ? target.source : {};
if (targetKind === "a16z") {
  target.source.generatedAt = observedAt;
} else {
  target.source.fetchedAt = observedAt;
}
target.source.evidenceCount = target.evidence.length;
target.source.sourceHuntImportedAt = observedAt;
target.source.notes = Array.isArray(target.source.notes) ? target.source.notes : [];
const note = `Imported ${audit.accepted} strict native rows from ${inputPaths.map((path) => basename(path)).join(", ")}; refreshed ${audit.updated} duplicates and rejected ${audit.rejected}.`;
if (!target.source.notes.includes(note)) target.source.notes.push(note);
audit.after = target.evidence.length;

if (auditPath) await writeJsonAtomic(resolve(root, auditPath), audit);
if (strict && audit.rejected > 0) {
  console.log(JSON.stringify({
    ...audit,
    duplicateRows: audit.duplicateRows.slice(0, 25),
    skippedRows: audit.skippedRows.slice(0, 25),
    rejectedRows: audit.rejectedRows.slice(0, 25),
    dryRun
  }, null, 2));
  throw new Error(`Strict import rejected ${audit.rejected} row(s); target was not written.`);
}
if (writeMode) {
  if (targetPublicArtifact) {
    await writePublicEvidenceArtifactPairAtomic({
      rootDir: root,
      canonicalPath: targetPath,
      snapshot: target,
      expectedCanonicalSha256: targetPublicArtifact.canonicalSha256,
      expectedLedgerSha256: targetPublicArtifact.ledgerSha256,
      expectedReviewLedgerSha256: targetPublicArtifact.reviewLedgerSha256
    });
  } else {
    await writeJsonAtomic(targetPath, target);
  }
}

console.log(JSON.stringify({
  ...audit,
  duplicateRows: audit.duplicateRows.slice(0, 25),
  skippedRows: audit.skippedRows.slice(0, 25),
  rejectedRows: audit.rejectedRows.slice(0, 25),
  dryRun
}, null, 2));

function normalizeEvidence(row, inputPath, rowIndex, entitiesById, targetKind) {
  const platform = normalizePlatform(row?.platform);
  const sourceUrl = canonicalUrl(row?.sourceUrl ?? row?.url ?? row?.canonicalUrl);
  const native = nativeIdentity(platform, sourceUrl);
  const suppliedPostId = cleanString(row?.platformPostId ?? row?.nativeId);
  const metricResult = normalizeMetrics(platform, row?.metrics);
  const metrics = metricResult.metrics;
  const inferredAttribution = resolveInputAttribution(row, entitiesById, targetKind);
  const entityId = cleanString(row?.entityId) ?? inferredAttribution?.entityId ?? null;
  const entity = entityId ? entitiesById.get(entityId) : null;
  const entityType = cleanString(row?.entityType) ?? inferredAttribution?.entityType ?? null;
  const rawVisibleText = serializedVisibleText(row?.rawVisibleText);
  const postedAt = nativePublicationTimestamp(
    platform,
    row?.postedAt ?? row?.publishedAt,
    rawVisibleText,
    sourceUrl
  );
  const rawAuthor = authorFromRawVisibleText(rawVisibleText);
  const authorName = cleanString(row?.authorName ?? row?.voiceName ?? row?.author?.name) ?? rawAuthor.name;
  const matchReason = cleanString(row?.matchReason ?? row?.evidenceReason ?? row?.verificationNotes);
  const reasons = [];

  if (!platform) reasons.push("unsupported_platform");
  if (!sourceUrl) reasons.push("invalid_url");
  if (!native?.postId) reasons.push("not_native_activity_url");
  if (suppliedPostId && native?.postId && identityPostId(platform, suppliedPostId) !== identityPostId(platform, native.postId)) {
    reasons.push("native_id_conflict");
  }
  const zeroEngagement = !hasPositiveScoringMetric(platform, metrics);
  const unscoredNativePlatform = ["tiktok", "facebook", "threads"].includes(platform);
  const captionlessHistory = ["x", "instagram", "linkedin", "tiktok", "facebook"].includes(platform) && row.captionAbsent === true;
  const nativeYouTubeDom = platform === "youtube" && /^authorized_native_youtube_.*_dom_v1$/.test(row.attributionProvenance ?? "");
  const unknownYouTubePublication = nativeYouTubeDom && row.attributionProvenance === NATIVE_YOUTUBE_UNKNOWN_DATE_SOURCE;
  if (platform === "x" && row.captionAbsent === true) reasons.push(...nativeXCaptionlessPostReasons(row));
  if (platform === "tiktok") reasons.push(...verifiedNativeTikTokReasons(row, entity));
  if (platform === "facebook") reasons.push(...verifiedNativeFacebookReasons(row, entity));
  if (platform === "threads") reasons.push(...verifiedNativeThreadsReasons(row));
  if (nativeYouTubeDom) reasons.push(...nativeYouTubeDomReasons(row, entity));
  if (unknownYouTubePublication && !zeroEngagement) {
    if (!retainZeroEngagement) reasons.push("unknown_native_publication_requires_unscored_retention_opt_in");
    else reasons.push(...verifiedZeroNativeReasons(row, platform, native, entity, rawVisibleText, metrics));
  }
  if (platform === "linkedin" && row.attributionProvenance === "native_linkedin_founder_history_v1") reasons.push(...verifiedNativeLinkedInFounderHistoryReasons(row, { ...entity, entityId }));
  if (platform === "linkedin" && row.attributionProvenance === "native_linkedin_company_detail_v1") reasons.push(...verifiedNativeLinkedInCompanyDetailReasons(row, { ...entity, entityId }));
  if (zeroEngagement) {
    if (!retainZeroEngagement) reasons.push("no_visible_positive_scoring_metrics");
    else reasons.push(...verifiedZeroNativeReasons(row, platform, native, entity, rawVisibleText, metrics));
  }
  if (captionlessHistory && !zeroEngagement) {
    if (!retainZeroEngagement) reasons.push("captionless_native_history_requires_retention_opt_in");
    else reasons.push(...verifiedZeroNativeReasons(row, platform, native, entity, rawVisibleText, metrics));
  }
  if (metricResult.unsupported.length > 0) reasons.push(`unsupported_metrics:${metricResult.unsupported.join(",")}`);
  if (row?.review_state !== "verified") reasons.push("not_verified");
  if (["invalid", "blocked"].includes(row?.linkStatus)) reasons.push("invalid_link");
  if (!entityId || !["company", "founder"].includes(entityType)) {
    reasons.push("missing_attribution");
  }
  if (entityId && !entity) reasons.push("unknown_entity");
  if (entity && entityType !== entity.entityType) reasons.push("entity_type_conflict");

  if (targetKind === "a16z" && entity) {
    if (cleanString(row.companySlug) && slugify(row.companySlug) !== entity.companySlug) {
      reasons.push("company_slug_conflict");
    }
    if (cleanString(row.companyName) && slugify(row.companyName) !== slugify(entity.companyName)) {
      reasons.push("company_name_conflict");
    }
    if (
      entity.entityType === "founder" &&
      cleanString(row.founderName) &&
      slugify(row.founderName) !== slugify(entity.founderName)
    ) {
      reasons.push("founder_name_conflict");
    }
    if (!postedAt) reasons.push("missing_posted_at");
    if (!authorName) reasons.push("missing_author");
    if (!matchReason) reasons.push("missing_attribution_reason");
  }

  if (reasons.length > 0) {
    return {
      ok: false,
      rejection: {
        input: relativePath(inputPath),
        row: rowIndex,
        platform: platform ?? row?.platform ?? null,
        sourceUrl: sourceUrl ?? row?.sourceUrl ?? null,
        reasons
      }
    };
  }

  const platformPostId = native.postId;
  const title = cleanString(row.title ?? row.text ?? row.content ?? row.body) ?? `${displayPlatform(platform)} activity`;
  const exactNativeLinkedInBody = platform === "linkedin" && ["native_linkedin_founder_history_v1", "native_linkedin_company_detail_v1"].includes(row.attributionProvenance);
  const text = captionlessHistory ? "" : ["tiktok", "facebook", "threads"].includes(platform) || exactNativeLinkedInBody || nativeYouTubeDom ? row.text : cleanString(row.text ?? row.content ?? row.body) ?? title;
  const checkedAt = observedAt;
  const id = scopeBatchDedupe
    ? stableId(`${explicitBatchSlug(row)}:${platform}:${platformPostId}:${entityId}`)
    : cleanString(row.id) ?? stableId(`${platform}:${platformPostId}:${entityId}`);
  if (targetKind === "a16z") {
    const normalized = {
      ...(scopeBatchDedupe ? { batchSlug: explicitBatchSlug(row) } : {}),
      companySlug: entity.companySlug,
      companyName: entity.companyName,
      entityType: entity.entityType,
      ...(entity.entityType === "founder" ? { founderName: entity.founderName } : {}),
      platform,
      sourceUrl,
      platformPostId,
      accountUrl: canonicalUrl(row.accountUrl),
      authorName,
      authorHandle: cleanString(row.authorHandle ?? row?.author?.handle ?? row?.author?.username) ?? rawAuthor.handle,
      postedAt,
      title,
      text,
      mediaType: normalizeMediaType(row.mediaType, platform, sourceUrl),
      ...(cleanString(row.mediaUrl) ? { mediaUrl: cleanString(row.mediaUrl) } : {}),
      ...(Array.isArray(row.mediaUrls)
        ? { mediaUrls: row.mediaUrls.map(cleanString).filter(Boolean) }
        : {}),
      ...(cleanString(row.thumbnailUrl) ? { thumbnailUrl: cleanString(row.thumbnailUrl) } : {}),
      ...(cleanString(row.thumbnailSource) ? { thumbnailSource: cleanString(row.thumbnailSource) } : {}),
      metrics,
      ...(zeroEngagement || captionlessHistory ? zeroEngagementFields(row, captionlessHistory) : {}),
      ...(unscoredNativePlatform ? unscoredNativePlatformFields(row, platform) : {}),
      rawVisibleText: rawVisibleText ?? JSON.stringify({
        source: "strict_source_hunt",
        metrics,
        verification: matchReason
      }),
      matchReason,
      why: cleanString(row.why) ?? `Imported from ${relativePath(inputPath)} after strict native item, metric, attribution, and canonical dedupe validation.`,
      review_state: "verified"
    };

    return {
      ok: true,
      row: normalized,
      entityId,
      identity: `${platform}:post:${identityPostId(platform, platformPostId)}`,
      urlIdentity: `${platform}:url:${sourceUrl.toLowerCase()}`
    };
  }

  const normalized = {
    ...row,
    id,
    entityType,
    entityId,
    companyName: cleanString(row.companyName ?? row.company) ?? cleanString(row.entityName) ?? entity?.companyName ?? entityId,
    platform,
    title,
    sourceUrl,
    platformPostId,
    authorName,
    authorHandle: cleanString(row.authorHandle ?? row?.author?.handle ?? row?.author?.username) ?? rawAuthor.handle,
    text,
    rawVisibleText: rawVisibleText ?? JSON.stringify({
      source: "strict_source_hunt",
      metrics,
      verification: matchReason ?? "Native activity URL with visible positive metrics."
    }),
    postedAt,
    metrics,
    contributionScore: zeroEngagement || captionlessHistory || unknownYouTubePublication ? 0 : Math.max(1, finiteNumber(row.contributionScore) ?? 1),
    ...(zeroEngagement || captionlessHistory ? zeroEngagementFields(row, captionlessHistory) : {}),
    ...(unscoredNativePlatform ? unscoredNativePlatformFields(row, platform) : {}),
    review_state: "verified",
    matchReason: matchReason ?? "Native activity URL from a verified company or founder account with visible metrics.",
    first_seen_at: validTimestamp(row.first_seen_at) ?? observedAt,
    last_checked_at: checkedAt,
    last_updated_at:
      nativeRepositoryActivityTimestamp(platform, rawVisibleText, sourceUrl) ??
      validTimestamp(row.last_updated_at) ??
      postedAt ??
      checkedAt
  };

  return {
    ok: true,
    row: normalized,
    entityId,
    identity: `${platform}:post:${identityPostId(platform, platformPostId)}`,
    urlIdentity: `${platform}:url:${sourceUrl.toLowerCase()}`
  };
}

function normalizedIdentity(row) {
  const platform = normalizePlatform(row?.platform);
  const sourceUrl = canonicalUrl(row?.sourceUrl ?? row?.url ?? row?.canonicalUrl);
  const native = nativeIdentity(platform, sourceUrl);
  const platformPostId = cleanString(row?.platformPostId ?? row?.nativeId ?? native?.postId);
  return {
    identity: platform && platformPostId ? `${platform}:post:${identityPostId(platform, platformPostId)}` : null,
    urlIdentity: platform && sourceUrl ? `${platform}:url:${sourceUrl.toLowerCase()}` : null
  };
}

function indexEvidenceRow(row, source) {
  if (!row || typeof row !== "object") return;
  sourceByRow.set(row, source);
  const normalized = normalizedIdentity(row);
  const entityId = canonicalEntityId(row, entitiesById, targetKind);
  const identityKey = attributedIdentityKey(normalized.identity, entityId, row);
  const urlKey = attributedIdentityKey(normalized.urlIdentity, entityId, row);
  if (identityKey) rowsByIdentity.set(identityKey, row);
  if (urlKey) rowsByUrl.set(urlKey, row);

  const contentIdentity = evidenceContentIdentity(row, entityId);
  if (!contentIdentity) return;
  for (const physicalKey of contentIdentity.keys) {
    const contentKey = attributedIdentityKey(physicalKey, entityId, row);
    if (!contentKey) continue;
    const indexed = rowsByContent.get(contentKey) ?? [];
    indexed.push({ row, contentIdentity });
    rowsByContent.set(contentKey, indexed);
  }
}

function findDuplicate(row, entityId) {
  const normalized = normalizedIdentity(row);
  const identityKey = attributedIdentityKey(normalized.identity, entityId, row);
  const identityMatch = identityKey ? rowsByIdentity.get(identityKey) : null;
  if (identityMatch) return { row: identityMatch, reason: "same_platform_post_id" };

  const urlKey = attributedIdentityKey(normalized.urlIdentity, entityId, row);
  const urlMatch = urlKey ? rowsByUrl.get(urlKey) : null;
  if (urlMatch) return { row: urlMatch, reason: "same_canonical_source_url" };

  const incomingContentIdentity = evidenceContentIdentity(row, entityId);
  if (!incomingContentIdentity) return null;
  for (const physicalKey of incomingContentIdentity.keys) {
    const contentKey = attributedIdentityKey(physicalKey, entityId, row);
    for (const indexed of rowsByContent.get(contentKey) ?? []) {
      if (!sourceAuthorsCompatible(incomingContentIdentity, indexed.contentIdentity)) continue;
      if (!publicationTimesCompatible(incomingContentIdentity, indexed.contentIdentity)) continue;
      // Full native Facebook history may repeat a caption on separate physical
      // reels. Both exact owner/permalink receipts must pass; ID and URL matches
      // above still dedupe, and other platforms retain their default contract.
      const entity = entitiesById.get(entityId);
      if (scopeBatchDedupe && retainZeroEngagement && explicitBatchSlug(row) === "F26" && row.platform === "facebook"
        && row.platformPostId !== indexed.row.platformPostId
        && verifiedNativeFacebookReasons(row, entity).length === 0
        && verifiedNativeFacebookReasons(indexed.row, entity).length === 0) continue;
      return {
        row: indexed.row,
        reason: "same_platform_author_substantive_body",
        contentIdentity: indexed.contentIdentity,
        incomingContentIdentity
      };
    }
  }
  return null;
}

function evidenceContentIdentity(row, entityId) {
  const entity = entityId ? entitiesById.get(entityId) : null;
  const rawVisibleText = serializedVisibleText(row?.rawVisibleText);
  const rawAuthor = authorFromRawVisibleText(rawVisibleText);
  const platform = normalizePlatform(row?.platform) ?? row?.platform;
  const sourceUrl = canonicalUrl(row?.sourceUrl ?? row?.url ?? row?.canonicalUrl);
  return sourceContentIdentity({
    platform,
    authorName: cleanString(row?.authorName ?? row?.voiceName ?? row?.author?.name) ?? rawAuthor.name,
    authorHandle: cleanString(row?.authorHandle ?? row?.author?.handle ?? row?.author?.username) ?? rawAuthor.handle,
    authorUrl: cleanString(row?.authorUrl ?? row?.author?.url),
    accountUrl: cleanString(row?.accountUrl),
    sourceUrl,
    fallbackAuthorName: entity?.founderName ?? entity?.companyName,
    body: cleanString(row?.text ?? row?.content ?? row?.body),
    postedAt: nativePublicationTimestamp(
      platform,
      row?.postedAt ?? row?.publishedAt,
      rawVisibleText,
      sourceUrl
    )
  });
}

function explicitBatchSlug(row) {
  return cleanString(row?.batchSlug ?? row?.batch)?.toUpperCase() ?? null;
}

function attributedIdentityKey(physicalIdentity, entityId, row) {
  if (!physicalIdentity || !entityId) return null;
  const attribution = `${entityId}:${physicalIdentity}`;
  return scopeBatchDedupe
    ? `${explicitBatchSlug(row) ?? "[unscoped]"}:${attribution}`
    : attribution;
}

function resolveInputAttribution(row, entitiesById, targetKind) {
  const supplied = cleanString(row?.entityId);
  if (supplied) {
    const entity = entitiesById.get(supplied);
    return entity ? { entityId: supplied, entityType: entity.entityType } : null;
  }
  if (targetKind !== "yc") return null;

  const companyName = cleanString(row?.companyName ?? row?.company);
  if (!companyName) return null;
  const matches = [...entitiesById.entries()].filter(([, entity]) =>
    entity.entityType === "company" && slugify(entity.companyName) === slugify(companyName)
  );
  if (matches.length !== 1) return null;
  return { entityId: matches[0][0], entityType: "company" };
}

function serializedVisibleText(value) {
  if (value && typeof value === "object") return JSON.stringify(value);
  return cleanString(value);
}

/**
 * A repository's publication date is its native creation timestamp. Push,
 * update, observation, and import clocks are activity metadata and must never
 * make an existing repository look newly published.
 */
function nativePublicationTimestamp(platform, suppliedValue, rawVisibleText, sourceUrl) {
  if (platform !== "github") return validTimestamp(suppliedValue);

  const raw = parsedVisibleText(rawVisibleText);
  const expectedIdentity = githubRepositoryIdentity(sourceUrl);
  const repository = matchingGithubRepositoryRecord(raw?.repository, expectedIdentity, false);
  const repo = matchingGithubRepositoryRecord(raw?.repo, expectedIdentity, false);
  const canonicalRepository = matchingGithubRepositoryRecord(
    raw?.canonicalRepository,
    expectedIdentity,
    false
  );
  const post = matchingGithubRepositoryRecord(
    raw?.post,
    expectedIdentity,
    true,
    raw
  );
  return firstValidTimestamp(
    repository?.createdAt,
    repository?.created_at,
    repository?.repositoryCreatedAt,
    repository?.repository_created_at,
    repository?.repositoryTimestamps?.createdAt,
    repository?.repositoryTimestamps?.created_at,
    repository?.repositoryTimestamps?.repositoryCreatedAt,
    repository?.repositoryTimestamps?.repository_created_at,
    repo?.createdAt,
    repo?.created_at,
    repo?.repositoryCreatedAt,
    repo?.repository_created_at,
    repo?.repositoryTimestamps?.createdAt,
    repo?.repositoryTimestamps?.created_at,
    repo?.repositoryTimestamps?.repositoryCreatedAt,
    repo?.repositoryTimestamps?.repository_created_at,
    canonicalRepository?.createdAt,
    canonicalRepository?.created_at,
    canonicalRepository?.repositoryCreatedAt,
    canonicalRepository?.repository_created_at,
    canonicalRepository?.repositoryTimestamps?.createdAt,
    canonicalRepository?.repositoryTimestamps?.created_at,
    canonicalRepository?.repositoryTimestamps?.repositoryCreatedAt,
    canonicalRepository?.repositoryTimestamps?.repository_created_at,
    post?.createdAt,
    post?.created_at,
    post?.repositoryCreatedAt,
    post?.repository_created_at,
    post?.repositoryTimestamps?.createdAt,
    post?.repositoryTimestamps?.created_at,
    post?.repositoryTimestamps?.repositoryCreatedAt,
    post?.repositoryTimestamps?.repository_created_at,
    raw?.repositoryTimestamps?.createdAt,
    raw?.repositoryTimestamps?.created_at,
    raw?.repositoryTimestamps?.repositoryCreatedAt,
    raw?.repositoryTimestamps?.repository_created_at,
    raw?.repositoryCreatedAt,
    raw?.repository_created_at
  );
}

function nativeRepositoryActivityTimestamp(platform, rawVisibleText, sourceUrl) {
  if (platform !== "github") return null;
  const raw = parsedVisibleText(rawVisibleText);
  const expectedIdentity = githubRepositoryIdentity(sourceUrl);
  const repository = matchingGithubRepositoryRecord(raw?.repository, expectedIdentity, false);
  const repo = matchingGithubRepositoryRecord(raw?.repo, expectedIdentity, false);
  const canonicalRepository = matchingGithubRepositoryRecord(
    raw?.canonicalRepository,
    expectedIdentity,
    false
  );
  const post = matchingGithubRepositoryRecord(
    raw?.post,
    expectedIdentity,
    true,
    raw
  );
  return latestValidTimestamp(
    repository?.pushedAt,
    repository?.pushed_at,
    repository?.updatedAt,
    repository?.updated_at,
    repository?.repositoryTimestamps?.pushedAt,
    repository?.repositoryTimestamps?.pushed_at,
    repository?.repositoryTimestamps?.updatedAt,
    repository?.repositoryTimestamps?.updated_at,
    repo?.pushedAt,
    repo?.pushed_at,
    repo?.updatedAt,
    repo?.updated_at,
    repo?.repositoryTimestamps?.pushedAt,
    repo?.repositoryTimestamps?.pushed_at,
    repo?.repositoryTimestamps?.updatedAt,
    repo?.repositoryTimestamps?.updated_at,
    canonicalRepository?.pushedAt,
    canonicalRepository?.pushed_at,
    canonicalRepository?.updatedAt,
    canonicalRepository?.updated_at,
    canonicalRepository?.repositoryTimestamps?.pushedAt,
    canonicalRepository?.repositoryTimestamps?.pushed_at,
    canonicalRepository?.repositoryTimestamps?.updatedAt,
    canonicalRepository?.repositoryTimestamps?.updated_at,
    post?.pushedAt,
    post?.pushed_at,
    post?.updatedAt,
    post?.updated_at,
    post?.repositoryTimestamps?.pushedAt,
    post?.repositoryTimestamps?.pushed_at,
    post?.repositoryTimestamps?.updatedAt,
    post?.repositoryTimestamps?.updated_at,
    raw?.repositoryTimestamps?.pushedAt,
    raw?.repositoryTimestamps?.pushed_at,
    raw?.repositoryTimestamps?.updatedAt,
    raw?.repositoryTimestamps?.updated_at,
    raw?.repositoryPushedAt,
    raw?.repository_pushed_at,
    raw?.repositoryUpdatedAt,
    raw?.repository_updated_at
  );
}

function matchingGithubRepositoryRecord(value, expectedIdentity, requireIdentity, raw = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (requireIdentity && githubCommitProvenance(raw, value)) return null;

  const identity = githubRepositoryIdentity(
    value.url ?? value.htmlUrl ?? value.html_url,
    value.fullName ?? value.full_name ?? value.id
  );
  if (identity && expectedIdentity && identity !== expectedIdentity) return null;
  if (requireIdentity && (!identity || !expectedIdentity || identity !== expectedIdentity)) return null;
  return value;
}

function githubCommitProvenance(raw, record = null) {
  const kind = cleanString(raw?.sourceProvenance?.kind ?? raw?.provenance?.kind)?.toLowerCase();
  if (kind === "github_commit") return true;

  return [
    raw?.sourceProvenance?.sourceUrl,
    raw?.sourceProvenance?.url,
    raw?.provenance?.sourceUrl,
    raw?.provenance?.url,
    record?.sourceUrl,
    record?.url,
    record?.htmlUrl,
    record?.html_url
  ].some((value) => /\/commit\/[0-9a-f]+(?:[/?#]|$)/i.test(String(value ?? "")));
}

function githubRepositoryIdentity(sourceUrl, platformPostId = null) {
  const canonicalSourceUrl = canonicalUrl(sourceUrl);
  const native = nativeIdentity("github", canonicalSourceUrl);
  if (native?.postId) return native.postId.toLowerCase();

  const candidate = cleanString(platformPostId)?.replace(/^\/+|\/+$/g, "");
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(candidate ?? "")
    ? candidate.toLowerCase()
    : null;
}

function parsedVisibleText(value) {
  const text = cleanString(value);
  if (!text?.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function firstValidTimestamp(...values) {
  for (const value of values) {
    const timestamp = validTimestamp(value);
    if (timestamp) return timestamp;
  }
  return null;
}

function latestValidTimestamp(...values) {
  return values
    .map((value) => validTimestamp(value))
    .filter(Boolean)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
}

function nativeIdentity(platform, sourceUrl) {
  if (!platform || !sourceUrl) return null;
  const url = new URL(sourceUrl);
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const parts = url.pathname.split("/").filter(Boolean);

  if (platform === "x" && ["x.com", "twitter.com"].includes(host)) {
    const index = parts.findIndex((part) => part.toLowerCase() === "status");
    if (index > 0 && /^\d+$/.test(parts[index + 1] ?? "")) return { postId: parts[index + 1] };
  }
  if (platform === "tiktok" && ["tiktok.com", "m.tiktok.com"].includes(host)) {
    const match = url.pathname.match(/^\/@[A-Za-z0-9._-]+\/(?:video|photo)\/(\d+)\/?$/);
    if (match) return { postId: match[1] };
  }
  if (platform === "facebook") {
    const identity = facebookNativeIdentity(sourceUrl);
    if (identity?.postId) return { postId: identity.postId };
  }
  if (platform === "threads") {
    const identity = nativeThreadsIdentity(sourceUrl);
    if (identity?.postId) return { postId: identity.postId };
  }
  if (platform === "instagram" && host.endsWith("instagram.com") && /^(p|reel|tv)$/.test(parts[0] ?? "")) {
    if (/^[A-Za-z0-9_-]+$/.test(parts[1] ?? "")) return { postId: parts[1] };
  }
  if (platform === "youtube" && ["youtube.com", "m.youtube.com", "youtu.be"].includes(host)) {
    const id = host === "youtu.be" ? parts[0] : url.searchParams.get("v") ?? (/^(shorts|live)$/.test(parts[0] ?? "") ? parts[1] : null);
    if (/^[A-Za-z0-9_-]{6,}$/.test(id ?? "")) return { postId: id };
  }
  if (platform === "linkedin" && host.endsWith("linkedin.com")) {
    const ugc = url.pathname.match(/^\/feed\/update\/urn:li:ugcPost:(\d{10,})\/?$/i)?.[1]
      ?? url.pathname.match(/^\/posts\/[^/]*-ugcPost-(\d{10,})(?:-[^/]+)?\/?$/i)?.[1];
    if (ugc && (host === "linkedin.com" || host.endsWith(".linkedin.com"))) return { postId: `ugcPost:${ugc}` };
    const activity = sourceUrl.match(/(?:activity[:\-]|activity-)(\d{10,})/i)?.[1];
    const update = sourceUrl.match(/urn:li:(?:activity|share|ugcPost):(\d{10,})/i)?.[1];
    if (activity ?? update) return { postId: activity ?? update };
  }
  if (platform === "github" && host === "github.com" && parts.length === 2 && !["search", "topics", "marketplace"].includes(parts[0].toLowerCase())) {
    return { postId: `${parts[0]}/${parts[1].replace(/\.git$/i, "")}` };
  }
  if (platform === "reddit" && (host === "reddit.com" || host.endsWith(".reddit.com") || host === "redd.it")) {
    const index = parts.findIndex((part) => part === "comments");
    const id = host === "redd.it" ? parts[0] : index >= 0 ? parts[index + 1] : null;
    if (/^[A-Za-z0-9]+$/.test(id ?? "")) return { postId: id.toLowerCase() };
  }
  if (platform === "product_hunt" && host.endsWith("producthunt.com")) {
    const launch = parts.findIndex((part) => part === "launches");
    const post = parts.findIndex((part) => part === "posts");
    const id = launch >= 0 ? parts[launch + 1] : post >= 0 ? parts[post + 1] : null;
    if (/^[A-Za-z0-9_-]+$/.test(id ?? "")) return { postId: id.toLowerCase() };
  }
  if (platform === "hacker_news" && host === "news.ycombinator.com" && url.pathname === "/item" && /^\d+$/.test(url.searchParams.get("id") ?? "")) {
    return { postId: url.searchParams.get("id") };
  }
  return null;
}

function normalizeMetrics(platform, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { metrics: {}, unsupported: [] };
  const aliases = {
    plays: "views",
    points: "upvotes",
    retweets: "reposts",
    openIssues: "issues",
    open_issues: "issues",
    reactions: platform === "linkedin" ? "reactions" : "likes",
    likes: platform === "linkedin" ? "reactions" : "likes",
    comments: platform === "x" ? "replies" : "comments",
    saves: platform === "x" ? "bookmarks" : "saves"
  };
  const derived = new Set(["score", "profile_score", "contribution_score", "max_repo_score"]);
  const allowed = DISPLAY_METRICS[platform] ?? new Set();
  const metrics = {};
  const unsupported = [];
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = aliases[rawKey] ?? rawKey;
    if (derived.has(key)) continue;
    const number = finiteNumber(rawValue);
    if (number == null || number < 0) continue;
    if (!allowed.has(key)) {
      unsupported.push(key);
      continue;
    }
    metrics[key] = number;
  }
  return { metrics, unsupported: [...new Set(unsupported)].sort() };
}

function authorFromRawVisibleText(value) {
  const text = cleanString(value);
  if (!text?.startsWith("{")) return { name: null, handle: null };
  try {
    const parsed = JSON.parse(text);
    const profile = parsed?.profile && typeof parsed.profile === "object" ? parsed.profile : {};
    const post = parsed?.post && typeof parsed.post === "object" ? parsed.post : {};
    return {
      name: cleanString(post.authorName) ?? cleanString(post.name) ?? cleanString(profile.name),
      handle: cleanString(post.authorHandle) ?? cleanString(post.username) ?? cleanString(profile.username)
    };
  } catch {
    return { name: null, handle: null };
  }
}

function hasPositiveScoringMetric(platform, metrics) {
  return [...(SCORING_METRICS[platform] ?? [])].some((key) => Number(metrics[key] ?? 0) > 0);
}

function zeroEngagementFields(row, captionlessHistory = false) {
  return {
    contributionScore: 0,
    tractionStatus: "unscored",
    tractionLimitations: [...new Set([
      ...(Array.isArray(row.tractionLimitations) ? row.tractionLimitations : []),
      captionlessHistory
        ? "Native media has no visible caption. Its native identity, date, owner, media receipt and observed metrics are retained as unscored account-history metadata; no caption text is created."
        : "Native original retained for account history without visible positive scoring metrics. Missing metrics remain unknown and this post contributes no traction score."
    ])]
  };
}

function unscoredNativePlatformFields(row, platform) {
  return { contributionScore: 0, tractionStatus: "unscored", tractionLimitations: [...new Set([...(row.tractionLimitations ?? []), `No calibrated traction model is configured for ${platform}; observed native engagement is retained without a traction contribution.`])] };
}

function nativeYouTubeDomReasons(row, entity) {
  return row.attributionProvenance === NATIVE_YOUTUBE_UNKNOWN_DATE_SOURCE
    ? verifiedNativeYouTubeUnknownDateReasons(row, entity)
    : verifiedNativeYouTubeDomReasons(row, entity);
}

/** This opt-in history lane binds an existing verified account receipt to the
 * exact outer native post. It never upgrades reposts, search hits, or subjects
 * of another account's post into company/founder originals. */
function verifiedZeroNativeReasons(row, platform, native, entity, rawVisibleText, metrics) {
  if (platform === "youtube" && /^authorized_native_youtube_.*_dom_v1$/.test(row.attributionProvenance ?? "")) return [
    ...(!entity?.batchSlugs?.includes(explicitBatchSlug(row)) || !includedBatches.has(explicitBatchSlug(row)) ? ["zero_engagement_requires_explicit_canonical_batch_entity"] : []),
    ...nativeYouTubeDomReasons(row, entity)
  ];
  if (["tiktok", "facebook", "threads"].includes(platform)) {
    return [
      ...(!entity?.batchSlugs?.includes(explicitBatchSlug(row)) || !includedBatches.has(explicitBatchSlug(row)) ? ["zero_engagement_requires_explicit_canonical_batch_entity"] : []),
      ...(platform === "tiktok" ? verifiedNativeTikTokReasons(row, entity) : platform === "threads" ? verifiedNativeThreadsReasons(row) : verifiedNativeFacebookReasons(row, entity))
    ];
  }
  const reasons = [];
  const sources = {
    x: "authenticated_native_x_ui_v1",
    linkedin: "authorized_linkedin_browser_dom_v1",
    instagram: "authorized_native_instagram_dom_v1"
  };
  const raw = parsedVisibleText(rawVisibleText);
  const post = raw?.post;
  const batch = explicitBatchSlug(row);
  if (!sources[platform] || raw?.source !== sources[platform] || !post) return ["zero_engagement_requires_native_original_receipt"];
  if (!entity?.batchSlugs?.includes(batch) || !includedBatches.has(batch)) reasons.push("zero_engagement_requires_explicit_canonical_batch_entity");
  const signals = new Set(row.attributionSignals ?? []);
  const requiredSignals = {
    x: ["official_yc_roster_account", "native_post_author"],
    linkedin: entity?.entityType === "founder"
      ? ["official_yc_linked_founder_account", "visible_native_linkedin_post", "visible_author_matches_official_founder"]
      : ["official_yc_linked_company_account", "visible_native_linkedin_post", "visible_author_matches_official_company"],
    instagram: ["mapped_official_account", "exact_native_author"]
  }[platform];
  if (row.attributionVersion !== 3 || row.attributionStatus !== "verified" || !requiredSignals.every((signal) => signals.has(signal))) {
    reasons.push("zero_engagement_requires_verified_account_attribution");
  }
  const rawUrl = canonicalUrl(post.url ?? post.sourceUrl);
  const rawNative = nativeIdentity(platform, rawUrl);
  const rawId = cleanString(post.id ?? post.platformPostId ?? post.shortcode);
  if (!native || rawNative?.postId !== native.postId || rawId !== native.postId) reasons.push("zero_engagement_receipt_native_id_conflict");
  const accountUrl = canonicalUrl(row.accountUrl);
  const authorUrl = canonicalUrl(platform === "linkedin" ? post.author?.profileUrl : platform === "instagram" ? raw.identityProof?.profileUrl : raw.accountUrl);
  if (!accountUrl || accountUrl !== authorUrl) reasons.push("zero_engagement_receipt_owner_conflict");
  const canonicalAccountMatches = entity?.socialAccounts?.[platform]?.some((known) =>
    platform === "x" ? known?.toLowerCase() === accountUrl?.toLowerCase() : known === accountUrl
  );
  if (platform !== "instagram" && !canonicalAccountMatches) reasons.push("zero_engagement_author_not_canonical_account");
  const rowHandle = cleanString(row.authorHandle)?.replace(/^@/, "").toLowerCase();
  const rawHandle = cleanString(post.authorHandle)?.replace(/^@/, "").toLowerCase();
  if (platform !== "linkedin" && (!rowHandle || rowHandle !== rawHandle)) reasons.push("zero_engagement_receipt_author_conflict");
  if (platform === "instagram") {
    if (raw.identityProof?.entityId !== row.entityId || raw.identityProof?.review_state !== "verified") reasons.push("zero_engagement_receipt_identity_conflict");
    const proofDomain = websiteDomain(raw.identityProof?.visibleWebsite);
    if ((!proofDomain || proofDomain !== websiteDomain(entity?.websiteUrl)) && !isOfficialInstagramOutboundReceipt(raw.identityProof?.officialWebsiteOutboundReceipt, { slug: entity?.companySlug, websiteUrl: entity?.websiteUrl }, row.accountUrl) && !isVerifiedInstagramFounderSocialIdentity(raw.identityProof, { ...entity, entityId: row.entityId }) && !isVerifiedInstagramFounderTeamIdentity(raw.identityProof, { ...entity, entityId: row.entityId })) reasons.push("zero_engagement_receipt_official_domain_conflict");
  } else {
    const identityUrl = canonicalUrl(raw.officialIdentitySourceUrl ?? raw.identitySourceUrl);
    if (identityUrl !== canonicalUrl(`https://www.ycombinator.com/companies/${entity?.companySlug}`)) reasons.push("zero_engagement_receipt_identity_conflict");
  }
  const verifiedCaptionAbsent = row.captionAbsent === true && post.captionAbsent === true && (
    platform === "x" && isVerifiedNativeXCaptionlessPost(row) ||
    platform === "instagram" && isVerifiedInstagramCaptionAbsence(post, post.captionAbsenceProof, row.authorHandle, native?.postId) ||
    platform === "linkedin" && isVerifiedLinkedInCaptionAbsence(post, post.captionAbsenceProof, row.accountUrl, native?.postId)
  );
  if (row.captionAbsent === true && !verifiedCaptionAbsent) reasons.push("caption_absence_requires_exact_native_review_receipt");
  if (!verifiedCaptionAbsent && (!cleanString(row.text) || cleanString(row.text) !== cleanString(post.text) || (row.originalText && cleanString(row.originalText) !== cleanString(post.text)))) reasons.push("zero_engagement_receipt_body_conflict");
  if (row.bodyTruncated || post.bodyTruncated || post.is_retweet || post.isRepost || ["repost", "third_party_subject_context"].includes(post.kind)) reasons.push("zero_engagement_requires_original_body");
  const rawMetrics = post.metrics ?? raw.metrics ?? {};
  const rawNormalized = normalizeMetrics(platform, rawMetrics).metrics;
  if (Object.keys(rawNormalized).length !== Object.keys(metrics).length || Object.entries(metrics).some(([key, value]) => rawNormalized[key] !== value)) reasons.push("zero_engagement_receipt_metrics_conflict");
  for (const supplied of [row.metrics ?? {}, rawMetrics]) {
    if (!supplied || typeof supplied !== "object" || Array.isArray(supplied) || Object.values(supplied).some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
      reasons.push("zero_engagement_requires_nonnegative_observed_metrics");
    }
  }
  return [...new Set(reasons)];
}

function sameAttribution(existing, incomingEntityId, entitiesById, targetKind) {
  return canonicalEntityId(existing, entitiesById, targetKind) === incomingEntityId;
}

function canonicalEntityId(row, entitiesById, targetKind) {
  const supplied = cleanString(row?.entityId);
  if (supplied && entitiesById.has(supplied)) return supplied;
  if (targetKind !== "a16z") return supplied;

  const companySlug = slugify(row?.companySlug ?? row?.companyName);
  if (!companySlug) return null;
  if (row?.entityType === "company") {
    const companyId = `a16z-speedrun-006-${companySlug}`;
    return entitiesById.has(companyId) ? companyId : null;
  }
  if (row?.entityType === "founder" && cleanString(row?.founderName)) {
    const founderId = `a16z-speedrun-006-${companySlug}-founder-${slugify(row.founderName)}`;
    return entitiesById.has(founderId) ? founderId : null;
  }
  return null;
}

function shouldReplaceObservation(existing, incoming) {
  const existingCompleteness = positiveMetricCount(existing.metrics);
  const incomingCompleteness = positiveMetricCount(incoming.metrics);
  if (incomingCompleteness !== existingCompleteness) return incomingCompleteness > existingCompleteness;
  return Date.parse(incoming.last_checked_at ?? 0) > Date.parse(existing.last_checked_at ?? 0);
}

function positiveMetricCount(metrics) {
  return Object.values(metrics ?? {}).filter((value) => Number(value) > 0).length;
}

function identityPostId(platform, value) {
  const text = String(value);
  return ["github", "reddit", "product_hunt"].includes(platform) ? text.toLowerCase() : text;
}

function canonicalUrl(value) {
  const text = cleanString(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (!/^https?:$/.test(url.protocol)) return null;
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_.+|fbclid|gclid|igshid|ref|ref_src|source|si|feature|trk)$/i.test(key)) url.searchParams.delete(key);
    }
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    if (url.hostname === "twitter.com" || url.hostname === "www.twitter.com") url.hostname = "x.com";
    if (url.hostname === "www.x.com") url.hostname = "x.com";
    if (url.hostname.startsWith("www.")) url.hostname = url.hostname.slice(4);
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function normalizePlatform(value) {
  const aliases = { twitter: "x", producthunt: "product_hunt", hn: "hacker_news", hackernews: "hacker_news" };
  const platform = aliases[String(value ?? "").toLowerCase()] ?? String(value ?? "").toLowerCase();
  return new Set(["x", "instagram", "linkedin", "tiktok", "facebook", "threads", "youtube", "github", "reddit", "product_hunt", "hacker_news"]).has(platform) ? platform : null;
}

function normalizeMediaType(value, platform, sourceUrl) {
  const supported = new Set(["text", "image", "video", "link", "repo", "launch", "unknown"]);
  const mediaType = String(value ?? "").toLowerCase();
  if (supported.has(mediaType)) return mediaType;
  if (platform === "youtube" || platform === "tiktok") return "video";
  if (platform === "instagram") return /\/(?:reel|tv)\//i.test(sourceUrl) ? "video" : "image";
  if (platform === "github") return "repo";
  if (platform === "product_hunt") return "launch";
  if (["x", "reddit", "hacker_news"].includes(platform)) return "text";
  if (platform === "linkedin") return "link";
  return "unknown";
}

function compareEvidence(left, right) {
  const leftIdentity = normalizedIdentity(left).identity ?? normalizedIdentity(left).urlIdentity ?? left.id;
  const rightIdentity = normalizedIdentity(right).identity ?? normalizedIdentity(right).urlIdentity ?? right.id;
  return leftIdentity.localeCompare(rightIdentity);
}

function stableId(value) {
  return `source-hunt-${createHash("sha256").update(value).digest("hex").slice(0, 20)}`;
}

function validTimestamp(value) {
  const text = cleanString(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : text;
}

function earliestTimestamp(...values) {
  const valid = values
    .map((value) => validTimestamp(value))
    .filter(Boolean)
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  return valid[0] ?? null;
}

function finiteNumber(value) {
  const number = typeof value === "string" ? Number(value.replace(/,/g, "")) : Number(value);
  return Number.isFinite(number) ? number : null;
}

function cleanString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function displayPlatform(platform) {
  return ({ x: "X", product_hunt: "Product Hunt", hacker_news: "Hacker News" })[platform] ?? platform;
}

function stringArg(name) {
  const exact = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function valueArgs(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (arg.startsWith(`${name}=`)) values.push(arg.slice(name.length + 1));
    else if (arg === name && process.argv[index + 1]) values.push(process.argv[index + 1]);
  }
  return values;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function knownYcEntities() {
  const founderAliases = await readJson(resolve(root, "src/lib/social/linkedin-founder-aliases-fall-2026.json"));
  const snapshots = await Promise.all([
    readJson(resolve(root, "src/lib/yc/spring-2026-companies.json")),
    readJson(resolve(root, "src/lib/yc/summer-2026-companies.json")),
    readJson(resolve(root, "src/lib/yc/fall-2026-companies.json"))
  ]);
  const entities = new Map();
  const currentCompanySlugs = new Set();
  for (const [snapshotIndex, snapshot] of snapshots.entries()) {
    const batchSlug = ["S2026", "S26", "F26"][snapshotIndex];
    for (const company of snapshot.companies ?? []) {
      currentCompanySlugs.add(company.slug);
      entities.set(`company-${company.slug}`, {
        entityType: "company",
        companyName: company.name,
        companySlug: company.slug,
        websiteUrl: company.websiteUrl,
        socialAccounts: knownSocialAccounts(company.socialLinks, entities.get(`company-${company.slug}`)?.socialAccounts),
        batchSlugs: [...new Set([...(entities.get(`company-${company.slug}`)?.batchSlugs ?? []), batchSlug])]
      });
      for (const founder of company.founders ?? []) {
        const founderLinks = batchSlug === "F26" ? { ...founder.socialLinks, linkedin: verifiedFallLinkedInFounderAccounts(company, founder, founderAliases) } : founder.socialLinks;
        entities.set(`founder-${company.slug}-${slugify(founder.name)}-${founder.id}`, {
          entityType: "founder",
          companyName: company.name,
          companySlug: company.slug,
          founderName: founder.name,
          websiteUrl: company.websiteUrl,
          socialAccounts: knownSocialAccounts(founderLinks, entities.get(`founder-${company.slug}-${slugify(founder.name)}-${founder.id}`)?.socialAccounts),
          batchSlugs: [...new Set([...(entities.get(`founder-${company.slug}-${slugify(founder.name)}-${founder.id}`)?.batchSlugs ?? []), batchSlug])]
        });
      }
    }
  }
  for (const row of target.evidence ?? []) {
    const entityId = cleanString(row.entityId);
    if (entityId && entityBelongsToCurrentCompany(entityId, currentCompanySlugs)) {
      const existing = entities.get(entityId);
      entities.set(entityId, {
        entityType: row.entityType,
        companyName: row.companyName ?? existing?.companyName,
        companySlug: row.companySlug ?? existing?.companySlug,
        founderName: existing?.founderName,
        websiteUrl: existing?.websiteUrl,
        socialAccounts: existing?.socialAccounts,
        batchSlugs: existing?.batchSlugs
      });
    }
  }
  return entities;
}

function knownSocialAccounts(links, previous = {}) {
  const result = { ...previous };
  for (const [platform, value] of Object.entries(links ?? {})) {
    for (const candidate of Array.isArray(value) ? value : [value]) {
      const url = canonicalUrl(candidate);
      if (url) result[platform] = [...new Set([...(result[platform] ?? []), url])];
    }
  }
  return result;
}

function websiteDomain(value) {
  const text = cleanString(value);
  if (!text) return null;
  try { return new URL(text.includes("://") ? text : `https://${text}`).hostname.toLowerCase().replace(/^www\./, ""); }
  catch { return null; }
}

async function knownA16zEntities() {
  const snapshot = await readJson(resolve(root, "src/lib/social/a16z-speedrun-006-social-accounts.json"));
  if (snapshot?.source?.batchSlug !== "A16ZSR006" || !Array.isArray(snapshot.companies)) {
    throw new Error("The A16ZSR006 social-account snapshot is missing or malformed.");
  }

  const entities = new Map();
  for (const company of snapshot.companies) {
    const companyName = cleanString(company.companyName);
    const companySlug = slugify(company.companySlug ?? companyName);
    if (!companyName || !companySlug) throw new Error("A16ZSR006 company attribution is missing a name or slug.");

    addUniqueEntity(entities, `a16z-speedrun-006-${companySlug}`, {
      entityType: "company",
      companyName,
      companySlug,
      batchSlugs: ["A16ZSR006"]
    });
    for (const founder of company.founders ?? []) {
      const founderName = cleanString(founder.name);
      if (!founderName) throw new Error(`A16ZSR006 founder attribution is missing a name for ${companySlug}.`);
      addUniqueEntity(entities, `a16z-speedrun-006-${companySlug}-founder-${slugify(founderName)}`, {
        entityType: "founder",
        companyName,
        companySlug,
        founderName,
        batchSlugs: ["A16ZSR006"]
      });
    }
  }
  return entities;
}

function addUniqueEntity(entities, entityId, entity) {
  if (entities.has(entityId)) throw new Error(`Duplicate canonical entity ID: ${entityId}`);
  entities.set(entityId, entity);
}

function entityBelongsToCurrentCompany(entityId, companySlugs) {
  if (entityId.startsWith("company-")) return companySlugs.has(entityId.slice("company-".length));
  if (!entityId.startsWith("founder-")) return false;
  const suffix = entityId.slice("founder-".length);
  return [...companySlugs].some((slug) => suffix.startsWith(`${slug}-`));
}

async function existingExternalEvidence(snapshotRoot) {
  const evidencePaths = [
    "src/lib/social/a16z-speedrun-006-social-evidence.json",
    "src/lib/social/public-evidence-current.json",
    "src/lib/social/logged-in-evidence-current.json",
    "src/lib/social/targeted-evidence-current.json"
  ];
  const githubPaths = [
    "src/lib/social/github-traction.json",
    "src/lib/social/github-traction-summer-2026.json",
    "src/lib/social/github-traction-a16z-speedrun-006.json"
  ];
  const [evidenceSnapshots, githubSnapshots] = await Promise.all([
    Promise.all(evidencePaths.map(async (path) => ({ path, snapshot: await readJson(resolve(snapshotRoot, path)) }))),
    Promise.all(githubPaths.map(async (path) => ({ path, snapshot: await readJson(resolve(snapshotRoot, path)) })))
  ]);
  return [
    ...evidenceSnapshots.flatMap(({ path, snapshot }) =>
      Array.isArray(snapshot.evidence)
        ? snapshot.evidence.map((row, index) => ({ row, source: `${path}#evidence[${index}]` }))
        : []
    ),
    ...githubSnapshots.flatMap(({ path, snapshot }) => githubRepositoryEvidence(snapshot, path))
  ];
}

function githubRepositoryEvidence(snapshot, sourcePath) {
  return (snapshot.accounts ?? []).flatMap((account, accountIndex) =>
    (account.repos ?? []).flatMap((repo, repoIndex) => {
      const fullName = cleanString(repo.fullName);
      const sourceUrl = canonicalUrl(repo.htmlUrl ?? (fullName ? `https://github.com/${fullName}` : null));
      if (!sourceUrl || !fullName) return [];
      return [{
        row: {
          entityType: account.entityType,
          entityId: account.entityId,
          platform: "github",
          sourceUrl,
          platformPostId: fullName
        },
        source: `${sourcePath}#accounts[${accountIndex}].repos[${repoIndex}]`
      }];
    })
  );
}

function slugify(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function writeJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

function relativePath(path) {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}
