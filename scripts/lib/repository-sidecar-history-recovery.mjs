import { createHash } from "node:crypto";

import { physicalSourceKey } from "./ingestion-source-delta.mjs";
import { physicalPostIdentity } from "./targeted-evidence-merge.mjs";

export const RECOVERY_COHORTS = Object.freeze(["S2026", "S26", "A16ZSR006"]);

export const REPOSITORY_SIDECAR_HISTORY_PATHS = Object.freeze([
  "src/lib/social/volume-evidence-current.json",
  "src/lib/social/targeted-evidence-current.json",
  "src/lib/social/logged-in-evidence-current.json",
  "src/lib/social/a16z-speedrun-006-social-evidence.json",
  "public/graph/s2026.json",
  "public/graph/s26.json",
  "public/graph/a16zsr006.json",
  "public/graph/s2026-insiders.json",
  "public/graph/s26-insiders.json",
  "public/graph/a16zsr006-insiders.json",
  "public/graph/s2026-yc-partners.json",
  "public/graph/s26-yc-partners.json",
  "public/graph/a16zsr006-yc-partners.json",
  "src/lib/graph/ranked-posts-sidecar.generated.json"
]);

const LIVE_VALIDATION_PLATFORMS = new Set(["x", "youtube", "github"]);
const NON_POST_PLATFORMS = new Set(["web", "rss"]);
const X_HOSTS = new Set(["x.com", "twitter.com", "mobile.twitter.com"]);

export function buildCohortOwnerCatalog(graphSnapshots) {
  const byScopedEntity = new Map();
  const batchesByEntityId = new Map();
  const companiesByScopedSlug = new Map();
  const companiesByScopedName = new Map();
  const foundersByScopedCompanyAndName = new Map();

  for (const graph of graphSnapshots ?? []) {
    const graphBatch = normalizeBatchSlug(graph?.batch?.slug ?? graph?.batchSlug);
    for (const node of graph?.nodes ?? []) {
      if (node?.entityType !== "company") continue;
      const batchSlug = normalizeBatchSlug(node?.batchSlug) ?? graphBatch;
      const companyId = clean(node?.entityId);
      if (!batchSlug || !companyId) continue;
      const companySlug = companySlugFrom(node, companyId);
      const company = addOwner({
        batchSlug,
        entityType: "company",
        entityId: companyId,
        entityName: clean(node?.label),
        companyId,
        companyName: clean(node?.label),
        companySlug,
        accounts: node?.socialAccounts
      });
      if (companySlug) companiesByScopedSlug.set(scopedKey(batchSlug, companySlug), company);
      if (company.companyName) {
        companiesByScopedName.set(scopedKey(batchSlug, normalizeName(company.companyName)), company);
      }

      for (const founder of node?.founders ?? []) {
        const founderId = clean(founder?.id);
        if (!founderId) continue;
        const owner = addOwner({
          batchSlug,
          entityType: "founder",
          entityId: founderId,
          entityName: clean(founder?.name),
          companyId,
          companyName: clean(node?.label),
          companySlug,
          accounts: founder?.socialAccounts
        });
        if (companySlug && owner.entityName) {
          foundersByScopedCompanyAndName.set(
            scopedKey(batchSlug, companySlug, normalizeName(owner.entityName)),
            owner
          );
        }
      }
    }
  }

  return {
    byScopedEntity,
    batchesByEntityId,
    companiesByScopedSlug,
    companiesByScopedName,
    foundersByScopedCompanyAndName
  };

  function addOwner(input) {
    const owner = {
      ...input,
      accounts: normalizeVerifiedAccounts(input.accounts)
    };
    byScopedEntity.set(scopedKey(owner.batchSlug, owner.entityId), owner);
    const batches = batchesByEntityId.get(owner.entityId) ?? new Set();
    batches.add(owner.batchSlug);
    batchesByEntityId.set(owner.entityId, batches);
    return owner;
  }
}

export function resolveCohortOwner(row, catalog, { fallbackBatchSlug = null } = {}) {
  const explicitBatch = normalizeBatchSlug(
    row?.batchSlug ?? row?.batch_slug ?? row?.nativeAuthorResolution?.owner?.batchSlug
  );
  const batchSlug = explicitBatch ?? normalizeBatchSlug(fallbackBatchSlug);
  const entityIds = uniqueStrings([
    row?.entityId,
    row?.entity_id,
    row?.nativeAuthorResolution?.owner?.entityId
  ]);

  for (const entityId of entityIds) {
    if (batchSlug) {
      const owner = catalog?.byScopedEntity?.get(scopedKey(batchSlug, entityId));
      if (owner) return owner;
    } else {
      const batches = catalog?.batchesByEntityId?.get(entityId);
      if (batches?.size === 1) {
        const owner = catalog.byScopedEntity.get(scopedKey([...batches][0], entityId));
        if (owner) return owner;
      }
    }
  }

  if (!batchSlug) return null;
  const entityType = normalizeEntityType(row?.entityType ?? row?.entity_type);
  const companySlug = normalizeSlug(
    row?.companySlug ?? row?.company_slug ?? row?.nativeAuthorResolution?.owner?.companySlug
  );
  if (entityType === "company" && companySlug) {
    const owner = catalog?.companiesByScopedSlug?.get(scopedKey(batchSlug, companySlug));
    if (owner) return owner;
  }
  if (entityType === "company") {
    const companyName = normalizeName(row?.companyName ?? row?.attachedCompanyName ?? row?.entityName);
    if (companyName) {
      const owner = catalog?.companiesByScopedName?.get(scopedKey(batchSlug, companyName));
      if (owner) return owner;
    }
  }
  if (entityType === "founder" && companySlug) {
    const founderName = normalizeName(
      row?.entityName ?? row?.founderName ?? row?.nativeAuthorResolution?.owner?.entityName
    );
    if (founderName) {
      const owner = catalog?.foundersByScopedCompanyAndName?.get(
        scopedKey(batchSlug, companySlug, founderName)
      );
      if (owner) return owner;
    }
  }
  return null;
}

export function evaluateHistoricalSidecarRow(
  row,
  {
    catalog,
    currentPhysicalKeys = new Set(),
    currentHeldPhysicalKeys = new Set(),
    sourcePath = null,
    fallbackBatchSlug = historyPathBatchSlug(sourcePath)
  } = {}
) {
  const reasons = [];
  const platform = normalizePlatform(row?.platform);
  if (!platform || NON_POST_PLATFORMS.has(platform)) reasons.push("not_native_social_post");
  if (row?.topVoice || row?.top_voice) reasons.push("third_party_top_voice_post");

  const pathBatchSlug = historyPathBatchSlug(sourcePath);
  const explicitBatchSlug = normalizeBatchSlug(row?.batchSlug ?? row?.batch_slug);
  if (pathBatchSlug && explicitBatchSlug && pathBatchSlug !== explicitBatchSlug) {
    reasons.push("path_batch_scope_conflict");
  }

  const owner = catalog
    ? resolveCohortOwner(row, catalog, { fallbackBatchSlug })
    : null;
  if (!owner) reasons.push("current_cohort_owner_not_resolved");

  const entityType = normalizeEntityType(row?.entityType ?? row?.entity_type);
  if (owner && entityType && entityType !== owner.entityType) reasons.push("entity_type_mismatch");
  const state = String(row?.review_state ?? row?.reviewState ?? row?.attributionStatus ?? "")
    .trim()
    .toLowerCase();
  if (state !== "verified") reasons.push("historical_row_not_verified");

  const normalizedRow = { ...row, platform };
  const physicalIdentity = platform ? recoveryPhysicalKey(normalizedRow) : null;
  if (!physicalIdentity) reasons.push("physical_post_identity_missing");
  if (physicalIdentity && currentPhysicalKeys.has(physicalIdentity)) {
    reasons.push("already_in_current_evidence");
  }
  if (physicalIdentity && currentHeldPhysicalKeys.has(physicalIdentity)) {
    reasons.push("current_review_hold_not_promotion_ready");
  }

  const nativeIdentity = platform ? nativePostIdentity(platform, row) : null;
  if (!nativeIdentity) reasons.push("invalid_native_post_url");
  const postIdentity = platform ? physicalPostIdentity(normalizedRow) : null;
  if (postIdentity?.conflict) reasons.push("native_url_platform_post_id_conflict");

  const accountMatch = owner && platform
    ? matchCurrentOwnerAccount(row, owner, platform, nativeIdentity)
    : null;
  if (owner && platform && !accountMatch) reasons.push("native_author_not_current_verified_owner");

  return {
    accepted: reasons.length === 0,
    reasons: [...new Set(reasons)],
    platform,
    owner,
    accountMatch,
    nativeIdentity,
    physicalKey: physicalIdentity,
    row
  };
}

export function extractEvidenceRows(document) {
  if (!document || typeof document !== "object") return [];
  if (Array.isArray(document)) return document.filter(looksLikeEvidenceRow);
  const rows = [];
  const seenArrays = new Set();
  visit(document);
  return rows;

  function visit(value) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === "evidence" && Array.isArray(child) && !seenArrays.has(child)) {
        seenArrays.add(child);
        for (const row of child) if (looksLikeEvidenceRow(row)) rows.push(row);
        continue;
      }
      if (key === "evidence") continue;
      visit(child);
    }
  }
}

export function extractCurrentEvidenceRows(document, { sourcePath = null } = {}) {
  const rows = extractEvidenceRows(document);
  if (!/github-traction(?:-[^/]*)?\.json$/i.test(String(sourcePath ?? ""))) return rows;
  for (const account of document?.accounts ?? []) {
    for (const repo of account?.repos ?? []) {
      const sourceUrl = clean(repo?.htmlUrl ?? repo?.html_url);
      const platformPostId = clean(repo?.fullName ?? repo?.full_name);
      if (!sourceUrl || !platformPostId) continue;
      rows.push({
        platform: "github",
        sourceUrl,
        platformPostId,
        platformObjectId: clean(repo?.id),
        entityType: account?.entityType,
        entityId: account?.entityId
      });
    }
  }
  return rows;
}

export function extractCurrentHeldRows(document, { sourcePath = null } = {}) {
  const rows = [];
  collectArraysNamed(document, "needsReview", (row) => {
    const normalized = normalizeHeldRow(row);
    if (normalized) rows.push(normalized);
  });
  if (/quarantine\.json$/i.test(String(sourcePath ?? ""))) {
    for (const entry of document?.rows ?? []) {
      for (const repo of entry?.physicalRepresentation?.repositories ?? []) {
        const sourceUrl = clean(repo?.canonicalUrl);
        if (!sourceUrl) continue;
        rows.push({
          platform: "github",
          sourceUrl,
          platformObjectId: clean(repo?.repositoryId)
        });
      }
    }
  }
  return rows;
}

export function physicalIdentityKeys(row) {
  const keys = new Set();
  const primary = physicalSourceKey(row);
  if (primary) keys.add(primary);
  if (normalizePlatform(row?.platform) !== "github") return keys;

  for (const candidate of [
    row,
    {
      ...row,
      platformPostId: null,
      platform_post_id: null,
      platformObjectId: null,
      platform_object_id: null
    }
  ]) {
    const value = physicalPostIdentity(candidate).value;
    if (value && value !== "row:unknown") {
      keys.add(`github:${String(value).trim().toLowerCase()}`);
    }
  }
  const objectId = clean(row?.platformObjectId ?? row?.platform_object_id);
  if (/^\d+$/.test(objectId ?? "")) keys.add(`github:object:${objectId}`);
  return keys;
}

export function recoveryPhysicalKey(row) {
  if (normalizePlatform(row?.platform) !== "github") return physicalSourceKey(row);
  const urlIdentity = physicalSourceKey({
    ...row,
    platformPostId: null,
    platform_post_id: null,
    platformObjectId: null,
    platform_object_id: null
  });
  return urlIdentity ?? physicalSourceKey(row);
}

export function summarizeRecoveryJournal(events) {
  const completedBlobs = new Set();
  const candidates = new Map();
  const validations = new Map();
  for (const event of events ?? []) {
    if (event?.type === "blob_checkpoint" && clean(event?.token)) {
      completedBlobs.add(event.token);
      for (const candidate of event.candidates ?? []) {
        const key = clean(candidate?.physicalKey);
        if (!key) continue;
        const previous = candidates.get(key);
        candidates.set(key, previous ? preferredCandidate(previous, candidate) : candidate);
      }
    }
    if (event?.type === "validation_checkpoint" && clean(event?.physicalKey)) {
      if (["accepted", "rejected"].includes(event.status)) {
        validations.set(event.physicalKey, event);
      }
    }
  }
  return { completedBlobs, candidates, validations };
}

export function buildPromotionReadyEvidence(candidate, validation) {
  if (!candidate || validation?.status !== "accepted") {
    throw new Error("Promotion-ready recovery rows require an accepted validation checkpoint.");
  }
  const decision = candidate.decision;
  if (!decision?.accepted || !decision.owner || !decision.accountMatch || !decision.nativeIdentity) {
    throw new Error("Promotion-ready recovery rows require an accepted ownership decision.");
  }
  const row = structuredClone(candidate.row);
  const owner = decision.owner;
  const account = decision.accountMatch.account;
  const attributionSignals = uniqueStrings([
    ...(Array.isArray(row?.attributionSignals) ? row.attributionSignals : []),
    "current_verified_account_mapping",
    "historical_native_post_recovery",
    validation.live ? "live_native_url_validation" : "native_url_grammar_validation"
  ]);
  return {
    ...row,
    batchSlug: owner.batchSlug,
    entityType: owner.entityType,
    entityId: owner.entityId,
    entityName: row?.entityName ?? owner.entityName,
    companySlug: row?.companySlug ?? owner.companySlug,
    companyName: row?.companyName ?? owner.companyName,
    attachedCompanyId: owner.companyId,
    attachedCompanyName: row?.attachedCompanyName ?? owner.companyName,
    platform: decision.platform,
    sourceUrl: validation.canonicalUrl ?? decision.nativeIdentity.url,
    platformPostId: decision.nativeIdentity.postId,
    socialAccountId: account.id ?? row?.socialAccountId ?? null,
    accountUrl: account.url ?? row?.accountUrl ?? null,
    review_state: "verified",
    linkStatus: validation.live || row?.linkStatus === "verified" ? "verified" : row?.linkStatus ?? null,
    attributionStatus: "verified",
    attributionMode: "account_owner",
    attributionSignals,
    _recoveryProvenance: {
      schemaVersion: 1,
      kind: "git_repository_non_public_sidecar_history",
      physicalKey: candidate.physicalKey,
      git: {
        blob: candidate.blob,
        commit: candidate.commit,
        committedAt: candidate.committedAt,
        path: candidate.path,
        sourceIndex: candidate.sourceIndex,
        occurrenceCount: candidate.occurrenceCount ?? 1
      },
      currentOwner: {
        batchSlug: owner.batchSlug,
        entityType: owner.entityType,
        entityId: owner.entityId,
        companyId: owner.companyId,
        socialAccountId: account.id ?? null,
        accountUrl: account.url ?? null
      },
      validation: {
        method: validation.method,
        live: Boolean(validation.live),
        canonicalUrl: validation.canonicalUrl ?? decision.nativeIdentity.url
      }
    }
  };
}

export function buildPromotionCandidateArtifact({
  runIdentity,
  baselineCommit,
  historyPaths,
  candidates,
  validations,
  audit = {}
}) {
  const evidence = [];
  const rejectionCounts = {};
  for (const [physicalKey, candidate] of [...candidates.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const validation = validations.get(physicalKey);
    if (validation?.status === "accepted") {
      evidence.push(buildPromotionReadyEvidence(candidate, validation));
    } else {
      const reasons = validation?.reasons?.length ? validation.reasons : ["live_validation_not_completed"];
      for (const reason of reasons) rejectionCounts[reason] = (rejectionCounts[reason] ?? 0) + 1;
    }
  }
  evidence.sort(compareEvidence);
  const byCohortPlatform = countBy(evidence, (row) => `${row.batchSlug}:${row.platform}`);
  const byCohort = countBy(evidence, (row) => row.batchSlug);
  const byPlatform = countBy(evidence, (row) => row.platform);
  return {
    schemaVersion: 1,
    kind: "repository-sidecar-history-promotion-candidate",
    source: {
      label: "True native posts recovered from non-public canonical artifact history",
      runIdentity,
      baselineCommit,
      historyPaths: [...historyPaths],
      notes: [
        "src/lib/social/public-evidence-current.json history is intentionally excluded.",
        "Every row is absent from all current canonical evidence sources at the baseline commit.",
        "Every row resolves to a current cohort company or founder and a current verified native account."
      ]
    },
    counts: {
      total: evidence.length,
      byCohort,
      byPlatform,
      byCohortPlatform,
      validationRejections: sortObject(rejectionCounts)
    },
    audit: sortObject(audit),
    evidence
  };
}

export async function validateNativeCandidate(
  candidate,
  { fetchImpl = globalThis.fetch, offline = false } = {}
) {
  const decision = candidate?.decision;
  if (!decision?.accepted) {
    return rejectedValidation("ownership_decision_not_accepted");
  }
  if (offline || !LIVE_VALIDATION_PLATFORMS.has(decision.platform)) {
    return {
      status: "accepted",
      live: false,
      method: offline
        ? "offline_current_verified_owner_plus_native_url_grammar"
        : "current_verified_owner_plus_native_url_grammar",
      canonicalUrl: decision.nativeIdentity.url,
      reasons: []
    };
  }
  if (typeof fetchImpl !== "function") return rejectedValidation("fetch_unavailable");

  if (decision.platform === "x") {
    const endpoint = new URL("https://publish.twitter.com/oembed");
    endpoint.searchParams.set("omit_script", "true");
    endpoint.searchParams.set("dnt", "true");
    endpoint.searchParams.set("url", decision.nativeIdentity.url);
    const response = await fetchImpl(endpoint, { headers: { accept: "application/json" } });
    if (!response?.ok) return httpRejected("x_oembed", response?.status);
    const payload = await response.json();
    const returnedPost = xStatusIdentity(payload?.url);
    const returnedAuthor = accountIdentity("x", payload?.author_url);
    if (!returnedPost || returnedPost.postId !== decision.nativeIdentity.postId) {
      return rejectedValidation("x_oembed_status_identity_mismatch");
    }
    if (!returnedAuthor || !decision.accountMatch.account.tokens.includes(returnedAuthor)) {
      return rejectedValidation("x_oembed_author_identity_mismatch");
    }
    if (!clean(payload?.html) || !/<blockquote\b/i.test(payload.html)) {
      return rejectedValidation("x_oembed_post_body_missing");
    }
    return {
      status: "accepted",
      live: true,
      method: "official_x_oembed",
      canonicalUrl: returnedPost.url,
      reasons: []
    };
  }

  if (decision.platform === "youtube") {
    const endpoint = new URL("https://www.youtube.com/oembed");
    endpoint.searchParams.set("format", "json");
    endpoint.searchParams.set("url", decision.nativeIdentity.url);
    const response = await fetchImpl(endpoint, { headers: { accept: "application/json" } });
    if (!response?.ok) return httpRejected("youtube_oembed", response?.status);
    const payload = await response.json();
    if (!clean(payload?.title) || String(payload?.type ?? "").toLowerCase() !== "video") {
      return rejectedValidation("youtube_oembed_video_missing");
    }
    return {
      status: "accepted",
      live: true,
      method: "official_youtube_oembed",
      canonicalUrl: decision.nativeIdentity.url,
      reasons: []
    };
  }

  const response = await fetchImpl(decision.nativeIdentity.url, {
    method: "GET",
    redirect: "follow",
    headers: { accept: "text/html", range: "bytes=0-4095", "user-agent": "returner-fund-history-recovery/1.0" }
  });
  if (!response?.ok) return httpRejected("github_native", response?.status);
  const finalIdentity = nativePostIdentity("github", { sourceUrl: response.url || decision.nativeIdentity.url });
  if (!finalIdentity || finalIdentity.postId.toLowerCase() !== decision.nativeIdentity.postId.toLowerCase()) {
    return rejectedValidation("github_redirect_identity_mismatch");
  }
  return {
    status: "accepted",
    live: true,
    method: "github_native_url",
    canonicalUrl: finalIdentity.url,
    reasons: []
  };
}

export function historyPathBatchSlug(path) {
  const value = String(path ?? "").toLowerCase();
  if (value.includes("a16z") || value.includes("a16zsr006")) return "A16ZSR006";
  if (value.includes("s2026")) return "S2026";
  if (/(^|\/)s26(?:[-./]|$)/.test(value)) return "S26";
  return null;
}

export function nativePostIdentity(platformValue, row) {
  const platform = normalizePlatform(platformValue);
  const rawUrl = clean(row?.sourceUrl ?? row?.source_url ?? row?.url ?? row);
  if (!platform || !rawUrl) return null;
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./i, "").toLowerCase();
  const path = decodeURIComponent(url.pathname);
  const explicit = clean(row?.platformPostId ?? row?.platform_post_id);

  if (platform === "x") return xStatusIdentity(url.toString());
  if (platform === "instagram" && host === "instagram.com") {
    const match = path.match(/^\/(?:p|reel|tv)\/([^/?#]+)/i);
    return match ? { postId: match[1], url: `https://www.instagram.com/reel/${match[1]}/` } : null;
  }
  if (platform === "youtube" && new Set(["youtube.com", "m.youtube.com", "youtu.be"]).has(host)) {
    const id = host === "youtu.be"
      ? path.split("/").filter(Boolean)[0]
      : url.searchParams.get("v") ?? path.match(/^\/(?:shorts|live|embed)\/([^/?#]+)/i)?.[1];
    return id ? { postId: id, url: `https://www.youtube.com/watch?v=${encodeURIComponent(id)}` } : null;
  }
  if (platform === "linkedin" && host.endsWith("linkedin.com")) {
    const activity = path.match(/(?:activity|ugcPost|share)[-:]?(\d{10,})/i)?.[1]
      ?? explicit;
    if (!activity || !/(?:\/posts\/|\/feed\/update\/|urn:li:)/i.test(`${path}${url.search}`)) return null;
    return { postId: activity, url: canonicalUrl(url) };
  }
  if (platform === "github" && host === "github.com") {
    const parts = path.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const postId = explicit ?? parts.slice(0, 4).join("/");
    return postId ? { postId, url: canonicalUrl(url) } : null;
  }
  if (platform === "product_hunt" && host.endsWith("producthunt.com") && /^\/posts\//i.test(path)) {
    return { postId: explicit ?? path.split("/").filter(Boolean).at(-1), url: canonicalUrl(url) };
  }
  if (platform === "hacker_news" && host === "news.ycombinator.com" && path === "/item") {
    const id = url.searchParams.get("id") ?? explicit;
    return id ? { postId: id, url: `https://news.ycombinator.com/item?id=${encodeURIComponent(id)}` } : null;
  }
  if (platform === "reddit" && host.endsWith("reddit.com") && /\/comments\//i.test(path)) {
    const id = path.match(/\/comments\/([^/]+)/i)?.[1] ?? explicit;
    return id ? { postId: id, url: canonicalUrl(url) } : null;
  }
  if (platform === "tiktok" && host.endsWith("tiktok.com") && /\/video\/\d+/i.test(path)) {
    const id = path.match(/\/video\/(\d+)/i)?.[1] ?? explicit;
    return id ? { postId: id, url: canonicalUrl(url) } : null;
  }
  if (platform === "bluesky" && host === "bsky.app" && /\/post\//i.test(path)) {
    const id = path.match(/\/post\/([^/]+)/i)?.[1] ?? explicit;
    return id ? { postId: id, url: canonicalUrl(url) } : null;
  }
  return null;
}

export function stableJson(value) {
  return `${JSON.stringify(sortDeep(value), null, 2)}\n`;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeVerifiedAccounts(accounts) {
  return (accounts ?? [])
    .filter((account) => String(account?.review_state ?? account?.reviewState ?? "").toLowerCase() === "verified")
    .map((account) => {
      const platform = normalizePlatform(account?.platform);
      const tokens = uniqueStrings([
        accountIdentity(platform, account?.url),
        genericHandleToken(platform, account?.handle)
      ]);
      return {
        id: clean(account?.id),
        platform,
        handle: clean(account?.handle),
        url: clean(account?.url),
        tokens
      };
    })
    .filter((account) => account.platform && (account.id || account.tokens.length > 0));
}

function matchCurrentOwnerAccount(row, owner, platform, nativeIdentity) {
  const accounts = owner.accounts.filter((account) => account.platform === platform);
  if (accounts.length === 0) return null;
  const socialAccountId = clean(row?.socialAccountId ?? row?.social_account_id);
  if (socialAccountId) {
    const direct = accounts.find((account) => account.id === socialAccountId);
    if (direct && (platform !== "x" || direct.tokens.includes(nativeIdentity?.authorToken))) {
      return { account: direct, matchedBy: "social_account_id" };
    }
  }
  const tokens = historicalAuthorTokens(row, platform, nativeIdentity);
  for (const account of accounts) {
    const matchedToken = account.tokens.find((token) => tokens.has(token));
    if (matchedToken) return { account, matchedBy: matchedToken };
  }
  return null;
}

function historicalAuthorTokens(row, platform, nativeIdentity) {
  const raw = parseRawVisibleText(row?.rawVisibleText);
  const values = [
    row?.accountUrl,
    row?.authorHandle,
    row?.author_handle,
    row?.nativeAuthorResolution?.author?.key,
    raw?.profile?.url,
    raw?.profile?.username,
    raw?.profile?.handle,
    raw?.profile?.screen_name,
    raw?.post?.author?.url,
    raw?.post?.author?.screen_name,
    raw?.post?.author?.username,
    raw?.author?.url,
    raw?.author?.screen_name,
    raw?.author?.username
  ];
  const tokens = new Set();
  if (nativeIdentity?.authorToken) tokens.add(nativeIdentity.authorToken);
  for (const value of values) {
    const token = accountIdentity(platform, value) ?? genericHandleToken(platform, value);
    if (token) tokens.add(token);
  }
  if (platform === "github") {
    try {
      const url = new URL(row?.sourceUrl ?? row?.source_url);
      const owner = url.pathname.split("/").filter(Boolean)[0];
      const token = genericHandleToken("github", owner);
      if (token) tokens.add(token);
    } catch {}
  }
  return tokens;
}

function accountIdentity(platformValue, rawValue) {
  const platform = normalizePlatform(platformValue);
  const value = clean(rawValue);
  if (!platform || !value) return null;
  if (!/^https?:\/\//i.test(value)) return genericHandleToken(platform, value);
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    const parts = decodeURIComponent(url.pathname).split("/").filter(Boolean);
    if (platform === "x" && X_HOSTS.has(host) && parts.length >= 1) {
      return genericHandleToken(platform, parts[0]);
    }
    if (platform === "instagram" && host === "instagram.com" && parts.length >= 1 && !["p", "reel", "tv"].includes(parts[0])) {
      return genericHandleToken(platform, parts[0]);
    }
    if (platform === "linkedin" && host.endsWith("linkedin.com") && ["in", "company"].includes(parts[0]) && parts[1]) {
      return `linkedin:${parts[0]}:${normalizeHandle(parts[1])}`;
    }
    if (platform === "youtube" && host.endsWith("youtube.com") && parts.length >= 1) {
      if (parts[0].startsWith("@")) return `youtube:handle:${normalizeHandle(parts[0])}`;
      if (["channel", "c", "user"].includes(parts[0]) && parts[1]) {
        return `youtube:${parts[0]}:${normalizeHandle(parts[1])}`;
      }
    }
    if (platform === "github" && host === "github.com" && parts[0]) {
      return genericHandleToken(platform, parts[0]);
    }
    if (platform === "product_hunt" && host.endsWith("producthunt.com") && parts[0]?.startsWith("@")) {
      return genericHandleToken(platform, parts[0]);
    }
    if (platform === "reddit" && host.endsWith("reddit.com") && ["u", "user"].includes(parts[0]) && parts[1]) {
      return genericHandleToken(platform, parts[1]);
    }
  } catch {}
  return null;
}

function genericHandleToken(platformValue, value) {
  const platform = normalizePlatform(platformValue);
  const handle = normalizeHandle(value);
  return platform && handle ? `${platform}:handle:${handle}` : null;
}

function xStatusIdentity(rawUrl) {
  try {
    const url = new URL(String(rawUrl ?? ""));
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    if (!X_HOSTS.has(host)) return null;
    const match = decodeURIComponent(url.pathname).match(/^\/([^/]+)\/status\/(\d+)(?:\/.*)?$/i);
    if (!match || match[1].toLowerCase() === "i") return null;
    const handle = normalizeHandle(match[1]);
    return handle
      ? {
          postId: match[2],
          authorToken: genericHandleToken("x", handle),
          url: `https://x.com/${handle}/status/${match[2]}`
        }
      : null;
  } catch {
    return null;
  }
}

function preferredCandidate(left, right) {
  const leftRank = candidateRank(left);
  const rightRank = candidateRank(right);
  const preferred = rightRank.localeCompare(leftRank) > 0 ? right : left;
  return {
    ...preferred,
    occurrenceCount: Number(left?.occurrenceCount ?? 1) + Number(right?.occurrenceCount ?? 1)
  };
}

function candidateRank(candidate) {
  const rawPriority = String(candidate?.path ?? "").startsWith("src/lib/social/") ? "2" : "1";
  const richness = String(Object.keys(candidate?.row ?? {}).length).padStart(5, "0");
  return `${rawPriority}:${richness}:${candidate?.committedAt ?? ""}:${candidate?.commit ?? ""}:${candidate?.path ?? ""}`;
}

function compareEvidence(left, right) {
  return String(left?.batchSlug ?? "").localeCompare(String(right?.batchSlug ?? ""))
    || String(left?.platform ?? "").localeCompare(String(right?.platform ?? ""))
    || String(physicalSourceKey(left) ?? "").localeCompare(String(physicalSourceKey(right) ?? ""));
}

function looksLikeEvidenceRow(row) {
  return Boolean(
    row
    && typeof row === "object"
    && !Array.isArray(row)
    && clean(row?.platform)
    && (clean(row?.sourceUrl ?? row?.source_url) || clean(row?.platformPostId ?? row?.platform_post_id))
  );
}

function collectArraysNamed(value, targetKey, onRow) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectArraysNamed(item, targetKey, onRow);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === targetKey && Array.isArray(child)) {
      for (const row of child) onRow(row);
      continue;
    }
    collectArraysNamed(child, targetKey, onRow);
  }
}

function normalizeHeldRow(row) {
  const platform = normalizePlatform(row?.platform);
  const sourceUrl = clean(row?.sourceUrl ?? row?.source_url ?? row?.candidateUrl);
  const platformPostId = clean(row?.platformPostId ?? row?.platform_post_id);
  if (!platform || (!sourceUrl && !platformPostId)) return null;
  return { platform, sourceUrl, platformPostId };
}

function companySlugFrom(node, companyId) {
  const explicit = normalizeSlug(node?.companySlug ?? node?.slug);
  if (explicit) return explicit;
  const profile = clean(node?.ycProfileUrl ?? node?.sourceUrl);
  if (profile) {
    try {
      const slug = new URL(profile).pathname.match(/\/companies\/([^/]+)/i)?.[1];
      if (slug) return normalizeSlug(slug);
    } catch {}
  }
  return normalizeSlug(String(companyId).replace(/^company-/, "").replace(/^a16z-speedrun-006-/, ""));
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

function canonicalUrl(input) {
  const url = input instanceof URL ? new URL(input) : new URL(String(input));
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid|ref$)/i.test(key)) url.searchParams.delete(key);
  }
  return url.toString();
}

function rejectedValidation(reason) {
  return { status: "rejected", live: false, method: null, canonicalUrl: null, reasons: [reason] };
}

function httpRejected(prefix, status) {
  return rejectedValidation(`${prefix}_http_${Number.isFinite(Number(status)) ? status : "failed"}`);
}

function countBy(rows, keyFor) {
  const counts = {};
  for (const row of rows) {
    const key = keyFor(row);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return sortObject(counts);
}

function sortObject(value) {
  return Object.fromEntries(Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b)));
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, sortDeep(child)])
  );
}

function normalizePlatform(value) {
  const platform = String(value ?? "").trim().toLowerCase();
  if (platform === "twitter") return "x";
  if (platform === "producthunt") return "product_hunt";
  if (["hackernews", "hn"].includes(platform)) return "hacker_news";
  return platform || null;
}

function normalizeBatchSlug(value) {
  const batch = String(value ?? "").trim().toUpperCase();
  return RECOVERY_COHORTS.includes(batch) ? batch : null;
}

function normalizeEntityType(value) {
  const entityType = String(value ?? "").trim().toLowerCase();
  return ["company", "founder"].includes(entityType) ? entityType : null;
}

function normalizeHandle(value) {
  const handle = String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/^@/, "")
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "")
    .toLowerCase();
  return /^[a-z0-9_.-]{1,128}$/.test(handle) ? handle : null;
}

function normalizeName(value) {
  const name = String(value ?? "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
  return name || null;
}

function normalizeSlug(value) {
  const slug = String(value ?? "").normalize("NFKC").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug || null;
}

function scopedKey(...values) {
  return values.join(":");
}

function uniqueStrings(values) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

function clean(value) {
  const text = String(value ?? "").trim();
  return text || null;
}
