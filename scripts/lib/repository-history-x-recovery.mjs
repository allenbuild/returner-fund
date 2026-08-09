import { physicalSourceKey } from "./ingestion-source-delta.mjs";

const X_EPOCH_MS = 1_288_834_974_657n;
const X_HOSTS = new Set(["x.com", "twitter.com", "mobile.twitter.com"]);

export function buildCohortOwnerCatalog(graphSnapshots) {
  const byScopedEntity = new Map();
  const batchesByEntityId = new Map();

  for (const graph of graphSnapshots ?? []) {
    const batchSlug = normalizeBatchSlug(graph?.batch?.slug);
    if (!batchSlug) continue;
    for (const node of graph?.nodes ?? []) {
      if (node?.entityType !== "company" || !clean(node?.entityId)) continue;
      addOwner({
        batchSlug,
        entityType: "company",
        entityId: clean(node.entityId),
        companyId: clean(node.entityId),
        companyName: clean(node.label),
        accounts: node.socialAccounts ?? []
      });
      for (const founder of node.founders ?? []) {
        if (!clean(founder?.id)) continue;
        addOwner({
          batchSlug,
          entityType: "founder",
          entityId: clean(founder.id),
          entityName: clean(founder.name),
          companyId: clean(node.entityId),
          companyName: clean(node.label),
          accounts: founder.socialAccounts ?? []
        });
      }
    }
  }

  return { byScopedEntity, batchesByEntityId };

  function addOwner(owner) {
    const key = scopedEntityKey(owner.batchSlug, owner.entityId);
    const xAccounts = (owner.accounts ?? [])
      .filter((account) => normalizePlatform(account?.platform) === "x")
      .filter((account) => String(account?.review_state ?? account?.reviewState ?? "").toLowerCase() === "verified")
      .flatMap((account) => {
        const identity = xAccountIdentity(account?.url);
        return identity ? [{ ...identity, url: account.url, matchReason: account.matchReason ?? null }] : [];
      });
    byScopedEntity.set(key, { ...owner, xAccounts });
    const batches = batchesByEntityId.get(owner.entityId) ?? new Set();
    batches.add(owner.batchSlug);
    batchesByEntityId.set(owner.entityId, batches);
  }
}

export function resolveCohortOwner(row, catalog) {
  const entityId = clean(row?.entityId ?? row?.entity_id);
  if (!entityId) return null;
  const explicitBatch = normalizeBatchSlug(row?.batchSlug ?? row?.batch_slug);
  if (explicitBatch) {
    return catalog.byScopedEntity.get(scopedEntityKey(explicitBatch, entityId)) ?? null;
  }
  const batches = catalog.batchesByEntityId.get(entityId);
  if (!batches || batches.size !== 1) return null;
  return catalog.byScopedEntity.get(scopedEntityKey([...batches][0], entityId)) ?? null;
}

export function evaluateHistoricalXRow(row, { catalog, currentPhysicalKeys = new Set() } = {}) {
  const reasons = [];
  const platform = normalizePlatform(row?.platform);
  if (platform !== "x") reasons.push("not_x_post");

  const owner = catalog ? resolveCohortOwner(row, catalog) : null;
  if (!owner) reasons.push("current_cohort_owner_not_resolved");
  if (owner && clean(row?.entityType ?? row?.entity_type) !== owner.entityType) {
    reasons.push("entity_type_mismatch");
  }

  const state = String(row?.review_state ?? row?.reviewState ?? "").trim().toLowerCase();
  if (state !== "verified") reasons.push("historical_row_not_verified");

  const native = xStatusIdentity(row?.sourceUrl ?? row?.source_url);
  const explicitId = clean(row?.platformPostId ?? row?.platform_post_id);
  if (!native) reasons.push("invalid_native_x_status_url");
  if (native && explicitId && native.postId !== explicitId) reasons.push("native_url_platform_post_id_conflict");

  const physicalKey = platform === "x" ? physicalSourceKey({ ...row, platform: "x" }) : null;
  if (!physicalKey) reasons.push("physical_post_identity_missing");
  if (physicalKey && currentPhysicalKeys.has(physicalKey)) reasons.push("already_in_current_evidence");

  const officialAccount = native && owner
    ? owner.xAccounts.find((account) => account.handle === native.handle) ?? null
    : null;
  if (owner && native && !officialAccount) reasons.push("native_author_not_current_verified_owner");

  const visibleAuthor = historicalVisibleAuthorHandle(row);
  if (visibleAuthor && native && visibleAuthor !== native.handle) {
    reasons.push("historical_visible_author_mismatch");
  }

  const exactPostedAt = native ? xSnowflakeTimestamp(native.postId) : null;
  if (!exactPostedAt) reasons.push("native_x_snowflake_timestamp_invalid");

  return {
    accepted: reasons.length === 0,
    reasons: [...new Set(reasons)],
    owner,
    officialAccount,
    native,
    physicalKey,
    exactPostedAt,
    row
  };
}

export function validateXOembedPayload(payload, candidate) {
  const reasons = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { accepted: false, reasons: ["x_oembed_payload_invalid"] };
  }
  const status = xStatusIdentity(payload.url);
  const author = xAccountIdentity(payload.author_url);
  if (!status || status.postId !== candidate?.native?.postId) reasons.push("x_oembed_status_identity_mismatch");
  if (!author || author.handle !== candidate?.native?.handle) reasons.push("x_oembed_author_identity_mismatch");
  const html = clean(payload.html);
  if (!html || !/<blockquote\b/i.test(html)) reasons.push("x_oembed_post_body_missing");
  const authorName = clean(payload.author_name);
  if (!authorName) reasons.push("x_oembed_author_name_missing");
  return {
    accepted: reasons.length === 0,
    reasons,
    authorName,
    authorUrl: author?.url ?? null,
    html
  };
}

export function buildRecoveredEvidenceRow(candidate, validation, provenance) {
  if (!candidate?.accepted || !validation?.accepted) {
    throw new Error("Recovered evidence requires accepted history and live validation decisions.");
  }
  const row = structuredClone(candidate.row);
  const attributionSignals = new Set([
    ...(Array.isArray(row.attributionSignals) ? row.attributionSignals : []),
    "current_verified_account_mapping",
    "official_x_oembed_author_match",
    "native_x_snowflake_timestamp"
  ]);
  return {
    ...row,
    batchSlug: candidate.owner.batchSlug,
    entityType: candidate.owner.entityType,
    entityId: candidate.owner.entityId,
    companyName: row.companyName ?? candidate.owner.companyName,
    attachedCompanyId: row.attachedCompanyId ?? candidate.owner.companyId,
    platform: "x",
    sourceUrl: candidate.native.url,
    platformPostId: candidate.native.postId,
    accountUrl: candidate.officialAccount.url,
    authorName: row.authorName ?? validation.authorName,
    postedAt: candidate.exactPostedAt,
    publishedAtPrecision: "millisecond",
    review_state: "verified",
    linkStatus: "verified",
    linkCheckedAt: provenance.checkedAt,
    attributionStatus: "verified",
    attributionMode: "account_owner",
    attributionSignals: [...attributionSignals],
    _recoveryProvenance: {
      schemaVersion: 1,
      kind: "git_repository_history_plus_official_x_oembed",
      physicalKey: candidate.physicalKey,
      git: {
        commit: provenance.commit,
        committedAt: provenance.committedAt,
        path: provenance.path,
        sourceIndex: provenance.sourceIndex
      },
      liveValidation: {
        checkedAt: provenance.checkedAt,
        endpoint: provenance.endpoint,
        returnedUrl: provenance.returnedUrl,
        returnedAuthorUrl: validation.authorUrl
      },
      timestamp: {
        method: "x_snowflake_epoch",
        exactPostedAt: candidate.exactPostedAt,
        historicalPostedAt: clean(row.postedAt ?? row.posted_at) ?? null
      }
    }
  };
}

export function summarizeRecoveryJournal(events) {
  const completedBlobs = new Set();
  const candidates = new Map();
  const validations = new Map();
  for (const event of events ?? []) {
    if (event?.type === "blob_checkpoint" && clean(event.token)) {
      completedBlobs.add(event.token);
      for (const candidate of event.candidates ?? []) {
        if (clean(candidate?.physicalKey) && !candidates.has(candidate.physicalKey)) {
          candidates.set(candidate.physicalKey, candidate);
        }
      }
    }
    if (event?.type === "validation_checkpoint" && clean(event.physicalKey)) {
      validations.set(event.physicalKey, event);
    }
  }
  return { completedBlobs, candidates, validations };
}

export function xSnowflakeTimestamp(postId) {
  try {
    const value = BigInt(String(postId));
    if (value <= 0n) return null;
    const timestampMs = Number((value >> 22n) + X_EPOCH_MS);
    if (!Number.isFinite(timestampMs)) return null;
    const timestamp = new Date(timestampMs);
    const year = timestamp.getUTCFullYear();
    return year >= 2006 && year <= new Date().getUTCFullYear() + 1
      ? timestamp.toISOString()
      : null;
  } catch {
    return null;
  }
}

export function xStatusIdentity(rawUrl) {
  try {
    const url = new URL(String(rawUrl ?? ""));
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    if (!X_HOSTS.has(host)) return null;
    const match = decodeURIComponent(url.pathname).match(/^\/([^/]+)\/status\/(\d+)(?:\/.*)?$/i);
    if (!match || match[1].toLowerCase() === "i") return null;
    const handle = normalizeHandle(match[1]);
    return handle && xSnowflakeTimestamp(match[2])
      ? { handle, postId: match[2], url: `https://x.com/${handle}/status/${match[2]}` }
      : null;
  } catch {
    return null;
  }
}

export function xAccountIdentity(rawUrl) {
  try {
    const url = new URL(String(rawUrl ?? ""));
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    if (!X_HOSTS.has(host)) return null;
    const parts = decodeURIComponent(url.pathname).split("/").filter(Boolean);
    if (parts.length !== 1) return null;
    const handle = normalizeHandle(parts[0]);
    return handle ? { handle, url: `https://x.com/${handle}` } : null;
  } catch {
    return null;
  }
}

function historicalVisibleAuthorHandle(row) {
  const raw = parseRawVisibleText(row?.rawVisibleText);
  const values = [
    row?.authorHandle,
    row?.author_handle,
    raw?.author,
    raw?.authorHandle,
    raw?.profile?.username,
    raw?.profile?.handle,
    raw?.post?.author,
    raw?.post?.authorHandle,
    raw?.post?.author_handle
  ];
  for (const value of values) {
    const text = clean(value);
    if (!text || /\s/.test(text)) continue;
    const handle = normalizeHandle(text);
    if (handle) return handle;
  }
  return null;
}

function parseRawVisibleText(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value ?? ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizePlatform(value) {
  const platform = String(value ?? "").trim().toLowerCase();
  return platform === "twitter" ? "x" : platform;
}

function normalizeBatchSlug(value) {
  const batch = clean(value)?.toUpperCase() ?? null;
  return new Set(["S2026", "S26", "A16ZSR006"]).has(batch) ? batch : null;
}

function normalizeHandle(value) {
  const handle = String(value ?? "").normalize("NFKC").trim().replace(/^@/, "").toLowerCase();
  return /^[a-z0-9_]{1,15}$/.test(handle) ? handle : null;
}

function scopedEntityKey(batchSlug, entityId) {
  return `${batchSlug}:${entityId}`;
}

function clean(value) {
  const text = String(value ?? "").trim();
  return text || null;
}
