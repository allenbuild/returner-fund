import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";

export const ARTIFACT_MANIFEST_VERSION = 2;
export const DEFAULT_ARTIFACT_MANIFEST_PATH = path.join("public", "graph", "manifest.json");

export const SUPPORTING_ARTIFACT_DESCRIPTORS = Object.freeze([
  Object.freeze({
    key: "authenticatedEvidenceLedger",
    paths: Object.freeze(["src/lib/social/logged-in-evidence-current.json"])
  }),
  Object.freeze({
    key: "topicFacets",
    paths: Object.freeze(["public/topic-facets"])
  }),
  Object.freeze({
    key: "rankedPostsSidecar",
    paths: Object.freeze(["src/lib/graph/ranked-posts-sidecar.generated.json"])
  }),
  Object.freeze({
    key: "timelines",
    paths: Object.freeze(["public/timelines"])
  }),
  Object.freeze({
    key: "scoringDiagnostics",
    paths: Object.freeze([
      "docs/outputs/scoring-diagnostics-v4-audit.json",
      "docs/outputs/scoring-diagnostics-v4-report.md"
    ])
  })
]);

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BENCHMARK_METADATA_FILENAMES = new Set(["daily-publication-receipt.json"]);
const REFRESH_TIMESTAMP_FIELDS = [
  "lastRefreshedAt",
  "refreshedAt",
  "lastSuccessfulRefreshAt",
  "metricsCheckedAt",
  "observedAt",
  "last_checked_at",
  "collectedAt"
];

export async function buildArtifactManifest({
  rootDir = process.cwd(),
  graphDir,
  benchmarkDir,
  manifestPath,
  ingestionRunId,
  publishedAt = new Date(),
  evidenceCollectedAt,
  oldestPlatformRefreshAt,
  allowEmptyGraphArtifacts = false
} = {}) {
  const paths = resolveArtifactPaths({ rootDir, graphDir, benchmarkDir, manifestPath });
  const normalizedRunId = requiredString(ingestionRunId, "ingestionRunId");
  const normalizedPublishedAt = isoTimestamp(publishedAt, "publishedAt");
  const [graphArtifacts, benchmarkArtifacts, supportingArtifacts] = await Promise.all([
    readArtifactDirectory(paths.graphDir, {
      kind: "graph",
      excludedFilename: path.dirname(paths.manifestPath) === paths.graphDir
        ? path.basename(paths.manifestPath)
        : undefined
    }),
    readArtifactDirectory(paths.benchmarkDir, {
      kind: "benchmark",
      excludedFilenames: BENCHMARK_METADATA_FILENAMES
    }),
    buildSupportingArtifactManifest({ rootDir: paths.rootDir })
  ]);

  if (graphArtifacts.length === 0 && !allowEmptyGraphArtifacts) {
    throw new Error(`No graph JSON artifacts found in ${paths.graphDir}.`);
  }

  const models = collectModels(graphArtifacts, benchmarkArtifacts);
  const derivedEvidenceCollectedAt = newestTimestamp(
    graphArtifacts.flatMap(({ json }) => [
      json.evidenceCollectedAt,
      json.metadata?.evidenceCollectedAt,
      json.publication?.evidenceCollectedAt,
      json.scoringContext?.evidenceAsOf
    ])
  );
  const derivedOldestPlatformRefreshAt = deriveOldestPlatformRefreshAt(graphArtifacts);
  const graphEntries = graphArtifacts.map(publicArtifactEntry);
  const benchmarkEntries = benchmarkArtifacts.map(publicArtifactEntry);
  const contentHash = artifactContentHash(graphEntries, benchmarkEntries, supportingArtifacts);

  return compactObject({
    schemaVersion: ARTIFACT_MANIFEST_VERSION,
    publishedAt: normalizedPublishedAt,
    ingestionRunId: normalizedRunId,
    evidenceCollectedAt: optionalIsoTimestamp(
      evidenceCollectedAt ?? derivedEvidenceCollectedAt,
      "evidenceCollectedAt"
    ),
    oldestPlatformRefreshAt: optionalIsoTimestamp(
      oldestPlatformRefreshAt ?? derivedOldestPlatformRefreshAt,
      "oldestPlatformRefreshAt"
    ),
    modelVersions: models.map(({ id, version }) => `${id}@${version}`),
    models,
    graphArtifacts: graphEntries,
    benchmarkArtifacts: benchmarkEntries,
    supportingArtifacts,
    contentHash
  });
}

export async function buildSupportingArtifactManifest({ rootDir = process.cwd() } = {}) {
  const resolvedRoot = path.resolve(rootDir);
  return Promise.all(SUPPORTING_ARTIFACT_DESCRIPTORS.map(async (descriptor) => {
    const files = [];
    for (const relativePath of descriptor.paths) {
      files.push(...await collectSupportingFiles(resolvedRoot, relativePath));
    }
    files.sort(compareText);
    if (files.length === 0) {
      throw new Error(`Supporting artifact ${descriptor.key} contains no files.`);
    }

    const entries = [];
    let totalByteSize = 0;
    for (const relativePath of files) {
      const file = await hashFile(path.join(resolvedRoot, ...relativePath.split("/")));
      totalByteSize += file.byteSize;
      entries.push({ relativePath, ...file });
    }

    return {
      key: descriptor.key,
      paths: [...descriptor.paths],
      fileCount: entries.length,
      totalByteSize,
      contentHash: sha256(JSON.stringify(entries))
    };
  }));
}

export const generateArtifactManifest = buildArtifactManifest;

export async function writeArtifactManifest(options = {}) {
  const paths = resolveArtifactPaths(options);
  const manifest = await buildArtifactManifest(options);
  await writeJsonAtomically(paths.manifestPath, manifest);
  return { manifest, manifestPath: paths.manifestPath };
}

export async function validateArtifactManifest(manifestOrOptions, maybeOptions = {}) {
  let manifest = manifestOrOptions;
  let options = maybeOptions;

  if (!looksLikeManifest(manifestOrOptions)) {
    options = manifestOrOptions ?? {};
    const paths = resolveArtifactPaths(options);
    try {
      manifest = JSON.parse(await readFile(paths.manifestPath, "utf8"));
    } catch (error) {
      return validationResult([
        error?.code === "ENOENT"
          ? `Missing manifest file: ${paths.manifestPath}`
          : `Could not read manifest ${paths.manifestPath}: ${error.message}`
      ]);
    }
  }

  const paths = resolveArtifactPaths(options);
  const errors = validateManifestShape(manifest, options);
  if (errors.length > 0) {
    return validationResult(errors, manifest);
  }

  let current;
  try {
    current = await buildArtifactManifest({
      ...options,
      rootDir: paths.rootDir,
      graphDir: paths.graphDir,
      benchmarkDir: paths.benchmarkDir,
      manifestPath: paths.manifestPath,
      ingestionRunId: options.expectedIngestionRunId ?? manifest.ingestionRunId,
      publishedAt: manifest.publishedAt,
      evidenceCollectedAt: options.evidenceCollectedAt,
      oldestPlatformRefreshAt: options.oldestPlatformRefreshAt,
      allowEmptyGraphArtifacts: true
    });
  } catch (error) {
    return validationResult([`Could not inspect published artifacts: ${error.message}`], manifest);
  }

  compareArtifactSets("graph", manifest.graphArtifacts, current.graphArtifacts, errors);
  compareArtifactSets("benchmark", manifest.benchmarkArtifacts, current.benchmarkArtifacts, errors);
  compareSupportingArtifactSets(manifest.supportingArtifacts, current.supportingArtifacts, errors);

  if (manifest.contentHash !== current.contentHash) {
    errors.push(
      `Overall content hash changed: expected ${manifest.contentHash}, received ${current.contentHash}.`
    );
  }
  if (!sameJson(manifest.modelVersions, current.modelVersions) || !sameJson(manifest.models, current.models)) {
    errors.push("Model version references are stale for the current artifact set.");
  }
  compareOptionalTimestamp(manifest, current, "evidenceCollectedAt", errors);
  compareOptionalTimestamp(manifest, current, "oldestPlatformRefreshAt", errors);

  return validationResult(errors, manifest, current);
}

export async function assertValidArtifactManifest(manifestOrOptions, maybeOptions) {
  const result = await validateArtifactManifest(manifestOrOptions, maybeOptions);
  if (!result.ok) {
    throw new Error(`Artifact manifest validation failed:\n- ${result.errors.join("\n- ")}`);
  }
  return result;
}

export async function writeJsonAtomically(targetPath, value) {
  const directory = path.dirname(targetPath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(targetPath)}.${process.pid}-${randomUUID()}.tmp`
  );
  let handle;

  await mkdir(directory, { recursive: true });
  try {
    handle = await open(temporaryPath, "wx", 0o644);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function resolveArtifactPaths({ rootDir = process.cwd(), graphDir, benchmarkDir, manifestPath } = {}) {
  const resolvedRoot = path.resolve(rootDir);
  return {
    rootDir: resolvedRoot,
    graphDir: path.resolve(graphDir ?? path.join(resolvedRoot, "public", "graph")),
    benchmarkDir: path.resolve(benchmarkDir ?? path.join(resolvedRoot, "outputs", "benchmarks")),
    manifestPath: path.resolve(manifestPath ?? path.join(resolvedRoot, DEFAULT_ARTIFACT_MANIFEST_PATH))
  };
}

async function readArtifactDirectory(
  directory,
  { kind, excludedFilename, excludedFilenames = new Set() } = {}
) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      if (kind === "benchmark") {
        return [];
      }
      throw new Error(`Missing ${kind} artifact directory: ${directory}`);
    }
    throw error;
  }

  const filenames = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".json") &&
        entry.name !== excludedFilename &&
        !excludedFilenames.has(entry.name)
    )
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  return Promise.all(filenames.map((filename) => readArtifact(path.join(directory, filename), filename, kind)));
}

async function readArtifact(filePath, filename, kind) {
  const bytes = await readFile(filePath);
  let json;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Invalid JSON in ${kind} artifact ${filePath}: ${error.message}`);
  }

  const generatedAtValue = kind === "graph" ? json.generatedAt : json.generatedAt ?? json.updatedAt;
  const generatedAt = isoTimestamp(generatedAtValue, `${kind} artifact ${filename} generatedAt`);
  return {
    filename,
    json,
    sha256: sha256(bytes),
    byteSize: bytes.byteLength,
    generatedAt,
    modelVersion: kind === "graph" ? optionalString(json.scoringContext?.modelVersion) : undefined
  };
}

async function collectSupportingFiles(rootDir, relativePath) {
  const absolutePath = path.resolve(rootDir, ...relativePath.split("/"));
  const info = await lstat(absolutePath);
  if (info.isFile()) {
    return [relativePath];
  }
  if (!info.isDirectory()) {
    throw new Error(`Supporting artifact path is not a regular file or directory: ${relativePath}.`);
  }

  const entries = (await readdir(absolutePath, { withFileTypes: true }))
    .sort((left, right) => compareText(left.name, right.name));
  const files = [];
  for (const entry of entries) {
    const childPath = `${relativePath}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...await collectSupportingFiles(rootDir, childPath));
    } else if (entry.isFile()) {
      files.push(childPath);
    } else {
      throw new Error(`Supporting artifact path is not a regular file: ${childPath}.`);
    }
  }
  return files;
}

async function hashFile(filePath) {
  const digest = createHash("sha256");
  let byteSize = 0;
  for await (const chunk of createReadStream(filePath)) {
    digest.update(chunk);
    byteSize += chunk.byteLength;
  }
  return { sha256: digest.digest("hex"), byteSize };
}

function publicArtifactEntry(artifact) {
  return compactObject({
    filename: artifact.filename,
    sha256: artifact.sha256,
    byteSize: artifact.byteSize,
    generatedAt: artifact.generatedAt,
    modelVersion: artifact.modelVersion
  });
}

function collectModels(graphArtifacts, benchmarkArtifacts) {
  const byKey = new Map();
  for (const { json } of graphArtifacts) {
    const id = optionalString(json.scoringContext?.modelId);
    const version = optionalString(json.scoringContext?.modelVersion);
    if (!id || !version) {
      continue;
    }
    byKey.set(`${id}@${version}`, compactObject({
      id,
      version,
      name: optionalString(json.scoringContext?.modelName)
    }));
  }

  const graphModelsByVersion = new Map([...byKey.values()].map((model) => [model.version, model]));
  for (const { json } of benchmarkArtifacts) {
    for (const observation of [...(json.daily ?? []), ...(json.weekly ?? [])]) {
      const version = optionalString(observation?.scoringModelVersion);
      if (!version || graphModelsByVersion.has(version)) {
        continue;
      }
      byKey.set(`unknown@${version}`, { id: "unknown", version });
    }
  }

  return [...byKey.values()].sort((left, right) =>
    `${left.id}@${left.version}`.localeCompare(`${right.id}@${right.version}`)
  );
}

function deriveOldestPlatformRefreshAt(graphArtifacts) {
  const newestByPlatform = new Map();
  const directCandidates = [];

  for (const { json } of graphArtifacts) {
    directCandidates.push(json.oldestPlatformRefreshAt, json.metadata?.oldestPlatformRefreshAt);
    for (const status of json.platformStatus ?? []) {
      const platform = optionalString(status?.platform);
      const refreshedAt = newestTimestamp(REFRESH_TIMESTAMP_FIELDS.map((field) => status?.[field]));
      if (platform && refreshedAt) {
        setNewestTimestamp(newestByPlatform, platform, refreshedAt);
      }
    }
    for (const evidence of json.evidence ?? []) {
      const platform = optionalString(evidence?.platform);
      const refreshedAt = newestTimestamp(REFRESH_TIMESTAMP_FIELDS.map((field) => evidence?.[field]));
      if (platform && refreshedAt) {
        setNewestTimestamp(newestByPlatform, platform, refreshedAt);
      }
    }
  }

  return oldestTimestamp([
    ...directCandidates,
    ...newestByPlatform.values()
  ]);
}

function setNewestTimestamp(map, key, value) {
  const current = map.get(key);
  if (!current || Date.parse(value) > Date.parse(current)) {
    map.set(key, value);
  }
}

function artifactContentHash(graphArtifacts, benchmarkArtifacts, supportingArtifacts) {
  return sha256(JSON.stringify({ graphArtifacts, benchmarkArtifacts, supportingArtifacts }));
}

function validateManifestShape(manifest, options) {
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return ["Manifest must be a JSON object."];
  }
  if (manifest.schemaVersion !== ARTIFACT_MANIFEST_VERSION) {
    errors.push(`Unsupported manifest schemaVersion: ${manifest.schemaVersion}.`);
  }
  validateTimestampField(manifest, "publishedAt", errors, true);
  if (!optionalString(manifest.ingestionRunId)) {
    errors.push("Manifest ingestionRunId must be a non-empty string.");
  }
  if (
    options.expectedIngestionRunId !== undefined &&
    manifest.ingestionRunId !== options.expectedIngestionRunId
  ) {
    errors.push(
      `Manifest ingestionRunId is ${manifest.ingestionRunId}; expected ${options.expectedIngestionRunId}.`
    );
  }
  validateTimestampField(manifest, "evidenceCollectedAt", errors, false);
  validateTimestampField(manifest, "oldestPlatformRefreshAt", errors, false);
  if (!Array.isArray(manifest.modelVersions) || !Array.isArray(manifest.models)) {
    errors.push("Manifest modelVersions and models must be arrays.");
  }
  validateArtifactEntries(manifest.graphArtifacts, "graph", errors);
  validateArtifactEntries(manifest.benchmarkArtifacts, "benchmark", errors);
  validateSupportingArtifactEntries(manifest.supportingArtifacts, errors);
  if (!SHA256_PATTERN.test(manifest.contentHash ?? "")) {
    errors.push("Manifest contentHash must be a lowercase SHA-256 digest.");
  }
  return errors;
}

function validateSupportingArtifactEntries(entries, errors) {
  if (!Array.isArray(entries)) {
    errors.push("Manifest supportingArtifacts must be an array.");
    return;
  }
  if (entries.length !== SUPPORTING_ARTIFACT_DESCRIPTORS.length) {
    errors.push(
      `Manifest supportingArtifacts must contain exactly ${SUPPORTING_ARTIFACT_DESCRIPTORS.length} entries.`
    );
  }

  const seen = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push("Manifest contains an invalid supporting artifact entry.");
      continue;
    }
    if (typeof entry.key !== "string" || !entry.key.trim()) {
      errors.push("Manifest supporting artifact key must be a non-empty string.");
    } else if (seen.has(entry.key)) {
      errors.push(`Manifest contains a duplicate supporting artifact reference: ${entry.key}.`);
    }
    seen.add(entry.key);
    if (!Array.isArray(entry.paths) || entry.paths.some((value) =>
      typeof value !== "string" || !value || path.isAbsolute(value) || value.split("/").includes("..")
    )) {
      errors.push(`Manifest supporting artifact ${entry.key} has unsafe paths.`);
    }
    if (!Number.isSafeInteger(entry.fileCount) || entry.fileCount < 1) {
      errors.push(`Manifest supporting artifact ${entry.key} has an invalid fileCount.`);
    }
    if (!Number.isSafeInteger(entry.totalByteSize) || entry.totalByteSize < 0) {
      errors.push(`Manifest supporting artifact ${entry.key} has an invalid totalByteSize.`);
    }
    if (!SHA256_PATTERN.test(entry.contentHash ?? "")) {
      errors.push(`Manifest supporting artifact ${entry.key} has an invalid contentHash.`);
    }
  }
}

function validateArtifactEntries(entries, kind, errors) {
  if (!Array.isArray(entries)) {
    errors.push(`Manifest ${kind}Artifacts must be an array.`);
    return;
  }
  const seen = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      errors.push(`Manifest contains an invalid ${kind} artifact entry.`);
      continue;
    }
    if (
      typeof entry.filename !== "string" ||
      !entry.filename.endsWith(".json") ||
      path.basename(entry.filename) !== entry.filename
    ) {
      errors.push(`Manifest contains an unsafe ${kind} artifact filename: ${entry.filename}.`);
    } else if (seen.has(entry.filename)) {
      errors.push(`Manifest contains a duplicate ${kind} artifact reference: ${entry.filename}.`);
    }
    seen.add(entry.filename);
    if (!SHA256_PATTERN.test(entry.sha256 ?? "")) {
      errors.push(`Manifest ${kind} artifact ${entry.filename} has an invalid SHA-256 digest.`);
    }
    if (!Number.isSafeInteger(entry.byteSize) || entry.byteSize < 0) {
      errors.push(`Manifest ${kind} artifact ${entry.filename} has an invalid byteSize.`);
    }
    if (!isIsoTimestamp(entry.generatedAt)) {
      errors.push(`Manifest ${kind} artifact ${entry.filename} has an invalid generatedAt.`);
    }
  }
}

function compareArtifactSets(kind, recorded, current, errors) {
  const recordedByFilename = new Map(recorded.map((entry) => [entry.filename, entry]));
  const currentByFilename = new Map(current.map((entry) => [entry.filename, entry]));

  for (const [filename, expected] of recordedByFilename) {
    const actual = currentByFilename.get(filename);
    if (!actual) {
      errors.push(`Missing ${kind} file for stale manifest reference: ${filename}.`);
      continue;
    }
    if (expected.sha256 !== actual.sha256 || expected.byteSize !== actual.byteSize) {
      errors.push(
        `Changed ${kind} file ${filename}: expected ${expected.sha256}/${expected.byteSize} bytes, ` +
        `received ${actual.sha256}/${actual.byteSize} bytes.`
      );
    }
    if (expected.generatedAt !== actual.generatedAt || expected.modelVersion !== actual.modelVersion) {
      errors.push(`Stale metadata reference for ${kind} file ${filename}.`);
    }
  }

  for (const filename of currentByFilename.keys()) {
    if (!recordedByFilename.has(filename)) {
      errors.push(`Unreferenced ${kind} file is missing from the manifest: ${filename}.`);
    }
  }
}

function compareSupportingArtifactSets(recorded, current, errors) {
  const recordedByKey = new Map(recorded.map((entry) => [entry.key, entry]));
  const currentByKey = new Map(current.map((entry) => [entry.key, entry]));

  for (const [key, expected] of recordedByKey) {
    const actual = currentByKey.get(key);
    if (!actual) {
      errors.push(`Manifest references unknown supporting artifact: ${key}.`);
      continue;
    }
    if (JSON.stringify(expected.paths) !== JSON.stringify(actual.paths)) {
      errors.push(`Supporting artifact paths changed for ${key}.`);
    }
    if (
      expected.fileCount !== actual.fileCount ||
      expected.totalByteSize !== actual.totalByteSize ||
      expected.contentHash !== actual.contentHash
    ) {
      errors.push(`Supporting artifact ${key} is stale.`);
    }
  }

  for (const key of currentByKey.keys()) {
    if (!recordedByKey.has(key)) {
      errors.push(`Manifest is missing supporting artifact: ${key}.`);
    }
  }
}

function compareOptionalTimestamp(recorded, current, field, errors) {
  if ((recorded[field] ?? null) !== (current[field] ?? null)) {
    errors.push(`Manifest ${field} is stale for the current artifact set.`);
  }
}

function validateTimestampField(value, field, errors, required) {
  if (value[field] === undefined && !required) {
    return;
  }
  if (!isIsoTimestamp(value[field])) {
    errors.push(`Manifest ${field} must be an ISO-8601 timestamp.`);
  }
}

function validationResult(errors, manifest, current) {
  return compactObject({
    ok: errors.length === 0,
    valid: errors.length === 0,
    errors,
    manifest,
    current
  });
}

function newestTimestamp(values) {
  return extremumTimestamp(values, (candidate, current) => candidate > current);
}

function oldestTimestamp(values) {
  return extremumTimestamp(values, (candidate, current) => candidate < current);
}

function extremumTimestamp(values, replacesCurrent) {
  let result;
  for (const value of values) {
    if (!isIsoTimestamp(value)) {
      continue;
    }
    if (!result || replacesCurrent(Date.parse(value), Date.parse(result))) {
      result = new Date(value).toISOString();
    }
  }
  return result;
}

function isoTimestamp(value, label) {
  const normalized = value instanceof Date ? value.toISOString() : value;
  if (!isIsoTimestamp(normalized)) {
    throw new Error(`${label} must be a valid ISO-8601 timestamp.`);
  }
  return new Date(normalized).toISOString();
}

function optionalIsoTimestamp(value, label) {
  return value === undefined || value === null || value === "" ? undefined : isoTimestamp(value, label);
}

function isIsoTimestamp(value) {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value));
}

function requiredString(value, label) {
  const normalized = optionalString(value);
  if (!normalized) {
    throw new Error(`${label} must be supplied as a non-empty string.`);
  }
  return normalized;
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function looksLikeManifest(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    ("schemaVersion" in value || "graphArtifacts" in value || "benchmarkArtifacts" in value)
  );
}
