import {
  RANKED_POSTS_SIDECAR_VERSION,
  rankedPostsSidecarScope,
  rankedPostsSidecarSnapshot,
  type RankedPostsSidecarScope,
  type RankedPostsSidecarSnapshot
} from "./ranked-posts-sidecar";
import {
  isPostTopic,
  POST_TOPIC_CLASSIFIER_VERSION,
  POST_TOPIC_SLUGS,
  POST_TOPIC_TAXONOMY_VERSION,
  type PostTopicClassification,
  type PostTopicSecondarySignal
} from "./post-topics";
import { PLATFORM_VALUES, type EvidenceItem, type TopVoiceAudienceId } from "./types";

const RANKED_POSTS_SIDECAR_URL = "/api/ranked-posts-sidecar";
const RANKED_POSTS_SIDECAR_MAX_BYTES = 4 * 1024 * 1024;
const RANKED_POSTS_SIDECAR_TIMEOUT_MS = 12_000;
export const RANKED_POSTS_SIDECAR_MAX_EVIDENCE_ROWS = 10_000;
export const RANKED_POSTS_SIDECAR_CACHE_MAX_ENTRIES = 9;
export const RANKED_POSTS_SIDECAR_IN_FLIGHT_MAX_ENTRIES = 12;
const RANKED_POSTS_SIDECAR_MAX_BATCHES = 32;
const RANKED_POSTS_SIDECAR_MAX_COMPANIES = 10_000;
const RANKED_POSTS_SIDECAR_MAX_CROSS_AUDIENCE_KEYS = 10_000;
const RANKED_POSTS_SIDECAR_MAX_STRING_LENGTH = 64_000;
const RANKED_POSTS_SIDECAR_MAX_METRICS = 64;
const RANKED_POSTS_SIDECAR_MAX_MEDIA_URLS = 32;
const RANKED_POSTS_SIDECAR_MAX_TOPICS = POST_TOPIC_SLUGS.length;
const TOP_VOICE_AUDIENCES = new Set<TopVoiceAudienceId>(["off", "yc_partners", "insiders"]);
const MEDIA_TYPES = new Set<EvidenceItem["mediaType"]>([
  "text", "image", "video", "link", "repo", "launch", "unknown"
]);
const TOPIC_CLASSIFICATION_METHODS = new Set<PostTopicClassification["method"]>([
  "curated", "rules", "fallback", "manual"
]);
const TOPIC_RULE_STRENGTHS = new Set<PostTopicClassification["strength"]>([
  "curated", "manual", "high", "medium", "low", "fallback"
]);
const TOPIC_SECONDARY_SIGNALS = new Set<PostTopicSecondarySignal>([
  "contains_quantified_metric", "revenue_mentioned", "user_count_mentioned", "growth_rate_mentioned",
  "customer_named", "partnership_named", "funding_amount_mentioned", "hiring_call_to_action",
  "product_availability_announced", "open_source_release", "benchmark_result", "accelerator_mentioned",
  "founder_authored", "company_authored", "third_party_mention", "competitor_comparison",
  "geographic_expansion", "regulatory_milestone", "award", "acquisition", "event_participation",
  "press_coverage"
]);

// Keep at most one completed snapshot for each graph scope. The scope key does
// not include generatedAt deliberately: a newer publication replaces the old
// entry, while rankedPostsSidecarScopeForGraph still requires an exact
// timestamp match before using it. In-flight requests remain keyed by the full
// graph target so successive publications cannot be incorrectly deduplicated.
const refreshedSnapshots = new Map<string, RankedPostsSidecarSnapshot>();
const refreshedSnapshotRequests = new Map<string, Promise<RankedPostsSidecarSnapshot>>();
const activeSnapshotRequests = new Map<number, {
  controller: AbortController;
  onCancel?: () => void;
}>();
let activeSnapshotRequestSequence = 0;

export function rankedPostsSidecarScopeForGraph(
  graph: RankedPostsGraphTarget,
  snapshot: RankedPostsSidecarSnapshot = rankedPostsSidecarSnapshot
): RankedPostsSidecarScope | null {
  if (!isValidTimestamp(graph.generatedAt)) return null;
  const audienceId = graph.selectedTopVoiceAudience?.id ?? "off";
  const scope = rankedPostsSidecarScope(graph.batch.slug, audienceId, snapshot);
  return scope && isValidTimestamp(scope.previewGeneratedAt) && scope.previewGeneratedAt === graph.generatedAt
    ? scope
    : null;
}

export async function loadRankedPostsSidecarForGraph(
  graph: RankedPostsGraphTarget,
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {}
): Promise<RankedPostsSidecarScope> {
  const bundledScope = rankedPostsSidecarScopeForGraph(graph);
  if (bundledScope) return bundledScope;

  const targetKey = rankedPostsSidecarTargetKey(graph);
  const scopeKey = rankedPostsSidecarScopeKey(graph);
  const cachedSnapshot = refreshedSnapshots.get(scopeKey);
  const cachedScope = cachedSnapshot
    ? rankedPostsSidecarScopeForGraph(graph, cachedSnapshot)
    : null;
  if (cachedSnapshot && cachedScope) {
    touchRefreshedSnapshot(scopeKey, cachedSnapshot);
    return cachedScope;
  }

  const snapshot = await fetchCurrentRankedPostsSidecar(targetKey, options);
  const scope = rankedPostsSidecarScopeForGraph(graph, snapshot);
  if (!scope) {
    throw new Error("Ranked Posts sidecar does not match the refreshed graph timestamp or scope.");
  }
  rememberRefreshedSnapshot(graph, snapshot);
  return scope;
}

export function isRankedPostsSidecarSnapshot(value: unknown): value is RankedPostsSidecarSnapshot {
  if (!isRecord(value) || value.version !== RANKED_POSTS_SIDECAR_VERSION) return false;
  if (!isValidTimestamp(value.generatedAt) || !isCanonicalParity(value.canonicalParity) || !isRecord(value.batches)) {
    return false;
  }

  const batches = Object.entries(value.batches);
  if (batches.length === 0 || batches.length > RANKED_POSTS_SIDECAR_MAX_BATCHES) return false;
  for (const [batchSlug, batch] of batches) {
    if (!isBoundedNonEmptyString(batchSlug, 128) || !isRecord(batch)) return false;
    const scopes = Object.entries(batch);
    if (scopes.length === 0 || scopes.length > TOP_VOICE_AUDIENCES.size) return false;
    for (const [audienceId, scope] of scopes) {
      if (!TOP_VOICE_AUDIENCES.has(audienceId as TopVoiceAudienceId) || !isRankedPostsSidecarScope(scope)) {
        return false;
      }
    }
  }
  return true;
}

export function clearRankedPostsSidecarLoaderCache(): void {
  for (const requestId of [...activeSnapshotRequests.keys()]) cancelActiveSnapshotRequest(requestId);
  refreshedSnapshots.clear();
  refreshedSnapshotRequests.clear();
}

export function rankedPostsSidecarLoaderCacheEntryCount(): number {
  return refreshedSnapshots.size;
}

export function rankedPostsSidecarLoaderInFlightCount(): number {
  return activeSnapshotRequests.size;
}

function rememberRefreshedSnapshot(graph: RankedPostsGraphTarget, snapshot: RankedPostsSidecarSnapshot): void {
  const scopeKey = rankedPostsSidecarScopeKey(graph);
  const audienceId = graph.selectedTopVoiceAudience?.id ?? "off";
  const candidateScope = rankedPostsSidecarScope(graph.batch.slug, audienceId, snapshot);
  if (!candidateScope || !isValidTimestamp(candidateScope.previewGeneratedAt)) return;

  const existing = refreshedSnapshots.get(scopeKey);
  const existingScope = existing
    ? rankedPostsSidecarScope(graph.batch.slug, audienceId, existing)
    : null;
  if (
    existingScope &&
    isValidTimestamp(existingScope.previewGeneratedAt) &&
    existingScope.previewGeneratedAt > candidateScope.previewGeneratedAt
  ) {
    return;
  }
  setBoundedRefreshedSnapshot(scopeKey, snapshot);
}

function touchRefreshedSnapshot(scopeKey: string, snapshot: RankedPostsSidecarSnapshot): void {
  setBoundedRefreshedSnapshot(scopeKey, snapshot);
}

function setBoundedRefreshedSnapshot(scopeKey: string, snapshot: RankedPostsSidecarSnapshot): void {
  refreshedSnapshots.delete(scopeKey);
  refreshedSnapshots.set(scopeKey, snapshot);
  while (refreshedSnapshots.size > RANKED_POSTS_SIDECAR_CACHE_MAX_ENTRIES) {
    const oldestKey = refreshedSnapshots.keys().next().value;
    if (oldestKey === undefined) break;
    refreshedSnapshots.delete(oldestKey);
  }
}

async function fetchCurrentRankedPostsSidecar(
  targetKey: string,
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal }
): Promise<RankedPostsSidecarSnapshot> {
  // Do not let one obsolete graph request abort a newer caller's hydration.
  // Signal-bearing callers (including Dashboard graph scopes) get independent
  // requests; other callers retain keyed in-flight dedupe.
  if (options.signal) {
    return fetchRankedPostsSidecar(options.fetchImpl ?? fetch, options.signal);
  }

  const existing = refreshedSnapshotRequests.get(targetKey);
  if (existing) return existing;

  const fetchImpl = options.fetchImpl ?? fetch;
  let cancelledBeforeRegistration = false;
  const request = fetchRankedPostsSidecar(fetchImpl, options.signal, () => {
    cancelledBeforeRegistration = true;
    refreshedSnapshotRequests.delete(targetKey);
  }).finally(() => {
    if (refreshedSnapshotRequests.get(targetKey) === request) {
      refreshedSnapshotRequests.delete(targetKey);
    }
  });
  if (!cancelledBeforeRegistration) refreshedSnapshotRequests.set(targetKey, request);
  return request;
}

async function fetchRankedPostsSidecar(
  fetchImpl: typeof fetch,
  parentSignal?: AbortSignal,
  onCancel?: () => void
): Promise<RankedPostsSidecarSnapshot> {
  if (parentSignal?.aborted) throw abortError();

  const controller = new AbortController();
  activeSnapshotRequestSequence += 1;
  const requestId = activeSnapshotRequestSequence;
  registerActiveSnapshotRequest(requestId, controller, onCancel);
  const abort = () => cancelActiveSnapshotRequest(requestId);
  const timeoutId = setTimeout(abort, RANKED_POSTS_SIDECAR_TIMEOUT_MS);
  parentSignal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetchImpl(rankedPostsSidecarApiUrl(), {
      cache: "no-store",
      signal: controller.signal
    });
    if (controller.signal.aborted) throw abortError();
    if (!response.ok) {
      throw new Error(`Ranked Posts sidecar request failed (${response.status}).`);
    }

    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > RANKED_POSTS_SIDECAR_MAX_BYTES) {
      throw new Error("Ranked Posts sidecar response exceeded the size limit.");
    }
    const body = await response.text();
    if (controller.signal.aborted) throw abortError();
    if (new TextEncoder().encode(body).byteLength > RANKED_POSTS_SIDECAR_MAX_BYTES) {
      throw new Error("Ranked Posts sidecar response exceeded the size limit.");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      throw new Error("Ranked Posts sidecar response was not valid JSON.", { cause: error });
    }
    if (!isRankedPostsSidecarSnapshot(parsed)) {
      throw new Error("Ranked Posts sidecar response failed validation.");
    }
    return parsed;
  } finally {
    clearTimeout(timeoutId);
    parentSignal?.removeEventListener("abort", abort);
    activeSnapshotRequests.delete(requestId);
  }
}

function registerActiveSnapshotRequest(
  requestId: number,
  controller: AbortController,
  onCancel?: () => void
): void {
  while (activeSnapshotRequests.size >= RANKED_POSTS_SIDECAR_IN_FLIGHT_MAX_ENTRIES) {
    const oldestRequestId = activeSnapshotRequests.keys().next().value;
    if (oldestRequestId === undefined) break;
    cancelActiveSnapshotRequest(oldestRequestId);
  }
  activeSnapshotRequests.set(requestId, { controller, onCancel });
}

function cancelActiveSnapshotRequest(requestId: number): void {
  const active = activeSnapshotRequests.get(requestId);
  if (!active) return;
  activeSnapshotRequests.delete(requestId);
  active.onCancel?.();
  active.controller.abort();
}

function isCanonicalParity(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return isNonNegativeInteger(value.fullRankableCount) &&
    isNonNegativeInteger(value.previewRankableCount) &&
    isNonNegativeInteger(value.representedRankableCount) &&
    isNonNegativeInteger(value.overflowRankableCount) &&
    isNonNegativeInteger(value.crossAudiencePreviewProjectionCount) &&
    isSha256(value.fullRankableDigest) &&
    isSha256(value.previewRankableDigest) &&
    isSha256(value.representedRankableDigest) &&
    isBoundedStringArray(
      value.crossAudiencePreviewProjectionKeys,
      RANKED_POSTS_SIDECAR_MAX_CROSS_AUDIENCE_KEYS,
      512
    ) &&
    value.crossAudiencePreviewProjectionCount === value.crossAudiencePreviewProjectionKeys.length;
}

function isRankedPostsSidecarScope(value: unknown): value is RankedPostsSidecarScope {
  if (!isRecord(value) || !isValidTimestamp(value.previewGeneratedAt)) return false;
  if (
    !isNonNegativeInteger(value.sourceEvidenceCount) ||
    !isNonNegativeInteger(value.previewEvidenceCount) ||
    !isNonNegativeInteger(value.fullRankableCount) ||
    !isNonNegativeInteger(value.previewRankableCount) ||
    !isNonNegativeInteger(value.overflowRankableCount) ||
    !isNonNegativeInteger(value.crossAudiencePreviewProjectionCount) ||
    !isSha256(value.fullRankableDigest) ||
    !isSha256(value.representedRankableDigest) ||
    !isCountMap(value.previewRankableByCompany) ||
    !isCountMap(value.fullRankableByCompany) ||
    !isBoundedStringArray(
      value.crossAudiencePreviewProjectionKeys,
      RANKED_POSTS_SIDECAR_MAX_CROSS_AUDIENCE_KEYS,
      512
    ) ||
    value.crossAudiencePreviewProjectionCount !== value.crossAudiencePreviewProjectionKeys.length ||
    !Array.isArray(value.evidence) ||
    value.evidence.length > RANKED_POSTS_SIDECAR_MAX_EVIDENCE_ROWS
  ) {
    return false;
  }
  return value.evidence.every(isEvidenceItem);
}

function isEvidenceItem(value: unknown): value is EvidenceItem {
  if (!isRecord(value)) return false;
  if (
    !isBoundedNonEmptyString(value.id, 512) ||
    (value.entityType !== "company" && value.entityType !== "founder") ||
    !isBoundedNonEmptyString(value.entityId, 512) ||
    !PLATFORM_VALUES.includes(value.platform as typeof PLATFORM_VALUES[number]) ||
    !isBoundedString(value.authorName, 2_000) ||
    !(value.authorHandle === null || isBoundedString(value.authorHandle, 2_000)) ||
    !isTimestampLike(value.postedAt) ||
    !isBoundedString(value.text, RANKED_POSTS_SIDECAR_MAX_STRING_LENGTH) ||
    !MEDIA_TYPES.has(value.mediaType as EvidenceItem["mediaType"]) ||
    !isMetrics(value.metrics) ||
    !isFiniteNumber(value.contributionScore) ||
    !isHttpUrl(value.sourceUrl) ||
    !isBoundedString(value.why, RANKED_POSTS_SIDECAR_MAX_STRING_LENGTH)
  ) {
    return false;
  }

  if (value.batchSlug !== undefined && !isBoundedNonEmptyString(value.batchSlug, 128)) return false;
  if (
    value.publishedAtPrecision !== undefined &&
    value.publishedAtPrecision !== "exact" &&
    value.publishedAtPrecision !== "day" &&
    value.publishedAtPrecision !== "unknown"
  ) return false;
  for (const key of ["observedAt", "metricsCheckedAt", "linkCheckedAt"] as const) {
    if (value[key] !== undefined && value[key] !== null && !isTimestampLike(value[key])) return false;
  }
  for (const key of [
    "title", "mediaUrl", "thumbnailUrl", "thumbnailSource", "linkFailureReason", "platformPostId",
    "platformObjectId", "rawVisibleText", "first_seen_at", "last_checked_at", "last_updated_at",
    "originalText", "attributionProvenance", "attachedCompanyId", "attachedCompanyName", "socialAccountId", "canonicalAccountId", "accountUrl",
    "matchReason"
  ] as const) {
    if (value[key] !== undefined && value[key] !== null && !isBoundedString(value[key], RANKED_POSTS_SIDECAR_MAX_STRING_LENGTH)) {
      return false;
    }
  }
  if (value.mediaUrls !== undefined && !isBoundedStringArray(value.mediaUrls, RANKED_POSTS_SIDECAR_MAX_MEDIA_URLS, 8_192)) {
    return false;
  }
  if (value.tractionLimitations !== undefined && !isBoundedStringArray(value.tractionLimitations, 64, 2_000)) {
    return false;
  }
  if (
    value.verbatimContributingSentences !== undefined &&
    !isBoundedStringArray(value.verbatimContributingSentences, 64, RANKED_POSTS_SIDECAR_MAX_STRING_LENGTH)
  ) {
    return false;
  }
  if (
    value.topics !== undefined &&
    (!Array.isArray(value.topics) || value.topics.length > RANKED_POSTS_SIDECAR_MAX_TOPICS ||
      !value.topics.every((topic) => typeof topic === "string" && isPostTopic(topic)))
  ) return false;
  if (value.rawEngagement !== undefined && !isFiniteNumber(value.rawEngagement)) return false;
  if (value.normalizedScore !== undefined && !isFiniteNumber(value.normalizedScore)) return false;
  if (value.tractionStatus !== undefined && value.tractionStatus !== "scored" && value.tractionStatus !== "unscored") {
    return false;
  }
  if (
    value.review_state !== undefined &&
    value.review_state !== "verified" &&
    value.review_state !== "needs_review" &&
    value.review_state !== "rejected"
  ) return false;
  if (
    value.linkStatus !== undefined && value.linkStatus !== null &&
    // Historical collectors emitted "valid"; scoring treats it equivalently
    // to a verified/usable link and current published sidecars still contain it.
    value.linkStatus !== "valid" && value.linkStatus !== "verified" && value.linkStatus !== "invalid" &&
    value.linkStatus !== "unchecked" && value.linkStatus !== "blocked"
  ) return false;
  if (value.topVoice !== undefined && !isEvidenceTopVoiceMatch(value.topVoice)) return false;
  if (value.publicationProvenance !== undefined && !isPublicationProvenance(value.publicationProvenance)) return false;
  if (value.topicClassification !== undefined && !isPostTopicClassification(value.topicClassification)) return false;
  return true;
}

function isPostTopicClassification(value: unknown): value is PostTopicClassification {
  if (!isRecord(value)) return false;
  if (
    !isPostTopicArray(value.topics, RANKED_POSTS_SIDECAR_MAX_TOPICS) ||
    typeof value.primaryTopic !== "string" || !isPostTopic(value.primaryTopic) ||
    !(value.secondaryTopic === null || (typeof value.secondaryTopic === "string" && isPostTopic(value.secondaryTopic))) ||
    !isBoundedSecondarySignalArray(value.secondarySignals, 64) ||
    !isBoundedTopicEvidenceArray(value.evidence, 64) ||
    !isBoundedString(value.reasoningSummary, 8_192) ||
    !isBoundedTopicAlternativeArray(value.alternatives, 64) ||
    typeof value.needsReview !== "boolean" ||
    value.classifierVersion !== POST_TOPIC_CLASSIFIER_VERSION ||
    value.taxonomyVersion !== POST_TOPIC_TAXONOMY_VERSION ||
    !TOPIC_CLASSIFICATION_METHODS.has(value.method as PostTopicClassification["method"]) ||
    !isUnitInterval(value.confidence) ||
    !TOPIC_RULE_STRENGTHS.has(value.strength as PostTopicClassification["strength"]) ||
    !isBoundedStringArray(value.matchedTerms, 128, 2_000) ||
    !isBoundedTopicRuleMatchArray(value.matches, 64) ||
    !isPriorTopicClassification(value.priorClassification)
  ) {
    return false;
  }
  return true;
}

function isPostTopicArray(value: unknown, maxEntries: number): boolean {
  return Array.isArray(value) && value.length <= maxEntries && value.every((topic) =>
    typeof topic === "string" && isPostTopic(topic)
  );
}

function isBoundedSecondarySignalArray(value: unknown, maxEntries: number): boolean {
  return Array.isArray(value) && value.length <= maxEntries && value.every((signal) =>
    typeof signal === "string" && TOPIC_SECONDARY_SIGNALS.has(signal as PostTopicSecondarySignal)
  );
}

function isBoundedTopicEvidenceArray(value: unknown, maxEntries: number): boolean {
  return Array.isArray(value) && value.length <= maxEntries && value.every((entry) =>
    isRecord(entry) && isBoundedString(entry.text, 8_192) &&
    (entry.signal === "topic_rule" ||
      (typeof entry.signal === "string" && TOPIC_SECONDARY_SIGNALS.has(entry.signal as PostTopicSecondarySignal)))
  );
}

function isBoundedTopicAlternativeArray(value: unknown, maxEntries: number): boolean {
  return Array.isArray(value) && value.length <= maxEntries && value.every((entry) =>
    isRecord(entry) && typeof entry.topic === "string" && isPostTopic(entry.topic) && isUnitInterval(entry.confidence)
  );
}

function isBoundedTopicRuleMatchArray(value: unknown, maxEntries: number): boolean {
  return Array.isArray(value) && value.length <= maxEntries && value.every((entry) =>
    isRecord(entry) && typeof entry.topic === "string" && isPostTopic(entry.topic) &&
    isFiniteNumber(entry.score) && isUnitInterval(entry.confidence) &&
    TOPIC_RULE_STRENGTHS.has(entry.strength as PostTopicClassification["strength"]) &&
    isBoundedStringArray(entry.matchedTerms, 128, 2_000)
  );
}

function isPriorTopicClassification(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return isRecord(value) &&
    isBoundedNonEmptyString(value.taxonomyVersion, 256) &&
    isBoundedNonEmptyString(value.classifierVersion, 256) &&
    (value.primaryTopic === null || isBoundedString(value.primaryTopic, 256));
}

function isEvidenceTopVoiceMatch(value: unknown): boolean {
  return isRecord(value) &&
    TOP_VOICE_AUDIENCES.has(value.audienceId as TopVoiceAudienceId) &&
    isBoundedNonEmptyString(value.memberId, 512) &&
    isBoundedString(value.displayName, 2_000) &&
    isBoundedString(value.category, 512) &&
    isFiniteNumber(value.weight) &&
    isBoundedString(value.matchedBy, 2_000) &&
    isFiniteNumber(value.originalContributionScore);
}

function isPublicationProvenance(value: unknown): boolean {
  if (!isRecord(value) || value.kind !== "github_repository") return false;
  return [value.createdAt, value.updatedAt, value.pushedAt, value.observedAt]
    .every((timestamp) => timestamp === null || isTimestampLike(timestamp));
}

function isMetrics(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= RANKED_POSTS_SIDECAR_MAX_METRICS && entries.every(([key, metric]) =>
    isBoundedNonEmptyString(key, 128) && isFiniteNumber(metric)
  );
}

function isCountMap(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= RANKED_POSTS_SIDECAR_MAX_COMPANIES && entries.every(([key, count]) =>
    isBoundedNonEmptyString(key, 512) && isNonNegativeInteger(count)
  );
}

function isBoundedStringArray(value: unknown, maxEntries: number, maxLength: number): value is string[] {
  return Array.isArray(value) && value.length <= maxEntries &&
    value.every((entry) => isBoundedString(entry, maxLength));
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function isBoundedNonEmptyString(value: unknown, maxLength: number): value is string {
  return isBoundedString(value, maxLength) && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isUnitInterval(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isTimestampLike(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function isHttpUrl(value: unknown): value is string {
  if (!isBoundedNonEmptyString(value, 8_192)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function isValidTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function rankedPostsSidecarTargetKey(graph: RankedPostsGraphTarget): string {
  return [
    graph.batch.slug,
    graph.selectedTopVoiceAudience?.id ?? "off",
    graph.generatedAt
  ].join("::");
}

function rankedPostsSidecarScopeKey(graph: RankedPostsGraphTarget): string {
  return [
    graph.batch.slug,
    graph.selectedTopVoiceAudience?.id ?? "off"
  ].join("::");
}

function rankedPostsSidecarApiUrl(): string {
  return `${RANKED_POSTS_SIDECAR_URL}?v=${encodeURIComponent(RANKED_POSTS_SIDECAR_VERSION)}&refresh=${Date.now().toString(36)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

export type { TopVoiceAudienceId };

export interface RankedPostsGraphTarget {
  batch: { slug: string };
  generatedAt: string;
  selectedTopVoiceAudience?: { id: TopVoiceAudienceId };
}
