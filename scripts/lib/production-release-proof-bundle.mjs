import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { validateArtifactManifest } from "./artifact-manifest.mjs";
import { normalizeAutonomousIngestionCatalogs } from
  "./ingestion-coverage-adapter.mjs";
import {
  INGESTION_CATALOG_MANIFEST_VERSION,
  computeIngestionCatalogSourceHash
} from "./ingestion-coverage-receipt.mjs";
import {
  INGESTION_PRODUCTION_RELEASE_PROOF_VERSION,
  PRODUCTION_GRAPH_BATCHES,
  PRODUCTION_GRAPH_CORE_PLATFORMS,
  captureProductionGraphSamples
} from "./production-graph-sampler.mjs";
import { auditProductionReleaseProofs } from
  "./production-release-proof-audit.mjs";

export const PRODUCTION_RELEASE_PROOF_BUNDLE_VERSION =
  "production-release-proof-bundle.v1";
export const PRODUCTION_DEPLOYMENT_ATTESTATION_VERSION =
  "production-deployment-attestation.v1";
export const PRODUCTION_RELEASE_PROOF_BUNDLE_TOOL_VERSION =
  "production-release-proof-bundle-capture.v1";

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const DEFAULT_MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_ATTESTATION_AGE_MS = 24 * 60 * 60 * 1_000;

/**
 * Build all four production-release receipts atomically. Local publication
 * bytes, independent deployment metadata, the anonymous live manifest, and
 * all 30 graph samples must reconcile before any receipt is returned.
 */
export async function captureProductionReleaseProofBundle({
  rootDir = process.cwd(),
  catalogs,
  expectedCatalogManifest,
  coveragePairs,
  artifactManifestPath = null,
  graphDir = null,
  benchmarkDir = null,
  deployedRevision,
  productionBaseUrl,
  deploymentAttestation,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxManifestBytes = DEFAULT_MAX_MANIFEST_BYTES,
  maxGraphResponseBytes = 24 * 1024 * 1024
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function.");
  const captureStartedAt = canonicalNow(now);
  const checkedTimeout = boundedInteger(timeoutMs, "timeoutMs", 50, 60_000);
  const checkedManifestBytes = boundedInteger(
    maxManifestBytes,
    "maxManifestBytes",
    1_024,
    16 * 1024 * 1024
  );
  const revision = requiredText(deployedRevision, "deployedRevision").toLowerCase();
  if (!GIT_REVISION.test(revision)) {
    throw new TypeError(
      "deployedRevision must be a full 40- or 64-character lowercase Git object ID."
    );
  }
  const baseUrl = normalizeProductionBaseUrl(productionBaseUrl);
  const root = resolve(rootDir);
  const manifestPath = resolve(
    artifactManifestPath ?? join(root, "public", "graph", "manifest.json")
  );
  const resolvedGraphDir = resolve(graphDir ?? join(root, "public", "graph"));
  const resolvedBenchmarkDir = resolve(benchmarkDir ?? join(root, "outputs", "benchmarks"));
  const normalizedCatalogs = normalizeAutonomousIngestionCatalogs(catalogs);
  const expectedManifest = normalizeExpectedManifest(
    expectedCatalogManifest,
    normalizedCatalogs
  );
  assertProductionBatchSet(expectedManifest);
  if (!Array.isArray(coveragePairs)) throw new TypeError("coveragePairs must be an array.");

  const blockers = [];
  let localManifest = null;
  let localManifestBytes = null;
  let localManifestSha256 = null;
  try {
    localManifestBytes = await readBoundedFile(
      manifestPath,
      checkedManifestBytes,
      "rebuilt graph manifest"
    );
    localManifestSha256 = sha256(localManifestBytes);
    localManifest = parseJson(localManifestBytes, "rebuilt graph manifest");
    const validation = await validateArtifactManifest(localManifest, {
      rootDir: root,
      graphDir: resolvedGraphDir,
      benchmarkDir: resolvedBenchmarkDir,
      manifestPath
    });
    if (!validation.ok) {
      blockers.push(...validation.errors.map((reason) => releaseBlocker(
        "rebuilt_manifest_invalid",
        reason,
        "Rebuild public/graph/manifest.json and every declared graph/benchmark artifact."
      )));
    }
  } catch (error) {
    blockers.push(releaseBlocker(
      "rebuilt_manifest_unreadable",
      errorMessage(error),
      "Provide a bounded, valid rebuilt public/graph/manifest.json and rerun capture."
    ));
  }

  const artifactDigest = clean(localManifest?.contentHash).toLowerCase();
  if (!SHA256.test(artifactDigest)) {
    blockers.push(releaseBlocker(
      "rebuilt_artifact_digest_invalid",
      "The rebuilt graph manifest does not contain a valid contentHash.",
      "Regenerate the artifact manifest from the exact rebuilt graph files."
    ));
  }

  const attestationAudit = auditDeploymentAttestation({
    value: deploymentAttestation,
    revision,
    artifactDigest,
    localManifestSha256,
    baseUrl,
    captureStartedAt
  });
  blockers.push(...attestationAudit.blockers);

  if (blockers.length > 0) {
    return blockedBundle({
      captureStartedAt,
      checkedAt: canonicalNow(now),
      revision,
      artifactDigest,
      expectedManifest,
      localManifestSha256,
      attestationAudit,
      blockers
    });
  }

  const liveManifest = await fetchLiveManifest({
    url: attestationAudit.manifestUrl,
    fetchImpl,
    timeoutMs: checkedTimeout,
    maxBytes: checkedManifestBytes,
    now
  });
  blockers.push(...liveManifest.blockers);
  if (liveManifest.sha256 !== localManifestSha256) {
    blockers.push(releaseBlocker(
      "live_manifest_bytes_mismatch",
      `Live manifest SHA-256 ${liveManifest.sha256 ?? "unavailable"} does not match rebuilt ${localManifestSha256}.`,
      "Deploy the exact rebuilt manifest bytes, independently verify the deployment, and rerun."
    ));
  }
  if (liveManifest.sha256 !== attestationAudit.manifestSha256) {
    blockers.push(releaseBlocker(
      "live_manifest_attestation_mismatch",
      "Live manifest bytes do not match the independently verified deployment metadata.",
      "Refresh the independent deployment attestation from the deployed production revision."
    ));
  }
  if (clean(liveManifest.value?.contentHash).toLowerCase() !== artifactDigest) {
    blockers.push(releaseBlocker(
      "live_artifact_digest_mismatch",
      "Live manifest contentHash does not match the rebuilt artifact digest.",
      "Deploy the exact validated graph artifact set and rerun capture."
    ));
  }
  if (blockers.length > 0) {
    return blockedBundle({
      captureStartedAt,
      checkedAt: canonicalNow(now),
      revision,
      artifactDigest,
      expectedManifest,
      localManifestSha256,
      attestationAudit,
      liveManifest,
      blockers
    });
  }

  const sampleCapture = await captureProductionGraphSamples({
    coveragePairs,
    baseUrl: baseUrl.toString(),
    artifactDigest,
    revision,
    fetchImpl,
    now,
    timeoutMs: checkedTimeout,
    maxResponseBytes: maxGraphResponseBytes
  });
  if (
    sampleCapture.productionSample === null ||
    sampleCapture.summary?.verifiedCells !== 30 ||
    sampleCapture.productionSample?.samples?.length !== 30
  ) {
    blockers.push(releaseBlocker(
      "production_sample_cartesian_incomplete",
      `Production sampler verified ${sampleCapture.summary?.verifiedCells ?? 0}/30 cells.`,
      "Resolve every blocked batch-platform sample and rerun the complete three-batch capture."
    ));
    return blockedBundle({
      captureStartedAt,
      checkedAt: canonicalNow(now),
      revision,
      artifactDigest,
      expectedManifest,
      localManifestSha256,
      attestationAudit,
      liveManifest,
      sampleCapture,
      blockers
    });
  }

  const checkedAt = canonicalNow(now);
  const expectedManifestDigest = sha256Stable(expectedManifest);
  const releaseProofs = {
    expectedManifest: proofReceipt({
      kind: "expectedManifest",
      status: "verified",
      checkedAt,
      artifactDigest: expectedManifestDigest,
      reason:
        "The independently supplied expected catalog manifest exactly reconciles with all normalized canonical catalogs."
    }),
    productionArtifact: proofReceipt({
      kind: "productionArtifact",
      status: "rebuilt",
      checkedAt,
      artifactDigest,
      revision,
      reason:
        `The rebuilt graph manifest and every declared graph/benchmark file passed exact digest and byte-size validation for revision ${revision}.`
    }),
    productionSample: sampleCapture.productionSample,
    deployment: proofReceipt({
      kind: "deployment",
      status: "verified",
      checkedAt,
      artifactDigest,
      revision,
      environment: "production",
      reason:
        `Independent ${attestationAudit.provider} deployment metadata and anonymous live manifest bytes identify production deployment ${attestationAudit.deploymentId} at revision ${revision}.`
    })
  };

  let audit;
  try {
    audit = auditProductionReleaseProofs({
      releaseProofs,
      catalogs: normalizedCatalogs,
      expectedCatalogManifest: expectedManifest,
      runStartedAt: captureStartedAt,
      generatedAt: checkedAt
    });
  } catch (error) {
    blockers.push(releaseBlocker(
      "cartesian_release_audit_failed",
      errorMessage(error),
      "Correct the exact release bindings and all 30 samples, then recapture the bundle."
    ));
    return blockedBundle({
      captureStartedAt,
      checkedAt,
      revision,
      artifactDigest,
      expectedManifest,
      localManifestSha256,
      attestationAudit,
      liveManifest,
      sampleCapture,
      blockers
    });
  }

  return {
    schemaVersion: PRODUCTION_RELEASE_PROOF_BUNDLE_VERSION,
    status: "verified",
    captureStartedAt,
    checkedAt,
    toolVersion: PRODUCTION_RELEASE_PROOF_BUNDLE_TOOL_VERSION,
    authentication: "none",
    revision,
    artifactDigest,
    expectedManifestSha256: expectedManifestDigest,
    rebuiltManifest: manifestBinding(localManifestSha256, localManifest),
    deploymentAttestation: attestationAudit.binding,
    liveManifest: liveManifest.binding,
    sampleCapture,
    releaseProofs,
    audit,
    blockers: []
  };
}

function blockedBundle({
  captureStartedAt,
  checkedAt,
  revision,
  artifactDigest,
  expectedManifest,
  localManifestSha256,
  attestationAudit,
  liveManifest = null,
  sampleCapture = null,
  blockers
}) {
  return {
    schemaVersion: PRODUCTION_RELEASE_PROOF_BUNDLE_VERSION,
    status: "blocked",
    captureStartedAt,
    checkedAt,
    toolVersion: PRODUCTION_RELEASE_PROOF_BUNDLE_TOOL_VERSION,
    authentication: "none",
    revision,
    artifactDigest: SHA256.test(artifactDigest) ? artifactDigest : null,
    expectedManifestSha256: sha256Stable(expectedManifest),
    rebuiltManifest: manifestBinding(localManifestSha256, null),
    deploymentAttestation: attestationAudit?.binding ?? null,
    liveManifest: liveManifest?.binding ?? null,
    sampleCapture,
    releaseProofs: emptyReleaseProofs(),
    audit: null,
    blockers: dedupeBlockers(blockers)
  };
}

function auditDeploymentAttestation({
  value,
  revision,
  artifactDigest,
  localManifestSha256,
  baseUrl,
  captureStartedAt
}) {
  const blockers = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      blockers: [releaseBlocker(
        "deployment_attestation_invalid",
        "Independent deployment metadata must be a JSON object.",
        "Export a verified production deployment attestation and rerun."
      )],
      binding: null
    };
  }
  const addMismatch = (code, reason) => blockers.push(releaseBlocker(
    code,
    reason,
    "Regenerate the independent deployment attestation from the exact production deployment."
  ));
  if (value.schemaVersion !== PRODUCTION_DEPLOYMENT_ATTESTATION_VERSION) {
    addMismatch("deployment_attestation_schema_mismatch", "Deployment attestation schema is unsupported.");
  }
  if (value.status !== "verified" || value.environment !== "production") {
    addMismatch("deployment_not_independently_verified", "Deployment attestation is not verified production metadata.");
  }
  const provider = clean(value.provider);
  const deploymentId = clean(value.deploymentId);
  const verificationMethod = clean(value.verificationMethod);
  if (!provider || !deploymentId || !verificationMethod) {
    addMismatch("deployment_attestation_provenance_missing", "Provider, deploymentId, and verificationMethod are required.");
  }
  const attestedRevision = clean(value.revision).toLowerCase();
  if (attestedRevision !== revision) {
    addMismatch("deployed_revision_mismatch", `Attested revision ${attestedRevision || "missing"} does not match ${revision}.`);
  }
  if (clean(value.artifactDigest).toLowerCase() !== artifactDigest) {
    addMismatch("deployed_artifact_digest_mismatch", "Attested artifact digest does not match the rebuilt manifest contentHash.");
  }
  const manifestSha256 = clean(value.manifestSha256).toLowerCase();
  if (manifestSha256 !== localManifestSha256) {
    addMismatch("deployed_manifest_digest_mismatch", "Attested manifest SHA-256 does not match the rebuilt manifest bytes.");
  }
  let productionUrl = null;
  let manifestUrl = null;
  try {
    productionUrl = normalizeProductionBaseUrl(value.productionUrl);
    manifestUrl = normalizeManifestUrl(value.manifestUrl, baseUrl);
    if (productionUrl.origin !== baseUrl.origin) {
      addMismatch("deployment_origin_mismatch", "Attested production origin differs from the requested production origin.");
    }
  } catch (error) {
    addMismatch("deployment_url_invalid", errorMessage(error));
  }
  let verifiedAt = null;
  try {
    verifiedAt = canonicalTimestamp(value.verifiedAt, "deploymentAttestation.verifiedAt");
    const age = Date.parse(captureStartedAt) - Date.parse(verifiedAt);
    if (age < 0 || age > MAX_ATTESTATION_AGE_MS) {
      addMismatch("deployment_attestation_stale", "Deployment attestation is future-dated or older than 24 hours.");
    }
  } catch (error) {
    addMismatch("deployment_attestation_timestamp_invalid", errorMessage(error));
  }
  const normalized = {
    schemaVersion: value.schemaVersion,
    status: value.status,
    environment: value.environment,
    provider,
    deploymentId,
    verificationMethod,
    productionUrl: productionUrl?.origin ?? null,
    manifestUrl: manifestUrl?.toString() ?? null,
    revision: attestedRevision,
    artifactDigest: clean(value.artifactDigest).toLowerCase(),
    manifestSha256,
    verifiedAt
  };
  return {
    blockers,
    provider,
    deploymentId,
    manifestUrl,
    manifestSha256,
    binding: {
      provider,
      deploymentId,
      verifiedAt,
      sha256: sha256Stable(normalized)
    }
  };
}

async function fetchLiveManifest({ url, fetchImpl, timeoutMs, maxBytes, now }) {
  if (!(url instanceof URL)) {
    return {
      sha256: null,
      value: null,
      binding: null,
      blockers: [releaseBlocker(
        "live_manifest_url_missing",
        "No verified live manifest URL is available.",
        "Supply an exact independent deployment attestation."
      )]
    };
  }
  const controller = new AbortController();
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      const error = new Error(`live manifest request timed out after ${timeoutMs}ms`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    const response = await Promise.race([
      fetchImpl(url, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "user-agent": "returner-production-release-proof/1.0"
        }
      }),
      deadline
    ]);
    if (!response?.ok || response.status !== 200) {
      throw new Error(`live manifest returned HTTP ${response?.status ?? "unknown"}`);
    }
    const contentType = clean(response.headers?.get?.("content-type")).toLowerCase();
    if (!contentType.includes("application/json")) {
      throw new Error(`live manifest content-type is ${contentType || "missing"}`);
    }
    if (response.redirected === true) throw new Error("live manifest redirected");
    if (response.url && new URL(response.url).toString() !== url.toString()) {
      throw new Error("live manifest resolved to an unexpected URL");
    }
    const bytes = await readBoundedResponse(response, maxBytes);
    const digest = sha256(bytes);
    const value = parseJson(bytes, "live graph manifest");
    const checkedAt = canonicalNow(now);
    return {
      sha256: digest,
      value,
      blockers: [],
      binding: {
        url: url.toString(),
        checkedAt,
        bytes: bytes.length,
        sha256: digest,
        authentication: "none"
      }
    };
  } catch (error) {
    return {
      sha256: null,
      value: null,
      binding: null,
      blockers: [releaseBlocker(
        "live_manifest_unverifiable",
        errorMessage(error),
        "Restore anonymous exact-byte access to the production graph manifest and rerun."
      )]
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function readBoundedResponse(response, maxBytes) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`declared content-length ${declared} exceeds ${maxBytes}`);
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error(`response exceeds ${maxBytes} bytes`);
    return bytes;
  }
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel("response byte limit exceeded");
      throw new Error(`response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size);
}

function proofReceipt({
  kind,
  status,
  checkedAt,
  artifactDigest,
  reason,
  revision = null,
  environment = null
}) {
  const binding = { kind, status, checkedAt, artifactDigest, revision, environment };
  return {
    schemaVersion: INGESTION_PRODUCTION_RELEASE_PROOF_VERSION,
    kind,
    receiptId: `release-${kind}-${sha256Stable(binding).slice(0, 32)}`,
    status,
    checkedAt,
    artifactDigest,
    toolVersion: PRODUCTION_RELEASE_PROOF_BUNDLE_TOOL_VERSION,
    reason,
    ...(revision ? { revision } : {}),
    ...(environment ? { environment } : {})
  };
}

function normalizeExpectedManifest(value, catalogs) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("expectedCatalogManifest must be an object.");
  }
  const expected = {
    version: INGESTION_CATALOG_MANIFEST_VERSION,
    batches: catalogs.map((catalog) => {
      const founders = catalog.companies.reduce(
        (sum, company) => sum + company.founders.length,
        0
      );
      return {
        batchSlug: catalog.batchSlug,
        sourcePath: catalog.sourcePath,
        sourceVersion: catalog.sourceVersion,
        sourceHash: computeIngestionCatalogSourceHash(catalog),
        companies: catalog.companies.length,
        founders,
        entities: catalog.companies.length + founders
      };
    }).sort((left, right) => left.batchSlug.localeCompare(right.batchSlug))
  };
  const actual = {
    version: value.version,
    batches: Array.isArray(value.batches)
      ? structuredClone(value.batches).sort((left, right) =>
          String(left.batchSlug ?? "").localeCompare(String(right.batchSlug ?? ""))
        )
      : null
  };
  if (stableJson(actual) !== stableJson(expected)) {
    throw new Error("expectedCatalogManifest does not match the canonical catalogs.");
  }
  return expected;
}

function assertProductionBatchSet(manifest) {
  const actual = manifest.batches.map((batch) => batch.batchSlug).sort();
  const expected = [...PRODUCTION_GRAPH_BATCHES].sort();
  if (stableJson(actual) !== stableJson(expected)) {
    throw new Error(
      `Release bundle requires exact production batches ${expected.join(", ")}.`
    );
  }
  if (PRODUCTION_GRAPH_CORE_PLATFORMS.length !== 10) {
    throw new Error("Release bundle requires the exact ten-platform sampler contract.");
  }
}

function normalizeProductionBaseUrl(value) {
  let url;
  try {
    url = new URL(requiredText(value, "productionBaseUrl"));
  } catch {
    throw new TypeError("productionBaseUrl must be an absolute HTTPS URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new TypeError("productionBaseUrl must be a credential-free HTTPS URL.");
  }
  url.pathname = "/";
  url.search = "";
  return url;
}

function normalizeManifestUrl(value, baseUrl) {
  const url = new URL(requiredText(value, "deploymentAttestation.manifestUrl"));
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.origin !== baseUrl.origin ||
    url.pathname !== "/graph/manifest.json" ||
    url.search
  ) {
    throw new TypeError(
      "deploymentAttestation.manifestUrl must be the exact credential-free production /graph/manifest.json URL."
    );
  }
  return url;
}

async function readBoundedFile(path, maxBytes, label) {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`${label} must be a regular file.`);
  if (metadata.size > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} bytes.`);
  }
  const bytes = await readFile(path);
  if (bytes.length !== metadata.size) throw new Error(`${label} changed while being read.`);
  return bytes;
}

function manifestBinding(sha, manifest) {
  if (!sha) return null;
  return {
    sha256: sha,
    contentHash: clean(manifest?.contentHash).toLowerCase() || null,
    ingestionRunId: clean(manifest?.ingestionRunId) || null,
    graphArtifacts: Array.isArray(manifest?.graphArtifacts)
      ? manifest.graphArtifacts.length
      : null
  };
}

function emptyReleaseProofs() {
  return {
    expectedManifest: null,
    productionArtifact: null,
    productionSample: null,
    deployment: null
  };
}

function releaseBlocker(code, reason, nextAction) {
  return { code, reason: String(reason), nextAction };
}

function dedupeBlockers(values) {
  return [...new Map(values.map((value) => [
    `${value.code}\u0000${value.reason}\u0000${value.nextAction}`,
    value
  ])).values()].sort((left, right) =>
    left.code.localeCompare(right.code) || left.reason.localeCompare(right.reason)
  );
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new SyntaxError(`${label} is invalid JSON: ${error.message}`);
  }
}

function canonicalNow(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("now() returned an invalid time.");
  return date.toISOString();
}

function canonicalTimestamp(value, label) {
  const text = requiredText(value, label);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== text) {
    throw new TypeError(`${label} must be a canonical ISO UTC timestamp.`);
  }
  return text;
}

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function requiredText(value, label) {
  const text = clean(value);
  if (!text) throw new TypeError(`${label} is required.`);
  return text;
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Stable(value) {
  return sha256(stableJson(value));
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

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
