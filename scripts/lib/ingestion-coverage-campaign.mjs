import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

export const INGESTION_COVERAGE_CAMPAIGN_VERSION =
  "ingestion-coverage-campaign.v1";
export const DEFAULT_INGESTION_COVERAGE_ARTIFACT_LIMIT_BYTES = 128 * 1024 * 1024;
export const DEFAULT_INGESTION_COVERAGE_MANIFEST_LIMIT_BYTES = 4 * 1024 * 1024;

const SHA256 = /^[a-f0-9]{64}$/;
const COLLECTOR_KINDS = new Set(["public", "github", "targeted"]);
const JSON_ROLES = Object.freeze([
  "catalogs",
  "expectedCatalogManifest",
  "pairScopes",
  "multiAttributionReviews",
  "releaseProofs"
]);

/**
 * Read and authenticate a campaign descriptor without discovering or inferring
 * missing production state from directory contents. Collector files are read
 * one at a time by an AsyncGenerator after all declared hashes are verified.
 */
export async function loadIngestionCoverageCampaign(
  manifestPath,
  {
    maxArtifactBytes = DEFAULT_INGESTION_COVERAGE_ARTIFACT_LIMIT_BYTES,
    maxManifestBytes = DEFAULT_INGESTION_COVERAGE_MANIFEST_LIMIT_BYTES
  } = {}
) {
  validateByteLimit(maxArtifactBytes, "maxArtifactBytes");
  validateByteLimit(maxManifestBytes, "maxManifestBytes");
  const manifestAbsolute = resolve(requiredText(manifestPath, "manifestPath"));
  const manifestRealPath = await realpath(manifestAbsolute);
  const campaignRoot = dirname(manifestRealPath);
  const manifestStat = await stat(manifestRealPath);
  assertBoundedRegularFile(manifestStat, maxManifestBytes, "campaign manifest");
  const manifestBytes = await readFile(manifestRealPath);
  const manifestSha256 = sha256Bytes(manifestBytes);
  const manifest = parseJson(manifestBytes, "campaign manifest");
  assertObject(manifest, "campaign manifest");
  if (manifest.schemaVersion !== INGESTION_COVERAGE_CAMPAIGN_VERSION) {
    throw new Error(
      `campaign manifest schemaVersion must be ${INGESTION_COVERAGE_CAMPAIGN_VERSION}.`
    );
  }
  const generatedAt = canonicalTimestamp(manifest.generatedAt, "manifest.generatedAt");
  const coverageGeneratedAt = canonicalTimestamp(
    manifest.coverageGeneratedAt ?? generatedAt,
    "manifest.coverageGeneratedAt"
  );
  const recentCoverageCutoff = optionalCanonicalTimestamp(
    manifest.recentCoverageCutoff,
    "manifest.recentCoverageCutoff"
  );
  if (Date.parse(coverageGeneratedAt) > Date.parse(generatedAt)) {
    throw new Error("manifest.coverageGeneratedAt cannot exceed manifest.generatedAt.");
  }
  if (
    recentCoverageCutoff &&
    Date.parse(recentCoverageCutoff) > Date.parse(coverageGeneratedAt)
  ) {
    throw new Error("manifest.recentCoverageCutoff cannot exceed coverageGeneratedAt.");
  }
  const manifestObservedAt = canonicalTimestamp(
    manifest.manifestObservedAt,
    "manifest.manifestObservedAt"
  );
  if (Date.parse(manifestObservedAt) > Date.parse(generatedAt)) {
    throw new Error("manifest.manifestObservedAt cannot exceed manifest.generatedAt.");
  }
  assertObject(manifest.artifacts, "manifest.artifacts");

  const descriptorState = {
    campaignRoot,
    generatedAt,
    maxArtifactBytes,
    paths: new Set([manifestRealPath])
  };
  const descriptors = {};
  for (const role of ["catalogs", "expectedCatalogManifest", "taskPlan", "runnerLog"]) {
    descriptors[role] = await verifyArtifactDescriptor(
      manifest.artifacts[role],
      role,
      descriptorState,
      { required: true }
    );
  }
  for (const role of ["pairScopes", "multiAttributionReviews", "releaseProofs"]) {
    descriptors[role] = await verifyArtifactDescriptor(
      manifest.artifacts[role],
      role,
      descriptorState,
      { required: false }
    );
  }

  if (!Array.isArray(manifest.artifacts.collectors)) {
    throw new TypeError("manifest.artifacts.collectors must be an array.");
  }
  descriptors.collectors = [];
  for (let index = 0; index < manifest.artifacts.collectors.length; index += 1) {
    const raw = manifest.artifacts.collectors[index];
    assertObject(raw, `manifest.artifacts.collectors[${index}]`);
    const kind = requiredText(raw.kind, `manifest.artifacts.collectors[${index}].kind`);
    if (!COLLECTOR_KINDS.has(kind)) {
      throw new Error(`Unsupported collector kind ${kind}.`);
    }
    const descriptor = await verifyArtifactDescriptor(
      raw,
      `collector:${kind}:${index}`,
      descriptorState,
      { required: true, expectedFormat: "json" }
    );
    descriptors.collectors.push({ ...descriptor, kind });
  }
  const rawSupporting = manifest.artifacts.supporting ?? [];
  if (!Array.isArray(rawSupporting)) {
    throw new TypeError("manifest.artifacts.supporting must be an array.");
  }
  descriptors.supporting = [];
  for (let index = 0; index < rawSupporting.length; index += 1) {
    const raw = rawSupporting[index];
    assertObject(raw, `manifest.artifacts.supporting[${index}]`);
    const kind = requiredText(raw.kind, `manifest.artifacts.supporting[${index}].kind`);
    const descriptor = await verifyArtifactDescriptor(
      raw,
      `supporting:${kind}:${index}`,
      descriptorState,
      { required: true }
    );
    descriptors.supporting.push({ ...descriptor, kind });
  }
  const rawHistoricalBackfills = manifest.artifacts.historicalBackfills ?? [];
  if (!Array.isArray(rawHistoricalBackfills)) {
    throw new TypeError("manifest.artifacts.historicalBackfills must be an array.");
  }
  descriptors.historicalBackfills = [];
  for (let index = 0; index < rawHistoricalBackfills.length; index += 1) {
    const raw = rawHistoricalBackfills[index];
    assertObject(raw, `manifest.artifacts.historicalBackfills[${index}]`);
    const journal = await verifyArtifactDescriptor(
      raw.journal,
      `historicalJournal:${index}`,
      descriptorState,
      { required: true, expectedFormat: "ndjson" }
    );
    const completionProofs = await verifyArtifactDescriptor(
      raw.completionProofs,
      `historicalCompletionProofs:${index}`,
      descriptorState,
      { required: false, expectedFormat: "json" }
    );
    assertObject(raw.limits ?? {}, `manifest.artifacts.historicalBackfills[${index}].limits`);
    descriptors.historicalBackfills.push({
      journal,
      completionProofs,
      limits: structuredClone(raw.limits ?? {})
    });
  }
  const rawHistoricalDepthBackfills = manifest.artifacts.historicalDepthBackfills ?? [];
  if (!Array.isArray(rawHistoricalDepthBackfills)) {
    throw new TypeError("manifest.artifacts.historicalDepthBackfills must be an array.");
  }
  descriptors.historicalDepthBackfills = [];
  for (let index = 0; index < rawHistoricalDepthBackfills.length; index += 1) {
    const raw = rawHistoricalDepthBackfills[index];
    assertObject(raw, `manifest.artifacts.historicalDepthBackfills[${index}]`);
    const journal = await verifyArtifactDescriptor(
      raw.journal,
      `historicalDepthJournal:${index}`,
      descriptorState,
      { required: true, expectedFormat: "ndjson" }
    );
    const completionProofs = await verifyArtifactDescriptor(
      raw.completionProofs,
      `historicalDepthCompletionProofs:${index}`,
      descriptorState,
      { required: false, expectedFormat: "json" }
    );
    assertObject(
      raw.limits ?? {},
      `manifest.artifacts.historicalDepthBackfills[${index}].limits`
    );
    descriptors.historicalDepthBackfills.push({
      journal,
      completionProofs,
      limits: structuredClone(raw.limits ?? {})
    });
  }

  assertFormat(descriptors.catalogs, "json", "catalogs");
  assertFormat(descriptors.expectedCatalogManifest, "json", "expectedCatalogManifest");
  assertFormat(descriptors.runnerLog, "ndjson", "runnerLog");
  if (!["json", "ndjson"].includes(descriptors.taskPlan.format)) {
    throw new Error("taskPlan artifact format must be json or ndjson.");
  }
  for (const role of JSON_ROLES) {
    if (descriptors[role]) assertFormat(descriptors[role], "json", role);
  }

  const catalogs = await readJsonArtifact(descriptors.catalogs);
  const expectedCatalogManifest = await readJsonArtifact(
    descriptors.expectedCatalogManifest
  );
  const taskPlan = descriptors.taskPlan.format === "ndjson"
    ? readNdjsonArtifact(descriptors.taskPlan)
    : await readJsonArtifact(descriptors.taskPlan);
  const runnerLogs = readNdjsonArtifact(descriptors.runnerLog);
  const pairScopes = descriptors.pairScopes
    ? await readJsonArtifact(descriptors.pairScopes)
    : [];
  const multiAttributionReviews = descriptors.multiAttributionReviews
    ? await readJsonArtifact(descriptors.multiAttributionReviews)
    : [];
  const releaseProofs = descriptors.releaseProofs
    ? await readJsonArtifact(descriptors.releaseProofs)
    : null;
  const historicalBackfills = [];
  for (const descriptor of descriptors.historicalBackfills) {
    const completionProofs = descriptor.completionProofs
      ? await readJsonArtifact(descriptor.completionProofs)
      : [];
    if (!Array.isArray(completionProofs)) {
      throw new TypeError("historical completion proofs artifact must contain a JSON array.");
    }
    historicalBackfills.push({
      journal: readArtifactChunks(descriptor.journal),
      artifact: adapterArtifactDescriptor(descriptor.journal),
      completionProofs,
      limits: descriptor.limits
    });
  }
  const historicalDepthBackfills = [];
  for (const descriptor of descriptors.historicalDepthBackfills) {
    const completionProofs = descriptor.completionProofs
      ? await readJsonArtifact(descriptor.completionProofs)
      : [];
    if (!Array.isArray(completionProofs)) {
      throw new TypeError(
        "historical-depth completion proofs artifact must contain a JSON array."
      );
    }
    historicalDepthBackfills.push({
      journal: readArtifactChunks(descriptor.journal),
      artifact: adapterArtifactDescriptor(descriptor.journal),
      completionProofs,
      limits: descriptor.limits
    });
  }

  if (!Array.isArray(catalogs)) throw new TypeError("catalogs artifact must contain a JSON array.");
  if (!Array.isArray(pairScopes)) {
    throw new TypeError("pairScopes artifact must contain a JSON array.");
  }
  if (!Array.isArray(multiAttributionReviews)) {
    throw new TypeError("multiAttributionReviews artifact must contain a JSON array.");
  }
  if (descriptors.taskPlan.format === "json" && !Array.isArray(taskPlan)) {
    throw new TypeError("JSON taskPlan artifact must contain an array.");
  }

  const inputArtifacts = [
    {
      kind: "campaign_manifest",
      path: relative(campaignRoot, manifestRealPath) || ".",
      sha256: manifestSha256,
      observedAt: manifestObservedAt
    },
    ...Object.entries(descriptors)
      .filter(([role, descriptor]) =>
        ![
          "collectors",
          "supporting",
          "historicalBackfills",
          "historicalDepthBackfills"
        ].includes(role) && descriptor
      )
      .map(([role, descriptor]) => inputProvenance(role, descriptor)),
    ...descriptors.collectors.map((descriptor) =>
      inputProvenance(`collector_${descriptor.kind}`, descriptor)
    ),
    ...descriptors.supporting.map((descriptor) =>
      inputProvenance(`supporting_${descriptor.kind}`, descriptor)
    ),
    ...descriptors.historicalBackfills.flatMap((descriptor) => [
      inputProvenance("historical_journal", descriptor.journal),
      ...(descriptor.completionProofs
        ? [inputProvenance("historical_completion_proofs", descriptor.completionProofs)]
        : [])
    ]),
    ...descriptors.historicalDepthBackfills.flatMap((descriptor) => [
      inputProvenance("historical_depth_journal", descriptor.journal),
      ...(descriptor.completionProofs
        ? [inputProvenance(
            "historical_depth_completion_proofs",
            descriptor.completionProofs
          )]
        : [])
    ])
  ];

  return {
    manifest,
    expectedCatalogManifest,
    materializerInput: {
      runId: clean(manifest.runId) || null,
      idempotencyKey: requiredText(manifest.idempotencyKey, "manifest.idempotencyKey"),
      campaignKey: requiredText(manifest.campaignKey, "manifest.campaignKey"),
      generatedAt: coverageGeneratedAt,
      materializedAt: generatedAt,
      ...(recentCoverageCutoff ? { recentCoverageCutoff } : {}),
      catalogs,
      expectedCatalogManifest,
      taskPlan,
      collectorArtifacts: readCollectorArtifacts(descriptors.collectors),
      runnerLogs,
      runnerLogArtifact: adapterArtifactDescriptor(descriptors.runnerLog),
      pairScopes,
      multiAttributionReviews,
      historicalBackfills,
      historicalDepthBackfills,
      releaseProofs,
      inputArtifacts
    },
    provenance: {
      campaignRoot,
      manifestPath: manifestRealPath,
      manifestSha256,
      inputArtifacts
    }
  };
}

async function* readCollectorArtifacts(descriptors) {
  for (const descriptor of descriptors) {
    yield {
      kind: descriptor.kind,
      artifact: adapterArtifactDescriptor(descriptor),
      snapshot: await readJsonArtifact(descriptor)
    };
  }
}

async function* readArtifactChunks(descriptor) {
  yield* createReadStream(descriptor.absolutePath);
}

async function verifyArtifactDescriptor(
  raw,
  role,
  state,
  { required, expectedFormat = null }
) {
  if (raw === null || raw === undefined) {
    if (required) throw new TypeError(`manifest.artifacts.${role} is required.`);
    return null;
  }
  assertObject(raw, `manifest.artifacts.${role}`);
  const declaredPath = requiredText(raw.path, `manifest.artifacts.${role}.path`);
  if (isAbsolute(declaredPath)) {
    throw new Error(`manifest.artifacts.${role}.path must be relative to the campaign manifest.`);
  }
  const joined = resolve(state.campaignRoot, declaredPath);
  assertWithinRoot(joined, state.campaignRoot, `manifest.artifacts.${role}.path`);
  const artifactRealPath = await realpath(joined);
  assertWithinRoot(artifactRealPath, state.campaignRoot, `manifest.artifacts.${role}.path`);
  if (state.paths.has(artifactRealPath)) {
    throw new Error(`Campaign artifact path is declared more than once: ${declaredPath}.`);
  }
  state.paths.add(artifactRealPath);
  const artifactStat = await stat(artifactRealPath);
  assertBoundedRegularFile(artifactStat, state.maxArtifactBytes, role);
  const declaredSha256 = requiredSha256(
    raw.sha256,
    `manifest.artifacts.${role}.sha256`
  );
  const actualSha256 = await sha256File(artifactRealPath);
  if (declaredSha256 !== actualSha256) {
    throw new Error(`manifest.artifacts.${role}.sha256 does not match ${declaredPath}.`);
  }
  const observedAt = canonicalTimestamp(
    raw.observedAt,
    `manifest.artifacts.${role}.observedAt`
  );
  if (Date.parse(observedAt) > Date.parse(state.generatedAt)) {
    throw new Error(`manifest.artifacts.${role}.observedAt cannot exceed generatedAt.`);
  }
  const format = requiredText(raw.format, `manifest.artifacts.${role}.format`);
  if (expectedFormat && format !== expectedFormat) {
    throw new Error(`manifest.artifacts.${role}.format must be ${expectedFormat}.`);
  }
  return {
    role,
    path: declaredPath,
    absolutePath: artifactRealPath,
    sha256: actualSha256,
    observedAt,
    format,
    bytes: artifactStat.size
  };
}

async function readJsonArtifact(descriptor) {
  const bytes = await readFile(descriptor.absolutePath);
  return parseJson(bytes, descriptor.role);
}

async function* readNdjsonArtifact(descriptor) {
  const input = createReadStream(descriptor.absolutePath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const rawLine of lines) {
    lineNumber += 1;
    const line = rawLine.trim();
    if (!line) continue;
    try {
      yield JSON.parse(line);
    } catch (error) {
      throw new SyntaxError(
        `${descriptor.role} contains invalid NDJSON at line ${lineNumber}: ${error.message}`
      );
    }
  }
}

function inputProvenance(kind, descriptor) {
  return {
    kind,
    path: descriptor.path,
    sha256: descriptor.sha256,
    observedAt: descriptor.observedAt
  };
}

function adapterArtifactDescriptor(descriptor) {
  return {
    path: descriptor.path,
    sha256: descriptor.sha256,
    observedAt: descriptor.observedAt
  };
}

function assertFormat(descriptor, expected, role) {
  if (descriptor.format !== expected) {
    throw new Error(`${role} artifact format must be ${expected}.`);
  }
}

function assertWithinRoot(candidate, root, label) {
  const suffix = relative(root, candidate);
  if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new Error(`${label} escapes the campaign directory.`);
  }
}

function assertBoundedRegularFile(value, limit, label) {
  if (!value.isFile()) throw new TypeError(`${label} must resolve to a regular file.`);
  if (value.size > limit) {
    throw new Error(`${label} is ${value.size} bytes, exceeding the ${limit}-byte safety limit.`);
  }
}

function validateByteLimit(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new SyntaxError(`${label} contains invalid JSON: ${error.message}`);
  }
}

function canonicalTimestamp(value, label) {
  const text = requiredText(value, label);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== text) {
    throw new TypeError(`${label} must be a canonical ISO-8601 UTC timestamp.`);
  }
  return text;
}

function optionalCanonicalTimestamp(value, label) {
  if (value === null || value === undefined || value === "") return null;
  return canonicalTimestamp(value, label);
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

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
}
