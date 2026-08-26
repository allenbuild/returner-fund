import { nativeEvidenceIdentityFromUrl } from "./dedupe";
import type { EvidenceItem, Platform } from "./types";

type LinkStatus = EvidenceItem["linkStatus"];
type PublicationPrecision = EvidenceItem["publishedAtPrecision"];

interface NativeAuthorResolutionReceipt {
  status?: string;
  author?: {
    platform?: Platform;
    key?: string;
  };
  owner?: {
    batchSlug?: string;
    entityType?: "company" | "founder";
    entityId?: string;
  };
}

export interface NativeLinkAttestationInput {
  platform: Platform;
  sourceUrl: string;
  platformPostId?: string | null;
  postedAt?: string | null;
  publishedAtPrecision?: PublicationPrecision;
  review_state?: EvidenceItem["review_state"];
  linkStatus?: LinkStatus;
  entityType?: "company" | "founder";
  entityId?: string;
  batchSlug?: string;
  batch_slug?: string;
  accountUrl?: string | null;
  authorHandle?: string | null;
  attributionVersion?: number;
  attributionStatus?: string;
  attributionProvenance?: string;
  nativeAuthorResolution?: NativeAuthorResolutionReceipt;
  rawVisibleText?: unknown;
}

export interface ExactNativePublicationDate {
  postedAt: string;
  publishedAtPrecision: "exact";
}

/**
 * Recover an exact native publication instant only from a collector receipt
 * that binds the persisted row to the same X or Instagram post and owner. This is
 * intentionally narrower than timestamp parsing: an ISO-looking `postedAt`
 * alone is never enough to upgrade unknown publication precision.
 */
export function exactNativePublicationDateFromVerifiedReceipt(
  input: NativeLinkAttestationInput
): ExactNativePublicationDate | null {
  if (
    (input.platform !== "x" && input.platform !== "instagram") ||
    input.review_state !== "verified" ||
    Number(input.attributionVersion ?? 0) < 3 ||
    input.attributionStatus !== "verified"
  ) {
    return null;
  }

  const nativeId = nativeEvidenceIdentityFromUrl(input.platform, input.sourceUrl);
  const explicitId = nativePostId(input.platform, input.platformPostId);
  const postedAt = exactInstant(input.postedAt);
  if (!nativeId || !explicitId || nativeId !== explicitId || !postedAt) return null;

  const payload = recordFromUnknown(parseReceipt(input.rawVisibleText));
  if (!payload) return null;
  const verified = input.platform === "x"
    ? verifiedXReceipt(input, payload, nativeId, postedAt)
    : verifiedInstagramReceipt(input, payload, nativeId, postedAt);
  if (!verified) return null;
  return { postedAt, publishedAtPrecision: "exact" };
}

/**
 * Promotes a native post link only when an already-persisted collection
 * receipt proves that the canonical URL, native ID, owner, and exact native
 * publication instant all describe the same object. This does not perform a
 * network request and never treats URL shape, review state, or attribution
 * alone as link verification.
 */
export function nativeLinkStatusFromVerifiedReceipt(
  input: NativeLinkAttestationInput
): LinkStatus {
  if (input.linkStatus === "verified" || input.linkStatus === "invalid" || input.linkStatus === "blocked") {
    return input.linkStatus;
  }
  return hasVerifiedNativeLinkReceipt(input) ? "verified" : input.linkStatus ?? null;
}

export function hasVerifiedNativeLinkReceipt(input: NativeLinkAttestationInput): boolean {
  if (
    input.review_state !== "verified" ||
    Number(input.attributionVersion ?? 0) < 3 ||
    input.attributionStatus !== "verified" ||
    (input.publishedAtPrecision !== undefined && input.publishedAtPrecision !== "exact")
  ) {
    return false;
  }

  if (input.platform === "x" || input.platform === "instagram") {
    return exactNativePublicationDateFromVerifiedReceipt(input) !== null;
  }

  const nativeId = nativeEvidenceIdentityFromUrl(input.platform, input.sourceUrl);
  const explicitId = nativePostId(input.platform, input.platformPostId);
  const postedAt = exactInstant(input.postedAt);
  if (!nativeId || !explicitId || nativeId !== explicitId || !postedAt) return false;

  const receipt = recordFromUnknown(parseReceipt(input.rawVisibleText));
  if (!receipt) return false;
  if (input.platform === "youtube") return verifiedYouTubeAtomReceipt(input, receipt, nativeId, postedAt);
  return false;
}

function verifiedXReceipt(
  input: NativeLinkAttestationInput,
  receipt: Record<string, unknown>,
  nativeId: string,
  postedAt: string
): boolean {
  if (
    stringValue(receipt.source) !== "x_native_evidence_reconciled_v1" ||
    input.attributionProvenance !== "x_public_profile_schema_org_exact_owner_v1"
  ) {
    return false;
  }

  const primary = recordFromUnknown(receipt.primary);
  const metricReceipt = recordFromUnknown(receipt.metricReceipt);
  if (
    !primary ||
    !metricReceipt ||
    stringValue(primary.id) !== nativeId ||
    nativeEvidenceIdentityFromUrl("x", stringValue(primary.sourceUrl) ?? "") !== nativeId ||
    exactInstant(primary.postedAt) !== postedAt ||
    stringValue(primary.attributionProvenance) !== input.attributionProvenance ||
    stringValue(metricReceipt.source) !== "x_native_metric_reconciliation_v1" ||
    stringValue(metricReceipt.nativePostId) !== nativeId ||
    metricReceipt.timestampConflict !== false
  ) {
    return false;
  }

  const nativeAuthor = input.nativeAuthorResolution;
  const requestedBatch = normalizedBatchSlug(input.batchSlug ?? input.batch_slug);
  const receiptBatch = normalizedBatchSlug(nativeAuthor?.owner?.batchSlug);
  if (
    nativeAuthor?.status !== "matched" ||
    nativeAuthor.author?.platform !== "x" ||
    nativeAuthor.owner?.entityType !== input.entityType ||
    nativeAuthor.owner?.entityId !== input.entityId ||
    (requestedBatch !== null && receiptBatch !== requestedBatch)
  ) {
    return false;
  }

  const receiptAuthor = normalizedHandle(nativeAuthor.author?.key);
  const primaryAuthor = normalizedHandle(primary.authorHandle);
  const inputAuthor = normalizedHandle(input.authorHandle);
  // Materializers resolve the persisted row's native author before invoking
  // receipt recovery. Requiring it prevents a receipt alone from filling a
  // missing row-level ownership claim.
  if (!receiptAuthor || receiptAuthor !== primaryAuthor || !inputAuthor || inputAuthor !== receiptAuthor) {
    return false;
  }

  const observedTimestamps = arrayFromUnknown(metricReceipt.observedTimestamps);
  const observations = arrayFromUnknown(metricReceipt.observations);
  return (
    observedTimestamps.some((value) => exactInstant(value) === postedAt) &&
    observations.some((value) => {
      const observation = recordFromUnknown(value);
      return Boolean(
        observation &&
        stringValue(observation.source) === input.attributionProvenance &&
        exactInstant(observation.postedAt) === postedAt &&
        exactInstant(observation.checkedAt)
      );
    })
  );
}

function verifiedYouTubeAtomReceipt(
  input: NativeLinkAttestationInput,
  receipt: Record<string, unknown>,
  nativeId: string,
  postedAt: string
): boolean {
  const attribution = recordFromUnknown(receipt.attribution);
  if (
    receipt.schemaVersion !== 1 ||
    stringValue(receipt.collector) !== "historical-depth-backfill" ||
    stringValue(receipt.platform) !== "youtube" ||
    stringValue(receipt.nativeId) !== nativeId ||
    stringValue(receipt.externalId) !== `youtube:${nativeId}` ||
    nativeEvidenceIdentityFromUrl("youtube", stringValue(receipt.sourceUrl) ?? "") !== nativeId ||
    nativeEvidenceIdentityFromUrl("youtube", stringValue(receipt.canonicalUrl) ?? "") !== nativeId ||
    exactInstant(receipt.publishedAt) !== postedAt ||
    stringValue(receipt.discoveryMethod) !== "youtube_official_atom_feed" ||
    !attribution ||
    stringValue(attribution.status) !== "verified" ||
    stringValue(attribution.method) !== "verified_channel_id_and_official_youtube_atom_feed" ||
    !/^UC[A-Za-z0-9_-]+$/.test(stringValue(attribution.nativeChannelId) ?? "") ||
    !["youtube_official_atom_feed", "verified_channel_id_and_official_youtube_atom_feed"].includes(
      input.attributionProvenance ?? ""
    )
  ) {
    return false;
  }

  if (!sameAccountUrl(input.accountUrl, stringValue(receipt.accountUrl))) return false;
  if (!sameAccountUrl(input.accountUrl, stringValue(attribution.accountUrl))) return false;
  if (!matchingOptionalValue(input.entityType, stringValue(receipt.entityType))) return false;
  if (!matchingOptionalValue(input.entityId, stringValue(receipt.entityId))) return false;

  const requestedBatch = normalizedBatchSlug(input.batchSlug ?? input.batch_slug);
  const receiptBatch = normalizedBatchSlug(stringValue(receipt.batchSlug));
  return requestedBatch === null || requestedBatch === receiptBatch;
}

function verifiedInstagramReceipt(
  input: NativeLinkAttestationInput,
  payload: Record<string, unknown>,
  nativeId: string,
  postedAt: string
): boolean {
  const receipt = recordFromUnknown(payload.receipt);
  const post = recordFromUnknown(payload.post);
  const nativeFeed = recordFromUnknown(receipt?.nativeFeed);
  const receiptSource = stringValue(receipt?.source);
  const receiptFetchedAt = exactInstant(receipt?.fetchedAt);
  const nativeFeedFetchedAt = exactInstant(nativeFeed?.fetchedAt);
  const provenance = input.attributionProvenance;
  const isNativeFeedReceipt =
    provenance === "instagram_anonymous_native_feed_native_owner_v1" &&
    post?.nativeFeedOnly === true &&
    stringValue(post?.nativeFeedMetricSource) === "instagram_anonymous_native_feed_v1";
  const isProfileReceipt =
    provenance === "instagram_public_web_profile_info_native_owner_v1" &&
    post?.nativeFeedOnly !== true;
  const receiptKindIsValid =
    receiptSource === "instagram_anonymous_native_feed_standalone_v1"
      ? isNativeFeedReceipt && validInstagramNativeFeedReceipt(
          nativeFeed,
          receiptSource,
          receiptFetchedAt,
          nativeFeedFetchedAt
        )
      : receiptSource === "instagram_public_web_profile_info_with_native_feed_metrics_v1"
        ? (isNativeFeedReceipt || isProfileReceipt) && validInstagramProfileReceipt(receipt) &&
          validInstagramNativeFeedReceipt(
            nativeFeed,
            receiptSource,
            receiptFetchedAt,
            nativeFeedFetchedAt
          )
        : receiptSource === "instagram_public_web_profile_info_v1"
          ? isProfileReceipt && validInstagramProfileReceipt(receipt)
          : false;
  if (
    !receipt ||
    !post ||
    !receiptFetchedAt ||
    !receiptKindIsValid ||
    stringValue(post.shortcode) !== nativeId ||
    nativeEvidenceIdentityFromUrl("instagram", stringValue(post.url) ?? "") !== nativeId ||
    exactInstant(post.postedAt) !== postedAt ||
    stringValue(post.profileRole) !== "primary"
  ) {
    return false;
  }

  const nativeAuthor = input.nativeAuthorResolution;
  const requestedBatch = normalizedBatchSlug(input.batchSlug ?? input.batch_slug);
  const receiptBatch = normalizedBatchSlug(nativeAuthor?.owner?.batchSlug);
  if (
    nativeAuthor?.status !== "matched" ||
    nativeAuthor.author?.platform !== "instagram" ||
    nativeAuthor.owner?.entityType !== input.entityType ||
    nativeAuthor.owner?.entityId !== input.entityId ||
    (requestedBatch !== null && receiptBatch !== requestedBatch)
  ) {
    return false;
  }

  const receiptAuthor = normalizedHandle(receipt.username);
  const postAuthor = normalizedHandle(post.authorUsername);
  const resolvedAuthor = normalizedHandle(nativeAuthor.author?.key);
  const inputAuthor = normalizedHandle(input.authorHandle);
  if (
    !receiptAuthor ||
    receiptAuthor !== postAuthor ||
    receiptAuthor !== resolvedAuthor ||
    !inputAuthor ||
    inputAuthor !== receiptAuthor
  ) {
    return false;
  }
  return sameAccountUrl(input.accountUrl, stringValue(receipt.accountUrl));
}

function validInstagramProfileReceipt(receipt: Record<string, unknown> | null): boolean {
  return Boolean(
    receipt &&
    positiveInteger(receipt.totalCount) &&
    positiveInteger(receipt.receivedEdgeCount) &&
    positiveInteger(receipt.processedEdgeCount)
  );
}

function validInstagramNativeFeedReceipt(
  nativeFeed: Record<string, unknown> | null,
  receiptSource: string | null,
  receiptFetchedAt: string | null,
  nativeFeedFetchedAt: string | null
): boolean {
  return Boolean(
    nativeFeed &&
    receiptFetchedAt &&
    nativeFeedFetchedAt &&
    stringValue(nativeFeed.source) === "instagram_anonymous_native_feed_v1" &&
    validInstagramReceiptTiming(receiptSource, receiptFetchedAt, nativeFeedFetchedAt) &&
    positiveInteger(nativeFeed.receivedItemCount) &&
    positiveInteger(nativeFeed.uniqueItemCount)
  );
}

function validInstagramReceiptTiming(
  receiptSource: string | null,
  receiptFetchedAt: string,
  nativeFeedFetchedAt: string
): boolean {
  if (receiptSource === "instagram_anonymous_native_feed_standalone_v1") {
    return nativeFeedFetchedAt === receiptFetchedAt;
  }
  return (
    receiptSource === "instagram_public_web_profile_info_with_native_feed_metrics_v1" &&
    Date.parse(nativeFeedFetchedAt) >= Date.parse(receiptFetchedAt)
  );
}

function nativePostId(platform: Platform, value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  if (/^https?:\/\//i.test(normalized)) return nativeEvidenceIdentityFromUrl(platform, normalized);
  if (platform === "x") return normalized.match(/(?:^|\/)status\/(\d+)/i)?.[1] ?? (/^\d+$/.test(normalized) ? normalized : null);
  if (platform === "instagram") {
    return normalized.match(/^(?:\/?)(?:p|reel|tv)[/:]([A-Za-z0-9_-]+)/i)?.[1] ??
      (/^[A-Za-z0-9_-]{5,30}$/.test(normalized) ? normalized : null);
  }
  if (platform === "youtube") {
    return normalized.match(/^(?:shorts|live)\/([A-Za-z0-9_-]+)$/i)?.[1] ??
      (/^[A-Za-z0-9_-]{6,}$/.test(normalized) ? normalized : null);
  }
  return null;
}

function exactInstant(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(normalized)) {
    return null;
  }
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function parseReceipt(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function arrayFromUnknown(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveInteger(value: unknown): boolean {
  const number = typeof value === "number" ? value : Number.NaN;
  return Number.isSafeInteger(number) && number > 0;
}

function normalizedBatchSlug(value: unknown): string | null {
  return stringValue(value)?.toUpperCase() ?? null;
}

function normalizedHandle(value: unknown): string | null {
  return stringValue(value)?.replace(/^@/, "").toLowerCase() ?? null;
}

function sameAccountUrl(left: string | null | undefined, right: string | null | undefined): boolean {
  const canonical = (value: string | null | undefined): string | null => {
    try {
      const url = new URL(value ?? "");
      url.hostname = url.hostname.replace(/^www\./i, "").toLowerCase();
      url.search = "";
      url.hash = "";
      url.pathname = url.pathname.replace(/\/+$/, "");
      return url.toString();
    } catch {
      return null;
    }
  };
  const canonicalLeft = canonical(left);
  return Boolean(canonicalLeft && canonicalLeft === canonical(right));
}

function matchingOptionalValue(expected: string | undefined, observed: string | null): boolean {
  return expected === undefined || expected === observed;
}
