import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const OPERATIONAL_LEDGER_POST_RECOVERY_SCHEMA_VERSION =
  "operational-ledger-post-recovery.v1";
export const OPERATIONAL_LEDGER_POST_RECOVERY_JOURNAL_VERSION =
  "operational-ledger-post-recovery-journal.v1";
export const OPERATIONAL_LEDGER_POST_RECOVERY_CHECKPOINT_VERSION =
  "operational-ledger-post-recovery-checkpoint.v1";
export const OPERATIONAL_LEDGER_POST_RECOVERY_VALIDATOR_VERSION =
  "anonymous-native-oembed.v1";

export const OPERATIONAL_LEDGER_SECTIONS = Object.freeze([
  "failures",
  "attempts",
  "discoveryAttempts",
  "sourceDiscoveryPaths"
]);

export const OPERATIONAL_LEDGER_RECOVERY_PLATFORMS = Object.freeze([
  "x",
  "linkedin",
  "instagram",
  "youtube"
]);

export const DEFAULT_CURRENT_EVIDENCE_PATHS = Object.freeze([
  "src/lib/social/public-evidence-current.json",
  "src/lib/social/logged-in-evidence-current.json",
  "src/lib/social/targeted-evidence-current.json",
  "src/lib/social/volume-evidence-current.json",
  "src/lib/social/a16z-speedrun-006-social-evidence.json",
  "src/lib/social/eden-robotics-verified-native-evidence.json",
  "outputs/source-hunt/2026-07-19-s26-new-companies-recent.json",
  "outputs/source-hunt/2026-07-19-cross-batch-community-video-recent.json",
  "outputs/source-hunt/2026-07-22-two-hour-official-youtube-s2026.json"
]);

const LEDGER_SCHEMA_VERSION = "public-ingestion-operational-ledger.v1";
const URL_PATTERN = /https?:\/\/[^\s"'<>\[\]{}\\]+/giu;
const TRAILING_URL_PUNCTUATION = /[),.;:!?]+$/u;
const X_POST_ID = /^\d{15,22}$/u;
const LINKEDIN_POST_ID = /^\d{18,22}$/u;
const INSTAGRAM_POST_ID = /^[A-Za-z0-9_-]{5,24}$/u;
const YOUTUBE_POST_ID = /^[A-Za-z0-9_-]{11}$/u;
const POSITIVE_METRIC_KEYS = new Set([
  "views",
  "likes",
  "comments",
  "replies",
  "reposts",
  "quotes",
  "saves",
  "videoViews",
  "videoPlays"
]);
const EXPLICIT_ID_KEYS = new Set([
  "platformpostid",
  "platform_post_id",
  "postid",
  "post_id",
  "statusid",
  "status_id",
  "tweetid",
  "tweet_id",
  "activityid",
  "activity_id",
  "shortcode",
  "videoid",
  "video_id"
]);
const EMBEDDED_ID_PATTERN =
  /["'](?:platformPostId|platform_post_id|postId|post_id|statusId|status_id|tweetId|tweet_id|activityId|activity_id|shortcode|videoId|video_id)["']\s*:\s*["']([^"']+)["']/giu;

export function normalizeRecoveryPlatform(value) {
  const platform = String(value ?? "").trim().toLowerCase();
  if (platform === "twitter") return "x";
  return OPERATIONAL_LEDGER_RECOVERY_PLATFORMS.includes(platform) ? platform : null;
}

export function normalizeNativePostUrl(platformHint, rawValue) {
  const rawUrl = String(rawValue ?? "").trim().replace(TRAILING_URL_PUNCTUATION, "");
  if (!rawUrl) return null;
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!new Set(["http:", "https:"]).has(url.protocol)) return null;

  const host = url.hostname.replace(/^www\./u, "").toLowerCase();
  const path = safeDecodePath(url.pathname);
  const hinted = normalizeRecoveryPlatform(platformHint);
  const platform = platformForHost(host) ?? hinted;
  if (!platform || (hinted && platform !== hinted)) return null;

  if (platform === "x") {
    if (!["x.com", "twitter.com", "mobile.twitter.com"].includes(host)) return null;
    const ordinary = path.match(/^\/([^/]+)\/status\/(\d{15,22})(?:\/|$)/iu);
    if (ordinary) {
      const authorKey = normalizeHandle(ordinary[1]);
      if (!authorKey || authorKey === "i") return null;
      return nativePost({
        platform,
        postId: ordinary[2],
        canonicalUrl: `https://x.com/${authorKey}/status/${ordinary[2]}`,
        authorKey,
        authorAccountKey: `x:${authorKey}`,
        sourceUrl: rawUrl
      });
    }
    const generic = path.match(/^\/i\/(?:web\/)?status\/(\d{15,22})(?:\/|$)/iu);
    if (!generic) return null;
    return nativePost({
      platform,
      postId: generic[1],
      canonicalUrl: `https://x.com/i/status/${generic[1]}`,
      authorKey: null,
      authorAccountKey: null,
      sourceUrl: rawUrl
    });
  }

  if (platform === "linkedin") {
    if (!(host === "linkedin.com" || host.endsWith(".linkedin.com"))) return null;
    const postMatch = path.match(/^\/posts\/([^/?#]+).*?activity-(\d{18,22})(?:[-/?#]|$)/iu);
    const urnMatch = `${path}${url.search}`.match(
      /urn:li:(?:activity|share|ugcPost)[:%3A]+(\d{18,22})/iu
    );
    const postId = postMatch?.[2] ?? urnMatch?.[1] ?? null;
    if (!postId || !LINKEDIN_POST_ID.test(postId)) return null;
    const authorKey = linkedinPostAuthor(postMatch?.[1]);
    return nativePost({
      platform,
      postId,
      canonicalUrl: postMatch
        ? canonicalLinkedinPostUrl(url)
        : `https://www.linkedin.com/feed/update/urn:li:activity:${postId}`,
      authorKey,
      authorAccountKey: authorKey ? `linkedin:${authorKey}` : null,
      sourceUrl: rawUrl
    });
  }

  if (platform === "instagram") {
    if (!(host === "instagram.com" || host.endsWith(".instagram.com"))) return null;
    const match = path.match(/^\/(p|reel|reels|tv)\/([A-Za-z0-9_-]{5,24})(?:\/|$)/iu);
    if (!match || !INSTAGRAM_POST_ID.test(match[2])) return null;
    const kind = match[1].toLowerCase() === "reels" ? "reel" : match[1].toLowerCase();
    return nativePost({
      platform,
      postId: match[2],
      canonicalUrl: `https://www.instagram.com/${kind}/${match[2]}/`,
      authorKey: null,
      authorAccountKey: null,
      sourceUrl: rawUrl
    });
  }

  if (platform === "youtube") {
    if (!["youtube.com", "m.youtube.com", "youtu.be"].includes(host)) return null;
    const postId = host === "youtu.be"
      ? path.split("/").filter(Boolean)[0]
      : url.searchParams.get("v") ??
        path.match(/^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})(?:\/|$)/iu)?.[1];
    if (!postId || !YOUTUBE_POST_ID.test(postId)) return null;
    return nativePost({
      platform,
      postId,
      canonicalUrl: `https://www.youtube.com/watch?v=${postId}`,
      authorKey: null,
      authorAccountKey: null,
      sourceUrl: rawUrl
    });
  }
  return null;
}

export function extractOperationalLedgerCandidates(ledger) {
  validateOperationalLedger(ledger);
  const occurrences = [];
  for (const section of OPERATIONAL_LEDGER_SECTIONS) {
    if (section === "attempts") {
      for (const [recordKey, row] of Object.entries(ledger.attempts).sort(([left], [right]) =>
        left.localeCompare(right)
      )) {
        extractRecordOccurrences(row, section, recordKey, occurrences);
      }
      continue;
    }
    ledger[section].forEach((row, index) => {
      extractRecordOccurrences(row, section, String(index), occurrences);
    });
  }

  const grouped = new Map();
  for (const occurrence of occurrences) {
    const current = grouped.get(occurrence.identity) ?? {
      identity: occurrence.identity,
      platform: occurrence.native.platform,
      platformPostId: occurrence.native.postId,
      canonicalUrl: occurrence.native.canonicalUrl,
      nativeAuthorKey: occurrence.native.authorKey,
      nativeAuthorAccountKey: occurrence.native.authorAccountKey,
      sourceUrl: occurrence.native.sourceUrl,
      metrics: {},
      provenance: []
    };
    if (nativeVariantQuality(occurrence.native) > nativeVariantQuality(current)) {
      current.canonicalUrl = occurrence.native.canonicalUrl;
      current.nativeAuthorKey = occurrence.native.authorKey;
      current.nativeAuthorAccountKey = occurrence.native.authorAccountKey;
      current.sourceUrl = occurrence.native.sourceUrl;
    }
    current.metrics = preferMetrics(current.metrics, occurrence.metrics);
    current.provenance.push(occurrence.provenance);
    grouped.set(occurrence.identity, current);
  }

  return [...grouped.values()]
    .map((candidate) => ({
      ...candidate,
      provenance: dedupeAndSortProvenance(candidate.provenance),
      occurrenceCount: candidate.provenance.length
    }))
    .sort(compareCandidate);
}

export function buildCurrentEvidenceIdentityIndex(sources) {
  const index = new Map();
  for (const source of [...(sources ?? [])].sort((left, right) => left.path.localeCompare(right.path))) {
    for (const collection of ["evidence", "needsReview"]) {
      const rows = Array.isArray(source.snapshot?.[collection]) ? source.snapshot[collection] : [];
      rows.forEach((row, rowIndex) => {
        const identity = physicalEvidenceIdentity(row);
        if (!identity) return;
        const matches = index.get(identity) ?? [];
        matches.push({ path: source.path, collection, rowIndex, id: row?.id ?? null });
        index.set(identity, matches);
      });
    }
  }
  for (const matches of index.values()) {
    matches.sort((left, right) =>
      left.path.localeCompare(right.path) ||
      left.collection.localeCompare(right.collection) ||
      left.rowIndex - right.rowIndex
    );
  }
  return index;
}

export function physicalEvidenceIdentity(row) {
  const platform = normalizeRecoveryPlatform(row?.platform ?? row?.sourcePlatform);
  if (!platform) return null;
  for (const value of [
    row?.sourceUrl,
    row?.source_url,
    row?.canonicalUrl,
    row?.canonical_url,
    row?.candidateUrl,
    row?.url
  ]) {
    const native = normalizeNativePostUrl(platform, value);
    if (native) return native.identity;
  }
  const postId = normalizeNativePostId(
    platform,
    row?.platformPostId ?? row?.platform_post_id ?? row?.nativeId
  );
  return postId ? physicalIdentity(platform, postId) : null;
}

export function buildCatalogOwnershipIndex(catalogs) {
  const exactOwners = new Map();
  const accountOwners = new Map();
  const officialSourceOwners = new Map();

  for (const catalog of catalogs ?? []) {
    for (const company of catalog.companies ?? []) {
      const companySlug = catalogCompanySlug(company);
      const companyOwner = ownerRecord({ catalog, company, companySlug, founder: null });
      addExactOwner(exactOwners, companyOwner);
      addOfficialSources(officialSourceOwners, companyOwner, [
        company.websiteUrl,
        company.profileUrl
      ]);
      addAccountOwners(accountOwners, companyOwner, company.accounts);
      for (const founder of company.founders ?? []) {
        const founderOwner = ownerRecord({ catalog, company, companySlug, founder });
        addExactOwner(exactOwners, founderOwner);
        addOfficialSources(officialSourceOwners, founderOwner, [founder.websiteUrl, founder.profileUrl]);
        addAccountOwners(accountOwners, founderOwner, founder.accounts);
      }
    }
  }
  return { exactOwners, accountOwners, officialSourceOwners };
}

export function auditOperationalLedgerCandidates({
  candidates,
  currentEvidenceIndex,
  ownershipIndex,
  validationReceipts = new Map(),
  inputManifest = null
}) {
  const evidence = [];
  const rejectedCandidates = [];
  const netNewCandidates = [];

  for (const candidate of candidates ?? []) {
    const existing = currentEvidenceIndex.get(candidate.identity) ?? [];
    if (existing.length > 0) {
      rejectedCandidates.push(rejection(candidate, ["already_in_current_evidence_or_review"], {
        existingMatches: existing
      }));
      continue;
    }
    netNewCandidates.push(candidate);
    const validationReceipt = validationReceipts.get(candidate.identity) ?? null;
    const ownership = resolveCandidateOwnership(candidate, ownershipIndex, validationReceipt);
    const reasons = [];
    if (!ownership.ok) reasons.push(...ownership.reasons);
    if (validationReceipt?.status === "not_found" || validationReceipt?.status === "failed") {
      reasons.push(`anonymous_validation_${validationReceipt.status}`);
    }
    if (reasons.length > 0) {
      rejectedCandidates.push(rejection(candidate, uniqueStrings(reasons), {
        ownershipReceipt: ownership.receipt ?? null,
        resolvedOwner: ownership.owner ?? null,
        validationReceipt
      }));
      continue;
    }
    const metrics = positiveMetrics(candidate.metrics);
    if (Object.keys(metrics).length === 0) {
      rejectedCandidates.push(rejection(candidate, ["missing_positive_metrics_for_promotion"], {
        ownershipReceipt: ownership.receipt,
        resolvedOwner: ownership.owner,
        validationReceipt
      }));
      continue;
    }
    evidence.push(promotionEvidence(candidate, ownership.owner, ownership.receipt, validationReceipt, metrics));
  }

  evidence.sort(compareEvidence);
  rejectedCandidates.sort(compareRejection);
  const attributableNetNew = netNewCandidates.flatMap((candidate) => {
    const ownership = resolveCandidateOwnership(
      candidate,
      ownershipIndex,
      validationReceipts.get(candidate.identity) ?? null
    );
    return ownership.ok ? [{ ...candidate, batchSlug: ownership.owner.batchSlug }] : [];
  });

  return {
    schemaVersion: OPERATIONAL_LEDGER_POST_RECOVERY_SCHEMA_VERSION,
    inputManifest,
    summary: recoverySummary({
      candidates,
      netNewCandidates,
      attributableNetNew,
      evidence,
      rejectedCandidates
    }),
    evidence,
    needsReview: [],
    rejectedCandidates
  };
}

export function resolveCandidateOwnership(candidate, index, validationReceipt = null) {
  const nativeAccountKey = candidate.nativeAuthorAccountKey ??
    accountKeyFromAnonymousReceipt(candidate.platform, validationReceipt);
  if (nativeAccountKey) {
    const owners = uniqueOwners(index.accountOwners.get(nativeAccountKey) ?? []);
    if (owners.length === 1) {
      return ownershipSuccess(owners[0], {
        method: candidate.nativeAuthorAccountKey
          ? "unique_native_author_from_post_url"
          : "unique_native_author_from_anonymous_oembed",
        nativeAccountKey,
        immutable: true
      });
    }
    if (owners.length > 1) {
      return ownershipFailure("native_author_maps_to_multiple_canonical_owners", {
        nativeAccountKey,
        owners
      });
    }
    if (["x", "linkedin", "youtube"].includes(candidate.platform)) {
      return ownershipFailure("native_author_not_in_canonical_roster", { nativeAccountKey });
    }
  }

  const contextual = contextOwnershipClaims(candidate, index);
  if (candidate.platform === "instagram") {
    const accountClaims = contextual.filter((claim) => claim.accountOwner);
    const owners = uniqueOwners(accountClaims.map((claim) => claim.accountOwner));
    if (owners.length === 1 && accountClaims.every((claim) =>
      !claim.exactOwner || sameOwner(claim.exactOwner, owners[0])
    )) {
      return ownershipSuccess(owners[0], {
        method: "mapped_collector_account_context",
        nativeAccountKey: accountClaims[0].accountKey,
        immutable: true
      });
    }
    return ownershipFailure(
      owners.length > 1
        ? "collector_account_maps_to_multiple_canonical_owners"
        : "instagram_native_owner_unavailable",
      { contextual }
    );
  }

  if (candidate.platform === "youtube") {
    const embeddedClaims = contextual.filter((claim) => claim.officialEmbeddedVideo);
    const owners = uniqueOwners(embeddedClaims.map((claim) => claim.exactOwner).filter(Boolean));
    if (owners.length === 1) {
      return ownershipSuccess(owners[0], {
        method: "canonical_official_page_embedded_native_video",
        sourceUrl: embeddedClaims[0].sourceUrl,
        immutable: true
      });
    }
    return ownershipFailure("youtube_channel_not_mapped_to_canonical_owner", {
      anonymousAuthorUrl: validationReceipt?.authorUrl ?? null,
      contextual
    });
  }

  if (candidate.platform === "x") {
    return ownershipFailure("x_native_author_unavailable");
  }
  if (candidate.platform === "linkedin") {
    return ownershipFailure("linkedin_native_author_unavailable_offline");
  }
  return ownershipFailure("canonical_owner_unavailable");
}

export function candidatesRequiringAnonymousValidation(candidates, currentEvidenceIndex) {
  return (candidates ?? [])
    .filter((candidate) => !currentEvidenceIndex.has(candidate.identity))
    .filter((candidate) => ["x", "youtube"].includes(candidate.platform))
    .sort(compareCandidate);
}

export async function validateAnonymousNativeCandidate(candidate, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
  userAgent = "ReturnerFundOfflineAudit/1.0"
} = {}) {
  if (!["x", "youtube"].includes(candidate.platform)) {
    return {
      validatorVersion: OPERATIONAL_LEDGER_POST_RECOVERY_VALIDATOR_VERSION,
      identity: candidate.identity,
      platform: candidate.platform,
      status: "skipped",
      reason: "offline_only_safety_constraint",
      endpointClass: null
    };
  }
  if (typeof fetchImpl !== "function") throw new TypeError("Anonymous validation requires fetch.");
  const endpoint = candidate.platform === "youtube"
    ? `https://www.youtube.com/oembed?url=${encodeURIComponent(candidate.canonicalUrl)}&format=json`
    : `https://publish.twitter.com/oembed?url=${encodeURIComponent(candidate.canonicalUrl)}&omit_script=true&dnt=true`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      headers: { accept: "application/json", "user-agent": userAgent },
      redirect: "follow",
      signal: controller.signal
    });
    if (response.status === 404) {
      return anonymousReceipt(candidate, "not_found", { httpStatus: response.status });
    }
    if (!response.ok) {
      return anonymousReceipt(candidate, "failed", { httpStatus: response.status });
    }
    const body = await response.json();
    const authorUrl = nullableText(body?.author_url);
    const authorName = nullableText(body?.author_name);
    const receipt = anonymousReceipt(candidate, "verified", {
      httpStatus: response.status,
      authorUrl,
      authorName,
      title: nullableText(body?.title),
      providerName: nullableText(body?.provider_name)
    });
    if (candidate.platform === "x" && candidate.nativeAuthorKey) {
      const observed = xHandleFromOembed(body);
      if (observed && observed !== candidate.nativeAuthorKey) {
        return { ...receipt, status: "failed", reason: "oembed_native_author_mismatch", observedAuthorKey: observed };
      }
      return { ...receipt, observedAuthorKey: observed ?? candidate.nativeAuthorKey };
    }
    return receipt;
  } catch (error) {
    return anonymousReceipt(candidate, "failed", {
      reason: error?.name === "AbortError" ? "anonymous_validation_timeout" : "anonymous_validation_error",
      errorClass: error?.name ?? "Error"
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function loadCurrentEvidenceSources(root, {
  paths = DEFAULT_CURRENT_EVIDENCE_PATHS
} = {}) {
  const sources = [];
  for (const configuredPath of paths) {
    const absolutePath = resolveInsideRoot(root, configuredPath);
    let bytes;
    try {
      bytes = await readFile(absolutePath);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const snapshot = parseJson(bytes, configuredPath);
    if (snapshot?.reviewLedgerRef) {
      const reviewPath = requiredSafeRelativePath(snapshot.reviewLedgerRef.path, "reviewLedgerRef.path");
      const reviewBytes = await readFile(resolveInsideRoot(root, reviewPath));
      verifyReferencedBytes(reviewBytes, snapshot.reviewLedgerRef, reviewPath);
      const review = parseJson(reviewBytes, reviewPath);
      snapshot.needsReview = review.needsReview ?? [];
      snapshot.attributionReconciliationLedger = review.attributionReconciliationLedger ?? [];
    }
    sources.push({
      path: configuredPath,
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
      snapshot
    });
  }
  return sources.sort((left, right) => left.path.localeCompare(right.path));
}

export async function readValidationJournal(path, { inputHash = null } = {}) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return new Map();
    throw error;
  }
  const receipts = new Map();
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    const entry = parseJson(Buffer.from(line), `${path}:${index + 1}`);
    if (entry.schemaVersion !== OPERATIONAL_LEDGER_POST_RECOVERY_JOURNAL_VERSION) {
      throw new Error(`Unsupported recovery journal schema at line ${index + 1}.`);
    }
    if (inputHash && entry.inputHash !== inputHash) {
      throw new Error("Recovery journal input hash does not match the current repository artifacts.");
    }
    if (!entry.identity || !entry.receipt) throw new Error(`Malformed recovery journal line ${index + 1}.`);
    const previous = receipts.get(entry.identity);
    if (previous && stableStringify(previous) !== stableStringify(entry.receipt)) {
      throw new Error(`Conflicting recovery journal receipt for ${entry.identity}.`);
    }
    receipts.set(entry.identity, entry.receipt);
  }
  return receipts;
}

export async function appendValidationJournal(path, { inputHash, identity, receipt }) {
  await mkdir(dirname(path), { recursive: true });
  const entry = {
    schemaVersion: OPERATIONAL_LEDGER_POST_RECOVERY_JOURNAL_VERSION,
    inputHash,
    identity,
    receipt
  };
  await appendFile(path, `${stableStringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function writeRecoveryArtifactAtomic(path, artifact) {
  await mkdir(dirname(path), { recursive: true });
  const body = `${stableStringify(artifact, 2)}\n`;
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
  return { path, bytes: Buffer.byteLength(body), sha256: sha256(Buffer.from(body)) };
}

export function buildRecoveryInputManifest({ ledgerBytes, ledgerPath, evidenceSources, catalogs }) {
  const catalogProjection = (catalogs ?? []).map((catalog) => ({
    batchSlug: catalog.slug,
    companies: (catalog.companies ?? []).map((company) => ({
      id: company.sourceKey,
      name: company.name,
      websiteUrl: company.websiteUrl ?? null,
      profileUrl: company.profileUrl ?? null,
      accounts: projectAccounts(company.accounts),
      founders: (company.founders ?? []).map((founder) => ({
        id: founder.sourceKey,
        name: founder.name,
        profileUrl: founder.profileUrl ?? null,
        accounts: projectAccounts(founder.accounts)
      })).sort((left, right) => left.id.localeCompare(right.id))
    })).sort((left, right) => left.id.localeCompare(right.id))
  })).sort((left, right) => left.batchSlug.localeCompare(right.batchSlug));
  const manifest = {
    ledger: {
      path: ledgerPath,
      bytes: ledgerBytes.byteLength,
      sha256: sha256(ledgerBytes)
    },
    evidenceSources: (evidenceSources ?? []).map((source) => ({
      path: source.path,
      bytes: source.bytes,
      sha256: source.sha256,
      evidenceCount: source.snapshot?.evidence?.length ?? 0,
      needsReviewCount: source.snapshot?.needsReview?.length ?? 0
    })),
    catalogSha256: sha256(Buffer.from(stableStringify(catalogProjection)))
  };
  return { ...manifest, inputHash: sha256(Buffer.from(stableStringify(manifest))) };
}

export function recoveryCheckpoint({ inputHash, pendingCandidates, receipts }) {
  const completed = [...receipts.keys()].sort();
  const pending = pendingCandidates
    .map((candidate) => candidate.identity)
    .filter((identity) => !receipts.has(identity))
    .sort();
  return {
    schemaVersion: OPERATIONAL_LEDGER_POST_RECOVERY_CHECKPOINT_VERSION,
    inputHash,
    completedValidationIdentities: completed,
    pendingValidationIdentities: pending,
    complete: pending.length === 0
  };
}

export function stableStringify(value, space = 0) {
  return JSON.stringify(sortJsonValue(value), null, space);
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function extractRecordOccurrences(row, section, recordKey, output) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return;
  const context = recordContext(row, section, recordKey);
  const local = [];
  walkRecord(row, [], context, local, new Set(), 0);
  const identities = new Set(local.map((item) => item.identity));
  const metrics = identities.size === 1 ? extractMetrics(row) : {};
  for (const item of local) output.push({ ...item, metrics });
}

function walkRecord(value, path, context, output, embeddedSeen, depth) {
  if (depth > 40) return;
  if (typeof value === "string") {
    const urls = value.match(URL_PATTERN) ?? [];
    for (const rawUrl of urls) {
      const native = normalizeNativePostUrl(context.platform, rawUrl);
      if (native) output.push(occurrence(native, path, context, value));
    }
    for (const match of value.matchAll(EMBEDDED_ID_PATTERN)) {
      const native = nativePostFromId(context.platform, match[1], context);
      if (native) output.push(occurrence(native, [...path, "$embeddedId"], context, value));
    }
    const trimmed = value.trim();
    if (
      trimmed.length <= 5_000_000 &&
      (trimmed.startsWith("{") || trimmed.startsWith("[")) &&
      !embeddedSeen.has(trimmed)
    ) {
      try {
        embeddedSeen.add(trimmed);
        walkRecord(JSON.parse(trimmed), [...path, "$json"], context, output, embeddedSeen, depth + 1);
      } catch {
        // Non-JSON operational messages are still URL-scanned above.
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      walkRecord(item, [...path, String(index)], context, output, embeddedSeen, depth + 1)
    );
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (EXPLICIT_ID_KEYS.has(key.toLowerCase())) {
      const nestedPlatform = normalizeRecoveryPlatform(value.platform ?? context.platform);
      const native = nativePostFromId(nestedPlatform, child, context);
      if (native) output.push(occurrence(native, [...path, key], context, child));
    }
    walkRecord(child, [...path, key], context, output, embeddedSeen, depth + 1);
  }
}

function occurrence(native, path, context, rawValue) {
  return {
    identity: native.identity,
    native,
    metrics: {},
    provenance: {
      section: context.section,
      recordKey: context.recordKey,
      recordId: context.recordId,
      fieldPath: path.join("."),
      sourceKind: path.includes("$embeddedId") ? "embedded_native_id" : "native_url",
      context: publicContext(context),
      rawValueSha256: sha256(Buffer.from(String(rawValue ?? "")))
    }
  };
}

function nativePostFromId(platform, rawId, context) {
  const postId = normalizeNativePostId(platform, rawId);
  if (!postId) return null;
  const accountKey = accountKeyFromUrl(platform, context.accountUrl);
  if (platform === "x") {
    const authorKey = accountKey?.split(":").slice(1).join(":") || null;
    return nativePost({
      platform,
      postId,
      canonicalUrl: authorKey
        ? `https://x.com/${authorKey}/status/${postId}`
        : `https://x.com/i/status/${postId}`,
      authorKey,
      authorAccountKey: accountKey,
      sourceUrl: null
    });
  }
  if (platform === "linkedin") {
    const authorKey = accountKey?.split(":").slice(1).join(":") || null;
    return nativePost({
      platform,
      postId,
      canonicalUrl: `https://www.linkedin.com/feed/update/urn:li:activity:${postId}`,
      authorKey,
      authorAccountKey: accountKey,
      sourceUrl: null
    });
  }
  if (platform === "instagram") {
    return nativePost({
      platform,
      postId,
      canonicalUrl: `https://www.instagram.com/p/${postId}/`,
      authorKey: null,
      authorAccountKey: accountKey,
      sourceUrl: null
    });
  }
  if (platform === "youtube") {
    return nativePost({
      platform,
      postId,
      canonicalUrl: `https://www.youtube.com/watch?v=${postId}`,
      authorKey: null,
      authorAccountKey: accountKey,
      sourceUrl: null
    });
  }
  return null;
}

function normalizeNativePostId(platform, rawId) {
  const value = String(rawId ?? "").trim();
  if (platform === "x") return X_POST_ID.test(value) ? value : null;
  if (platform === "linkedin") return LINKEDIN_POST_ID.test(value) ? value : null;
  if (platform === "instagram") return INSTAGRAM_POST_ID.test(value) ? value : null;
  if (platform === "youtube") return YOUTUBE_POST_ID.test(value) ? value : null;
  return null;
}

function nativePost({ platform, postId, canonicalUrl, authorKey, authorAccountKey, sourceUrl }) {
  return {
    platform,
    postId,
    identity: physicalIdentity(platform, postId),
    canonicalUrl,
    authorKey,
    authorAccountKey,
    sourceUrl
  };
}

function physicalIdentity(platform, postId) {
  return `${platform}:${postId}`;
}

function recordContext(row, section, recordKey) {
  return {
    row,
    section,
    recordKey,
    recordId: nullableText(row.id) ?? (section === "attempts" ? recordKey : null),
    platform: normalizeRecoveryPlatform(row.platform ?? row.discovered_platform),
    batchSlug: nullableText(row.batchSlug ?? row.batch_slug),
    entityType: nullableText(row.entityType ?? row.discovered_entity_type) ?? "company",
    entityId: nullableText(
      row.entityId ?? row.entity_id ?? row.discovered_entity_id ?? row.company_id
    ),
    entityName: nullableText(
      row.entityName ?? row.entity_name ?? row.discovered_entity_name ?? row.company_name
    ),
    companySlug: nullableText(row.companySlug ?? row.company_slug),
    companyName: nullableText(row.companyName ?? row.company_name),
    accountUrl: nullableText(row.accountUrl ?? row.account_url),
    sourceUrl: nullableText(row.sourceUrl ?? row.source_url),
    discoveredUrl: nullableText(row.discovered_url),
    matchReason: nullableText(row.matchReason ?? row.match_reason ?? row.failure_reason),
    reviewState: nullableText(row.review_state),
    status: nullableText(row.status),
    source: nullableText(row.source)
  };
}

function publicContext(context) {
  return {
    platform: context.platform,
    batchSlug: context.batchSlug,
    entityType: context.entityType,
    entityId: context.entityId,
    entityName: context.entityName,
    companySlug: context.companySlug,
    companyName: context.companyName,
    accountUrl: context.accountUrl,
    sourceUrl: context.sourceUrl,
    discoveredUrl: context.discoveredUrl,
    matchReason: context.matchReason,
    reviewState: context.reviewState,
    status: context.status,
    source: context.source
  };
}

function validateOperationalLedger(ledger) {
  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) {
    throw new TypeError("Operational ledger must be an object.");
  }
  if (ledger.schemaVersion !== LEDGER_SCHEMA_VERSION) {
    throw new Error(`Unsupported operational ledger schema: ${ledger.schemaVersion ?? "missing"}.`);
  }
  for (const section of ["failures", "discoveryAttempts", "sourceDiscoveryPaths"]) {
    if (!Array.isArray(ledger[section])) throw new TypeError(`Operational ledger ${section} must be an array.`);
  }
  if (!ledger.attempts || typeof ledger.attempts !== "object" || Array.isArray(ledger.attempts)) {
    throw new TypeError("Operational ledger attempts must be an object.");
  }
}

function contextOwnershipClaims(candidate, index) {
  return candidate.provenance.map((provenance) => {
    const context = provenance.context;
    const exactOwner = index.exactOwners.get(exactOwnerKey(
      context.batchSlug,
      context.entityType,
      context.entityId
    )) ?? null;
    const accountKey = accountKeyFromUrl(candidate.platform, context.accountUrl);
    const accountOwners = uniqueOwners(index.accountOwners.get(accountKey) ?? []);
    const sourceKey = canonicalSourceKey(context.sourceUrl);
    const officialOwners = uniqueOwners(index.officialSourceOwners.get(sourceKey) ?? []);
    const officialEmbeddedVideo = candidate.platform === "youtube" &&
      provenance.section === "sourceDiscoveryPaths" &&
      context.reviewState === "verified" &&
      /official .*embedded native youtube video/iu.test(context.matchReason ?? "") &&
      officialOwners.some((owner) => exactOwner && sameOwnerCompany(owner, exactOwner));
    return {
      exactOwner,
      accountKey,
      accountOwner: accountOwners.length === 1 ? accountOwners[0] : null,
      sourceUrl: context.sourceUrl,
      officialEmbeddedVideo
    };
  });
}

function promotionEvidence(candidate, owner, ownershipReceipt, validationReceipt, metrics) {
  const id = `operational-ledger-${candidate.platform}-${owner.batchSlug.toLowerCase()}-${owner.entityId}-${candidate.platformPostId}`
    .replace(/[^a-z0-9_-]+/giu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "")
    .toLowerCase();
  return {
    id,
    platform: candidate.platform,
    platformPostId: candidate.platformPostId,
    sourceUrl: candidate.canonicalUrl,
    candidateUrl: candidate.canonicalUrl,
    batchSlug: owner.batchSlug,
    entityType: owner.entityType,
    entityId: owner.entityId,
    entityName: owner.entityName,
    companySlug: owner.companySlug,
    companyName: owner.companyName,
    attachedCompanyId: owner.companyEntityId,
    accountUrl: owner.accountUrl ?? null,
    metrics,
    review_state: "verified",
    linkStatus: validationReceipt?.status === "verified" ? "verified" : "offline_verified",
    attributionStatus: "verified",
    attributionVersion: 3,
    attributionMode: "account_owner",
    attributionSignals: [ownershipReceipt.method],
    matchReason: "Recovered from the immutable public-ingestion operational ledger after full-corpus physical deduplication and exact canonical owner resolution.",
    recoveryReceipt: {
      schemaVersion: OPERATIONAL_LEDGER_POST_RECOVERY_SCHEMA_VERSION,
      physicalIdentity: candidate.identity,
      occurrenceCount: candidate.occurrenceCount,
      ownership: ownershipReceipt,
      anonymousValidation: validationReceipt,
      provenance: candidate.provenance
    }
  };
}

function rejection(candidate, reasons, extra = {}) {
  return {
    identity: candidate.identity,
    platform: candidate.platform,
    platformPostId: candidate.platformPostId,
    canonicalUrl: candidate.canonicalUrl,
    nativeAuthorKey: candidate.nativeAuthorKey,
    occurrenceCount: candidate.occurrenceCount,
    reasons: uniqueStrings(reasons),
    provenance: candidate.provenance,
    ...extra
  };
}

function recoverySummary({ candidates, netNewCandidates, attributableNetNew, evidence, rejectedCandidates }) {
  const rejectionReasonCounts = countBy(
    rejectedCandidates.flatMap((candidate) => candidate.reasons),
    (reason) => reason
  );
  const existingCount = rejectedCandidates.filter((candidate) =>
    candidate.reasons.includes("already_in_current_evidence_or_review")
  ).length;
  return {
    extractedUniqueNativeIdentities: candidates.length,
    alreadyInCurrentEvidenceOrReview: existingCount,
    trueNetNewBeforeAttribution: netNewCandidates.length,
    trueNetNewAttributable: attributableNetNew.length,
    promotionReadyEvidence: evidence.length,
    rejectedUniqueIdentities: rejectedCandidates.length,
    extractedByPlatform: countBy(candidates, (candidate) => candidate.platform),
    netNewByPlatform: countBy(netNewCandidates, (candidate) => candidate.platform),
    attributableByCohortPlatform: nestedCohortPlatformCounts(attributableNetNew),
    promotionReadyByCohortPlatform: nestedCohortPlatformCounts(evidence),
    rejectionReasonCounts
  };
}

function nestedCohortPlatformCounts(rows) {
  const counts = {};
  for (const row of rows) {
    const batchSlug = row.batchSlug ?? resolvedCandidateBatch(row) ?? "unresolved";
    counts[batchSlug] ??= {};
    counts[batchSlug][row.platform] = (counts[batchSlug][row.platform] ?? 0) + 1;
  }
  return sortJsonValue(counts);
}

function resolvedCandidateBatch(candidate) {
  return candidate.provenance
    ?.map((provenance) => provenance.context?.batchSlug)
    .filter(Boolean)
    .sort()[0] ?? null;
}

function extractMetrics(value) {
  const metrics = {};
  const seen = new Set();
  const visit = (candidate, depth) => {
    if (depth > 20 || candidate == null) return;
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length <= 2_000_000 && !seen.has(trimmed)) {
        try {
          seen.add(trimmed);
          visit(JSON.parse(trimmed), depth + 1);
        } catch {
          // Ignore non-JSON text.
        }
      }
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (typeof candidate !== "object") return;
    if (candidate.metrics && typeof candidate.metrics === "object" && !Array.isArray(candidate.metrics)) {
      for (const [key, raw] of Object.entries(candidate.metrics)) {
        const number = Number(raw);
        if (POSITIVE_METRIC_KEYS.has(key) && Number.isFinite(number) && number > 0) {
          metrics[key] = Math.max(metrics[key] ?? 0, number);
        }
      }
    }
    Object.values(candidate).forEach((item) => visit(item, depth + 1));
  };
  visit(value, 0);
  return sortJsonValue(metrics);
}

function positiveMetrics(metrics) {
  return Object.fromEntries(Object.entries(metrics ?? {})
    .filter(([key, value]) => POSITIVE_METRIC_KEYS.has(key) && Number.isFinite(value) && value > 0)
    .sort(([left], [right]) => left.localeCompare(right)));
}

function preferMetrics(left, right) {
  const merged = { ...(left ?? {}) };
  for (const [key, value] of Object.entries(right ?? {})) merged[key] = Math.max(merged[key] ?? 0, value);
  return sortJsonValue(merged);
}

function ownerRecord({ catalog, company, companySlug, founder }) {
  return {
    batchSlug: catalog.slug,
    entityType: founder ? "founder" : "company",
    entityId: founder?.sourceKey ?? company.sourceKey,
    entityName: founder?.name ?? company.name,
    companySlug,
    companyName: company.name,
    companyEntityId: company.sourceKey,
    accountUrl: null
  };
}

function addExactOwner(index, owner) {
  index.set(exactOwnerKey(owner.batchSlug, owner.entityType, owner.entityId), owner);
}

function exactOwnerKey(batchSlug, entityType, entityId) {
  return [
    String(batchSlug ?? "").trim().toUpperCase(),
    String(entityType ?? "company").trim().toLowerCase(),
    String(entityId ?? "").trim().toLowerCase()
  ].join(":");
}

function addAccountOwners(index, owner, accounts) {
  for (const account of accounts ?? []) {
    const platform = normalizeRecoveryPlatform(account?.platform);
    if (!platform) continue;
    for (const accountKey of accountKeys(platform, account?.url, account?.handle, account?.accountId)) {
      const withAccount = { ...owner, accountUrl: account?.url ?? null };
      index.set(accountKey, [...(index.get(accountKey) ?? []), withAccount]);
    }
  }
}

function addOfficialSources(index, owner, urls) {
  for (const rawUrl of urls ?? []) {
    const key = canonicalSourceKey(rawUrl);
    if (!key) continue;
    index.set(key, [...(index.get(key) ?? []), owner]);
  }
}

function accountKeys(platform, rawUrl, fallbackHandle = null, accountId = null) {
  const keys = new Set();
  const direct = accountKeyFromUrl(platform, rawUrl);
  if (direct) keys.add(direct);
  const handle = normalizeHandle(fallbackHandle);
  if (handle && ["x", "linkedin", "instagram"].includes(platform)) keys.add(`${platform}:${handle}`);
  if (platform === "youtube" && accountId) keys.add(`youtube:channel:${String(accountId).toLowerCase()}`);
  return [...keys];
}

function accountKeyFromUrl(platform, rawUrl) {
  if (!platform || !rawUrl) return null;
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./u, "").toLowerCase();
  const parts = safeDecodePath(url.pathname).split("/").filter(Boolean);
  if (platform === "x" && ["x.com", "twitter.com", "mobile.twitter.com"].includes(host)) {
    const handle = normalizeHandle(parts[0]);
    return handle && handle !== "i" ? `x:${handle}` : null;
  }
  if (platform === "instagram" && (host === "instagram.com" || host.endsWith(".instagram.com"))) {
    const handle = normalizeHandle(parts[0]);
    if (!handle || ["p", "reel", "reels", "tv"].includes(handle)) return null;
    return `instagram:${handle}`;
  }
  if (platform === "linkedin" && (host === "linkedin.com" || host.endsWith(".linkedin.com"))) {
    if (!["in", "company"].includes(parts[0]?.toLowerCase()) || !parts[1]) return null;
    return `linkedin:${normalizeHandle(parts[1])}`;
  }
  if (platform === "youtube" && ["youtube.com", "m.youtube.com"].includes(host)) {
    if (parts[0]?.toLowerCase() === "channel" && parts[1]) {
      return `youtube:channel:${parts[1].toLowerCase()}`;
    }
    if (parts[0]?.startsWith("@")) return `youtube:handle:${normalizeHandle(parts[0])}`;
    if (["c", "user"].includes(parts[0]?.toLowerCase()) && parts[1]) {
      return `youtube:handle:${normalizeHandle(parts[1])}`;
    }
  }
  return null;
}

function accountKeyFromAnonymousReceipt(platform, receipt) {
  if (receipt?.status !== "verified" || !receipt.authorUrl) return null;
  return accountKeyFromUrl(platform, receipt.authorUrl);
}

function canonicalSourceKey(rawUrl) {
  if (!rawUrl) return null;
  try {
    const url = new URL(String(rawUrl));
    const host = url.hostname.replace(/^www\./u, "").toLowerCase();
    const path = safeDecodePath(url.pathname).replace(/\/+$/u, "") || "/";
    return `${host}${path}`.toLowerCase();
  } catch {
    return null;
  }
}

function platformForHost(host) {
  if (["x.com", "twitter.com", "mobile.twitter.com"].includes(host)) return "x";
  if (host === "linkedin.com" || host.endsWith(".linkedin.com")) return "linkedin";
  if (host === "instagram.com" || host.endsWith(".instagram.com")) return "instagram";
  if (["youtube.com", "m.youtube.com", "youtu.be"].includes(host)) return "youtube";
  return null;
}

function linkedinPostAuthor(rawSlug) {
  const slug = String(rawSlug ?? "").trim();
  if (!slug) return null;
  const beforeActivity = slug.replace(/_.*$/u, "");
  return normalizeHandle(beforeActivity);
}

function canonicalLinkedinPostUrl(url) {
  return `https://www.linkedin.com${safeDecodePath(url.pathname).replace(/\/+$/u, "")}`;
}

function xHandleFromOembed(body) {
  const authorName = String(body?.author_name ?? "");
  const fromName = authorName.match(/\(@([^()]+)\)\s*$/u)?.[1];
  if (fromName) return normalizeHandle(fromName);
  const html = String(body?.html ?? "");
  const fromHtml = html.match(/https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/([^/?#"']+)/iu)?.[1];
  return normalizeHandle(fromHtml);
}

function anonymousReceipt(candidate, status, extra = {}) {
  return {
    validatorVersion: OPERATIONAL_LEDGER_POST_RECOVERY_VALIDATOR_VERSION,
    identity: candidate.identity,
    platform: candidate.platform,
    status,
    endpointClass: candidate.platform === "youtube" ? "youtube_anonymous_oembed" : "x_anonymous_oembed",
    ...extra
  };
}

function ownershipSuccess(owner, receipt) {
  return { ok: true, owner, receipt };
}

function ownershipFailure(reason, receipt = null) {
  return { ok: false, reasons: [reason], receipt };
}

function sameOwner(left, right) {
  return left?.batchSlug === right?.batchSlug &&
    left?.entityType === right?.entityType &&
    left?.entityId === right?.entityId;
}

function sameOwnerCompany(left, right) {
  return left?.batchSlug === right?.batchSlug && left?.companyEntityId === right?.companyEntityId;
}

function uniqueOwners(owners) {
  return [...new Map((owners ?? []).map((owner) => [
    `${owner.batchSlug}:${owner.entityType}:${owner.entityId}`,
    owner
  ])).values()].sort((left, right) =>
    left.batchSlug.localeCompare(right.batchSlug) ||
    left.entityType.localeCompare(right.entityType) ||
    left.entityId.localeCompare(right.entityId)
  );
}

function projectAccounts(accounts) {
  return (accounts ?? []).map((account) => ({
    platform: normalizeRecoveryPlatform(account?.platform) ?? account?.platform ?? null,
    handle: account?.handle ?? null,
    url: account?.url ?? null,
    accountId: account?.accountId ?? null
  })).sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));
}

function catalogCompanySlug(company) {
  try {
    const parts = new URL(company?.profileUrl).pathname.split("/").filter(Boolean);
    const index = parts.indexOf("companies");
    if (index >= 0 && parts[index + 1]) return parts[index + 1];
  } catch {
    // Fall back to stable source identity.
  }
  return String(company?.sourceKey ?? "")
    .replace(/^company-/u, "")
    .replace(/^a16z-speedrun-006-/u, "");
}

function nativeVariantQuality(value) {
  return Number(Boolean(value?.nativeAuthorAccountKey ?? value?.authorAccountKey)) * 4 +
    Number(Boolean(value?.sourceUrl)) * 2 +
    Number(!String(value?.canonicalUrl ?? "").includes("/i/status/"));
}

function dedupeAndSortProvenance(rows) {
  return [...new Map(rows.map((row) => [stableStringify(row), row])).values()].sort((left, right) =>
    left.section.localeCompare(right.section) ||
    left.recordKey.localeCompare(right.recordKey) ||
    left.fieldPath.localeCompare(right.fieldPath) ||
    left.rawValueSha256.localeCompare(right.rawValueSha256)
  );
}

function compareCandidate(left, right) {
  return left.platform.localeCompare(right.platform) ||
    left.platformPostId.localeCompare(right.platformPostId);
}

function compareEvidence(left, right) {
  return left.batchSlug.localeCompare(right.batchSlug) ||
    left.platform.localeCompare(right.platform) ||
    left.platformPostId.localeCompare(right.platformPostId) ||
    left.entityId.localeCompare(right.entityId);
}

function compareRejection(left, right) {
  return left.platform.localeCompare(right.platform) ||
    left.platformPostId.localeCompare(right.platformPostId);
}

function countBy(values, selector) {
  const counts = {};
  for (const value of values ?? []) {
    const key = String(selector(value) ?? "unknown");
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return sortJsonValue(counts);
}

function uniqueStrings(values) {
  return [...new Set((values ?? []).filter(Boolean).map(String))].sort();
}

function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJsonValue(value[key])]));
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Could not parse ${label}: ${error.message}`);
  }
}

function resolveInsideRoot(root, configuredPath) {
  const absolute = resolve(root, configuredPath);
  const rel = relative(resolve(root), absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Path escapes repository root: ${configuredPath}`);
  }
  return absolute;
}

function requiredSafeRelativePath(value, label) {
  const path = String(value ?? "").trim();
  if (!path || isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) {
    throw new Error(`${label} must be a safe repository-relative path.`);
  }
  return path;
}

function verifyReferencedBytes(bytes, reference, label) {
  if (Number(reference.bytes) !== bytes.byteLength) {
    throw new Error(`${label} byte count does not match its reference.`);
  }
  if (reference.sha256 !== sha256(bytes)) {
    throw new Error(`${label} hash does not match its reference.`);
  }
}

function safeDecodePath(path) {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function normalizeHandle(value) {
  return String(value ?? "").normalize("NFKC").trim().replace(/^@/u, "").replace(/\/+$/u, "").toLowerCase() || null;
}

function nullableText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}
