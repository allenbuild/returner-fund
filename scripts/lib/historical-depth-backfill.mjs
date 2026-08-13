import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  writeFile
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { CircuitOpenError, createHttpPolicy } from "./http-policy.mjs";
import {
  HISTORICAL_DEPTH_RUNNER_VERSION,
  HISTORICAL_DEPTH_SCHEMA_VERSION,
  buildHistoricalDepthTargets
} from "./historical-depth-targets.mjs";
import { loadAutonomousCatalogs } from "./autonomous-ingestion-plan.mjs";
import {
  HistoricalDepthPayloadError,
  looksLikeAccessWall,
  parseProductHuntPage,
  parseRedditListing,
  parseYouTubeChannelApi,
  parseYouTubeFeed,
  parseYouTubePlaylistPage,
  parseYouTubePublicPage,
  productHuntGraphqlRequest,
  redditListingRequest,
  youtubeBrowseContinuationRequest,
  youtubeChannelIdFromAccountUrl,
  youtubeChannelsApiUrl,
  youtubeFeedUrl,
  youtubePlaylistItemsApiUrl,
  youtubePublicVideosUrl
} from "./historical-depth-sources.mjs";

export const HISTORICAL_DEPTH_LIMITS = Object.freeze({
  globalConcurrency: 4,
  hostConcurrency: 1,
  hostPaceMs: 500,
  redditPaceMs: 1_000,
  requestTimeoutMs: 20_000,
  requestAttempts: 2,
  circuitFailureThreshold: 3,
  circuitCooldownMs: 60_000,
  maxResponseBytes: 4 * 1024 * 1024,
  maxLineBytes: 8 * 1024 * 1024,
  youtubePublicMaxPages: 10,
  youtubeApiPageSize: 50,
  youtubeApiMaxPages: 100,
  productHuntPageSize: 20,
  productHuntMaxPages: 50,
  redditPageSize: 100,
  redditMaxPages: 10,
  maxItemsPerTarget: 5_000
});

export class HistoricalDepthBodyLimitError extends Error {
  constructor(limit, observed) {
    super(`Historical-depth response exceeded ${limit} bytes.`);
    this.name = "HistoricalDepthBodyLimitError";
    this.limit = limit;
    this.observed = observed;
  }
}

export class HistoricalDepthBodyTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Historical-depth response body did not finish within ${timeoutMs}ms.`);
    this.name = "HistoricalDepthBodyTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export async function buildHistoricalDepthPlan(root, options = {}) {
  const catalogs = options.catalogs ?? await loadAutonomousCatalogs(root);
  const targetPlan = buildHistoricalDepthTargets(catalogs, options);
  const limits = normalizeLimits(options.limits);
  const credentialAvailability = credentialModes(options.credentials);
  const byPlatform = Object.fromEntries(targetPlan.platforms.map((platform) => [platform, {
    ...targetPlan.byPlatform[platform],
    targetAccountPairs: targetPlan.targets.filter((target) => target.platform === platform).length,
    validTargetAccountPairs: targetPlan.targets.filter((target) =>
      target.platform === platform && !target.mappingBlocker
    ).length,
    credentialsAvailable: platform === "youtube"
      ? credentialAvailability.youtubeApiKey
      : platform === "product_hunt"
        ? credentialAvailability.productHuntToken
        : credentialAvailability.redditAccessToken
  }]));
  const logicalByPlatform = { youtube: 0, product_hunt: 0, reddit: 0 };
  for (const target of targetPlan.targets) {
    if (target.mappingBlocker) continue;
    logicalByPlatform[target.platform] += worstCaseLogicalRequests(
      target.platform,
      limits,
      credentialAvailability
    );
  }
  const estimatedWorstCaseLogicalRequests = Object.values(logicalByPlatform)
    .reduce((sum, value) => sum + value, 0);
  return {
    schemaVersion: HISTORICAL_DEPTH_SCHEMA_VERSION,
    runnerVersion: HISTORICAL_DEPTH_RUNNER_VERSION,
    platforms: targetPlan.platforms,
    batches: targetPlan.batches,
    companiesEvaluated: targetPlan.companiesEvaluated,
    foundersEvaluated: targetPlan.foundersEvaluated,
    ownersEvaluated: targetPlan.ownersEvaluated,
    ownerPlatformPairsEvaluated: targetPlan.ownerPlatformPairsEvaluated,
    verifiedMappingsFound: targetPlan.verifiedMappingsFound,
    verifiedAccountsMapped: targetPlan.verifiedAccountsMapped,
    invalidVerifiedMappings: targetPlan.invalidVerifiedMappings,
    unverifiedMappingsSkipped: targetPlan.unverifiedMappingsSkipped,
    unmappedOwnerPlatformPairs: targetPlan.unmappedOwnerPlatformPairs,
    targetAccountPairs: targetPlan.targetAccountPairs,
    byPlatform,
    credentials: credentialAvailability,
    concurrency: {
      global: limits.globalConcurrency,
      perHost: limits.hostConcurrency,
      defaultHostPaceMs: limits.hostPaceMs,
      redditHostPaceMs: limits.redditPaceMs,
      signedInSessions: false
    },
    limits: publicLimits(limits),
    technicalDepth: {
      youtube: credentialAvailability.youtubeApiKey
        ? "official uploads-playlist API paginated until endpoint exhaustion or the explicit page cap; Atom feed is also checked"
        : "non-paginated Atom recent feed plus bounded anonymous public-continuation discovery; full exact-timestamp history remains queued for YOUTUBE_API_KEY",
      product_hunt: credentialAvailability.productHuntToken
        ? "official GraphQL posts(url:) pagination from an explicit 1970 cutoff"
        : "no API collection; official Product Hunt endpoints require PRODUCT_HUNT_TOKEN",
      reddit: credentialAvailability.redditAccessToken
        ? "official OAuth listing pagination, still subject to Reddit's approximately 1,000-item listing window"
        : "anonymous public JSON listing where allowed, with access walls recorded and the approximately 1,000-item listing cutoff preserved"
    },
    estimatedWorstCaseLogicalRequestsByPlatform: logicalByPlatform,
    estimatedWorstCaseLogicalRequests,
    estimatedWorstCaseHttpAttempts: estimatedWorstCaseLogicalRequests * limits.requestAttempts
  };
}

export async function runHistoricalDepthBackfill({
  root = process.cwd(),
  outputDir,
  catalogs,
  batches,
  platforms,
  limits: limitOverrides,
  credentials: credentialValues,
  resume = false,
  fetch: fetchImplementation = globalThis.fetch,
  clock,
  signal,
  now = () => new Date(),
  onPageCommitted
} = {}) {
  if (!outputDir) throw new Error("runHistoricalDepthBackfill requires an outputDir.");
  if (typeof fetchImplementation !== "function") throw new Error("A fetch implementation is required.");
  const loadedCatalogs = catalogs ?? await loadAutonomousCatalogs(root);
  const plan = buildHistoricalDepthTargets(loadedCatalogs, { batches, platforms });
  const limits = normalizeLimits(limitOverrides);
  const credentials = normalizeCredentials(credentialValues);
  const config = {
    schemaVersion: HISTORICAL_DEPTH_SCHEMA_VERSION,
    runnerVersion: HISTORICAL_DEPTH_RUNNER_VERSION,
    batches: plan.batches.map((batch) => batch.slug),
    platforms: plan.platforms,
    targetKeys: plan.targets.map((target) => target.targetKey),
    credentialModes: credentialModes(credentials),
    limits: publicLimits(limits)
  };
  const configFingerprint = sha256(stableJson(config));
  const store = await HistoricalDepthCheckpointStore.open(resolve(outputDir), {
    config,
    configFingerprint,
    resume,
    now,
    maxLineBytes: limits.maxLineBytes
  });
  if (store.state.status === "completed" && store.state.summary) {
    return structuredClone(store.state.summary);
  }

  const attempts = new Map();
  const http = createHttpPolicy({
    fetch: fetchImplementation,
    clock,
    globalConcurrency: limits.globalConcurrency,
    providerConcurrency: limits.hostConcurrency,
    providerPaceMs: limits.hostPaceMs,
    timeoutMs: limits.requestTimeoutMs,
    maxAttempts: limits.requestAttempts,
    circuitBreaker: {
      failureThreshold: limits.circuitFailureThreshold,
      cooldownMs: limits.circuitCooldownMs
    },
    providers: {
      "www.reddit.com": { providerConcurrency: 1, providerPaceMs: limits.redditPaceMs },
      "oauth.reddit.com": { providerConcurrency: 1, providerPaceMs: limits.redditPaceMs },
      "api.producthunt.com": { providerConcurrency: 1, providerPaceMs: limits.hostPaceMs },
      "www.googleapis.com": { providerConcurrency: 1, providerPaceMs: limits.hostPaceMs },
      "www.youtube.com": { providerConcurrency: 1, providerPaceMs: limits.hostPaceMs }
    },
    onEvent(event) {
      if (event.phase === "start") {
        attempts.set(event.requestId, (attempts.get(event.requestId) ?? 0) + 1);
      }
    }
  });
  const context = {
    http,
    attempts,
    nextRequestId: 1,
    limits,
    credentials,
    store,
    signal,
    now,
    onPageCommitted
  };
  const pending = plan.targets.filter((target) => !store.isCompleted(target.targetKey));
  await runWorkerPool(pending, limits.globalConcurrency, async (target) => {
    throwIfAborted(signal);
    await collectTarget(target, context);
  });
  const summary = buildSummary(plan, store.state, limits, credentialModes(credentials), now());
  await store.finish(summary);
  return summary;
}

async function collectTarget(target, context) {
  if (target.mappingBlocker || !target.accountUrl) {
    const progress = freshProgress(target, context.limits);
    await context.store.completeTarget(target, terminalReceipt(target, progress, {
      outcome: "manual_review",
      blocker: `invalid_verified_mapping:${target.mappingBlocker ?? "missing_native_account_url"}`,
      credentialRequired: false,
      nextAction: "Correct or retire the verified mapping; do not infer that the native account is absent.",
      coverageExtent: "not_started_invalid_verified_mapping",
      sourceExhausted: false
    }));
    return;
  }
  try {
    if (target.platform === "youtube") await collectYouTube(target, context);
    else if (target.platform === "product_hunt") await collectProductHunt(target, context);
    else await collectReddit(target, context);
  } catch (error) {
    if (isAbort(error) || context.signal?.aborted) throw error;
    let progress = context.store.progressFor(target.targetKey) ?? freshProgress(target, context.limits);
    const failedAttempts = Number(error?.historicalDepthRequestAttempts ?? 0);
    if (failedAttempts > 0) progress = failedRequestProgress(progress, failedAttempts, Boolean(error?.httpStatus));
    const resolution = errorResolution(error, target);
    await context.store.completeTarget(target, terminalReceipt(target, progress, resolution));
  }
}

async function collectYouTube(target, context) {
  let progress = context.store.progressFor(target.targetKey) ?? freshProgress(target, context.limits);
  const acceptedSeen = new Set(progress.seenItemKeys ?? []);
  const discoverySeen = new Set(progress.seenDiscoveryKeys ?? []);
  let channelId = progress.channelId ?? youtubeChannelIdFromAccountUrl(target.accountUrl) ?? target.accountId;

  if (progress.stage === "resolve") {
    const requestUrl = youtubePublicVideosUrl(target);
    const fetched = await fetchText(context, requestUrl, {
      headers: { accept: "text/html", "user-agent": publicUserAgent() }
    });
    if (!fetched.response.ok) {
      throw tagAttemptCount(
        httpError(target, fetched.response, requestUrl, fetched.text),
        fetched.requestAttempts
      );
    }
    if (looksLikeAccessWall(fetched.text)) {
      throw tagAttemptCount(new HistoricalDepthPayloadError(
        "youtube_public_access_wall",
        "YouTube returned an HTTP 200 challenge or access wall for the verified channel."
      ), fetched.requestAttempts);
    }
    const parsed = parseFetched(fetched, () => parseYouTubePublicPage(fetched.text, {
      seen: discoverySeen,
      maxItems: context.limits.maxItemsPerTarget
    }));
    if (channelId && parsed.channelId && channelId !== parsed.channelId) {
      throw new HistoricalDepthPayloadError(
        "youtube_channel_identity_mismatch",
        `Verified YouTube mapping resolved to ${parsed.channelId}, not ${channelId}.`
      );
    }
    channelId = channelId ?? parsed.channelId;
    progress = updateProgress(progress, {
      requestAttempts: fetched.requestAttempts,
      pageItemsSeen: parsed.itemsSeen,
      pageRejected: parsed.rejectedMissingExactTimestamp,
      pageDuplicates: parsed.duplicates,
      stage: "feed",
      channelId,
      publicContinuationToken: parsed.continuationToken,
      publicContinuationApiKey: parsed.innertubeApiKey,
      publicClientVersion: parsed.innertubeClientVersion,
      publicPagesFetched: 1,
      seenDiscoveryKeys: [...discoverySeen]
    });
    await commitPage(context, target, progress, [], {
      pageType: "youtube_public_channel_discovery",
      requestUrl,
      pageItemsSeen: parsed.itemsSeen,
      pageAccepted: 0,
      pageRejected: parsed.rejectedMissingExactTimestamp,
      pageDuplicates: parsed.duplicates,
      coverageExtent: "public_continuation_discovery_without_exact_timestamps"
    });
  }

  if (!channelId) {
    await context.store.completeTarget(target, terminalReceipt(target, progress, {
      outcome: "manual_review",
      blocker: "youtube_native_channel_id_unresolved",
      credentialRequired: false,
      nextAction: "Verify the mapped handle and persist its exact UC channel ID before resuming history.",
      coverageExtent: "verified_mapping_requires_native_channel_id",
      sourceExhausted: false
    }));
    return;
  }

  if (progress.stage === "feed") {
    const requestUrl = youtubeFeedUrl(channelId);
    try {
      const fetched = await fetchText(context, requestUrl, {
        headers: { accept: "application/atom+xml, application/xml", "user-agent": publicUserAgent() }
      });
      if (!fetched.response.ok) {
        throw tagAttemptCount(
          httpError(target, fetched.response, requestUrl, fetched.text),
          fetched.requestAttempts
        );
      }
      const parsed = parseFetched(fetched, () => parseYouTubeFeed(fetched.text, {
        target: { ...target, accountId: channelId },
        seen: acceptedSeen,
        discoveredAt: context.now()
      }));
      progress = updateProgress(progress, {
        requestAttempts: fetched.requestAttempts,
        pageItemsSeen: parsed.itemsSeen,
        pageAccepted: parsed.accepted,
        pageRejected: parsed.rejected,
        pageDuplicates: parsed.duplicates,
        earliest: parsed.earliest,
        latest: parsed.latest,
        stage: context.credentials.youtubeApiKey ? "api_channel" : "public_continuation",
        channelId,
        seenItemKeys: [...acceptedSeen]
      });
      await commitPage(context, target, progress, parsed.evidence, {
        pageType: "youtube_atom_feed",
        requestUrl,
        pageItemsSeen: parsed.itemsSeen,
        pageAccepted: parsed.accepted,
        pageRejected: parsed.rejected,
        pageDuplicates: parsed.duplicates,
        coverageExtent: parsed.coverageExtent
      });
    } catch (error) {
      if (!context.credentials.youtubeApiKey) throw error;
      progress = updateProgress(progress, {
        requestAttempts: Number(error?.historicalDepthRequestAttempts ?? 0),
        stage: "api_channel",
        channelId,
        sourceBlockers: [...(progress.sourceBlockers ?? []), exactBlocker(error, target)]
      });
      await commitPage(context, target, progress, [], {
        pageType: "youtube_atom_feed",
        requestUrl,
        blocker: exactBlocker(error, target),
        coverageExtent: "atom_feed_blocked_official_api_fallback_pending"
      });
    }
  }

  if (!context.credentials.youtubeApiKey) {
    while (
      progress.stage === "public_continuation" &&
      progress.publicContinuationToken &&
      progress.publicContinuationApiKey &&
      progress.publicPagesFetched < context.limits.youtubePublicMaxPages
    ) {
      throwIfAborted(context.signal);
      const request = youtubeBrowseContinuationRequest({
        token: progress.publicContinuationToken,
        apiKey: progress.publicContinuationApiKey,
        clientVersion: progress.publicClientVersion
      });
      const fetched = await fetchText(context, request.url, request.init);
      if (!fetched.response.ok) {
        throw tagAttemptCount(
          httpError(target, fetched.response, request.url, fetched.text),
          fetched.requestAttempts
        );
      }
      if (looksLikeAccessWall(fetched.text)) {
        throw tagAttemptCount(new HistoricalDepthPayloadError(
          "youtube_public_continuation_access_wall",
          "YouTube public continuation returned a challenge or access wall."
        ), fetched.requestAttempts);
      }
      const parsed = parseFetched(fetched, () => parseYouTubePublicPage(fetched.text, {
        seen: discoverySeen,
        maxItems: context.limits.maxItemsPerTarget
      }));
      progress = updateProgress(progress, {
        requestAttempts: fetched.requestAttempts,
        pageItemsSeen: parsed.itemsSeen,
        pageRejected: parsed.rejectedMissingExactTimestamp,
        pageDuplicates: parsed.duplicates,
        stage: "public_continuation",
        publicContinuationToken: parsed.continuationToken,
        publicPagesFetched: progress.publicPagesFetched + 1,
        seenDiscoveryKeys: [...discoverySeen]
      });
      await commitPage(context, target, progress, [], {
        pageType: "youtube_public_continuation_discovery",
        requestUrl: request.url,
        pageItemsSeen: parsed.itemsSeen,
        pageAccepted: 0,
        pageRejected: parsed.rejectedMissingExactTimestamp,
        pageDuplicates: parsed.duplicates,
        coverageExtent: "public_continuation_discovery_without_exact_timestamps"
      });
    }
    const hitPublicCap = Boolean(progress.publicContinuationToken) &&
      progress.publicPagesFetched >= context.limits.youtubePublicMaxPages;
    progress = { ...progress, truncated: hitPublicCap, sourceExhausted: false };
    await context.store.completeTarget(target, terminalReceipt(target, progress, {
      outcome: "manual_review",
      blocker: "credentials_required:YOUTUBE_API_KEY:full_exact_timestamp_history",
      credentialRequired: true,
      requiredCredential: "YOUTUBE_API_KEY",
      nextAction: "Provide a restricted YouTube Data API key and run a new resumable campaign for the uploads playlist.",
      coverageExtent: progress.accepted > 0
        ? "recent_atom_feed_collected_full_history_queued"
        : "public_discovery_only_full_history_queued",
      sourceExhausted: false,
      technicalCutoff: hitPublicCap
        ? "youtube_public_continuation_page_cap"
        : "youtube_public_pages_lack_exact_publication_timestamps"
    }));
    return;
  }

  if (progress.stage === "api_channel") {
    const requestUrl = youtubeChannelsApiUrl(channelId, context.credentials.youtubeApiKey);
    const fetched = await fetchJson(context, requestUrl, {
      headers: { accept: "application/json", "user-agent": publicUserAgent() }
    }, target);
    const parsed = parseFetched(
      fetched,
      () => parseYouTubeChannelApi(fetched.payload, { ...target, accountId: channelId })
    );
    progress = updateProgress(progress, {
      requestAttempts: fetched.requestAttempts,
      stage: "api_pages",
      channelId: parsed.channelId ?? channelId,
      uploadsPlaylistId: parsed.uploadsPlaylistId,
      nextCursor: null
    });
    await commitPage(context, target, progress, [], {
      pageType: "youtube_channels_api",
      requestUrl,
      coverageExtent: "uploads_playlist_resolved"
    });
  }

  while (
    progress.stage === "api_pages" &&
    progress.providerPagesFetched < context.limits.youtubeApiMaxPages &&
    progress.itemsSeen < context.limits.maxItemsPerTarget
  ) {
    throwIfAborted(context.signal);
    const requestUrl = youtubePlaylistItemsApiUrl({
      playlistId: progress.uploadsPlaylistId,
      pageToken: progress.nextCursor,
      pageSize: context.limits.youtubeApiPageSize,
      apiKey: context.credentials.youtubeApiKey
    });
    const fetched = await fetchJson(context, requestUrl, {
      headers: { accept: "application/json", "user-agent": publicUserAgent() }
    }, target);
    const parsed = parseFetched(fetched, () => parseYouTubePlaylistPage(fetched.payload, {
      target,
      expectedChannelId: progress.channelId,
      seen: acceptedSeen,
      discoveredAt: context.now()
    }));
    const nextProviderPages = progress.providerPagesFetched + 1;
    const limitReached = Boolean(parsed.nextCursor) && (
      nextProviderPages >= context.limits.youtubeApiMaxPages ||
      progress.itemsSeen + parsed.itemsSeen >= context.limits.maxItemsPerTarget
    );
    progress = updateProgress(progress, {
      requestAttempts: fetched.requestAttempts,
      pageItemsSeen: parsed.itemsSeen,
      pageAccepted: parsed.accepted,
      pageRejected: parsed.rejected,
      pageDuplicates: parsed.duplicates,
      earliest: parsed.earliest,
      latest: parsed.latest,
      stage: parsed.sourceExhausted ? "done" : "api_pages",
      nextCursor: parsed.nextCursor,
      providerPagesFetched: nextProviderPages,
      sourceExhausted: parsed.sourceExhausted,
      truncated: limitReached,
      seenItemKeys: [...acceptedSeen]
    });
    await commitPage(context, target, progress, parsed.evidence, {
      pageType: "youtube_uploads_playlist_page",
      requestUrl,
      pageItemsSeen: parsed.itemsSeen,
      pageAccepted: parsed.accepted,
      pageRejected: parsed.rejected,
      pageDuplicates: parsed.duplicates,
      coverageExtent: parsed.sourceExhausted
        ? "all_items_exposed_by_official_uploads_playlist_api"
        : "official_uploads_playlist_api_page"
    });
    if (parsed.sourceExhausted || limitReached) break;
  }
  await finishExhaustiveOrLimited(target, progress, context, {
    sourceName: "youtube",
    completeExtent: "all_items_exposed_by_official_uploads_playlist_api",
    limitBlocker: "youtube_api_page_or_item_limit_reached"
  });
}

async function collectProductHunt(target, context) {
  let progress = context.store.progressFor(target.targetKey) ?? freshProgress(target, context.limits);
  if (!context.credentials.productHuntToken) {
    await context.store.completeTarget(target, terminalReceipt(target, progress, {
      outcome: "manual_review",
      blocker: "credentials_required:PRODUCT_HUNT_TOKEN:official_graphql_history",
      credentialRequired: true,
      requiredCredential: "PRODUCT_HUNT_TOKEN",
      nextAction: "Provide an approved Product Hunt developer token and confirm the API use is permitted for this project.",
      coverageExtent: "not_started_product_hunt_token_required",
      sourceExhausted: false
    }));
    return;
  }
  if (!target.officialWebsite || !target.officialDomain) {
    await context.store.completeTarget(target, terminalReceipt(target, progress, {
      outcome: "manual_review",
      blocker: "product_hunt_exact_official_url_filter_unavailable",
      credentialRequired: false,
      nextAction: "Verify the canonical company website before querying Product Hunt posts by exact URL.",
      coverageExtent: "not_started_missing_official_website",
      sourceExhausted: false
    }));
    return;
  }
  const seen = new Set(progress.seenItemKeys ?? []);
  while (
    progress.providerPagesFetched < context.limits.productHuntMaxPages &&
    progress.itemsSeen < context.limits.maxItemsPerTarget
  ) {
    throwIfAborted(context.signal);
    const request = productHuntGraphqlRequest(target, {
      after: progress.nextCursor,
      pageSize: context.limits.productHuntPageSize,
      token: context.credentials.productHuntToken
    });
    const fetched = await fetchJson(context, request.url, request.init, target);
    const parsed = parseFetched(fetched, () => parseProductHuntPage(fetched.payload, {
      target,
      seen,
      discoveredAt: context.now()
    }));
    const nextProviderPages = progress.providerPagesFetched + 1;
    const limitReached = Boolean(parsed.nextCursor) && (
      nextProviderPages >= context.limits.productHuntMaxPages ||
      progress.itemsSeen + parsed.itemsSeen >= context.limits.maxItemsPerTarget
    );
    progress = updateProgress(progress, {
      requestAttempts: fetched.requestAttempts,
      pageItemsSeen: parsed.itemsSeen,
      pageAccepted: parsed.accepted,
      pageRejected: parsed.rejected,
      pageDuplicates: parsed.duplicates,
      earliest: parsed.earliest,
      latest: parsed.latest,
      nextCursor: parsed.nextCursor,
      providerPagesFetched: nextProviderPages,
      sourceExhausted: parsed.sourceExhausted,
      truncated: limitReached,
      seenItemKeys: [...seen]
    });
    await commitPage(context, target, progress, parsed.evidence, {
      pageType: "product_hunt_graphql_posts_by_url",
      requestUrl: request.url,
      pageItemsSeen: parsed.itemsSeen,
      pageAccepted: parsed.accepted,
      pageRejected: parsed.rejected,
      pageDuplicates: parsed.duplicates,
      coverageExtent: parsed.sourceExhausted
        ? "all_official_graphql_posts_matching_exact_official_url_since_1970"
        : "official_graphql_posts_page"
    });
    if (parsed.sourceExhausted || limitReached) break;
  }
  await finishExhaustiveOrLimited(target, progress, context, {
    sourceName: "product_hunt",
    completeExtent: "all_official_graphql_posts_matching_exact_official_url_since_1970",
    limitBlocker: "product_hunt_graphql_page_or_item_limit_reached",
    emptyResolution: {
      outcome: "manual_review",
      blocker: "verified_product_hunt_mapping_but_exact_official_url_query_empty",
      nextAction: "Review Product Hunt URL aliases and launch slugs; do not infer that the verified product account has no history.",
      coverageExtent: "official_graphql_exact_url_query_exhausted_without_verified_launch_match"
    }
  });
}

async function collectReddit(target, context) {
  let progress = context.store.progressFor(target.targetKey) ?? freshProgress(target, context.limits);
  const seen = new Set(progress.seenItemKeys ?? []);
  while (
    progress.providerPagesFetched < context.limits.redditMaxPages &&
    progress.itemsSeen < context.limits.maxItemsPerTarget
  ) {
    throwIfAborted(context.signal);
    const request = redditListingRequest(target, {
      after: progress.nextCursor,
      count: progress.itemsSeen,
      pageSize: context.limits.redditPageSize,
      accessToken: context.credentials.redditAccessToken
    });
    const fetched = await fetchText(context, request.url, request.init);
    if (!fetched.response.ok) {
      throw tagAttemptCount(
        httpError(target, fetched.response, request.url, fetched.text),
        fetched.requestAttempts
      );
    }
    if (looksLikeAccessWall(fetched.text)) {
      throw tagAttemptCount(new HistoricalDepthPayloadError(
        "reddit_access_wall",
        "Reddit returned an HTTP 200 access wall instead of listing JSON."
      ), fetched.requestAttempts);
    }
    let payload;
    try {
      payload = JSON.parse(fetched.text);
    } catch {
      throw tagAttemptCount(new HistoricalDepthPayloadError(
        "reddit_non_json_response",
        "Reddit listing response was not valid JSON."
      ), fetched.requestAttempts);
    }
    const parsed = parseFetched(fetched, () => parseRedditListing(payload, {
      target,
      identity: request.identity,
      seen,
      discoveredAt: context.now()
    }));
    const nextProviderPages = progress.providerPagesFetched + 1;
    const endpointLimitReached = Boolean(parsed.nextCursor) && (
      nextProviderPages >= context.limits.redditMaxPages ||
      progress.itemsSeen + parsed.itemsSeen >= 1_000 ||
      progress.itemsSeen + parsed.itemsSeen >= context.limits.maxItemsPerTarget
    );
    progress = updateProgress(progress, {
      requestAttempts: fetched.requestAttempts,
      pageItemsSeen: parsed.itemsSeen,
      pageAccepted: parsed.accepted,
      pageRejected: parsed.rejected,
      pageDuplicates: parsed.duplicates,
      earliest: parsed.earliest,
      latest: parsed.latest,
      nextCursor: parsed.nextCursor,
      providerPagesFetched: nextProviderPages,
      sourceExhausted: parsed.sourceExhausted,
      truncated: endpointLimitReached,
      technicalCutoff: "reddit_listing_window_maximum_1000_items",
      seenItemKeys: [...seen]
    });
    await commitPage(context, target, progress, parsed.evidence, {
      pageType: context.credentials.redditAccessToken ? "reddit_oauth_listing" : "reddit_public_json_listing",
      requestUrl: request.url,
      pageItemsSeen: parsed.itemsSeen,
      pageAccepted: parsed.accepted,
      pageRejected: parsed.rejected,
      pageDuplicates: parsed.duplicates,
      coverageExtent: parsed.sourceExhausted
        ? "all_posts_exposed_by_reddit_listing_not_guaranteed_account_lifetime_history"
        : "reddit_listing_page"
    });
    if (parsed.sourceExhausted || endpointLimitReached) break;
  }
  if (progress.truncated) {
    await context.store.completeTarget(target, terminalReceipt(target, progress, {
      outcome: "manual_review",
      blocker: "reddit_listing_1000_item_or_configured_page_cutoff_reached",
      credentialRequired: false,
      nextAction: "Record the endpoint cutoff; use an approved deeper Reddit data product if complete lifetime history is required.",
      coverageExtent: "bounded_reddit_listing_history",
      sourceExhausted: false,
      technicalCutoff: "reddit_listing_window_maximum_1000_items"
    }));
    return;
  }
  await context.store.completeTarget(target, terminalReceipt(target, progress, {
    outcome: progress.accepted > 0 ? "collected" : "verified_no_history",
    blocker: null,
    credentialRequired: false,
    nextAction: "No immediate action; preserve the Reddit listing-window cutoff in downstream coverage.",
    coverageExtent: "all_posts_exposed_by_reddit_listing_not_guaranteed_account_lifetime_history",
    sourceExhausted: Boolean(progress.sourceExhausted),
    technicalCutoff: "reddit_listing_window_maximum_1000_items"
  }));
}

async function finishExhaustiveOrLimited(target, progress, context, {
  sourceName,
  completeExtent,
  limitBlocker,
  emptyResolution = null
}) {
  if (!progress.sourceExhausted || progress.truncated) {
    await context.store.completeTarget(target, terminalReceipt(target, progress, {
      outcome: "manual_review",
      blocker: limitBlocker,
      credentialRequired: false,
      nextAction: `Start a new explicitly higher-cap ${sourceName} run and merge by canonical externalId.`,
      coverageExtent: `bounded_${sourceName}_history`,
      sourceExhausted: false,
      technicalCutoff: limitBlocker
    }));
    return;
  }
  if (progress.accepted === 0 && emptyResolution) {
    await context.store.completeTarget(target, terminalReceipt(target, progress, {
      ...emptyResolution,
      credentialRequired: false,
      sourceExhausted: true
    }));
    return;
  }
  await context.store.completeTarget(target, terminalReceipt(target, progress, {
    outcome: progress.accepted > 0 ? "collected" : "verified_no_history",
    blocker: null,
    credentialRequired: false,
    nextAction: "No action; the configured official endpoint was exhausted successfully.",
    coverageExtent: completeExtent,
    sourceExhausted: true
  }));
}

async function fetchJson(context, url, init, target) {
  const fetched = await fetchText(context, url, init);
  if (!fetched.response.ok) {
    throw tagAttemptCount(httpError(target, fetched.response, url, fetched.text), fetched.requestAttempts);
  }
  if (looksLikeAccessWall(fetched.text)) {
    throw tagAttemptCount(new HistoricalDepthPayloadError(
      `${target.platform}_access_wall`,
      `${target.platform} returned an HTTP 200 challenge or access wall.`
    ), fetched.requestAttempts);
  }
  try {
    return { ...fetched, payload: JSON.parse(fetched.text) };
  } catch {
    throw tagAttemptCount(new HistoricalDepthPayloadError(
      `${target.platform}_non_json_response`,
      `${target.platform} returned a non-JSON response from its JSON endpoint.`
    ), fetched.requestAttempts);
  }
}

async function fetchText(context, url, init = {}) {
  throwIfAborted(context.signal);
  const requestId = `historical-depth:${context.nextRequestId++}:${sha256(url).slice(0, 16)}`;
  const provider = new URL(url).hostname.toLowerCase();
  try {
    const response = await context.http.fetch(url, {
      ...init,
      headers: {
        accept: "application/json, application/xml, text/xml, text/html;q=0.8",
        "user-agent": publicUserAgent(),
        ...(init.headers ?? {})
      },
      signal: context.signal
    }, { provider, requestId });
    const text = await readBoundedText(response, context.limits.maxResponseBytes, {
      timeoutMs: context.limits.requestTimeoutMs
    });
    return {
      response,
      text,
      requestAttempts: context.attempts.get(requestId) ?? 0
    };
  } catch (error) {
    try {
      error.historicalDepthRequestAttempts = context.attempts.get(requestId) ?? 0;
    } catch {
      // Frozen provider errors still retain their exact error identity.
    }
    throw error;
  } finally {
    context.attempts.delete(requestId);
  }
}

export async function readBoundedText(
  response,
  maxBytes = HISTORICAL_DEPTH_LIMITS.maxResponseBytes,
  { timeoutMs = HISTORICAL_DEPTH_LIMITS.requestTimeoutMs } = {}
) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HistoricalDepthBodyLimitError(maxBytes, declared);
  }
  const chunks = [];
  let observed = 0;
  let reader = null;
  let timer = null;
  const consume = async () => {
    if (response.body?.getReader) {
      reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = Buffer.from(value);
          observed += chunk.length;
          if (observed > maxBytes) {
            await reader.cancel().catch(() => {});
            throw new HistoricalDepthBodyLimitError(maxBytes, observed);
          }
          chunks.push(chunk);
        }
      } finally {
        reader.releaseLock?.();
      }
    } else {
      const body = Buffer.from(await response.arrayBuffer());
      observed = body.length;
      if (observed > maxBytes) throw new HistoricalDepthBodyLimitError(maxBytes, observed);
      chunks.push(body);
    }
    return Buffer.concat(chunks, observed).toString("utf8");
  };
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reader?.cancel?.().catch(() => {});
      reject(new HistoricalDepthBodyTimeoutError(timeoutMs));
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([consume(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function freshProgress(target, limits) {
  return {
    targetKey: target.targetKey,
    platform: target.platform,
    stage: target.platform === "youtube" ? "resolve" : "pages",
    pagesAttempted: 0,
    pagesFetched: 0,
    requests: 0,
    itemsSeen: 0,
    accepted: 0,
    rejected: 0,
    duplicates: 0,
    earliest: null,
    latest: null,
    nextCursor: null,
    providerPagesFetched: 0,
    publicPagesFetched: 0,
    sourceExhausted: false,
    truncated: false,
    credentialRequired: false,
    blocker: null,
    technicalCutoff: null,
    sourceLimit: sourceLimit(target.platform, limits),
    seenItemKeys: [],
    seenDiscoveryKeys: [],
    sourceBlockers: []
  };
}

function updateProgress(progress, {
  requestAttempts = 0,
  pageItemsSeen = 0,
  pageAccepted = 0,
  pageRejected = 0,
  pageDuplicates = 0,
  earliest = null,
  latest = null,
  ...changes
} = {}) {
  return {
    ...progress,
    ...changes,
    pagesAttempted: progress.pagesAttempted + 1,
    pagesFetched: progress.pagesFetched + 1,
    requests: progress.requests + requestAttempts,
    itemsSeen: progress.itemsSeen + pageItemsSeen,
    accepted: progress.accepted + pageAccepted,
    rejected: progress.rejected + pageRejected,
    duplicates: progress.duplicates + pageDuplicates,
    earliest: earlier(progress.earliest, earliest),
    latest: later(progress.latest, latest),
    truncated: Boolean(progress.truncated || changes.truncated)
  };
}

function failedRequestProgress(progress, requestAttempts, responseFetched) {
  return {
    ...progress,
    pagesAttempted: progress.pagesAttempted + 1,
    pagesFetched: progress.pagesFetched + (responseFetched ? 1 : 0),
    requests: progress.requests + requestAttempts
  };
}

function tagAttemptCount(error, requestAttempts) {
  try {
    error.historicalDepthRequestAttempts = Number(requestAttempts ?? 0);
  } catch {
    // Preserve frozen provider errors without mutating them.
  }
  return error;
}

function parseFetched(fetched, operation) {
  try {
    return operation();
  } catch (error) {
    throw tagAttemptCount(error, fetched.requestAttempts);
  }
}

async function commitPage(context, target, progress, evidence, {
  pageType,
  requestUrl,
  pageItemsSeen = 0,
  pageAccepted = 0,
  pageRejected = 0,
  pageDuplicates = 0,
  blocker = null,
  coverageExtent
}) {
  const receipt = pageReceipt(target, progress, {
    pageType,
    requestUrl: redactedUrl(requestUrl),
    pageItemsSeen,
    pageAccepted,
    pageRejected,
    pageDuplicates,
    blocker,
    coverageExtent
  });
  await context.store.commitPage(target, receipt, evidence, progress);
  if (typeof context.onPageCommitted === "function") {
    await context.onPageCommitted({ target, receipt, evidence, progress });
  }
}

function pageReceipt(target, progress, {
  pageType,
  requestUrl,
  pageItemsSeen,
  pageAccepted,
  pageRejected,
  pageDuplicates,
  blocker,
  coverageExtent
}) {
  return {
    ...receiptBase(target, progress),
    receiptType: "page",
    pageType,
    requestUrl,
    pageItemsSeen,
    pageAccepted,
    pageRejected,
    pageDuplicates,
    blocker,
    blockers: blocker ? [blocker] : [],
    coverageExtent
  };
}

function terminalReceipt(target, progress, {
  outcome,
  blocker = null,
  blockers = blocker ? [blocker] : [],
  credentialRequired = false,
  requiredCredential = null,
  nextAction,
  coverageExtent,
  sourceExhausted = progress.sourceExhausted,
  technicalCutoff = progress.technicalCutoff ?? null
}) {
  return {
    ...receiptBase(target, { ...progress, sourceExhausted }),
    receiptType: "target",
    outcome,
    credentialRequired: Boolean(credentialRequired),
    requiredCredential,
    blocker,
    blockers: [...new Set([...(progress.sourceBlockers ?? []), ...blockers].filter(Boolean))],
    nextAction,
    coverageExtent,
    technicalCutoff
  };
}

function receiptBase(target, progress) {
  return {
    schemaVersion: HISTORICAL_DEPTH_SCHEMA_VERSION,
    runnerVersion: HISTORICAL_DEPTH_RUNNER_VERSION,
    provider: target.platform,
    platform: target.platform,
    targetKey: target.targetKey,
    batchSlug: target.batchSlug,
    entityType: target.entityType,
    entityId: target.entityId,
    entityName: target.entityName,
    companyId: target.companyId,
    companyName: target.companyName,
    officialDomain: target.officialDomain,
    accountUrl: target.accountUrl,
    accountSourceKey: target.accountSourceKey,
    mappingVerified: true,
    pagesAttempted: progress.pagesAttempted,
    pagesFetched: progress.pagesFetched,
    requests: progress.requests,
    itemsSeen: progress.itemsSeen,
    accepted: progress.accepted,
    rejected: progress.rejected,
    duplicates: progress.duplicates,
    earliest: progress.earliest,
    latest: progress.latest,
    nextCursor: progress.nextCursor,
    sourceExhausted: Boolean(progress.sourceExhausted),
    truncated: Boolean(progress.truncated),
    sourceLimit: progress.sourceLimit
  };
}

function errorResolution(error, target) {
  if (error instanceof CircuitOpenError) {
    return {
      outcome: "access_blocked",
      blocker: `circuit_open:${error.provider}:retry_at=${new Date(error.retryAt).toISOString()}`,
      credentialRequired: false,
      nextAction: "Resume only after the exact circuit cooldown; do not raise concurrency.",
      coverageExtent: "provider_circuit_open",
      sourceExhausted: false
    };
  }
  if (error instanceof HistoricalDepthBodyLimitError) {
    return {
      outcome: "access_blocked",
      blocker: `bounded_body_limit_exceeded:limit=${error.limit}:observed=${error.observed}`,
      credentialRequired: false,
      nextAction: "Manually review the endpoint before raising the bounded response limit.",
      coverageExtent: "response_body_rejected_by_safety_limit",
      sourceExhausted: false
    };
  }
  if (error instanceof HistoricalDepthBodyTimeoutError) {
    return {
      outcome: "access_blocked",
      blocker: `response_body_timeout:timeout_ms=${error.timeoutMs}`,
      credentialRequired: false,
      nextAction: "Retry from the durable checkpoint after the provider body endpoint is responsive.",
      coverageExtent: "response_body_timeout",
      sourceExhausted: false
    };
  }
  if (error?.httpStatus) {
    const status = Number(error.httpStatus);
    const credentialRequired = status === 401 ||
      (status === 403 && ["youtube", "product_hunt"].includes(target.platform));
    return {
      outcome: credentialRequired ? "manual_review" : "access_blocked",
      blocker: exactBlocker(error, target),
      credentialRequired,
      requiredCredential: credentialRequired
        ? target.platform === "youtube" ? "YOUTUBE_API_KEY" : "PRODUCT_HUNT_TOKEN"
        : null,
      nextAction: credentialRequired
        ? "Replace or provision the approved API credential; never use a personal signed-in browser session."
        : "Retry from the checkpoint only after the recorded endpoint block is resolved.",
      coverageExtent: "provider_http_blocked",
      sourceExhausted: false
    };
  }
  const code = clean(error?.code) || error?.name || "Error";
  return {
    outcome: "access_blocked",
    blocker: `provider_error:${target.platform}:${code}:${cleanMessage(error?.message)}`,
    credentialRequired: false,
    nextAction: "Diagnose the exact recorded provider response, then resume from the durable checkpoint.",
    coverageExtent: "provider_request_or_payload_failed",
    sourceExhausted: false
  };
}

function httpError(target, response, requestUrl, body) {
  const status = Number(response.status);
  const retryAfter = clean(response.headers?.get?.("retry-after"));
  const bodyReason = providerBodyReason(body);
  const error = new Error(
    `${target.platform} HTTP ${status} from ${new URL(requestUrl).hostname}` +
    (bodyReason ? ` (${bodyReason})` : "")
  );
  error.name = "HistoricalDepthHttpError";
  error.httpStatus = status;
  error.provider = target.platform;
  error.hostname = new URL(requestUrl).hostname;
  error.retryAfter = retryAfter;
  error.bodyReason = bodyReason;
  return error;
}

function exactBlocker(error, target) {
  if (error?.httpStatus) {
    return [
      `http_${error.httpStatus}`,
      target.platform,
      error.hostname ?? "unknown_host",
      error.retryAfter ? `retry_after=${error.retryAfter}` : null,
      error.bodyReason ? `reason=${error.bodyReason}` : null
    ].filter(Boolean).join(":");
  }
  if (error instanceof CircuitOpenError) {
    return `circuit_open:${error.provider}:retry_at=${new Date(error.retryAt).toISOString()}`;
  }
  return `provider_error:${target.platform}:${clean(error?.code) || error?.name || "Error"}:${cleanMessage(error?.message)}`;
}

function providerBodyReason(body) {
  const text = String(body ?? "").slice(0, 50_000);
  for (const [pattern, reason] of [
    [/quotaExceeded/i, "quota_exceeded"],
    [/keyInvalid|API key not valid/i, "api_key_invalid"],
    [/invalid token|unauthorized/i, "credential_invalid"],
    [/rate.?limit|too many requests/i, "rate_limited"],
    [/captcha|challenge/i, "challenge_required"],
    [/access denied|forbidden|blocked/i, "access_denied"]
  ]) {
    if (pattern.test(text)) return reason;
  }
  return null;
}

function sourceLimit(platform, limits) {
  if (platform === "youtube") {
    return {
      publicMaxPages: limits.youtubePublicMaxPages,
      apiMaxPages: limits.youtubeApiMaxPages,
      apiPageSize: limits.youtubeApiPageSize,
      maxItems: limits.maxItemsPerTarget
    };
  }
  if (platform === "product_hunt") {
    return {
      maxPages: limits.productHuntMaxPages,
      pageSize: limits.productHuntPageSize,
      maxItems: limits.maxItemsPerTarget,
      postedAfter: "1970-01-01T00:00:00.000Z"
    };
  }
  return {
    maxPages: limits.redditMaxPages,
    pageSize: limits.redditPageSize,
    endpointWindowMaxItems: 1_000,
    maxItems: limits.maxItemsPerTarget
  };
}

class HistoricalDepthCheckpointStore {
  static async open(outputDir, options) {
    const store = new HistoricalDepthCheckpointStore(outputDir, options);
    await store.initialize();
    return store;
  }

  constructor(outputDir, { config, configFingerprint, resume, now, maxLineBytes }) {
    this.outputDir = outputDir;
    this.journalPath = join(outputDir, "pages.ndjson");
    this.checkpointPath = join(outputDir, "checkpoint-current.json");
    this.summaryPath = join(outputDir, "summary.json");
    this.config = config;
    this.configFingerprint = configFingerprint;
    this.resume = resume;
    this.now = now;
    this.maxLineBytes = maxLineBytes;
    this.writeTail = Promise.resolve();
    this.state = null;
  }

  async initialize() {
    await mkdir(this.outputDir, { recursive: true });
    const journalExists = await exists(this.journalPath);
    const checkpointExists = await exists(this.checkpointPath);
    if ((journalExists || checkpointExists) && !this.resume) {
      throw new Error("Historical-depth output already exists; pass resume=true to continue it safely.");
    }
    if (this.resume && journalExists !== checkpointExists) {
      throw new Error("Historical-depth resume requires both pages.ndjson and checkpoint-current.json.");
    }
    const startedAt = this.now().toISOString();
    this.state = checkpointExists
      ? JSON.parse(await readFile(this.checkpointPath, "utf8"))
      : {
          schemaVersion: HISTORICAL_DEPTH_SCHEMA_VERSION,
          runnerVersion: HISTORICAL_DEPTH_RUNNER_VERSION,
          status: "running",
          config: this.config,
          configFingerprint: this.configFingerprint,
          startedAt,
          updatedAt: startedAt,
          lastSequence: 0,
          progress: {},
          completed: {},
          summary: null
        };
    if (this.state.configFingerprint !== this.configFingerprint) {
      throw new Error("Historical-depth resume configuration does not match the original fingerprint.");
    }
    if (journalExists) {
      const repaired = await repairTruncatedTail(this.journalPath, this.maxLineBytes);
      if (repaired) this.state.recoveredTruncatedJournalTail = true;
      await this.replayJournal();
    } else {
      const event = await this.appendEvent({
        type: "run_initialized",
        config: this.config,
        configFingerprint: this.configFingerprint,
        startedAt
      });
      this.applyEvent(event);
    }
    await this.writeCheckpoint();
  }

  isCompleted(targetKey) {
    return Boolean(this.state.completed[targetKey]);
  }

  progressFor(targetKey) {
    const progress = this.state.progress[targetKey];
    return progress ? structuredClone(progress) : null;
  }

  async commitPage(target, receipt, evidence, progress) {
    return this.enqueue(async () => {
      const event = await this.appendEvent({
        type: "page_checkpoint",
        targetKey: target.targetKey,
        receipt,
        evidence,
        progress
      });
      this.applyEvent(event);
      await this.writeCheckpoint();
    });
  }

  async completeTarget(target, receipt) {
    return this.enqueue(async () => {
      const event = await this.appendEvent({
        type: "target_completed",
        targetKey: target.targetKey,
        receipt
      });
      this.applyEvent(event);
      await this.writeCheckpoint();
    });
  }

  async finish(summary) {
    return this.enqueue(async () => {
      if (this.state.status === "completed") return;
      const event = await this.appendEvent({ type: "run_completed", summary });
      this.applyEvent(event);
      await atomicJsonWrite(this.summaryPath, summary);
      await this.writeCheckpoint();
    });
  }

  enqueue(operation) {
    const pending = this.writeTail.then(operation, operation);
    this.writeTail = pending.catch(() => {});
    return pending;
  }

  async appendEvent(payload) {
    const event = {
      schemaVersion: HISTORICAL_DEPTH_SCHEMA_VERSION,
      sequence: this.state.lastSequence + 1,
      recordedAt: this.now().toISOString(),
      ...payload
    };
    const line = `${JSON.stringify(event)}\n`;
    if (Buffer.byteLength(line) > this.maxLineBytes) {
      throw new Error(`Historical-depth event exceeds maxLineBytes=${this.maxLineBytes}.`);
    }
    await appendFile(this.journalPath, line, "utf8");
    return event;
  }

  applyEvent(event) {
    if (!Number.isInteger(event.sequence) || event.sequence <= this.state.lastSequence) return;
    if (event.type === "run_initialized") {
      if (event.configFingerprint !== this.configFingerprint) {
        throw new Error("Historical-depth journal fingerprint mismatch.");
      }
      this.state.startedAt = event.startedAt ?? this.state.startedAt;
    } else if (event.type === "page_checkpoint") {
      this.state.progress[event.targetKey] = event.progress;
    } else if (event.type === "target_completed") {
      delete this.state.progress[event.targetKey];
      this.state.completed[event.targetKey] = event.receipt;
    } else if (event.type === "run_completed") {
      this.state.status = "completed";
      this.state.summary = event.summary;
    } else {
      throw new Error(`Unknown historical-depth event type ${event.type}.`);
    }
    this.state.lastSequence = event.sequence;
    this.state.updatedAt = event.recordedAt;
  }

  async replayJournal() {
    const input = createReadStream(this.journalPath, { encoding: "utf8" });
    const lines = createInterface({ input, crlfDelay: Infinity });
    let lineNumber = 0;
    for await (const line of lines) {
      lineNumber += 1;
      if (!line) continue;
      if (Buffer.byteLength(line) > this.maxLineBytes) {
        throw new Error(`Historical-depth journal line ${lineNumber} exceeds maxLineBytes.`);
      }
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        throw new Error(`Historical-depth journal line ${lineNumber} is invalid JSON.`);
      }
      this.applyEvent(event);
    }
  }

  async writeCheckpoint() {
    await atomicJsonWrite(this.checkpointPath, this.state);
  }
}

function buildSummary(plan, state, limits, credentials, completedAt) {
  const receipts = Object.values(state.completed);
  const totals = emptyTotals();
  const byPlatform = {};
  const byBatch = {};
  for (const receipt of receipts) {
    addTotals(totals, receipt);
    byPlatform[receipt.platform] ??= emptyTotals();
    byBatch[receipt.batchSlug] ??= emptyTotals();
    addTotals(byPlatform[receipt.platform], receipt);
    addTotals(byBatch[receipt.batchSlug], receipt);
  }
  return {
    schemaVersion: HISTORICAL_DEPTH_SCHEMA_VERSION,
    runnerVersion: HISTORICAL_DEPTH_RUNNER_VERSION,
    startedAt: state.startedAt,
    completedAt: completedAt.toISOString(),
    status: receipts.length === plan.targetAccountPairs ? "completed" : "incomplete",
    companiesEvaluated: plan.companiesEvaluated,
    foundersEvaluated: plan.foundersEvaluated,
    ownersEvaluated: plan.ownersEvaluated,
    ownerPlatformPairsEvaluated: plan.ownerPlatformPairsEvaluated,
    verifiedMappingsFound: plan.verifiedMappingsFound,
    verifiedAccountsMapped: plan.verifiedAccountsMapped,
    invalidVerifiedMappings: plan.invalidVerifiedMappings,
    unmappedOwnerPlatformPairs: plan.unmappedOwnerPlatformPairs,
    targetAccountPairs: plan.targetAccountPairs,
    completedTargetAccountPairs: receipts.length,
    platforms: plan.platforms,
    batches: plan.batches,
    credentials,
    totals,
    byPlatform,
    byBatch,
    limits: publicLimits(limits),
    artifacts: {
      pageCheckpointJournal: "pages.ndjson",
      currentCheckpoint: "checkpoint-current.json",
      summary: "summary.json"
    }
  };
}

function emptyTotals() {
  return {
    targets: 0,
    collected: 0,
    verifiedNoHistory: 0,
    accessBlocked: 0,
    manualReview: 0,
    credentialRequired: 0,
    truncated: 0,
    sourceExhausted: 0,
    partialEvidenceTargets: 0,
    requests: 0,
    pagesAttempted: 0,
    pagesFetched: 0,
    itemsSeen: 0,
    accepted: 0,
    rejected: 0,
    duplicates: 0,
    earliest: null,
    latest: null
  };
}

function addTotals(total, receipt) {
  total.targets += 1;
  if (receipt.outcome === "collected") total.collected += 1;
  else if (receipt.outcome === "verified_no_history") total.verifiedNoHistory += 1;
  else if (receipt.outcome === "access_blocked") total.accessBlocked += 1;
  else if (receipt.outcome === "manual_review") total.manualReview += 1;
  if (receipt.credentialRequired) total.credentialRequired += 1;
  if (receipt.truncated) total.truncated += 1;
  if (receipt.sourceExhausted) total.sourceExhausted += 1;
  if (receipt.accepted > 0 && receipt.outcome !== "collected") total.partialEvidenceTargets += 1;
  for (const field of [
    "requests",
    "pagesAttempted",
    "pagesFetched",
    "itemsSeen",
    "accepted",
    "rejected",
    "duplicates"
  ]) total[field] += Number(receipt[field] ?? 0);
  total.earliest = earlier(total.earliest, receipt.earliest);
  total.latest = later(total.latest, receipt.latest);
}

function normalizeLimits(overrides = {}) {
  const limits = { ...HISTORICAL_DEPTH_LIMITS, ...(overrides ?? {}) };
  for (const [key, fallback] of Object.entries(HISTORICAL_DEPTH_LIMITS)) {
    const value = Number(limits[key]);
    if (!Number.isFinite(value) || value < 0 || (key !== "hostPaceMs" && key !== "redditPaceMs" && value === 0)) {
      throw new Error(`Historical-depth limit ${key} must be a valid bounded number.`);
    }
    limits[key] = Math.floor(value);
    if (fallback > 0 && limits[key] === 0 && !["hostPaceMs", "redditPaceMs"].includes(key)) {
      throw new Error(`Historical-depth limit ${key} must be positive.`);
    }
  }
  if (limits.globalConcurrency > 4) {
    throw new Error("Historical-depth globalConcurrency cannot exceed the safe maximum of 4.");
  }
  if (limits.hostConcurrency !== 1) {
    throw new Error("Historical-depth hostConcurrency is fixed at 1.");
  }
  if (limits.youtubeApiPageSize > 50) {
    throw new Error("youtubeApiPageSize cannot exceed the official API maximum of 50.");
  }
  if (limits.productHuntPageSize > 100) {
    throw new Error("productHuntPageSize cannot exceed the bounded maximum of 100.");
  }
  if (limits.redditPageSize > 100) {
    throw new Error("redditPageSize cannot exceed the official listing maximum of 100.");
  }
  if (limits.redditMaxPages * limits.redditPageSize > 1_000) {
    throw new Error("Reddit listing plans cannot claim beyond the 1,000-item endpoint window.");
  }
  return limits;
}

function publicLimits(limits) {
  return Object.fromEntries(Object.keys(HISTORICAL_DEPTH_LIMITS).map((key) => [key, limits[key]]));
}

function normalizeCredentials(credentials = {}) {
  return {
    youtubeApiKey: clean(credentials?.youtubeApiKey) ?? null,
    productHuntToken: clean(credentials?.productHuntToken) ?? null,
    redditAccessToken: clean(credentials?.redditAccessToken) ?? null
  };
}

function credentialModes(credentials = {}) {
  return {
    youtubeApiKey: Boolean(clean(credentials?.youtubeApiKey)),
    productHuntToken: Boolean(clean(credentials?.productHuntToken)),
    redditAccessToken: Boolean(clean(credentials?.redditAccessToken))
  };
}

function worstCaseLogicalRequests(platform, limits, credentials) {
  if (platform === "youtube") {
    return credentials.youtubeApiKey
      ? 1 + 1 + 1 + limits.youtubeApiMaxPages
      : limits.youtubePublicMaxPages + 1;
  }
  if (platform === "product_hunt") {
    return credentials.productHuntToken ? limits.productHuntMaxPages : 0;
  }
  return limits.redditMaxPages;
}

async function repairTruncatedTail(path, maxLineBytes) {
  const details = await stat(path);
  if (details.size === 0) return false;
  const handle = await open(path, "r+");
  try {
    const tailBytes = Math.min(details.size, maxLineBytes + 1);
    const buffer = Buffer.alloc(tailBytes);
    await handle.read(buffer, 0, tailBytes, details.size - tailBytes);
    if (buffer[buffer.length - 1] === 0x0a) return false;
    const lastNewline = buffer.lastIndexOf(0x0a);
    if (lastNewline < 0) {
      throw new Error("Historical-depth journal tail exceeds maxLineBytes or lacks a durable newline.");
    }
    const truncateAt = details.size - tailBytes + lastNewline + 1;
    await handle.truncate(truncateAt);
    return true;
  } finally {
    await handle.close();
  }
}

async function atomicJsonWrite(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function runWorkerPool(items, concurrency, worker) {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  });
  await Promise.all(workers);
}

function redactedUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:key|access_token|token)$/i.test(key)) url.searchParams.set(key, "REDACTED");
    }
    return url.toString();
  } catch {
    return String(rawUrl ?? "");
  }
}

function publicUserAgent() {
  return "ReturnerFundHistoricalDepth/1.0 (+public-evidence-audit; no-signed-in-session)";
}

function cleanMessage(value) {
  return String(value ?? "unknown_error")
    .replace(/([?&](?:key|access_token|token)=)[^&\s]+/gi, "$1REDACTED")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, "$1REDACTED")
    .replace(/(bearer\s+)[A-Za-z0-9._~-]{8,}/gi, "$1REDACTED")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function clean(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function earlier(left, right) {
  if (!left) return right ?? null;
  if (!right) return left;
  return left < right ? left : right;
}

function later(left, right) {
  if (!left) return right ?? null;
  if (!right) return left;
  return left > right ? left : right;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Historical-depth backfill aborted", "AbortError");
}

function isAbort(error) {
  return error?.name === "AbortError";
}
