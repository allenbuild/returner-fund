import { createHash } from "node:crypto";
import {
  adaptAutonomousIngestionCoverage
} from "./ingestion-coverage-adapter.mjs";
import {
  INGESTION_CORE_PLATFORMS,
  INGESTION_EXTENDED_ONLY_PLATFORMS,
  buildIngestionCoverageReceipt,
  streamIngestionCoverageReceiptJson
} from "./ingestion-coverage-receipt.mjs";
import {
  buildTerminalOutcomeResolutionSummary
} from "./ingestion-terminal-outcome-resolution.mjs";

export const INGESTION_COVERAGE_MATERIALIZATION_VERSION =
  "ingestion-coverage-materialization.v1";
export const INGESTION_PRODUCTION_RELEASE_PROOF_VERSION =
  "ingestion-production-release-proof.v1";

const SHA256 = /^[a-f0-9]{64}$/;
const PHYSICAL_EVIDENCE_PLATFORMS = new Set([
  ...INGESTION_CORE_PLATFORMS,
  ...INGESTION_EXTENDED_ONLY_PLATFORMS
]);
const RELEASE_PROOF_KINDS = Object.freeze({
  expectedManifest: {
    status: "verified",
    missing: "No independent expected-manifest verification receipt was supplied."
  },
  productionArtifact: {
    status: "rebuilt",
    missing: "No production-artifact rebuild receipt was supplied."
  },
  productionSample: {
    status: "verified",
    missing: "No representative production sample receipt was supplied for every batch and supported platform."
  },
  deployment: {
    status: "verified",
    missing: "No production deployment verification receipt was supplied."
  }
});
const UNRESOLVED_QUEUE_CODES = new Set([
  "no_current_attempt",
  "missing_native_evidence",
  "ambiguous_legacy_outcome",
  "missing_exact_reason"
]);

/**
 * Build one measured, fail-closed campaign result from the existing adapter and
 * receipt contracts. Numeric counts are only summaries of validated pair rows;
 * they never promote a pair or release to success.
 */
export async function materializeIngestionCoverage({
  releaseProofs = null,
  inputArtifacts = [],
  historicalBackfills = [],
  historicalDepthBackfills = [],
  materializedAt = null,
  unresolvedPreviewLimit = 250,
  ...adapterInput
} = {}) {
  if (!Number.isInteger(unresolvedPreviewLimit) || unresolvedPreviewLimit < 0) {
    throw new TypeError("unresolvedPreviewLimit must be a non-negative integer.");
  }

  const historicalCoverage = await adaptHistoricalCoverageInputs(
    historicalBackfills,
    adapterInput.generatedAt
  );
  const historicalDepthCoverage = await adaptHistoricalDepthCoverageInputs(
    historicalDepthBackfills,
    adapterInput.catalogs,
    adapterInput.generatedAt
  );
  const crossLayerDuplicateState = { reviews: [] };
  const normalized = await adaptAutonomousIngestionCoverage({
    ...adapterInput,
    taskPlan: mergeTaskPlanRows(
      adapterInput.taskPlan,
      [
        ...historicalCoverage.flatMap((entry) => entry.taskPlan),
        ...historicalDepthCoverage.flatMap((entry) => entry.taskPlan)
      ]
    ),
    collectorArtifacts: mergeCollectorArtifactsWithHistoricalDepth(
      adapterInput.collectorArtifacts,
      historicalCoverage.flatMap((entry) => entry.collectorArtifacts),
      historicalDepthCoverage.flatMap((entry) => entry.collectorArtifacts),
      crossLayerDuplicateState
    ),
    pairScopes: mergeIngestionPairScopes(
      mergeIngestionPairScopes(
        adapterInput.pairScopes ?? [],
        historicalCoverage.flatMap((entry) => entry.pairScopes)
      ),
      historicalDepthCoverage.flatMap((entry) => entry.pairScopes)
    )
  });
  const crossLayerDuplicateReviews = [...crossLayerDuplicateState.reviews].sort(
    compareCrossLayerDuplicateReviews
  );
  const coverageReceipt = buildIngestionCoverageReceipt(normalized);
  const outputGeneratedAt = canonicalTimestamp(
    materializedAt ?? coverageReceipt.generatedAt,
    "materializedAt"
  );
  if (Date.parse(outputGeneratedAt) < Date.parse(coverageReceipt.generatedAt)) {
    throw new Error("materializedAt cannot predate the coverage receipt.");
  }
  const expectedCatalogManifestSha256 = sha256Stable(normalized.expectedCatalogManifest);
  const coverageReceiptSha256 = sha256CoverageReceipt(
    coverageReceipt,
    normalized.expectedCatalogManifest
  );
  const productionReleaseStatus = summarizeProductionRelease({
    releaseProofs,
    expectedCatalogManifestSha256,
    expectedCatalogManifest: normalized.expectedCatalogManifest,
    coveragePairs: coverageReceipt.pairs,
    run: coverageReceipt.run,
    generatedAt: outputGeneratedAt
  });
  const fullIngestionCoverageStatus = summarizeFullCoverage(
    coverageReceipt,
    unresolvedPreviewLimit
  );
  const terminalOutcomeResolution = buildTerminalOutcomeResolutionSummary(
    coverageReceipt
  );
  const normalizedInputArtifacts = normalizeInputArtifacts(
    inputArtifacts,
    outputGeneratedAt
  );
  const objectiveComplete = productionReleaseStatus.complete &&
    fullIngestionCoverageStatus.objectiveComplete;

  const digestPayload = {
    schemaVersion: INGESTION_COVERAGE_MATERIALIZATION_VERSION,
    runId: coverageReceipt.runId,
    generatedAt: outputGeneratedAt,
    coverageGeneratedAt: coverageReceipt.generatedAt,
    objectiveComplete,
    productionReleaseStatus,
    fullIngestionCoverageStatus,
    terminalOutcomeResolution,
    coverageReceiptSha256,
    expectedCatalogManifestSha256,
    inputArtifacts: normalizedInputArtifacts,
    adapterProvenance: normalized.provenance,
    historicalAdapterProvenance: historicalCoverage.map((entry) => entry.provenance),
    historicalDepthAdapterProvenance: historicalDepthCoverage.map((entry) => entry.provenance),
    crossLayerDuplicateReviews
  };

  return {
    schemaVersion: INGESTION_COVERAGE_MATERIALIZATION_VERSION,
    runId: coverageReceipt.runId,
    generatedAt: outputGeneratedAt,
    coverageGeneratedAt: coverageReceipt.generatedAt,
    objectiveComplete,
    productionReleaseStatus,
    fullIngestionCoverageStatus,
    terminalOutcomeResolution,
    historicalCoverage: {
      runs: historicalCoverage.map((entry) => ({
        provenance: entry.provenance,
        targetCoverage: entry.targetCoverage,
        rejectedEvidence: entry.rejectedEvidence,
        outboundLinks: entry.outboundLinks
      }))
    },
    historicalDepthCoverage: {
      runs: historicalDepthCoverage.map((entry) => ({
        provenance: entry.provenance,
        coverageSummary: entry.coverageSummary,
        targetCoverage: entry.targetCoverage,
        accountTargetCoverage: entry.accountTargetCoverage,
        pairCoverage: entry.pairCoverage,
        rejectedEvidence: entry.rejectedEvidence
      })),
      crossLayerDuplicateReviews
    },
    coverageReceipt,
    provenance: {
      adapter: normalized.provenance,
      historicalAdapters: historicalCoverage.map((entry) => entry.provenance),
      historicalDepthAdapters: historicalDepthCoverage.map((entry) => entry.provenance),
      crossLayerDuplicateReviews,
      inputArtifacts: normalizedInputArtifacts,
      expectedCatalogManifestSha256,
      coverageReceiptSha256,
      terminalOutcomeResolutionSha256: sha256Stable(terminalOutcomeResolution),
      materializationManifestSha256: sha256Stable(digestPayload),
      hashAlgorithm: "sha256",
      hashSerialization: "stable-json.v1"
    }
  };
}

async function adaptHistoricalCoverageInputs(values, generatedAt) {
  if (!Array.isArray(values)) throw new TypeError("historicalBackfills must be an array.");
  if (values.length === 0) return [];
  const { adaptHistoricalBackfillCoverage } = await import("./historical-coverage-adapter.mjs");
  const outputs = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    assertObject(value, `historicalBackfills[${index}]`);
    outputs.push(await adaptHistoricalBackfillCoverage({
      journal: value.journal,
      artifact: value.artifact,
      generatedAt,
      recencyCutoffAt: value.completionProofs?.[0]?.coveredThrough ?? null,
      completionProofs: value.completionProofs ?? [],
      limits: value.limits ?? {}
    }));
  }
  return outputs;
}

async function adaptHistoricalDepthCoverageInputs(values, catalogs, generatedAt) {
  if (!Array.isArray(values)) {
    throw new TypeError("historicalDepthBackfills must be an array.");
  }
  if (values.length === 0) return [];
  const { adaptHistoricalDepthCoverage } = await import(
    "./historical-depth-coverage-adapter.mjs"
  );
  const outputs = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    assertObject(value, `historicalDepthBackfills[${index}]`);
    outputs.push(await adaptHistoricalDepthCoverage({
      journal: value.journal,
      artifact: value.artifact,
      catalogs,
      generatedAt,
      completionProofs: value.completionProofs ?? [],
      limits: value.limits ?? {}
    }));
  }
  return outputs;
}

/**
 * Index primary/shallow evidence while it is streamed, then reconcile depth
 * evidence by immutable native identity. Exact duplicates share the primary
 * digest and remain one physical registry entry. Timestamp/URL conflicts are
 * held out and emitted as explicit review records instead of double-counting.
 */
async function* mergeCollectorArtifactsWithHistoricalDepth(
  primary,
  historical,
  depth,
  state
) {
  const shallowByNativeIdentity = new Map();
  for await (const envelope of asAsyncIterable(primary, "primary campaign rows")) {
    indexShallowEnvelope(envelope, shallowByNativeIdentity, "primary");
    yield envelope;
  }
  for (const envelope of historical) {
    const reconciled = reconcileRecoveryEnvelope(
      envelope,
      shallowByNativeIdentity,
      state,
      "historical"
    );
    indexShallowEnvelope(reconciled, shallowByNativeIdentity, "historical");
    yield reconciled;
  }
  for (const envelope of depth) {
    yield reconcileRecoveryEnvelope(
      envelope,
      shallowByNativeIdentity,
      state,
      "historical_depth"
    );
  }
}

function indexShallowEnvelope(envelope, index, sourceLayer) {
  if (!isObject(envelope) || !isObject(envelope.snapshot)) return;
  const snapshot = envelope.snapshot.isolatedEvidence?.snapshot ?? envelope.snapshot;
  const evidence = Array.isArray(snapshot.evidence) ? snapshot.evidence : [];
  for (const row of evidence) {
    const descriptor = physicalEvidenceDescriptor(row);
    if (!descriptor) continue;
    const ref = {
      ...descriptor,
      artifactPath: clean(envelope.artifact?.path) || "unknown-artifact",
      kind: clean(envelope.kind) || "unknown",
      pairKey: rawEvidencePairKey(row),
      sourceLayer
    };
    for (const alias of descriptor.physicalAliases) {
      const refs = index.get(alias) ?? [];
      refs.push(ref);
      index.set(alias, refs);
    }
  }
}

function reconcileRecoveryEnvelope(envelope, shallowIndex, state, sourceLayer) {
  const label = sourceLayer === "historical_depth" ? "historical-depth" : sourceLayer;
  assertObject(envelope, `${label} collector envelope`);
  assertObject(envelope.snapshot, `${label} collector snapshot`);
  if (!Array.isArray(envelope.snapshot.evidence)) {
    throw new TypeError(`${label} collector snapshot.evidence must be an array.`);
  }
  const output = structuredClone(envelope);
  const kept = [];
  for (const row of output.snapshot.evidence) {
    const descriptor = physicalEvidenceDescriptor(row);
    const shallow = descriptor
      ? shallowCandidates(descriptor, shallowIndex)
      : [];
    if (!descriptor || shallow.length === 0) {
      kept.push(row);
      continue;
    }
    const exact = shallow.find((candidate) =>
      candidate.publishedAt === descriptor.publishedAt &&
      (!candidate.canonicalUrl || !descriptor.canonicalUrl ||
        candidate.canonicalUrl === descriptor.canonicalUrl)
    );
    const depthRef = {
      artifactPath: clean(output.artifact?.path) || "unknown-depth-artifact",
      pairKey: rawEvidencePairKey(row),
      sourceLayer,
      nativeId: descriptor.nativeId,
      publishedAt: descriptor.publishedAt,
      canonicalUrl: descriptor.canonicalUrl
    };
    if (exact) {
      row.digest = exact.digest;
      if (exact.nativeId) row.nativeId = exact.nativeId;
      if (exact.canonicalUrl) row.canonicalUrl = exact.canonicalUrl;
      kept.push(row);
      state.reviews.push({
        reviewKey: `cross-layer-${sha256Stable({
          physicalKey: exact.physicalKey,
          depthRef,
          disposition: "coalesced_exact_identity"
        })}`,
        physicalKey: exact.physicalKey,
        platform: descriptor.platform,
        nativeId: exact.nativeId ?? descriptor.nativeId,
        sourceLayer,
        status: "needs_review",
        disposition: "coalesced_exact_identity",
        depthRef,
        shallowRefs: shallow.map(shallowReviewRef).sort(compareShallowReviewRefs),
        reason:
          `The same immutable native item was present in an earlier layer and ${label}; ` +
          "it was coalesced to one physical post and retained for source-attribution review.",
        nextAction:
          "Confirm the canonical timestamp, URL, and owner attribution before approving the " +
          "cross-layer duplicate; do not count either source as a second post."
      });
      continue;
    }
    const disposition = sourceLayer === "historical_depth"
      ? "depth_evidence_held_conflict"
      : "historical_evidence_held_conflict";
    state.reviews.push({
      reviewKey: `cross-layer-${sha256Stable({
        physicalKey: shallow[0].physicalKey,
        depthRef,
        disposition
      })}`,
      physicalKey: shallow[0].physicalKey,
      platform: descriptor.platform,
      nativeId: descriptor.nativeId,
      sourceLayer,
      status: "needs_review",
      disposition,
      depthRef,
      shallowRefs: shallow.map(shallowReviewRef).sort(compareShallowReviewRefs),
      reason:
        `An earlier layer and ${label} share a physical alias but disagree on the ` +
        "canonical timestamp or URL; the recovery row was held to prevent double-counting.",
      nextAction:
        "Resolve the native timestamp and canonical URL from the official item, then reissue " +
        "one corrected evidence row with a stable digest."
    });
  }
  output.snapshot.evidence = kept;
  return output;
}

function shallowCandidates(descriptor, index) {
  const uniqueRefs = new Map();
  for (const alias of descriptor.physicalAliases) {
    for (const ref of index.get(alias) ?? []) {
      const key = [
        ref.artifactPath,
        ref.pairKey,
        ref.digest,
        ref.nativeId,
        ref.canonicalUrl,
        ref.publishedAt
      ].join("\u0000");
      uniqueRefs.set(key, ref);
    }
  }
  return [...uniqueRefs.values()].sort(compareShallowReviewRefs);
}

function physicalEvidenceDescriptor(row) {
  if (!isObject(row)) return null;
  const platform = normalizedPhysicalPlatform(row.platform);
  if (!platform) return null;
  const nativeId = clean(
    row.nativeId ?? row.platformPostId ?? row.platform_post_id ?? row.platformObjectId
  );
  if (!nativeId) return null;
  const canonicalUrl = canonicalEvidenceUrl(
    platform,
    row.canonicalUrl ?? row.sourceUrl ?? row.url
  );
  const publishedAt = canonicalEvidenceTimestamp(
    row.publishedAt ?? row.postedAt ?? row.last_updated_at
  );
  if (!publishedAt) return null;
  const identity = {
    batchSlug: clean(row.batchSlug ?? row.batch_slug),
    entityType: clean(row.entityType ?? row.entity_type).toLowerCase(),
    entityId: clean(row.entityId ?? row.entity_id ?? row.entitySourceKey ?? row.company_id),
    platform
  };
  const digest = SHA256.test(clean(row.digest).toLowerCase())
    ? clean(row.digest).toLowerCase()
    : sha256Stable({
        adapterVersion: "autonomous-ingestion-coverage-adapter.v1",
        identity,
        nativeId,
        canonicalUrl: clean(row.canonicalUrl ?? row.sourceUrl ?? row.url) || null,
        publishedAt,
        title: clean(row.title) || null,
        text: clean(row.text) || null,
        rawVisibleText: clean(row.rawVisibleText) || null,
        metrics: row.metrics ?? null
      });
  return {
    physicalKey: `${platform}:native:${encodeURIComponent(nativeId)}`,
    physicalAliases: [
      `${platform}:native:${encodeURIComponent(nativeId)}`,
      ...(canonicalUrl
        ? [`${platform}:url:${encodeURIComponent(canonicalUrl)}`]
        : [])
    ],
    platform,
    nativeId,
    canonicalUrl,
    publishedAt,
    digest
  };
}

function normalizedPhysicalPlatform(value) {
  const platform = clean(value).toLowerCase().replace(/-/g, "_");
  const normalized = ({
    twitter: "x",
    producthunt: "product_hunt",
    hn: "hacker_news",
    hackernews: "hacker_news",
    website: "web"
  })[platform] ?? platform;
  return PHYSICAL_EVIDENCE_PLATFORMS.has(normalized)
    ? normalized
    : null;
}

function canonicalEvidenceUrl(platform, value) {
  const text = clean(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:") return null;
    let host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (platform === "reddit" && host === "old.reddit.com") host = "reddit.com";
    url.hostname = host;
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    const entries = [...url.searchParams.entries()].sort(([left], [right]) =>
      left.localeCompare(right)
    );
    url.search = "";
    for (const [key, entryValue] of entries) url.searchParams.append(key, entryValue);
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function canonicalEvidenceTimestamp(value) {
  const text = clean(value);
  const parsed = Date.parse(text);
  return text && Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function rawEvidencePairKey(row) {
  return [
    clean(row.batchSlug ?? row.batch_slug) || "unknown-batch",
    clean(row.entityType ?? row.entity_type).toLowerCase() || "unknown-entity-type",
    clean(row.entityId ?? row.entity_id ?? row.entitySourceKey ?? row.company_id) ||
      "unknown-entity",
    normalizedPhysicalPlatform(row.platform) || clean(row.platform) || "unknown-platform"
  ].join(":");
}

function shallowReviewRef(value) {
  return {
    artifactPath: value.artifactPath,
    kind: value.kind,
    pairKey: value.pairKey,
    publishedAt: value.publishedAt,
    canonicalUrl: value.canonicalUrl,
    digest: value.digest
  };
}

function compareShallowReviewRefs(left, right) {
  return left.artifactPath.localeCompare(right.artifactPath) ||
    left.pairKey.localeCompare(right.pairKey) || left.digest.localeCompare(right.digest);
}

function compareCrossLayerDuplicateReviews(left, right) {
  return left.physicalKey.localeCompare(right.physicalKey) ||
    left.disposition.localeCompare(right.disposition) ||
    left.reviewKey.localeCompare(right.reviewKey);
}

async function* concatenateAsyncRows(primary, appended) {
  yield* asAsyncIterable(primary, "primary campaign rows");
  for (const row of appended) yield row;
}

// Historical recovery emits one task per recovered entity/platform pair. The
// autonomous plan already contains that denominator, so retain the historical
// task only when no equivalent canonical task exists. Without this merge, a
// real historical HN/RSS/web attempt can become ambiguous between two identical
// discovery tasks even though both came from the same canonical owner pair.
async function* mergeTaskPlanRows(primary, appended) {
  const identities = new Set();
  for await (const row of asAsyncIterable(primary, "primary campaign task rows")) {
    identities.add(taskPlanIdentity(row));
    yield row;
  }
  for (const row of appended) {
    const identity = taskPlanIdentity(row);
    if (identities.has(identity)) continue;
    identities.add(identity);
    yield row;
  }
}

function taskPlanIdentity(row) {
  assertObject(row, "task plan row");
  const batchSlug = requiredText(row.batchSlug ?? row.batch_slug, "task plan batchSlug");
  const entityType = requiredText(row.entityType ?? row.entity_type, "task plan entityType")
    .toLowerCase();
  const entityId = requiredText(
    row.entitySourceKey ?? row.entityId ?? row.entity_id,
    "task plan entityId"
  );
  const platform = normalizedTaskPlatform(row.platform);
  const accountUrl = canonicalTaskAccountUrl(row.account?.url ?? row.accountUrl ?? null);
  return [batchSlug, entityType, entityId, platform, accountUrl ?? "discovery"].join("\u0000");
}

function normalizedTaskPlatform(value) {
  const platform = requiredText(value, "task plan platform").toLowerCase();
  return ({
    twitter: "x",
    website: "web",
    producthunt: "product_hunt",
    hn: "hacker_news",
    hackernews: "hacker_news"
  })[platform] ?? platform;
}

function canonicalTaskAccountUrl(value) {
  const text = clean(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString().replace(/\/$/, "");
  } catch {
    return text.replace(/\/+$/, "").toLowerCase();
  }
}

export function mergeIngestionPairScopes(primary, appended) {
  if (!Array.isArray(primary) || !Array.isArray(appended)) {
    throw new TypeError("pairScopes and historical pairScopes must be arrays.");
  }
  const merged = new Map();
  for (const [source, rows] of [["campaign", primary], ["historical", appended]]) {
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      assertObject(row, `${source} pairScopes[${index}]`);
      const identity = {
        batchSlug: requiredText(row.batchSlug, `${source} pairScopes[${index}].batchSlug`),
        entityType: requiredText(row.entityType, `${source} pairScopes[${index}].entityType`),
        entityId: requiredText(row.entityId, `${source} pairScopes[${index}].entityId`),
        platform: requiredText(row.platform, `${source} pairScopes[${index}].platform`)
      };
      const key = [
        identity.batchSlug,
        identity.entityType,
        identity.entityId,
        identity.platform
      ].join("\u0000");
      const scope = isObject(row.scope) ? row.scope : Object.fromEntries(
        Object.entries(row).filter(([field]) => ![
          "batchSlug",
          "entityType",
          "entityId",
          "platform"
        ].includes(field))
      );
      const current = merged.get(key) ?? { ...identity, scope: {} };
      current.scope = mergeScopePayload(current.scope, scope, key);
      merged.set(key, current);
    }
  }
  return [...merged.values()].sort((left, right) =>
    left.batchSlug.localeCompare(right.batchSlug) ||
    left.entityType.localeCompare(right.entityType) ||
    left.entityId.localeCompare(right.entityId) ||
    left.platform.localeCompare(right.platform)
  );
}

function mergeScopePayload(left, right, pairKey) {
  assertObject(right, `${pairKey} scope`);
  const merged = structuredClone(left);
  for (const [key, value] of Object.entries(right)) {
    if (key === "integrityChecks" && isObject(value)) {
      merged.integrityChecks = mergeScopePayload(
        isObject(merged.integrityChecks) ? merged.integrityChecks : {},
        value,
        `${pairKey} integrityChecks`
      );
      continue;
    }
    if (merged[key] === undefined) {
      merged[key] = structuredClone(value);
      continue;
    }
    if (stableJson(merged[key]) !== stableJson(value)) {
      throw new Error(`${pairKey} has conflicting ${key} scope proofs.`);
    }
  }
  return merged;
}

async function* asAsyncIterable(value, label) {
  if (value?.[Symbol.asyncIterator]) {
    yield* value;
    return;
  }
  if (value?.[Symbol.iterator]) {
    yield* value;
    return;
  }
  throw new TypeError(`${label} must be iterable or async iterable.`);
}

/** Stream the large receipt without constructing a second serialized copy. */
export function* streamIngestionCoverageMaterializationJson(
  materialization,
  { expectedCatalogManifest, maxChunkCharacters = 65_536 } = {}
) {
  assertObject(materialization, "materialization");
  if (!materialization.coverageReceipt) {
    throw new TypeError("materialization.coverageReceipt is required.");
  }
  const keys = Object.keys(materialization);
  yield "{";
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (index) yield ",";
    yield `${JSON.stringify(key)}:`;
    if (key === "coverageReceipt") {
      yield* streamIngestionCoverageReceiptJson(materialization.coverageReceipt, {
        expectedCatalogManifest,
        maxChunkCharacters
      });
    } else {
      yield* chunkString(JSON.stringify(materialization[key]), maxChunkCharacters);
    }
  }
  yield "}";
}

export async function writeIngestionCoverageMaterializationJson(
  materialization,
  { write, expectedCatalogManifest, maxChunkCharacters = 65_536 } = {}
) {
  if (typeof write !== "function") throw new TypeError("write must be an async chunk sink.");
  const hash = createHash("sha256");
  let chunks = 0;
  let characters = 0;
  for (const chunk of streamIngestionCoverageMaterializationJson(materialization, {
    expectedCatalogManifest,
    maxChunkCharacters
  })) {
    await write(chunk);
    hash.update(chunk);
    chunks += 1;
    characters += chunk.length;
  }
  return {
    chunks,
    characters,
    sha256: hash.digest("hex"),
    strategy: "streamed-materialization-with-normalized-receipt.v1"
  };
}

export function summarizeProductionRelease({
  releaseProofs,
  expectedCatalogManifestSha256,
  expectedCatalogManifest,
  coveragePairs,
  run,
  generatedAt
}) {
  const source = isObject(releaseProofs) ? releaseProofs : {};
  if (!Array.isArray(coveragePairs)) {
    throw new TypeError("coveragePairs must be the validated receipt pair array.");
  }
  const expectedPairIndex = new Map(coveragePairs.map((pair) => [pair.pairKey, pair]));
  const receipts = {};
  const blockers = [];
  for (const [kind, contract] of Object.entries(RELEASE_PROOF_KINDS)) {
    const result = normalizeReleaseProof(source[kind], {
      kind,
      expectedStatus: contract.status,
      expectedBatchSlugs: expectedCatalogManifest.batches.map((batch) => batch.batchSlug),
      expectedPairIndex,
      run,
      generatedAt
    });
    receipts[kind] = result.receipt;
    if (!result.valid) blockers.push(result.reason ?? contract.missing);
  }

  if (
    receipts.expectedManifest?.valid === true &&
    receipts.expectedManifest.artifactDigest !== expectedCatalogManifestSha256
  ) {
    receipts.expectedManifest = {
      ...receipts.expectedManifest,
      valid: false,
      validationError: "Expected-manifest receipt digest does not match the independently supplied manifest."
    };
    blockers.push(receipts.expectedManifest.validationError);
  }

  if (
    receipts.productionArtifact?.valid === true &&
    receipts.deployment?.valid === true
  ) {
    if (receipts.productionArtifact.artifactDigest !== receipts.deployment.artifactDigest) {
      blockers.push("Deployment receipt does not identify the rebuilt production artifact digest.");
    }
    if (receipts.productionArtifact.revision !== receipts.deployment.revision) {
      blockers.push("Deployment receipt revision does not match the rebuilt production artifact revision.");
    }
  }
  if (
    receipts.productionArtifact?.valid === true &&
    receipts.productionSample?.valid === true
  ) {
    if (receipts.productionArtifact.artifactDigest !== receipts.productionSample.artifactDigest) {
      blockers.push("Production sample receipt does not identify the rebuilt production artifact digest.");
    }
    if (receipts.productionArtifact.revision !== receipts.productionSample.revision) {
      blockers.push("Production sample receipt revision does not match the rebuilt production artifact revision.");
    }
  }

  const uniqueBlockers = [...new Set(blockers)];
  const complete = uniqueBlockers.length === 0 &&
    Object.values(receipts).every((receipt) => receipt?.valid === true);
  return {
    status: complete ? "verified" : "incomplete",
    complete,
    requiredReceiptCount: Object.keys(RELEASE_PROOF_KINDS).length,
    verifiedReceiptCount: Object.values(receipts).filter((receipt) => receipt?.valid).length,
    receipts,
    blockers: uniqueBlockers,
    nextActions: uniqueBlockers.map((blocker) => `Provide a fresh proof receipt: ${blocker}`)
  };
}

export function summarizeFullCoverage(receipt, unresolvedPreviewLimit = 250) {
  assertObject(receipt, "receipt");
  if (!Array.isArray(receipt.pairs) || !Array.isArray(receipt.evidenceRegistry)) {
    throw new TypeError("receipt must contain validated pairs and evidenceRegistry arrays.");
  }
  const corePairs = receipt.pairs.filter((pair) => pair.matrixScope === "core");
  const extendedOnlyPairs = receipt.pairs.filter((pair) => pair.matrixScope === "extended_only");
  const global = summarizePairs(corePairs, receipt.evidenceRegistry);
  const groups = buildCoverageGroups(corePairs, receipt.evidenceRegistry);
  const unresolved = corePairs
    .filter((pair) => !pairResolution(pair).resolved)
    .map((pair) => unresolvedPairRecord(pair));
  const documentedBlockers = corePairs
    .filter((pair) => {
      const resolution = pairResolution(pair);
      return resolution.resolved && resolution.mode === "documented_blocker";
    })
    .map((pair) => unresolvedPairRecord(pair));
  const objectiveComplete = global.scope.objectiveCompletePairs === global.denominator.pairs;
  const coverageMatrixResolved = unresolved.length === 0;
  const status = objectiveComplete
    ? "complete"
    : coverageMatrixResolved
      ? "blocked_with_next_actions"
      : "incomplete";

  return {
    status,
    objectiveComplete,
    coverageMatrixResolved,
    denominator: {
      companies: receipt.inventory.companies,
      founders: receipt.inventory.founders,
      entities: receipt.inventory.entities,
      corePlatforms: receipt.inventory.corePlatforms.length,
      extendedOnlyPlatforms: receipt.inventory.extendedOnlyPlatforms.length,
      corePairs: receipt.inventory.corePairCount,
      allPairs: receipt.inventory.extendedPairCount
    },
    evaluated: global.evaluated,
    terminalStatusBuckets: global.terminalStatusBuckets,
    mapping: global.mapping,
    profiles: global.profiles,
    posts: {
      ...global.posts,
      physicalPosts: global.posts.attributedPosts,
      physicalRecentPosts: global.posts.recentPosts,
      physicalHistoricalPosts: global.posts.historicalPosts,
      allMatrixPhysicalPosts: receipt.summary.physicalPosts,
      allMatrixPhysicalRecentPosts: receipt.summary.physicalRecentPosts,
      allMatrixPhysicalHistoricalPosts: receipt.summary.physicalHistoricalPosts,
      allMatrixStoredUnpublishedPosts: receipt.summary.storedUnpublishedPosts
    },
    scope: global.scope,
    unresolved: {
      pairs: unresolved.length,
      documentedBlockerPairs: documentedBlockers.length,
      previewLimit: unresolvedPreviewLimit,
      previewTruncated: unresolved.length > unresolvedPreviewLimit,
      preview: unresolved.slice(0, unresolvedPreviewLimit),
      documentedBlockerPreview: documentedBlockers.slice(0, unresolvedPreviewLimit),
      completeRecordsPath: "coverageReceipt.pairs"
    },
    byBatch: groups.byBatch,
    byPlatform: groups.byPlatform,
    byBatchPlatform: groups.byBatchPlatform,
    extendedOnly: {
      excludedFromObjective: true,
      reason: "These lanes are declared extended-only and are not supported by the normalized collector matrix.",
      ...summarizePairs(extendedOnlyPairs, receipt.evidenceRegistry)
    },
    expectedCatalogManifest: receipt.catalogManifest,
    definitions: {
      evaluatedPair: "Every task for the pair has a dated current attempt or an explicit collector-unavailable/not-applicable plan outcome; raw counts do not qualify.",
      coverageMatrixResolved: "Every pair is objective-complete or has a structured technical blocker/queue reason and concrete next action; this is not objective completion.",
      objectiveComplete: "Every pair carries complete recent, historical, stored-unpublished, scheduler, and four-dimensional integrity proof receipts."
    }
  };
}

function buildCoverageGroups(pairs, registry) {
  const byBatchPairs = new Map();
  const byPlatformPairs = new Map();
  const byBatchPlatformPairs = new Map();
  for (const pair of pairs) {
    addGroupPair(byBatchPairs, pair.batchSlug, pair);
    addGroupPair(byPlatformPairs, pair.platform, pair);
    addGroupPair(byBatchPlatformPairs, `${pair.batchSlug}\u0000${pair.platform}`, pair);
  }
  return {
    byBatch: summarizeGroupMap(byBatchPairs, registry),
    byPlatform: summarizeGroupMap(byPlatformPairs, registry),
    byBatchPlatform: Object.fromEntries(
      [...byBatchPlatformPairs.entries()].sort(([left], [right]) => left.localeCompare(right))
        .map(([key, groupPairs]) => {
          const [batchSlug, platform] = key.split("\u0000");
          return [`${batchSlug}:${platform}`, {
            batchSlug,
            platform,
            ...summarizePairs(groupPairs, registry)
          }];
        })
    )
  };
}

function summarizeGroupMap(groups, registry) {
  return Object.fromEntries(
    [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))
      .map(([key, pairs]) => [key, summarizePairs(pairs, registry)])
  );
}

function addGroupPair(map, key, pair) {
  const list = map.get(key) ?? [];
  list.push(pair);
  map.set(key, list);
}

function summarizePairs(pairs, registry) {
  const evidenceByKey = new Map(registry.map((entry) => [entry.evidenceKey, entry]));
  const entityState = new Map();
  const evidenceKeys = new Set();
  const recentKeys = new Set();
  const historicalKeys = new Set();
  const storedKeys = new Set();
  let mappedPairs = 0;
  const mappedProfileKeys = new Set();
  const verifiedProfileKeys = new Set();
  const scrapedProfileKeys = new Set();
  const verifiedScrapedProfileKeys = new Set();
  const statusBuckets = {
    collected: 0,
    verified_no_account: 0,
    blocked: 0,
    queued: 0
  };
  const scope = {
    recentBackfillCompletePairs: 0,
    historicalBackfillCompletePairs: 0,
    storedUnpublishedSurfacedPairs: 0,
    schedulerCurrentPairs: 0,
    integrityVerifiedPairs: 0,
    objectiveCompletePairs: 0,
    matrixResolvedPairs: 0
  };

  for (const pair of pairs) {
    statusBuckets[pair.terminal.status] += 1;
    if (pair.mapping.accountCount > 0) mappedPairs += 1;
    const accountVerification = new Map(
      pair.mapping.accounts.map((account) => [account.accountKey, account.verified === true])
    );
    for (const account of pair.mapping.accounts) {
      const profileKey = `${pair.pairKey}\u0000${account.accountKey}`;
      mappedProfileKeys.add(profileKey);
      if (account.verified === true) verifiedProfileKeys.add(profileKey);
    }
    for (const outcome of pair.accountOutcomes) {
      if (outcome.profileScraped) {
        const profileKey = `${pair.pairKey}\u0000${outcome.accountKey}`;
        scrapedProfileKeys.add(profileKey);
        if (accountVerification.get(outcome.accountKey) === true) {
          verifiedScrapedProfileKeys.add(profileKey);
        }
      }
    }
    for (const evidenceKey of pair.evidence.evidenceRefs) {
      evidenceKeys.add(evidenceKey);
      const evidence = evidenceByKey.get(evidenceKey);
      if (evidence?.recency === "recent") recentKeys.add(evidenceKey);
      if (evidence?.recency === "historical") historicalKeys.add(evidenceKey);
      if (evidence?.storedUnpublished) storedKeys.add(evidenceKey);
    }
    if (pair.scope.recentBackfillComplete) scope.recentBackfillCompletePairs += 1;
    if (pair.scope.historicalBackfillComplete) scope.historicalBackfillCompletePairs += 1;
    if (pair.scope.storedUnpublishedSurfaced) scope.storedUnpublishedSurfacedPairs += 1;
    if (pair.scope.scheduledIngestionCurrent) scope.schedulerCurrentPairs += 1;
    if (pair.scope.integrityVerified) scope.integrityVerifiedPairs += 1;
    if (pair.scope.objectiveComplete) scope.objectiveCompletePairs += 1;
    if (pairResolution(pair).resolved) scope.matrixResolvedPairs += 1;

    const entityKey = `${pair.batchSlug}:${pair.entity.type}:${pair.entity.id}`;
    const state = entityState.get(entityKey) ?? {
      type: pair.entity.type,
      corePairs: 0,
      evaluatedCorePairs: 0,
      resolvedCorePairs: 0
    };
    if (INGESTION_CORE_PLATFORMS.includes(pair.platform)) {
      state.corePairs += 1;
      if (pairEvaluated(pair)) state.evaluatedCorePairs += 1;
      if (pairResolution(pair).resolved) state.resolvedCorePairs += 1;
    }
    entityState.set(entityKey, state);
  }

  const entityValues = [...entityState.values()];
  const companies = entityValues.filter((entity) => entity.type === "company");
  const founders = entityValues.filter((entity) => entity.type === "founder");
  const fullyEvaluated = (entity) => entity.corePairs > 0 &&
    entity.evaluatedCorePairs === entity.corePairs;
  const fullyResolved = (entity) => entity.corePairs > 0 &&
    entity.resolvedCorePairs === entity.corePairs;
  const profilesMapped = mappedProfileKeys.size;
  const verifiedAccounts = verifiedProfileKeys.size;
  const profilesScraped = scrapedProfileKeys.size;
  const verifiedProfilesScraped = verifiedScrapedProfileKeys.size;

  return {
    denominator: {
      pairs: pairs.length,
      companies: companies.length,
      founders: founders.length,
      entities: entityValues.length
    },
    evaluated: {
      pairs: pairs.filter(pairEvaluated).length,
      companies: companies.filter(fullyEvaluated).length,
      founders: founders.filter(fullyEvaluated).length,
      entities: entityValues.filter(fullyEvaluated).length,
      resolvedCompanies: companies.filter(fullyResolved).length,
      resolvedFounders: founders.filter(fullyResolved).length,
      resolvedEntities: entityValues.filter(fullyResolved).length
    },
    terminalStatusBuckets: statusBuckets,
    mapping: {
      mappedPairs,
      unmappedPairs: pairs.length - mappedPairs,
      mappingCoveragePercent: percent(mappedPairs, pairs.length),
      verifiedAccounts
    },
    profiles: {
      mapped: profilesMapped,
      scraped: profilesScraped,
      scrapeCoveragePercent: percent(profilesScraped, profilesMapped),
      verifiedMapped: verifiedAccounts,
      verifiedScraped: verifiedProfilesScraped,
      verifiedScrapeCoveragePercent: percent(verifiedProfilesScraped, verifiedAccounts)
    },
    posts: {
      attributedPosts: evidenceKeys.size,
      recentPosts: recentKeys.size,
      historicalPosts: historicalKeys.size,
      storedUnpublishedPosts: storedKeys.size
    },
    scope: {
      ...scope,
      objectiveCoveragePercent: percent(scope.objectiveCompletePairs, pairs.length),
      matrixResolutionPercent: percent(scope.matrixResolvedPairs, pairs.length)
    }
  };
}

function pairEvaluated(pair) {
  return pair.accountOutcomes.length > 0 && pair.accountOutcomes.every((outcome) =>
    outcome.attempt !== null ||
    ["collector_unavailable", "not_applicable"].includes(outcome.reasonCode)
  );
}

function pairResolution(pair) {
  if (pair.scope.objectiveComplete === true) return { resolved: true, mode: "objective" };
  if (!["blocked", "queued"].includes(pair.terminal.status)) {
    return { resolved: false, mode: "missing_scope_proofs" };
  }
  if (pair.terminal.status === "queued" && UNRESOLVED_QUEUE_CODES.has(pair.terminal.reasonCode)) {
    return { resolved: false, mode: pair.terminal.reasonCode };
  }
  if (!clean(pair.terminal.reason) || !clean(pair.terminal.nextAction)) {
    return { resolved: false, mode: "missing_exact_blocker_or_next_action" };
  }
  return { resolved: true, mode: "documented_blocker" };
}

function unresolvedPairRecord(pair) {
  const resolution = pairResolution(pair);
  const missingScopeReceipts = [];
  if (!pair.scope.recentBackfillComplete) missingScopeReceipts.push("recent_backfill");
  if (!pair.scope.historicalBackfillComplete) missingScopeReceipts.push("historical_backfill");
  if (!pair.scope.storedUnpublishedSurfaced) missingScopeReceipts.push("stored_unpublished");
  if (!pair.scope.scheduledIngestionCurrent) missingScopeReceipts.push("scheduler");
  if (!pair.scope.integrityVerified) missingScopeReceipts.push("integrity");
  return {
    pairKey: pair.pairKey,
    batchSlug: pair.batchSlug,
    entityType: pair.entity.type,
    entityId: pair.entity.id,
    platform: pair.platform,
    terminalStatus: pair.terminal.status,
    reasonCode: pair.terminal.reasonCode,
    reason: pair.terminal.reason,
    nextAction: pair.terminal.nextAction,
    resolutionMode: resolution.mode,
    missingScopeReceipts
  };
}

function normalizeReleaseProof(
  value,
  { kind, expectedStatus, expectedBatchSlugs, expectedPairIndex, run, generatedAt }
) {
  if (value === null || value === undefined) {
    return { valid: false, receipt: null, reason: RELEASE_PROOF_KINDS[kind].missing };
  }
  try {
    assertObject(value, `releaseProofs.${kind}`);
    if (value.schemaVersion !== INGESTION_PRODUCTION_RELEASE_PROOF_VERSION) {
      throw new Error(
        `releaseProofs.${kind}.schemaVersion must be ${INGESTION_PRODUCTION_RELEASE_PROOF_VERSION}.`
      );
    }
    if (clean(value.status) !== expectedStatus) {
      throw new Error(`releaseProofs.${kind}.status must be ${expectedStatus}.`);
    }
    const checkedAt = canonicalTimestamp(value.checkedAt, `releaseProofs.${kind}.checkedAt`);
    if (Date.parse(checkedAt) < Date.parse(run.startedAt) ||
        Date.parse(checkedAt) > Date.parse(generatedAt)) {
      throw new Error(`releaseProofs.${kind}.checkedAt must be within the campaign read window.`);
    }
    const receipt = {
      schemaVersion: value.schemaVersion,
      kind,
      receiptId: requiredText(value.receiptId, `releaseProofs.${kind}.receiptId`),
      status: expectedStatus,
      checkedAt,
      artifactDigest: requiredSha256(
        value.artifactDigest,
        `releaseProofs.${kind}.artifactDigest`
      ),
      toolVersion: requiredText(value.toolVersion, `releaseProofs.${kind}.toolVersion`),
      reason: operationalText(value.reason, `releaseProofs.${kind}.reason`),
      valid: true
    };
    if (["productionArtifact", "productionSample", "deployment"].includes(kind)) {
      receipt.revision = requiredText(value.revision, `releaseProofs.${kind}.revision`);
    }
    if (kind === "productionSample") {
      if (!Array.isArray(value.samples) || value.samples.length === 0) {
        throw new TypeError("releaseProofs.productionSample.samples must be a non-empty array.");
      }
      const sampleIds = new Set();
      const sampledBatches = new Set();
      const sampledPlatforms = new Set();
      const sampledBatchPlatforms = new Set();
      receipt.samples = value.samples.map((sample, index) => {
        assertObject(sample, `releaseProofs.productionSample.samples[${index}]`);
        const sampleId = requiredText(
          sample.sampleId,
          `releaseProofs.productionSample.samples[${index}].sampleId`
        );
        if (sampleIds.has(sampleId)) throw new Error(`Duplicate production sampleId ${sampleId}.`);
        sampleIds.add(sampleId);
        const batchSlug = requiredText(
          sample.batchSlug,
          `releaseProofs.productionSample.samples[${index}].batchSlug`
        );
        const platform = requiredText(
          sample.platform,
          `releaseProofs.productionSample.samples[${index}].platform`
        );
        if (!expectedBatchSlugs.includes(batchSlug)) {
          throw new Error(`Production sample ${sampleId} uses unknown batch ${batchSlug}.`);
        }
        if (!INGESTION_CORE_PLATFORMS.includes(platform)) {
          throw new Error(`Production sample ${sampleId} uses unsupported platform ${platform}.`);
        }
        if (sample.verified !== true) {
          throw new Error(`Production sample ${sampleId} must be explicitly verified.`);
        }
        const sampleCheckedAt = canonicalTimestamp(
          sample.checkedAt,
          `releaseProofs.productionSample.samples[${index}].checkedAt`
        );
        if (Date.parse(sampleCheckedAt) < Date.parse(run.startedAt) ||
            Date.parse(sampleCheckedAt) > Date.parse(generatedAt)) {
          throw new Error(`Production sample ${sampleId} checkedAt is outside the campaign read window.`);
        }
        const pairKey = requiredText(
          sample.pairKey,
          `releaseProofs.productionSample.samples[${index}].pairKey`
        );
        const expectedPair = expectedPairIndex.get(pairKey);
        if (!expectedPair) {
          throw new Error(`Production sample ${sampleId} references unknown pair ${pairKey}.`);
        }
        if (expectedPair.batchSlug !== batchSlug || expectedPair.platform !== platform) {
          throw new Error(
            `Production sample ${sampleId} pairKey does not match batch ${batchSlug} and platform ${platform}.`
          );
        }
        sampledBatches.add(batchSlug);
        sampledPlatforms.add(platform);
        sampledBatchPlatforms.add(`${batchSlug}\u0000${platform}`);
        return {
          sampleId,
          batchSlug,
          platform,
          pairKey,
          verified: true,
          checkedAt: sampleCheckedAt,
          reason: operationalText(
            sample.reason,
            `releaseProofs.productionSample.samples[${index}].reason`
          )
        };
      }).sort((left, right) => left.sampleId.localeCompare(right.sampleId));
      const missingBatches = expectedBatchSlugs.filter((batch) => !sampledBatches.has(batch));
      const missingPlatforms = INGESTION_CORE_PLATFORMS.filter(
        (platform) => !sampledPlatforms.has(platform)
      );
      const missingBatchPlatforms = expectedBatchSlugs.flatMap((batchSlug) =>
        INGESTION_CORE_PLATFORMS
          .filter((platform) =>
            !sampledBatchPlatforms.has(`${batchSlug}\u0000${platform}`)
          )
          .map((platform) => `${batchSlug}:${platform}`)
      );
      if (missingBatchPlatforms.length) {
        throw new Error(
          `Production samples are incomplete; missing batches [${missingBatches.join(", ")}] ` +
          `and platforms [${missingPlatforms.join(", ")}]; missing batch-platform ` +
          `combinations [${missingBatchPlatforms.join(", ")}].`
        );
      }
    }
    if (kind === "deployment") {
      if (value.environment !== "production") {
        throw new Error("releaseProofs.deployment.environment must be production.");
      }
      receipt.environment = "production";
    }
    return { valid: true, receipt };
  } catch (error) {
    return {
      valid: false,
      receipt: {
        kind,
        valid: false,
        validationError: error instanceof Error ? error.message : String(error)
      },
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

function normalizeInputArtifacts(values, generatedAt) {
  if (!Array.isArray(values)) throw new TypeError("inputArtifacts must be an array.");
  const seen = new Set();
  return values.map((value, index) => {
    assertObject(value, `inputArtifacts[${index}]`);
    const artifact = {
      kind: requiredText(value.kind, `inputArtifacts[${index}].kind`),
      path: requiredText(value.path, `inputArtifacts[${index}].path`),
      sha256: requiredSha256(value.sha256, `inputArtifacts[${index}].sha256`),
      observedAt: canonicalTimestamp(
        value.observedAt,
        `inputArtifacts[${index}].observedAt`
      )
    };
    if (Date.parse(artifact.observedAt) > Date.parse(generatedAt)) {
      throw new Error(`inputArtifacts[${index}].observedAt cannot exceed generatedAt.`);
    }
    const identity = `${artifact.kind}:${artifact.path}`;
    if (seen.has(identity)) throw new Error(`Duplicate input artifact ${identity}.`);
    seen.add(identity);
    return artifact;
  }).sort((left, right) =>
    left.kind.localeCompare(right.kind) || left.path.localeCompare(right.path)
  );
}

function sha256CoverageReceipt(receipt, expectedCatalogManifest) {
  const hash = createHash("sha256");
  for (const chunk of streamIngestionCoverageReceiptJson(receipt, {
    expectedCatalogManifest
  })) hash.update(chunk);
  return hash.digest("hex");
}

function sha256Stable(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function percent(numerator, denominator) {
  if (!denominator) return 0;
  return Number(((numerator / denominator) * 100).toFixed(2));
}

function* chunkString(value, maxChunkCharacters) {
  for (let index = 0; index < value.length; index += maxChunkCharacters) {
    yield value.slice(index, index + maxChunkCharacters);
  }
}

function operationalText(value, label) {
  const text = requiredText(value, label);
  if (text.length < 16) throw new Error(`${label} must record an exact operational reason.`);
  return text;
}

function canonicalTimestamp(value, label) {
  const text = requiredText(value, label);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== text) {
    throw new TypeError(`${label} must be a canonical ISO-8601 UTC timestamp.`);
  }
  return text;
}

function requiredSha256(value, label) {
  const text = requiredText(value, label).toLowerCase();
  if (!SHA256.test(text)) throw new TypeError(`${label} must be a lowercase sha256 digest.`);
  return text;
}

function requiredText(value, label) {
  const text = clean(value);
  if (!text) throw new TypeError(`${label} is required.`);
  return text;
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertObject(value, label) {
  if (!isObject(value)) throw new TypeError(`${label} must be an object.`);
}
