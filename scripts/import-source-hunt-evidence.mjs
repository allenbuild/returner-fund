import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  publicationTimesCompatible,
  sourceAuthorsCompatible,
  sourceContentIdentity
} from "./lib/source-content-identity.mjs";

const DISPLAY_METRICS = {
  github: new Set(["stars", "forks", "recent_commits_30d", "issues", "watchers", "subscribers"]),
  x: new Set(["views", "likes", "replies", "reposts", "quotes", "bookmarks"]),
  linkedin: new Set(["views", "reactions", "comments", "reposts"]),
  instagram: new Set(["views", "likes", "comments", "shares", "saves"]),
  product_hunt: new Set(["upvotes", "comments"]),
  youtube: new Set(["views", "likes", "comments"]),
  hacker_news: new Set(["upvotes", "comments"]),
  reddit: new Set(["upvotes", "comments"])
};

const SCORING_METRICS = {
  github: new Set(["stars", "forks", "recent_commits_30d", "issues"]),
  x: new Set(["views", "likes", "replies", "reposts", "quotes"]),
  linkedin: new Set(["views", "reactions", "comments", "reposts"]),
  instagram: new Set(["views", "likes", "comments", "shares", "saves"]),
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
const externalEvidenceRoot = resolve(root, stringArg("--external-evidence-root") ?? ".");
const auditPath = stringArg("--audit-output");
const dryRun = process.argv.includes("--dry-run");
const writeMode = process.argv.includes("--write");
const strict = process.argv.includes("--strict");
const appendOnly = process.argv.includes("--append-only");
const refreshGenerated = process.argv.includes("--refresh-generated");
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

const target = await readJson(targetPath);
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
  await writeJsonAtomic(targetPath, target);
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
  const postedAt = validTimestamp(row?.postedAt ?? row?.publishedAt);
  const rawVisibleText = serializedVisibleText(row?.rawVisibleText);
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
  if (!hasPositiveScoringMetric(platform, metrics)) reasons.push("no_visible_positive_scoring_metrics");
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
  const text = cleanString(row.text ?? row.content ?? row.body) ?? title;
  const checkedAt = observedAt;
  const id = cleanString(row.id) ?? stableId(`${platform}:${platformPostId}:${entityId}`);
  if (targetKind === "a16z") {
    const normalized = {
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
    contributionScore: Math.max(1, finiteNumber(row.contributionScore) ?? 1),
    review_state: "verified",
    matchReason: matchReason ?? "Native activity URL from a verified company or founder account with visible metrics.",
    first_seen_at: validTimestamp(row.first_seen_at) ?? observedAt,
    last_checked_at: checkedAt,
    last_updated_at: postedAt ?? checkedAt
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
  const identityKey = attributedIdentityKey(normalized.identity, entityId);
  const urlKey = attributedIdentityKey(normalized.urlIdentity, entityId);
  if (identityKey) rowsByIdentity.set(identityKey, row);
  if (urlKey) rowsByUrl.set(urlKey, row);

  const contentIdentity = evidenceContentIdentity(row, entityId);
  if (!contentIdentity) return;
  for (const physicalKey of contentIdentity.keys) {
    const contentKey = attributedIdentityKey(physicalKey, entityId);
    if (!contentKey) continue;
    const indexed = rowsByContent.get(contentKey) ?? [];
    indexed.push({ row, contentIdentity });
    rowsByContent.set(contentKey, indexed);
  }
}

function findDuplicate(row, entityId) {
  const normalized = normalizedIdentity(row);
  const identityKey = attributedIdentityKey(normalized.identity, entityId);
  const identityMatch = identityKey ? rowsByIdentity.get(identityKey) : null;
  if (identityMatch) return { row: identityMatch, reason: "same_platform_post_id" };

  const urlKey = attributedIdentityKey(normalized.urlIdentity, entityId);
  const urlMatch = urlKey ? rowsByUrl.get(urlKey) : null;
  if (urlMatch) return { row: urlMatch, reason: "same_canonical_source_url" };

  const incomingContentIdentity = evidenceContentIdentity(row, entityId);
  if (!incomingContentIdentity) return null;
  for (const physicalKey of incomingContentIdentity.keys) {
    const contentKey = attributedIdentityKey(physicalKey, entityId);
    for (const indexed of rowsByContent.get(contentKey) ?? []) {
      if (!sourceAuthorsCompatible(incomingContentIdentity, indexed.contentIdentity)) continue;
      if (!publicationTimesCompatible(incomingContentIdentity, indexed.contentIdentity)) continue;
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
  const rawAuthor = authorFromRawVisibleText(serializedVisibleText(row?.rawVisibleText));
  return sourceContentIdentity({
    platform: normalizePlatform(row?.platform) ?? row?.platform,
    authorName: cleanString(row?.authorName ?? row?.voiceName ?? row?.author?.name) ?? rawAuthor.name,
    authorHandle: cleanString(row?.authorHandle ?? row?.author?.handle ?? row?.author?.username) ?? rawAuthor.handle,
    authorUrl: cleanString(row?.authorUrl ?? row?.author?.url),
    accountUrl: cleanString(row?.accountUrl),
    sourceUrl: canonicalUrl(row?.sourceUrl ?? row?.url ?? row?.canonicalUrl),
    fallbackAuthorName: entity?.founderName ?? entity?.companyName,
    body: cleanString(row?.text ?? row?.content ?? row?.body),
    postedAt: validTimestamp(row?.postedAt ?? row?.publishedAt)
  });
}

function attributedIdentityKey(physicalIdentity, entityId) {
  return physicalIdentity && entityId ? `${entityId}:${physicalIdentity}` : null;
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

function nativeIdentity(platform, sourceUrl) {
  if (!platform || !sourceUrl) return null;
  const url = new URL(sourceUrl);
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const parts = url.pathname.split("/").filter(Boolean);

  if (platform === "x" && ["x.com", "twitter.com"].includes(host)) {
    const index = parts.findIndex((part) => part.toLowerCase() === "status");
    if (index > 0 && /^\d+$/.test(parts[index + 1] ?? "")) return { postId: parts[index + 1] };
  }
  if (platform === "instagram" && host.endsWith("instagram.com") && /^(p|reel|tv)$/.test(parts[0] ?? "")) {
    if (/^[A-Za-z0-9_-]+$/.test(parts[1] ?? "")) return { postId: parts[1] };
  }
  if (platform === "youtube" && ["youtube.com", "m.youtube.com", "youtu.be"].includes(host)) {
    const id = host === "youtu.be" ? parts[0] : url.searchParams.get("v") ?? (/^(shorts|live)$/.test(parts[0] ?? "") ? parts[1] : null);
    if (/^[A-Za-z0-9_-]{6,}$/.test(id ?? "")) return { postId: id };
  }
  if (platform === "linkedin" && host.endsWith("linkedin.com")) {
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
  return new Set(["x", "instagram", "linkedin", "youtube", "github", "reddit", "product_hunt", "hacker_news"]).has(platform) ? platform : null;
}

function normalizeMediaType(value, platform, sourceUrl) {
  const supported = new Set(["text", "image", "video", "link", "repo", "launch", "unknown"]);
  const mediaType = String(value ?? "").toLowerCase();
  if (supported.has(mediaType)) return mediaType;
  if (platform === "youtube") return "video";
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
  const snapshots = await Promise.all([
    readJson(resolve(root, "src/lib/yc/spring-2026-companies.json")),
    readJson(resolve(root, "src/lib/yc/summer-2026-companies.json"))
  ]);
  const entities = new Map();
  const currentCompanySlugs = new Set();
  for (const snapshot of snapshots) {
    for (const company of snapshot.companies ?? []) {
      currentCompanySlugs.add(company.slug);
      entities.set(`company-${company.slug}`, {
        entityType: "company",
        companyName: company.name,
        companySlug: company.slug
      });
      for (const founder of company.founders ?? []) {
        entities.set(`founder-${company.slug}-${slugify(founder.name)}-${founder.id}`, {
          entityType: "founder",
          companyName: company.name,
          companySlug: company.slug,
          founderName: founder.name
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
        founderName: existing?.founderName
      });
    }
  }
  return entities;
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
      companySlug
    });
    for (const founder of company.founders ?? []) {
      const founderName = cleanString(founder.name);
      if (!founderName) throw new Error(`A16ZSR006 founder attribution is missing a name for ${companySlug}.`);
      addUniqueEntity(entities, `a16z-speedrun-006-${companySlug}-founder-${slugify(founderName)}`, {
        entityType: "founder",
        companyName,
        companySlug,
        founderName
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
