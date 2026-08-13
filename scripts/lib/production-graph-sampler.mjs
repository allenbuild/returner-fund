import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

export const PRODUCTION_GRAPH_SAMPLE_CAPTURE_VERSION =
  "production-graph-sample-capture.v1";
export const PRODUCTION_GRAPH_SAMPLE_TOOL_VERSION =
  "production-graph-sampler.v1";
export const INGESTION_PRODUCTION_RELEASE_PROOF_VERSION =
  "ingestion-production-release-proof.v1";

export const PRODUCTION_GRAPH_BATCHES = Object.freeze([
  "S2026",
  "S26",
  "A16ZSR006"
]);

export const PRODUCTION_GRAPH_CORE_PLATFORMS = Object.freeze([
  "github",
  "x",
  "instagram",
  "linkedin",
  "youtube",
  "product_hunt",
  "reddit",
  "hacker_news",
  "rss",
  "web"
]);

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_RESPONSE_BYTES = 24 * 1024 * 1024;
const DEFAULT_MAX_COVERAGE_BYTES = 256 * 1024 * 1024;
const MAX_PAIR_BYTES = 4 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CANONICAL_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PLATFORM_STATUS_VALUES = new Set([
  "working",
  "public_only",
  "needs_config",
  "disabled",
  "risky"
]);
const SAFE_RESPONSE_HEADERS = Object.freeze([
  "age",
  "cache-control",
  "cf-ray",
  "content-length",
  "content-type",
  "date",
  "etag",
  "server",
  "server-timing",
  "via",
  "x-request-id",
  "x-vercel-cache",
  "x-vercel-id"
]);

/**
 * Read only the coverage pair array from a large materialization. This scanner
 * skips the evidence registry without retaining it, bounds both the file and
 * each parsed pair, and supports either { coverageReceipt: { pairs: [...] } }
 * or a standalone { pairs: [...] } receipt.
 */
export async function readCoveragePairsFromFile(
  path,
  { maxBytes = DEFAULT_MAX_COVERAGE_BYTES } = {}
) {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`Coverage input is not a regular file: ${path}`);
  if (metadata.size > positiveInteger(maxBytes, "maxBytes")) {
    throw new Error(
      `Coverage input exceeds the ${maxBytes}-byte safety limit: ${metadata.size} bytes.`
    );
  }

  const pairs = [];
  let bytesRead = 0;
  let objectDepth = 0;
  let arrayDepth = 0;
  let inString = false;
  let escaped = false;
  let tokenBytes = null;
  let tokenEscaped = false;
  let lastString = null;
  let pendingKey = null;
  let coverageObjectDepth = null;
  let targetArrayDepth = null;
  let pairActive = false;
  let pairBraceDepth = 0;
  let pairSegments = [];
  let pairBytes = 0;
  let finished = false;

  const stream = createReadStream(path, { highWaterMark: 256 * 1024 });
  for await (const chunk of stream) {
    bytesRead += chunk.length;
    if (bytesRead > maxBytes) throw new Error("Coverage input exceeded its streaming byte limit.");
    let captureStart = pairActive ? 0 : null;

    for (let index = 0; index < chunk.length; index += 1) {
      const byte = chunk[index];

      if (inString) {
        if (tokenBytes && tokenBytes.length <= 64) tokenBytes.push(byte);
        if (escaped) {
          escaped = false;
          tokenEscaped = true;
          continue;
        }
        if (byte === 0x5c) {
          escaped = true;
          continue;
        }
        if (byte === 0x22) {
          inString = false;
          if (tokenBytes && !tokenEscaped && tokenBytes.length <= 65) {
            lastString = Buffer.from(tokenBytes.slice(0, -1)).toString("utf8");
          } else {
            lastString = null;
          }
          tokenBytes = null;
        }
        continue;
      }

      if (byte === 0x22) {
        inString = true;
        escaped = false;
        tokenEscaped = false;
        tokenBytes = !pairActive && arrayDepth === 0 && objectDepth <= 2 ? [] : null;
        continue;
      }

      if (pairActive) {
        if (byte === 0x7b) pairBraceDepth += 1;
        if (byte === 0x7d) {
          pairBraceDepth -= 1;
          if (pairBraceDepth === 0) {
            pairSegments.push(chunk.subarray(captureStart, index + 1));
            pairBytes += index + 1 - captureStart;
            if (pairBytes > MAX_PAIR_BYTES) {
              throw new Error(`Coverage pair exceeds the ${MAX_PAIR_BYTES}-byte safety limit.`);
            }
            const pair = parsePairBytes(pairSegments, pairs.length);
            const projected = projectCoveragePair(pair);
            if (PRODUCTION_GRAPH_BATCHES.includes(projected.batchSlug) &&
                PRODUCTION_GRAPH_CORE_PLATFORMS.includes(projected.platform)) {
              pairs.push(projected);
            }
            pairActive = false;
            pairSegments = [];
            pairBytes = 0;
            captureStart = null;
          }
        }
        continue;
      }

      if (isWhitespace(byte)) continue;

      if (byte === 0x3a && lastString !== null) {
        pendingKey = lastString;
        lastString = null;
        continue;
      }

      if (targetArrayDepth !== null && arrayDepth === targetArrayDepth && byte === 0x7b) {
        pairActive = true;
        pairBraceDepth = 1;
        pairSegments = [];
        pairBytes = 0;
        captureStart = index;
        objectDepth += 1;
        continue;
      }

      if (byte === 0x7b) {
        objectDepth += 1;
        if (pendingKey === "coverageReceipt" && objectDepth === 2 && arrayDepth === 0) {
          coverageObjectDepth = objectDepth;
        }
        pendingKey = null;
        lastString = null;
        continue;
      }

      if (byte === 0x7d) {
        if (coverageObjectDepth === objectDepth) coverageObjectDepth = null;
        objectDepth -= 1;
        pendingKey = null;
        lastString = null;
        continue;
      }

      if (byte === 0x5b) {
        const isReceiptPairs = pendingKey === "pairs" &&
          ((coverageObjectDepth !== null && objectDepth === coverageObjectDepth) ||
           (coverageObjectDepth === null && objectDepth === 1));
        arrayDepth += 1;
        if (isReceiptPairs) targetArrayDepth = arrayDepth;
        pendingKey = null;
        lastString = null;
        continue;
      }

      if (byte === 0x5d) {
        if (targetArrayDepth === arrayDepth) {
          finished = true;
          break;
        }
        arrayDepth -= 1;
        pendingKey = null;
        lastString = null;
        continue;
      }

      // Commas and scalar values end a pending key/value transition.
      if (byte !== 0x2c) pendingKey = null;
      lastString = null;
    }

    if (finished) break;
    if (pairActive && captureStart !== null) {
      pairSegments.push(chunk.subarray(captureStart));
      pairBytes += chunk.length - captureStart;
      if (pairBytes > MAX_PAIR_BYTES) {
        throw new Error(`Coverage pair exceeds the ${MAX_PAIR_BYTES}-byte safety limit.`);
      }
    }
  }

  if (!finished) throw new Error("Coverage input does not contain a complete receipt pairs array.");
  if (pairs.length === 0) {
    throw new Error("Coverage receipt contains no canonical production batch/core-platform pairs.");
  }
  return validateCoveragePairs(pairs);
}

/**
 * Fetch each canonical batch exactly once and evaluate all ten platform cells
 * from those three responses. The fetches are concurrent but never exceed the
 * fixed three-batch denominator. No cookies, authorization, or browser state
 * are accepted or sent.
 */
export async function captureProductionGraphSamples({
  coveragePairs,
  baseUrl,
  artifactDigest = null,
  revision = null,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function.");
  const endpoint = normalizeBaseUrl(baseUrl);
  const checkedTimeout = boundedInteger(timeoutMs, "timeoutMs", 50, 60_000);
  const checkedMaxBytes = boundedInteger(
    maxResponseBytes,
    "maxResponseBytes",
    1_024,
    64 * 1024 * 1024
  );
  const normalizedPairs = validateCoveragePairs(coveragePairs);
  const coverageIndex = indexCoveragePairs(normalizedPairs);
  const coveragePairKeysSha256 = sha256(normalizedPairs.map((pair) => pair.pairKey)
    .sort()
    .join("\n"));

  const bindingBlockers = [];
  const digest = clean(artifactDigest);
  const normalizedRevision = clean(revision);
  if (!SHA256_PATTERN.test(digest)) {
    bindingBlockers.push(blocker(
      "release_binding",
      "missing_or_invalid_artifact_digest",
      "A production artifact SHA-256 digest was not supplied to bind the sample receipt.",
      "Supply the exact digest from the rebuilt productionArtifact receipt."
    ));
  }
  if (!normalizedRevision) {
    bindingBlockers.push(blocker(
      "release_binding",
      "missing_revision",
      "A production revision was not supplied to bind the sample receipt.",
      "Supply the exact deployed revision from the productionArtifact receipt."
    ));
  }

  const batchResults = await Promise.all(PRODUCTION_GRAPH_BATCHES.map((batchSlug) =>
    fetchAndSampleBatch({
      batchSlug,
      endpoint,
      pairsByPlatform: coverageIndex.get(batchSlug),
      fetchImpl,
      now,
      timeoutMs: checkedTimeout,
      maxResponseBytes: checkedMaxBytes
    })
  ));

  const cells = batchResults.flatMap((result) => result.cells);
  const requests = batchResults.map((result) => result.request);
  const cellBlockers = cells.flatMap((cell) => cell.blockers);
  const blockers = [...bindingBlockers, ...cellBlockers].sort(compareBlockers);
  const verifiedCells = cells.filter((cell) => cell.verified);
  const finalCheckedAt = canonicalNow(now);
  const allCellsVerified = verifiedCells.length ===
    PRODUCTION_GRAPH_BATCHES.length * PRODUCTION_GRAPH_CORE_PLATFORMS.length;

  let productionSample = null;
  if (allCellsVerified && bindingBlockers.length === 0) {
    const samples = verifiedCells.map((cell) => proofSample(cell)).sort(
      (left, right) => left.sampleId.localeCompare(right.sampleId)
    );
    productionSample = {
      schemaVersion: INGESTION_PRODUCTION_RELEASE_PROOF_VERSION,
      kind: "productionSample",
      receiptId: `production-sample-${sha256(stableJson({
        digest,
        revision: normalizedRevision,
        samples
      })).slice(0, 32)}`,
      status: "verified",
      checkedAt: finalCheckedAt,
      artifactDigest: digest,
      revision: normalizedRevision,
      toolVersion: PRODUCTION_GRAPH_SAMPLE_TOOL_VERSION,
      reason: `Three bounded read-only production /api/graph responses verified all ${samples.length} canonical batch-platform sample cells for revision ${normalizedRevision}.`,
      samples
    };
  }

  const finalUrlOrigins = [...new Set(requests.map((request) => request.finalUrl)
    .filter(Boolean)
    .map((value) => new URL(value).origin))].sort();
  const deploymentIds = [...new Set(requests.map((request) =>
    request.responseHeaders?.["x-vercel-id"] ?? null
  ).filter(Boolean))].sort();

  return {
    schemaVersion: PRODUCTION_GRAPH_SAMPLE_CAPTURE_VERSION,
    status: productionSample ? "verified" : "blocked",
    checkedAt: finalCheckedAt,
    toolVersion: PRODUCTION_GRAPH_SAMPLE_TOOL_VERSION,
    source: {
      endpoint: endpoint.toString(),
      authentication: "none",
      requestCount: requests.length,
      concurrencyLimit: PRODUCTION_GRAPH_BATCHES.length,
      timeoutMs: checkedTimeout,
      maxResponseBytes: checkedMaxBytes
    },
    coverageSource: {
      corePairCount: normalizedPairs.length,
      pairKeysSha256: coveragePairKeysSha256,
      byBatch: Object.fromEntries(PRODUCTION_GRAPH_BATCHES.map((batchSlug) => [
        batchSlug,
        normalizedPairs.filter((pair) => pair.batchSlug === batchSlug).length
      ]))
    },
    deploymentBinding: {
      artifactDigest: digest || null,
      revision: normalizedRevision || null,
      bindingSource: "explicit_sampler_input",
      responseOrigins: finalUrlOrigins,
      deploymentRequestIds: deploymentIds
    },
    denominator: {
      batches: PRODUCTION_GRAPH_BATCHES.length,
      corePlatforms: PRODUCTION_GRAPH_CORE_PLATFORMS.length,
      batchPlatformCells: PRODUCTION_GRAPH_BATCHES.length *
        PRODUCTION_GRAPH_CORE_PLATFORMS.length
    },
    summary: {
      verifiedCells: verifiedCells.length,
      blockedCells: cells.length - verifiedCells.length,
      blockers: blockers.length,
      proofEmitted: productionSample !== null
    },
    requests,
    cells,
    blockers,
    productionSample
  };
}

async function fetchAndSampleBatch({
  batchSlug,
  endpoint,
  pairsByPlatform,
  fetchImpl,
  now,
  timeoutMs,
  maxResponseBytes
}) {
  const requestUrl = new URL("/api/graph", endpoint);
  requestUrl.searchParams.set("batch", batchSlug);
  requestUrl.searchParams.set("topVoices", "off");
  const startedAt = canonicalNow(now);
  const startedMs = Date.now();
  const controller = new AbortController();
  let timeout;
  const timeoutFailure = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      const error = new Error(`production graph request timed out after ${timeoutMs}ms`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  let response;
  try {
    response = await Promise.race([
      fetchImpl(requestUrl, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "user-agent": "returner-production-graph-sampler/1.0"
        }
      }),
      timeoutFailure
    ]);
  } catch (error) {
    clearTimeout(timeout);
    const checkedAt = canonicalNow(now);
    const request = {
      batchSlug,
      requestedUrl: requestUrl.toString(),
      startedAt,
      checkedAt,
      durationMs: Math.max(0, Date.now() - startedMs),
      status: null,
      ok: false,
      redirected: false,
      finalUrl: null,
      responseBytes: 0,
      responseSha256: null,
      responseHeaders: {},
      graph: null,
      error: errorMessage(error)
    };
    return {
      request,
      cells: blockedBatchCells(batchSlug, pairsByPlatform, checkedAt, blocker(
        `${batchSlug}:request`,
        "request_failed",
        `Production graph request failed: ${errorMessage(error)}`,
        `Restore read-only production access for ${requestUrl} and rerun the three-batch sampler.`
      ))
    };
  }

  const responseHeaders = safeHeaders(response.headers);
  const checkedAt = canonicalNow(now);
  const rawFinalUrl = clean(response.url);
  const finalUrl = rawFinalUrl || requestUrl.toString();
  const request = {
    batchSlug,
    requestedUrl: requestUrl.toString(),
    startedAt,
    checkedAt,
    durationMs: Math.max(0, Date.now() - startedMs),
    status: Number.isInteger(response.status) ? response.status : null,
    ok: response.ok === true,
    redirected: response.redirected === true,
    finalUrl,
    responseBytes: 0,
    responseSha256: null,
    responseHeaders,
    graph: null,
    error: null
  };

  const commonBlockers = [];
  if (!response.ok || response.status !== 200) {
    commonBlockers.push(blocker(
      `${batchSlug}:request`,
      "http_status",
      `Production graph returned HTTP ${response.status ?? "unknown"} for ${batchSlug}.`,
      "Restore an HTTP 200 JSON production graph response and rerun the sampler."
    ));
  }
  if ((response.redirected === true && !rawFinalUrl) || !sameGraphEndpoint(requestUrl, finalUrl)) {
    commonBlockers.push(blocker(
      `${batchSlug}:request`,
      "unexpected_redirect",
      `Production graph resolved to unexpected URL ${finalUrl}.`,
      `Serve ${requestUrl} without a cross-origin or cross-path redirect.`
    ));
  }
  const contentType = responseHeaders["content-type"] ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    commonBlockers.push(blocker(
      `${batchSlug}:request`,
      "invalid_content_type",
      `Production graph content-type was ${contentType || "missing"}.`,
      "Return application/json from the production graph endpoint."
    ));
  }
  if (commonBlockers.length > 0) {
    clearTimeout(timeout);
    return {
      request,
      cells: blockedBatchCells(batchSlug, pairsByPlatform, checkedAt, commonBlockers)
    };
  }

  let parsed;
  try {
    parsed = await Promise.race([
      readBoundedJsonResponse(response, maxResponseBytes),
      timeoutFailure
    ]);
    clearTimeout(timeout);
    request.responseBytes = parsed.bytes;
    request.responseSha256 = parsed.sha256;
  } catch (error) {
    clearTimeout(timeout);
    request.error = errorMessage(error);
    return {
      request,
      cells: blockedBatchCells(batchSlug, pairsByPlatform, checkedAt, blocker(
        `${batchSlug}:request`,
        "invalid_or_oversized_json",
        `Production graph body could not be verified: ${errorMessage(error)}`,
        `Return valid JSON no larger than ${maxResponseBytes} bytes for ${batchSlug}.`
      ))
    };
  }

  const graphValidation = validateGraphEnvelope(parsed.value, batchSlug);
  request.graph = graphValidation.metadata;
  if (graphValidation.blockers.length > 0) {
    return {
      request,
      cells: blockedBatchCells(batchSlug, pairsByPlatform, checkedAt, graphValidation.blockers)
    };
  }

  const graphIndex = buildGraphIndex(parsed.value, batchSlug);
  return {
    request,
    cells: PRODUCTION_GRAPH_CORE_PLATFORMS.map((platform) => selectCellSample({
      batchSlug,
      platform,
      checkedAt,
      coveragePairs: pairsByPlatform?.get(platform) ?? [],
      graphIndex,
      graphMetadata: graphValidation.metadata,
      request
    }))
  };
}

function selectCellSample({
  batchSlug,
  platform,
  checkedAt,
  coveragePairs,
  graphIndex,
  graphMetadata,
  request
}) {
  if (coveragePairs.length === 0) {
    return blockedCell(batchSlug, platform, checkedAt, null, blocker(
      `${batchSlug}:${platform}`,
      "missing_coverage_pair",
      `No exact canonical coverage pair exists for ${batchSlug}:${platform}.`,
      "Rebuild the coverage receipt with the complete canonical pair matrix."
    ));
  }

  const evaluations = coveragePairs.map((pair) => evaluatePair(pair, graphIndex, batchSlug, platform));
  evaluations.sort((left, right) =>
    Number(right.verified) - Number(left.verified) ||
    right.rank - left.rank ||
    left.pair.pairKey.localeCompare(right.pair.pairKey)
  );
  const selected = evaluations[0];
  if (!selected.verified) {
    return blockedCell(
      batchSlug,
      platform,
      checkedAt,
      selected.pair.pairKey,
      selected.blockers,
      selected.observation,
      selected.pair.expectation
    );
  }

  const sampleId = `production-${sha256(
    `${batchSlug}\u0000${platform}\u0000${selected.pair.pairKey}\u0000${request.responseSha256}`
  ).slice(0, 32)}`;
  const signalSummary = signalReason(selected.observation);
  return {
    sampleId,
    batchSlug,
    platform,
    pairKey: selected.pair.pairKey,
    verified: true,
    checkedAt,
    reason: `Production rendered exact pair ${selected.pair.pairKey}; ${signalSummary}.`,
    coverageExpectation: selected.pair.expectation,
    observation: selected.observation,
    graph: graphMetadata,
    request: {
      requestedUrl: request.requestedUrl,
      finalUrl: request.finalUrl,
      httpStatus: request.status,
      responseSha256: request.responseSha256,
      deploymentRequestId: request.responseHeaders?.["x-vercel-id"] ?? null
    },
    blockers: []
  };
}

function evaluatePair(pair, graphIndex, batchSlug, platform) {
  const key = `${pair.entity.type}\u0000${pair.entity.id}`;
  const entity = graphIndex.entities.get(key) ?? null;
  const evidence = graphIndex.evidence.get(`${key}\u0000${platform}`) ?? [];
  const needsReview = graphIndex.needsReview.get(`${key}\u0000${platform}`) ?? [];
  const accounts = (entity?.accounts ?? []).filter((account) => account.platform === platform);
  const expectedMatches = matchExpectedAccounts(pair.expectation.accounts, accounts, platform);
  const statuses = graphIndex.platformStatuses.get(platform) ?? [];
  const validStatuses = statuses.filter((status) =>
    !Array.isArray(status.batchSlugs) || status.batchSlugs.includes(batchSlug)
  );
  const observation = {
    entityPresent: entity !== null,
    entityType: pair.entity.type,
    entityId: pair.entity.id,
    evidenceCount: evidence.length,
    evidenceIds: evidence.slice(0, 10).map((row) => clean(row.id)).filter(Boolean),
    accountCount: accounts.length,
    accounts: accounts.slice(0, 10).map((account) => ({
      id: clean(account.id) || null,
      handle: clean(account.handle) || null,
      url: clean(account.url) || null,
      reviewState: clean(account.review_state) || null
    })),
    expectedAccountMatchCount: expectedMatches.length,
    expectedAccountMatches: expectedMatches,
    needsReviewCount: needsReview.length,
    needsReviewIds: needsReview.slice(0, 10).map((row) => clean(row.id)).filter(Boolean),
    platformStatuses: validStatuses.map((status) => ({
      status: status.status,
      authMethod: clean(status.authMethod) || null,
      notes: clean(status.notes) || null,
      batchSlugs: Array.isArray(status.batchSlugs) ? [...status.batchSlugs] : null
    }))
  };
  const blockers = [];
  if (!entity) {
    blockers.push(blocker(
      pair.pairKey,
      "entity_missing",
      `Production batch ${batchSlug} does not contain exact ${pair.entity.type} ${pair.entity.id}.`,
      "Deploy a graph containing the exact canonical entity, then rerun the sampler."
    ));
  }
  if (statuses.length > 1) {
    blockers.push(blocker(
      pair.pairKey,
      "duplicate_platform_status",
      `Production batch ${batchSlug} repeats ${platform} platform status ${statuses.length} times.`,
      "Publish exactly one unambiguous platform status row per platform."
    ));
  }
  if (statuses.length > 0 && validStatuses.length === 0) {
    blockers.push(blocker(
      pair.pairKey,
      "platform_status_batch_mismatch",
      `Production ${platform} status excludes batch ${batchSlug}.`,
      `Publish a ${platform} status applicable to ${batchSlug}.`
    ));
  }
  if (validStatuses.some((status) => !PLATFORM_STATUS_VALUES.has(status.status))) {
    blockers.push(blocker(
      pair.pairKey,
      "invalid_platform_status",
      `Production ${platform} status uses an unsupported status value.`,
      "Publish a canonical platform status value before sampling."
    ));
  }
  const signalCount = evidence.length + accounts.length + needsReview.length + validStatuses.length;
  if (signalCount === 0) {
    blockers.push(blocker(
      pair.pairKey,
      "platform_signal_missing",
      `Production rendered ${pair.entity.id} but no ${platform} evidence, account, review, or status signal.`,
      `Publish an explicit ${platform} evidence/account/review/status state and rerun the sampler.`
    ));
  }
  const rank = evidence.length * 1_000 + expectedMatches.length * 500 +
    accounts.length * 100 + needsReview.length * 10 + validStatuses.length;
  return { pair, observation, blockers, verified: blockers.length === 0, rank };
}

function buildGraphIndex(graph, batchSlug) {
  const entities = new Map();
  const evidence = new Map();
  const needsReview = new Map();
  const platformStatuses = new Map();

  for (const node of graph.nodes) {
    if (!node || typeof node !== "object") continue;
    const entityId = clean(node.entityId);
    if (entityId && clean(node.batchSlug) === batchSlug) {
      entities.set(`company\u0000${entityId}`, {
        type: "company",
        id: entityId,
        accounts: Array.isArray(node.socialAccounts) ? node.socialAccounts : []
      });
    }
    for (const founder of Array.isArray(node.founders) ? node.founders : []) {
      const founderId = clean(founder?.id);
      if (!founderId) continue;
      entities.set(`founder\u0000${founderId}`, {
        type: "founder",
        id: founderId,
        accounts: Array.isArray(founder.socialAccounts) ? founder.socialAccounts : []
      });
    }
  }
  for (const row of graph.evidence) {
    if (!row || typeof row !== "object") continue;
    if (clean(row.batchSlug) && clean(row.batchSlug) !== batchSlug) continue;
    const entityType = clean(row.entityType);
    const entityId = clean(row.entityId);
    const platform = clean(row.platform);
    if (!entityType || !entityId || !platform) continue;
    addMapArray(evidence, `${entityType}\u0000${entityId}\u0000${platform}`, row);
  }
  for (const row of graph.needsReview) {
    if (!row || typeof row !== "object") continue;
    if (clean(row.batchSlug) && clean(row.batchSlug) !== batchSlug) continue;
    const entityType = clean(row.entityType);
    const entityId = clean(row.entityId);
    const platform = clean(row.platform);
    if (!entityType || !entityId || !platform) continue;
    addMapArray(needsReview, `${entityType}\u0000${entityId}\u0000${platform}`, row);
  }
  for (const row of graph.platformStatus) {
    if (!row || typeof row !== "object") continue;
    const platform = clean(row.platform);
    if (platform) addMapArray(platformStatuses, platform, row);
  }
  return { entities, evidence, needsReview, platformStatuses };
}

function validateGraphEnvelope(graph, batchSlug) {
  const blockers = [];
  if (!graph || typeof graph !== "object" || Array.isArray(graph)) {
    return {
      metadata: null,
      blockers: [blocker(
        `${batchSlug}:response`,
        "invalid_graph_shape",
        "Production graph response is not a JSON object.",
        "Deploy a canonical GraphResponse object and rerun the sampler."
      )]
    };
  }
  const responseBatch = clean(graph.batch?.slug);
  if (responseBatch !== batchSlug) {
    blockers.push(blocker(
      `${batchSlug}:response`,
      "batch_mismatch",
      `Production requested ${batchSlug} but returned batch ${responseBatch || "missing"}.`,
      `Return the exact requested ${batchSlug} graph.`
    ));
  }
  if (!Array.isArray(graph.batches) || !graph.batches.some((row) => clean(row?.slug) === batchSlug)) {
    blockers.push(blocker(
      `${batchSlug}:response`,
      "batch_inventory_missing",
      `Production graph batch inventory does not contain ${batchSlug}.`,
      "Publish the canonical batch inventory with the graph response."
    ));
  }
  for (const field of ["nodes", "evidence", "needsReview", "platformStatus"]) {
    if (!Array.isArray(graph[field])) {
      blockers.push(blocker(
        `${batchSlug}:response`,
        "invalid_graph_shape",
        `Production graph field ${field} is not an array.`,
        `Publish a canonical GraphResponse with an array ${field} field.`
      ));
    }
  }
  const mode = clean(graph.mode);
  if (!mode || mode === "demo" || !["official_snapshot", "database"].includes(mode)) {
    blockers.push(blocker(
      `${batchSlug}:response`,
      "non_production_graph_mode",
      `Production graph mode was ${mode || "missing"}.`,
      "Deploy an official_snapshot or database graph response, never demo data."
    ));
  }
  const generatedAt = clean(graph.generatedAt);
  if (!isCanonicalTimestamp(generatedAt)) {
    blockers.push(blocker(
      `${batchSlug}:response`,
      "invalid_graph_timestamp",
      `Production graph generatedAt was ${generatedAt || "missing"}.`,
      "Publish a canonical ISO UTC graph generation timestamp."
    ));
  }
  return {
    metadata: {
      batchSlug: responseBatch || null,
      mode: mode || null,
      generatedAt: generatedAt || null,
      evidenceAsOf: clean(graph.scoringContext?.evidenceAsOf) || null,
      modelId: clean(graph.scoringContext?.modelId) || null,
      modelVersion: clean(graph.scoringContext?.modelVersion) || null,
      nodeCount: Array.isArray(graph.nodes) ? graph.nodes.length : null,
      evidenceCount: Array.isArray(graph.evidence) ? graph.evidence.length : null,
      needsReviewCount: Array.isArray(graph.needsReview) ? graph.needsReview.length : null,
      platformStatusCount: Array.isArray(graph.platformStatus) ? graph.platformStatus.length : null
    },
    blockers
  };
}

async function readBoundedJsonResponse(response, maxBytes) {
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`declared content-length ${contentLength} exceeds ${maxBytes}`);
  }
  let bytes;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error("response stream returned non-byte data");
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("response byte limit exceeded");
        throw new Error(`decoded response exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
    bytes = Buffer.allocUnsafe(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  } else if (typeof response.arrayBuffer === "function") {
    const value = Buffer.from(await response.arrayBuffer());
    if (value.length > maxBytes) throw new Error(`response exceeds ${maxBytes} bytes`);
    bytes = value;
  } else {
    throw new Error("response body is not readable");
  }
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("response body is not valid JSON");
  }
  return { value, bytes: bytes.length, sha256: sha256(bytes) };
}

function validateCoveragePairs(value) {
  if (!Array.isArray(value)) throw new TypeError("coveragePairs must be an array.");
  const pairs = value.map(projectCoveragePair);
  const seen = new Set();
  for (const pair of pairs) {
    const expected = `${pair.batchSlug}:${pair.entity.type}:${pair.entity.id}:${pair.platform}`;
    if (pair.pairKey !== expected) {
      throw new Error(`Coverage pairKey ${pair.pairKey} does not match ${expected}.`);
    }
    if (!PRODUCTION_GRAPH_BATCHES.includes(pair.batchSlug)) {
      throw new Error(`Coverage pair uses unsupported production batch ${pair.batchSlug}.`);
    }
    if (!PRODUCTION_GRAPH_CORE_PLATFORMS.includes(pair.platform)) {
      throw new Error(`Coverage pair uses unsupported core platform ${pair.platform}.`);
    }
    if (seen.has(pair.pairKey)) throw new Error(`Duplicate coverage pairKey ${pair.pairKey}.`);
    seen.add(pair.pairKey);
  }
  return pairs;
}

function projectCoveragePair(pair) {
  if (!pair || typeof pair !== "object" || Array.isArray(pair)) {
    throw new TypeError("Coverage pair must be an object.");
  }
  const entityType = clean(pair.entity?.type ?? pair.entityType);
  const entityId = clean(pair.entity?.id ?? pair.entityId);
  if (!["company", "founder"].includes(entityType)) {
    throw new Error(`Coverage pair has invalid entity type ${entityType || "missing"}.`);
  }
  const sourceAccounts = Array.isArray(pair.mapping?.accounts)
    ? pair.mapping.accounts
    : Array.isArray(pair.expectation?.accounts) ? pair.expectation.accounts : [];
  const accounts = sourceAccounts.map((account) => ({
    url: clean(account?.url) || null,
    handle: clean(account?.handle) || null,
    verified: account?.verified === true,
    identity: clean(account?.identity) || null
  }));
  return {
    pairKey: requiredText(pair.pairKey, "coverage pairKey"),
    batchSlug: requiredText(pair.batchSlug, "coverage batchSlug"),
    platform: requiredText(pair.platform, "coverage platform"),
    entity: {
      type: entityType,
      id: requiredText(entityId, "coverage entity id"),
      name: clean(pair.entity?.name) || null
    },
    expectation: {
      mappingStatus: clean(pair.mapping?.status ?? pair.expectation?.mappingStatus) || "unknown",
      verifiedAccountCount: Number.isInteger(pair.mapping?.verifiedAccountCount ??
        pair.expectation?.verifiedAccountCount)
        ? (pair.mapping?.verifiedAccountCount ?? pair.expectation.verifiedAccountCount)
        : accounts.filter((account) => account.verified).length,
      accounts,
      terminalStatus: clean(pair.terminal?.status ?? pair.expectation?.terminalStatus) || "unknown",
      terminalReasonCode: clean(pair.terminal?.reasonCode ??
        pair.expectation?.terminalReasonCode) || "unknown",
      postCount: nonNegativeInteger(pair.evidence?.postCount ?? pair.expectation?.postCount),
      recentPostCount: nonNegativeInteger(pair.evidence?.recentPostCount ??
        pair.expectation?.recentPostCount),
      historicalPostCount: nonNegativeInteger(pair.evidence?.historicalPostCount ??
        pair.expectation?.historicalPostCount)
    }
  };
}

function indexCoveragePairs(pairs) {
  const result = new Map(PRODUCTION_GRAPH_BATCHES.map((batch) => [batch, new Map(
    PRODUCTION_GRAPH_CORE_PLATFORMS.map((platform) => [platform, []])
  )]));
  for (const pair of pairs) result.get(pair.batchSlug).get(pair.platform).push(pair);
  for (const platforms of result.values()) {
    for (const rows of platforms.values()) rows.sort((a, b) => a.pairKey.localeCompare(b.pairKey));
  }
  return result;
}

function blockedBatchCells(batchSlug, pairsByPlatform, checkedAt, blockers) {
  const rows = Array.isArray(blockers) ? blockers : [blockers];
  return PRODUCTION_GRAPH_CORE_PLATFORMS.map((platform) => {
    const pair = pairsByPlatform?.get(platform)?.[0] ?? null;
    return blockedCell(batchSlug, platform, checkedAt, pair?.pairKey ?? null, rows.map((entry) => ({
      ...entry,
      scope: `${batchSlug}:${platform}`
    })), null, pair?.expectation ?? null);
  });
}

function blockedCell(
  batchSlug,
  platform,
  checkedAt,
  pairKey,
  blockers,
  observation = null,
  coverageExpectation = null
) {
  return {
    sampleId: null,
    batchSlug,
    platform,
    pairKey,
    verified: false,
    checkedAt,
    reason: null,
    coverageExpectation,
    observation,
    graph: null,
    request: null,
    blockers: Array.isArray(blockers) ? blockers : [blockers]
  };
}

function proofSample(cell) {
  return {
    sampleId: cell.sampleId,
    batchSlug: cell.batchSlug,
    platform: cell.platform,
    pairKey: cell.pairKey,
    verified: true,
    checkedAt: cell.checkedAt,
    reason: cell.reason
  };
}

function matchExpectedAccounts(expected, actual, platform) {
  const actualKeys = new Set(actual.flatMap((account) => accountKeys(account, platform)));
  return expected.filter((account) => accountKeys(account, platform).some((key) => actualKeys.has(key)))
    .map((account) => ({ url: account.url, handle: account.handle }));
}

function accountKeys(account, platform) {
  const result = [];
  const handle = clean(account?.handle).toLowerCase().replace(/^@/, "");
  if (handle) result.push(`handle:${handle}`);
  const url = clean(account?.url);
  if (url) {
    try {
      const parsed = new URL(url);
      let host = parsed.hostname.toLowerCase().replace(/^www\./, "");
      if (platform === "x" && host === "twitter.com") host = "x.com";
      const path = parsed.pathname.replace(/\/+$/, "").toLowerCase();
      result.push(`url:${host}${path}`);
    } catch {
      // Invalid public account URLs do not become matches.
    }
  }
  return result;
}

function signalReason(observation) {
  const parts = [];
  if (observation.evidenceCount) parts.push(`${observation.evidenceCount} exact platform evidence row(s)`);
  if (observation.accountCount) parts.push(`${observation.accountCount} exact entity account(s)`);
  if (observation.needsReviewCount) parts.push(`${observation.needsReviewCount} exact review row(s)`);
  if (observation.platformStatuses.length) {
    parts.push(`platform status ${observation.platformStatuses.map((row) => row.status).join(",")}`);
  }
  return parts.join(", ");
}

function safeHeaders(headers) {
  const result = {};
  for (const name of SAFE_RESPONSE_HEADERS) {
    const value = clean(headers?.get?.(name));
    if (value) result[name] = value;
  }
  return result;
}

function sameGraphEndpoint(requested, finalValue) {
  try {
    const final = new URL(finalValue);
    return final.origin === requested.origin && final.pathname === requested.pathname &&
      final.searchParams.get("batch") === requested.searchParams.get("batch") &&
      final.searchParams.get("topVoices") === requested.searchParams.get("topVoices");
  } catch {
    return false;
  }
}

function normalizeBaseUrl(value) {
  const text = requiredText(value, "baseUrl");
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new TypeError("baseUrl must be an absolute HTTPS URL.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw new TypeError("baseUrl must be an unauthenticated absolute HTTPS URL.");
  }
  parsed.pathname = "/";
  parsed.search = "";
  return parsed;
}

function canonicalNow(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("now() returned an invalid timestamp.");
  return date.toISOString();
}

function isCanonicalTimestamp(value) {
  return CANONICAL_ISO_PATTERN.test(value) && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

function parsePairBytes(segments, index) {
  try {
    return JSON.parse(Buffer.concat(segments).toString("utf8"));
  } catch {
    throw new Error(`Coverage pairs[${index}] is not valid JSON.`);
  }
}

function addMapArray(map, key, value) {
  const rows = map.get(key) ?? [];
  rows.push(value);
  map.set(key, rows);
}

function blocker(scope, code, reason, nextAction) {
  return { scope, code, reason, nextAction };
}

function compareBlockers(left, right) {
  return left.scope.localeCompare(right.scope) || left.code.localeCompare(right.code) ||
    left.reason.localeCompare(right.reason);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function requiredText(value, label) {
  const text = clean(value);
  if (!text) throw new TypeError(`${label} must be a non-empty string.`);
  return text;
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer.`);
  return value;
}

function boundedInteger(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`${label} must be an integer from ${min} through ${max}.`);
  }
  return value;
}

function isWhitespace(byte) {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}
