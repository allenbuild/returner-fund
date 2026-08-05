#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const ledgerPath = path.resolve(root, argValue("--ledger") ?? "work/volume-target-2026-08-05/post-ledger.ndjson");
const volumePath = path.resolve(root, "src/lib/social/volume-evidence-current.json");
const canonicalPath = path.resolve(root, "src/lib/social/public-evidence-current.json");
const referencePaths = [
  "src/lib/social/volume-evidence-current.json",
  "src/lib/social/targeted-evidence-current.json",
  "src/lib/social/logged-in-evidence-current.json",
  "src/lib/social/a16z-speedrun-006-social-evidence.json"
].map((relativePath) => path.resolve(root, relativePath));
const graphPaths = ["s2026.json", "s26.json", "a16zsr006.json"].map((filename) =>
  path.resolve(root, "public/graph", filename)
);
const dryRun = process.argv.includes("--dry-run");
const replaceVolume = process.argv.includes("--replace");

const [canonical, ...references] = await Promise.all([
  readJson(canonicalPath),
  ...referencePaths.map(async (relativePath) => {
    try {
      return await readJson(path.resolve(root, relativePath));
    } catch (error) {
      if (error?.code === "ENOENT") return { evidence: [] };
      throw error;
    }
  }),
]);
const graphSnapshots = await Promise.all(graphPaths.map(readJson));
const entityCatalog = buildEntityCatalog(graphSnapshots);
const volume = references[0];
const volumeBase = replaceVolume ? { evidence: [] } : volume;
const existingNativeKeys = new Set(
  [...[canonical, ...(replaceVolume ? references.slice(1) : references)].flatMap((snapshot) => snapshot.evidence ?? [])]
    .map(nativeKey)
    .filter(Boolean)
);

const bestByNativeKey = new Map();
for (const line of (await readFile(ledgerPath, "utf8")).split(/\r?\n/)) {
  if (!line.trim()) continue;
  const ledgerRow = JSON.parse(line);
  if (!ledgerRow.nativeKey || !["accepted", "historical"].includes(ledgerRow.status)) continue;
  const key = canonicalLedgerNativeKey(ledgerRow);
  if (!key) continue;
  const current = bestByNativeKey.get(key);
  if (!current || statusRank(ledgerRow.status) < statusRank(current.status)) {
    bestByNativeKey.set(key, ledgerRow);
  }
}

const additions = [];
const skipped = { alreadyPresent: 0, unmappedEntity: 0, nonPostContext: 0, staleHistoricalActivity: 0, invalid: 0 };
const unmapped = [];
for (const ledgerRow of [...bestByNativeKey.values()].sort((left, right) =>
  left.nativeKey.localeCompare(right.nativeKey)
)) {
  const key = canonicalLedgerNativeKey(ledgerRow);
  if (existingNativeKeys.has(key)) {
    skipped.alreadyPresent += 1;
    continue;
  }

  if (isNonPostContext(ledgerRow.row)) {
    skipped.nonPostContext += 1;
    continue;
  }
  if (isStaleSummerLinkedInActivity(ledgerRow)) {
    skipped.staleHistoricalActivity += 1;
    continue;
  }

  const projection = projectLedgerRow(ledgerRow, entityCatalog);
  if (projection.kind === "unmapped") {
    skipped.unmappedEntity += 1;
    unmapped.push({ nativeKey: ledgerRow.nativeKey, source: ledgerRow.source, row: ledgerRow.row });
    continue;
  }
  if (projection.kind === "invalid") {
    skipped.invalid += 1;
    continue;
  }
  additions.push(projection.row);
  existingNativeKeys.add(key);
}

const next = {
  ...volumeBase,
  source: {
    ...(volumeBase.source ?? {}),
    fetchedAt: new Date().toISOString(),
    evidenceCount: (volumeBase.evidence?.length ?? 0) + additions.length,
    notes: [
      ...(Array.isArray(volumeBase.source?.notes) ? volumeBase.source.notes : []),
      "Volume ledger projections retain verified accepted and historical native evidence with compact provenance; zero-metric history remains visible but does not contribute to traction scores."
    ]
  },
  evidence: [...(volumeBase.evidence ?? []), ...additions]
};

const report = {
  schemaVersion: 1,
  status: dryRun ? "dry_run" : "updated",
  ledgerPath: path.relative(root, ledgerPath),
  outputPath: path.relative(root, volumePath),
  ledgerUniqueStrictRows: bestByNativeKey.size,
  additions: additions.length,
  skipped,
  unmappedPreview: unmapped.slice(0, 20).map(({ nativeKey, source, row }) => ({
    nativeKey,
    source,
    entityType: row?.entityType,
    entityId: row?.entityId,
    companySlug: row?.companySlug,
    companyName: row?.companyName,
    entityName: row?.entityName,
    platform: row?.platform,
    sourceUrl: row?.sourceUrl
  })),
  finalVolumeEvidence: next.evidence.length,
  finalVolumeBytes: Buffer.byteLength(`${JSON.stringify(next)}\n`),
  sourceOperationalLedgersChanged: false
};

if (!dryRun) {
  const temporaryPath = `${volumePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(next)}\n`, "utf8");
  await rename(temporaryPath, volumePath);
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

function projectLedgerRow(ledgerRow, catalog) {
  const row = ledgerRow.row;
  if (!row || typeof row !== "object") return { kind: "invalid" };
  const platform = String(row.platform ?? ledgerRow.platform ?? "").trim().toLowerCase();
  const sourceUrl = stringValue(row.sourceUrl ?? row.nativeUrl ?? row.url ?? row.exactUrl ?? row.canonicalUrl);
  const platformPostId = canonicalPlatformPostId(
    platform,
    row.platformPostId ?? row.nativeId ?? row.native_id ?? row.postId ?? row.externalId ?? row.external_id,
    sourceUrl
  );
  const postedAt = timestampValue(row.postedAt ?? row.publishedAt ?? row.published_at ?? row.timestamp ?? row.createdAt ?? row.created_at);
  if (!platform || !sourceUrl || !platformPostId) {
    return { kind: "invalid" };
  }

  const owner = resolveOwner(row, catalog);
  if (!owner) return { kind: "unmapped" };

  const retrievedAt = timestampValue(row.first_seen_at ?? row.discoveredAt ?? row.retrievedAt) ?? new Date().toISOString();
  const author = authorFromRow(row);
  const metrics = normalizeMetrics(row.metrics ?? row.metricsAtCapture ?? row.counts);
  const rawVisibleText = compactProvenance(ledgerRow, row, owner, platformPostId, sourceUrl);
  const id = `volume-ledger-${platform}-${sha256(ledgerRow.nativeKey).slice(0, 24)}`;
  const score = finiteNumber(row.contributionScore) ?? 0;

  return {
    kind: "row",
    row: {
      id,
      batchSlug: owner.batchSlug,
      entityType: owner.entityType,
      entityId: owner.entityId,
      companySlug: owner.companySlug,
      companyName: owner.companyName,
      platform,
      title: boundedText(row.title ?? row.text ?? row.content ?? row.name ?? sourceUrl, 240),
      sourceUrl,
      platformPostId,
      text: boundedText(row.text ?? row.content ?? row.title ?? `${platform} native evidence ${platformPostId}`, 1_200),
      rawVisibleText,
      postedAt,
      publishedAtPrecision: postedAt ? (/^\d{4}-\d{2}-\d{2}$/.test(postedAt) ? "day" : "exact") : "unknown",
      metrics,
      contributionScore: score,
      review_state: "verified",
      linkStatus: row.linkStatus === "invalid" ? "invalid" : "verified",
      linkCheckedAt: timestampValue(row.linkCheckedAt ?? row.last_checked_at ?? retrievedAt),
      first_seen_at: retrievedAt,
      last_checked_at: timestampValue(row.last_checked_at ?? retrievedAt),
      last_updated_at: timestampValue(row.last_updated_at ?? postedAt ?? retrievedAt),
      matchReason: `Verified ${ledgerRow.status} evidence projected from the Returner volume ledger (${ledgerRow.source?.label ?? "volume ledger"}); native identity ${ledgerRow.nativeKey}.`,
      attributionVersion: 3,
      attributionStatus: "verified",
      attributionMode: owner.entityType === "founder" ? "account_owner" : "subject",
      attributionSignals: [
        "volume_ledger_status_verified",
        "native_platform_identity",
        ...(author.handle ? ["native_author_preserved"] : [])
      ],
      ...(author.name ? { authorName: author.name } : {}),
      ...(author.handle ? { authorHandle: author.handle } : {}),
      ...(stringValue(row.accountUrl) ? { accountUrl: stringValue(row.accountUrl) } : {}),
      ...(row.mediaUrl ? { mediaUrl: row.mediaUrl } : {}),
      ...(Array.isArray(row.mediaUrls) ? { mediaUrls: row.mediaUrls.filter(Boolean) } : {})
    }
  };
}

function isNonPostContext(row) {
  if (!row || typeof row !== "object" || String(row.platform ?? "").toLowerCase() !== "linkedin") {
    return false;
  }
  return Boolean(
    row.platformCommentUrn ??
      row.commentUrn ??
      row.verificationNotes?.commentUrn ??
      /commentUrn=|\/comments\//i.test(String(row.sourceUrl ?? ""))
  );
}

function isStaleSummerLinkedInActivity(ledgerRow) {
  const row = ledgerRow?.row;
  if (!row || typeof row !== "object" || String(row.platform ?? "").toLowerCase() !== "linkedin") {
    return false;
  }
  if (!/\/feed\/update\/urn:li:activity:/i.test(String(row.sourceUrl ?? ""))) {
    return false;
  }
  if (
    normalizeBatch(row.batchSlug ?? row.batch_slug) !== "S26" &&
    String(ledgerRow?.source?.label ?? "") !== "supplemental-artifact-reconciliation"
  ) {
    return false;
  }
  const postedAt = Date.parse(String(row.postedAt ?? row.publishedAt ?? row.created_at ?? ""));
  return Number.isFinite(postedAt) && postedAt < Date.parse("2026-05-01T00:00:00.000Z");
}

function buildEntityCatalog(graphSnapshots) {
  const byId = new Map();
  const byLegacyFounderId = new Map();
  const companies = [];
  for (const graph of graphSnapshots) {
    for (const node of graph.nodes ?? []) {
      if (node.entityType !== "company") continue;
      const company = {
      batchSlug: node.batchSlug,
      entityType: "company",
      entityId: node.entityId,
        companySlug: companySlugFromEntityId(node.entityId, node.label),
        companyName: node.label,
        founderIds: new Map((node.founders ?? []).map((founder) => [slugify(founder.name), founder]))
      };
      companies.push(company);
      byId.set(company.entityId, company);
      for (const founder of node.founders ?? []) {
        const founderOwner = {
          batchSlug: node.batchSlug,
          entityType: "founder",
          entityId: founder.id,
          companySlug: company.companySlug,
          companyName: node.label,
          founderName: founder.name,
          companyId: node.entityId
        };
        byId.set(founder.id, founderOwner);
        const legacyId = String(founder.id).match(/^(?:founder-[^-]+|founder-[^-]+-[^-]+)-(.+)-(\d+)$/);
        if (legacyId) byLegacyFounderId.set(`founder-${legacyId[2]}`, founderOwner);
        byLegacyFounderId.set(String(founder.id).replace(/^founder-[^-]+-/, "founder-"), founderOwner);
      }
    }
  }
  return { byId, byLegacyFounderId, companies };
}

function resolveOwner(row, catalog) {
  const entityHints = [
    row,
    ...(Array.isArray(row.entityRefs) ? row.entityRefs.map((entityId) => ({ entityId })) : []),
    ...(Array.isArray(row.sourceProvenance?.entities) ? row.sourceProvenance.entities : [])
  ];
  const directHint = entityHints.find((hint) => stringValue(hint?.entityId));
  const rawBatch = normalizeBatch(
    row.batchSlug ?? row.batch_slug ?? row.batch ?? directHint?.batchSlug ?? row.batchSlugs?.[0]
  );
  const rawEntityId = stringValue(row.entityId) ?? stringValue(row.companyEntityId) ?? stringValue(row.founderEntityId) ?? stringValue(directHint?.entityId);
  const legacyNumber = rawEntityId?.match(/-(\d+)$/)?.[1];
  const direct = rawEntityId
    ? catalog.byId.get(rawEntityId) ?? catalog.byLegacyFounderId.get(rawEntityId) ??
      (legacyNumber ? catalog.byLegacyFounderId.get(`founder-${legacyNumber}`) : null)
    : null;
  if (direct && (!rawBatch || direct.batchSlug.toUpperCase() === rawBatch)) return direct;

  const companyHint = entityHints.find((hint) => stringValue(hint?.companySlug) || stringValue(hint?.companyName));
  const rawCompanySlug = slugify(row.companySlug ?? companyHint?.companySlug ?? row.companyName ?? row.company ?? companyHint?.companyName ?? "");
  const rawCompanyName = String(row.companyName ?? row.company ?? companyHint?.companyName ?? "").trim().toLowerCase();
  const candidates = catalog.companies.filter((company) =>
    (!rawBatch || normalizeBatch(company.batchSlug) === rawBatch) &&
    (slugify(company.companySlug) === rawCompanySlug || company.companyName.toLowerCase() === rawCompanyName)
  );
  const company = candidates[0];
  if (!company) return null;
  const rawEntityType = String(row.entityType ?? directHint?.entityType ?? "company");
  if (rawEntityType === "company") return company;

  const rawFounderName = String(
    row.entityName ?? row.founderName ?? directHint?.founderName ?? row.authorName ?? row.author?.name ?? ""
  ).trim();
  const founder = company.founderIds.get(slugify(rawFounderName));
  if (founder) {
    return {
      batchSlug: company.batchSlug,
      entityType: "founder",
      entityId: founder.id,
      companySlug: company.companySlug,
      companyName: company.companyName,
      founderName: founder.name,
      companyId: company.entityId
    };
  }
  return null;
}

function authorFromRow(row) {
  const author = row.author && typeof row.author === "object" ? row.author : {};
  return {
    name: stringValue(row.authorName ?? author.name ?? row.entityName),
    handle: normalizeHandle(row.authorHandle ?? author.handle ?? author.username ?? author.screen_name)
  };
}

function companySlugFromEntityId(entityId, label) {
  if (String(entityId).startsWith("a16z-speedrun-006-")) {
    return String(entityId).slice("a16z-speedrun-006-".length);
  }
  return String(entityId).replace(/^company-/, "") || slugify(label);
}

function normalizeBatch(value) {
  const text = String(value ?? "").toUpperCase();
  if (text.includes("A16ZSR006")) return "A16ZSR006";
  if (text.includes("S2026") || text.includes("P26") || text.includes("SPRING 2026")) return "S2026";
  if (text.includes("S26") || text.includes("SUMMER 2026")) return "S26";
  return text.trim() || null;
}

function normalizeMetrics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const metrics = {};
  for (const [key, raw] of Object.entries(value)) {
    const number = finiteNumber(raw);
    if (number !== null && number >= 0) metrics[key] = number;
  }
  return metrics;
}

function compactProvenance(ledgerRow, row, owner, platformPostId, sourceUrl) {
  return JSON.stringify({
    projection: "returner_volume_ledger_projection_v1",
    status: ledgerRow.status,
    nativeKey: ledgerRow.nativeKey,
    source: {
      label: ledgerRow.source?.label ?? null,
      sourceIndex: ledgerRow.source?.sourceIndex ?? null
    },
    sourceEvidenceId: row.id ?? row.candidateId ?? null,
    nativeUrl: sourceUrl,
    platformPostId,
    entity: {
      batchSlug: owner.batchSlug,
      entityType: owner.entityType,
      entityId: owner.entityId,
      companySlug: owner.companySlug,
      companyName: owner.companyName
    },
    author: authorFromRow(row),
    evidenceType: row.evidenceType ?? row.sourceKind ?? null,
    commentUrn: row.platformCommentUrn ?? row.commentUrn ?? null,
    parentSourceUrl: row.parentSourceUrl ?? null,
    isRetweet: row.isRetweet ?? row.verification?.isRetweet ?? null
  });
}

function nativeKey(row) {
  const platform = stringValue(row.platform)?.toLowerCase();
  const sourceUrl = stringValue(row.sourceUrl ?? row.nativeUrl ?? row.url ?? row.exactUrl ?? row.canonicalUrl);
  const id = canonicalPlatformPostId(
    platform,
    row.platformPostId ?? row.nativeId ?? row.native_id ?? row.postId ?? row.externalId ?? row.external_id,
    sourceUrl
  );
  return platform && id ? `${platform}:${id}` : null;
}

function canonicalLedgerNativeKey(ledgerRow) {
  const row = ledgerRow?.row;
  return row && typeof row === "object" ? nativeKey({
    platform: row.platform ?? ledgerRow.platform,
    platformPostId: row.platformPostId ?? row.nativeId ?? row.native_id ?? row.postId ?? row.externalId ?? row.external_id,
    sourceUrl: row.sourceUrl ?? row.nativeUrl ?? row.url ?? row.exactUrl ?? row.canonicalUrl
  }) : stringValue(ledgerRow?.nativeKey);
}

function canonicalPlatformPostId(platform, value, sourceUrl = null) {
  const id = stringValue(value);
  if (!id) return null;
  if (platform === "hacker_news") return id.replace(/^hn:/i, "");
  if (platform === "product_hunt") {
    // Product Hunt public URLs are the validator's canonical native identity.
    // Recovery rows sometimes carry a numeric API object ID alongside the
    // human-readable launch URL; publishing both identities creates a false
    // native-ID conflict and quarantines an otherwise valid post.
    const urlIdentity = productHuntUrlIdentity(sourceUrl);
    if (urlIdentity) return urlIdentity;
  }
  return id;
}

function productHuntUrlIdentity(rawUrl) {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (url.hostname.replace(/^www\./i, "").toLowerCase() !== "producthunt.com") return null;
    const path = url.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
    if (/^posts\/[a-z0-9][a-z0-9_-]*$/.test(path)) return path;
    if (/^p\/[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)?$/.test(path)) return path;
    if (/^products\/[a-z0-9][a-z0-9_-]*\/launches\/[a-z0-9][a-z0-9_-]*$/.test(path)) return path;
    return null;
  } catch {
    return null;
  }
}

function statusRank(status) {
  return status === "accepted" ? 0 : 1;
}

function stringValue(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function timestampValue(value) {
  const text = stringValue(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function normalizeHandle(value) {
  const text = stringValue(value);
  return text ? text.replace(/^@/, "") : null;
}

function boundedText(value, limit) {
  const text = String(value ?? "").trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function slugify(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function argValue(name) {
  const prefix = `${name}=`;
  return process.argv.slice(2).find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? null;
}
