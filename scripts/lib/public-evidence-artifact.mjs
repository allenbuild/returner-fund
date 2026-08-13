import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const PUBLIC_EVIDENCE_ARTIFACT_MAX_BYTES = 75 * 1024 * 1024;
export const PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_MAX_BYTES = 75 * 1024 * 1024;
export const PUBLIC_EVIDENCE_LEGACY_MAX_BYTES = 128 * 1024 * 1024;
export const PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_PATH =
  "outputs/public-ingestion-operational-ledger-current.json";
export const PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_VERSION =
  "public-ingestion-operational-ledger.v1";
export const PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_REFERENCE_VERSION =
  "public-evidence-operational-ledger-reference.v1";

export const PUBLIC_EVIDENCE_OPERATIONAL_KEYS = Object.freeze([
  "failures",
  "attempts",
  "discoveryAttempts",
  "sourceDiscoveryPaths"
]);

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function serializeCompactPublicEvidenceArtifact(
  value,
  { maxBytes = PUBLIC_EVIDENCE_ARTIFACT_MAX_BYTES } = {}
) {
  const body = serializeCompactJson(value, "Public evidence artifact");
  assertPublicEvidenceArtifactSize(body, { maxBytes });
  return body;
}

export function serializeCompactPublicEvidenceOperationalLedger(
  value,
  { maxBytes = PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_MAX_BYTES } = {}
) {
  const body = serializeCompactJson(value, "Public evidence operational ledger");
  assertPublicEvidenceOperationalLedgerSize(body, { maxBytes });
  return body;
}

export function assertPublicEvidenceArtifactSize(
  body,
  { maxBytes = PUBLIC_EVIDENCE_ARTIFACT_MAX_BYTES } = {}
) {
  return assertArtifactSize(body, maxBytes, "Public evidence artifact");
}

export function assertPublicEvidenceOperationalLedgerSize(
  body,
  { maxBytes = PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_MAX_BYTES } = {}
) {
  return assertArtifactSize(body, maxBytes, "Public evidence operational ledger");
}

/**
 * Extract the four operational collections from one hydrated/legacy public
 * snapshot. The two returned JSON bodies are deterministic and individually
 * bounded below GitHub's 100 MiB hard limit.
 */
export function buildPublicEvidenceArtifactPair(
  snapshot,
  {
    ledgerRelativePath = PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_PATH,
    canonicalMaxBytes = PUBLIC_EVIDENCE_ARTIFACT_MAX_BYTES,
    ledgerMaxBytes = PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_MAX_BYTES
  } = {}
) {
  assertPlainObject(snapshot, "Public evidence snapshot");
  const normalizedLedgerPath = validateLedgerRelativePath(ledgerRelativePath);
  if (Object.hasOwn(snapshot, "operationalLedgerRef")) {
    throw new Error(
      "Public evidence snapshot is already split; hydrate it before rebuilding the artifact pair."
    );
  }
  const operational = normalizeOperationalCollections(snapshot, {
    requireOwnProperties: true,
    label: "Public evidence snapshot"
  });
  const operationalLedger = {
    schemaVersion: PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_VERSION,
    failures: operational.failures,
    attempts: operational.attempts,
    discoveryAttempts: operational.discoveryAttempts,
    sourceDiscoveryPaths: operational.sourceDiscoveryPaths
  };
  const ledgerBody = serializeCompactPublicEvidenceOperationalLedger(
    operationalLedger,
    { maxBytes: ledgerMaxBytes }
  );
  const reference = {
    schemaVersion: PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_REFERENCE_VERSION,
    path: normalizedLedgerPath,
    sha256: sha256(ledgerBody),
    bytes: Buffer.byteLength(ledgerBody),
    counts: operationalCounts(operational)
  };
  const canonical = publicEvidenceWithoutOperationalCollections(snapshot, reference);
  const canonicalBody = serializeCompactPublicEvidenceArtifact(canonical, {
    maxBytes: canonicalMaxBytes
  });
  return {
    canonical,
    canonicalBody,
    canonicalSha256: sha256(canonicalBody),
    operationalLedger,
    ledgerBody,
    ledgerSha256: reference.sha256,
    reference
  };
}

/**
 * Hydrate a split public snapshot from the exact ledger bytes named by its
 * reference. Legacy embedded snapshots remain readable during the migration.
 */
export function hydratePublicEvidenceArtifact(
  canonical,
  ledgerSource = null,
  {
    expectedLedgerPath = PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_PATH,
    ledgerMaxBytes = PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_MAX_BYTES
  } = {}
) {
  assertPlainObject(canonical, "Public evidence artifact");
  const reference = canonical.operationalLedgerRef;
  if (reference === undefined) {
    return {
      ...canonical,
      ...normalizeOperationalCollections(canonical, {
        requireOwnProperties: false,
        label: "Legacy public evidence artifact"
      })
    };
  }
  for (const key of PUBLIC_EVIDENCE_OPERATIONAL_KEYS) {
    if (Object.hasOwn(canonical, key)) {
      throw new Error(`Split public evidence artifact must not embed ${key}.`);
    }
  }
  validateOperationalLedgerReference(reference, { expectedLedgerPath });
  if (ledgerSource === null || ledgerSource === undefined) {
    throw new Error(`Public evidence operational ledger is required at ${reference.path}.`);
  }
  const ledgerBody = sourceBytes(ledgerSource);
  assertPublicEvidenceOperationalLedgerSize(ledgerBody, { maxBytes: ledgerMaxBytes });
  if (ledgerBody.length !== reference.bytes) {
    throw new Error(
      `Public evidence operational ledger byte count mismatch: expected ${reference.bytes}, received ${ledgerBody.length}.`
    );
  }
  const actualHash = sha256(ledgerBody);
  if (actualHash !== reference.sha256) {
    throw new Error(
      `Public evidence operational ledger SHA-256 mismatch: expected ${reference.sha256}, received ${actualHash}.`
    );
  }
  const ledger = parseJsonSource(ledgerBody, "Public evidence operational ledger");
  validateOperationalLedger(ledger);
  const operational = normalizeOperationalCollections(ledger, {
    requireOwnProperties: true,
    label: "Public evidence operational ledger"
  });
  const counts = operationalCounts(operational);
  for (const key of PUBLIC_EVIDENCE_OPERATIONAL_KEYS) {
    if (counts[key] !== reference.counts[key]) {
      throw new Error(
        `Public evidence operational ledger ${key} count mismatch: expected ${reference.counts[key]}, received ${counts[key]}.`
      );
    }
  }
  const hydrated = {};
  for (const [key, value] of Object.entries(canonical)) {
    if (key !== "operationalLedgerRef") hydrated[key] = value;
  }
  return { ...hydrated, ...operational };
}

export async function hydratePublicEvidenceArtifactWithLoader(
  canonical,
  {
    loadLedger,
    expectedLedgerPath = PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_PATH,
    ledgerMaxBytes = PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_MAX_BYTES
  } = {}
) {
  if (!canonical || !Object.hasOwn(canonical, "operationalLedgerRef")) {
    return hydratePublicEvidenceArtifact(canonical, null, {
      expectedLedgerPath,
      ledgerMaxBytes
    });
  }
  if (typeof loadLedger !== "function") {
    throw new TypeError("loadLedger must be a function for a split public evidence artifact.");
  }
  const reference = canonical.operationalLedgerRef;
  validateOperationalLedgerReference(reference, { expectedLedgerPath });
  const ledgerSource = await loadLedger(reference.path);
  return hydratePublicEvidenceArtifact(canonical, ledgerSource, {
    expectedLedgerPath,
    ledgerMaxBytes
  });
}

export async function readPublicEvidenceArtifact(
  canonicalPath,
  {
    rootDir = process.cwd(),
    expectedLedgerPath = PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_PATH,
    readFileImpl = readFile
  } = {}
) {
  const rootPath = resolve(rootDir);
  const resolvedCanonicalPath = resolve(rootPath, canonicalPath);
  const canonicalBytes = sourceBytes(await readFileImpl(resolvedCanonicalPath));
  const canonical = parseJsonSource(canonicalBytes, `Public evidence artifact ${resolvedCanonicalPath}`);
  const split = Boolean(canonical && Object.hasOwn(canonical, "operationalLedgerRef"));
  assertPublicEvidenceArtifactSize(canonicalBytes, {
    maxBytes: split ? PUBLIC_EVIDENCE_ARTIFACT_MAX_BYTES : PUBLIC_EVIDENCE_LEGACY_MAX_BYTES
  });
  let ledgerBytes = null;
  let ledgerPath = null;
  const snapshot = await hydratePublicEvidenceArtifactWithLoader(canonical, {
    expectedLedgerPath,
    loadLedger: async (relativePath) => {
      ledgerPath = resolveArtifactPath(rootPath, relativePath);
      ledgerBytes = sourceBytes(await readFileImpl(ledgerPath));
      return ledgerBytes;
    }
  });
  return {
    snapshot,
    canonical,
    canonicalPath: resolvedCanonicalPath,
    canonicalBytes,
    canonicalSha256: sha256(canonicalBytes),
    ledgerPath,
    ledgerBytes,
    ledgerSha256: ledgerBytes ? sha256(ledgerBytes) : null,
    reference: canonical.operationalLedgerRef ?? null,
    split
  };
}

/**
 * Publish a verified pair. Both temporary files are parsed and hash-checked
 * before either destination changes. The ledger is installed first and the
 * canonical reference last; a recoverable rename failure rolls the ledger
 * back, while an abrupt crash is detected by fail-closed hydration.
 */
export async function writePublicEvidenceArtifactPairAtomic({
  rootDir = process.cwd(),
  canonicalPath,
  snapshot,
  ledgerRelativePath = PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_PATH,
  expectedCanonicalSha256,
  expectedLedgerSha256,
  readFileImpl = readFile,
  writeFileImpl = writeFile,
  renameImpl = rename,
  removeImpl = rm,
  mkdirImpl = mkdir,
  statImpl = stat
} = {}) {
  const rootPath = resolve(rootDir);
  const resolvedCanonicalPath = resolve(
    rootPath,
    requiredText(canonicalPath, "canonicalPath")
  );
  const normalizedLedgerPath = validateLedgerRelativePath(ledgerRelativePath);
  const resolvedLedgerPath = resolveArtifactPath(rootPath, normalizedLedgerPath);
  const pair = buildPublicEvidenceArtifactPair(snapshot, {
    ledgerRelativePath: normalizedLedgerPath
  });
  const currentCanonical = await readOptionalBytes(resolvedCanonicalPath, readFileImpl);
  const currentLedger = await readOptionalBytes(resolvedLedgerPath, readFileImpl);
  assertExpectedHash(
    currentCanonical,
    expectedCanonicalSha256,
    "Canonical public evidence artifact"
  );
  assertExpectedHash(
    currentLedger,
    expectedLedgerSha256,
    "Public evidence operational ledger"
  );
  const canonicalMode = await existingMode(resolvedCanonicalPath, statImpl, 0o644);
  const ledgerMode = await existingMode(resolvedLedgerPath, statImpl, canonicalMode);
  await Promise.all([
    mkdirImpl(dirname(resolvedCanonicalPath), { recursive: true }),
    mkdirImpl(dirname(resolvedLedgerPath), { recursive: true })
  ]);
  const nonce = `${process.pid}-${randomUUID()}`;
  const canonicalTemporary = `${resolvedCanonicalPath}.${nonce}.tmp`;
  const ledgerTemporary = `${resolvedLedgerPath}.${nonce}.tmp`;
  let ledgerPublished = false;
  let canonicalPublished = false;
  try {
    await Promise.all([
      writeFileImpl(canonicalTemporary, pair.canonicalBody, {
        flag: "wx",
        mode: canonicalMode
      }),
      writeFileImpl(ledgerTemporary, pair.ledgerBody, {
        flag: "wx",
        mode: ledgerMode
      })
    ]);
    const [temporaryCanonical, temporaryLedger] = await Promise.all([
      readFileImpl(canonicalTemporary),
      readFileImpl(ledgerTemporary)
    ]);
    verifyArtifactPairBytes(temporaryCanonical, temporaryLedger, pair);
    await assertUnchanged(
      resolvedCanonicalPath,
      currentCanonical,
      readFileImpl,
      "Canonical public evidence artifact"
    );
    await assertUnchanged(
      resolvedLedgerPath,
      currentLedger,
      readFileImpl,
      "Public evidence operational ledger"
    );
    await renameImpl(ledgerTemporary, resolvedLedgerPath);
    ledgerPublished = true;
    await renameImpl(canonicalTemporary, resolvedCanonicalPath);
    canonicalPublished = true;
  } catch (error) {
    if (ledgerPublished && !canonicalPublished) {
      try {
        await restoreArtifact({
          path: resolvedLedgerPath,
          previous: currentLedger,
          mode: ledgerMode,
          writeFileImpl,
          renameImpl,
          removeImpl
        });
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Public evidence pair publication failed and ledger rollback also failed."
        );
      }
    }
    throw error;
  } finally {
    await Promise.all([
      removeImpl(canonicalTemporary, { force: true }),
      removeImpl(ledgerTemporary, { force: true })
    ]);
  }
  const [publishedCanonical, publishedLedger] = await Promise.all([
    readFileImpl(resolvedCanonicalPath),
    readFileImpl(resolvedLedgerPath)
  ]);
  verifyArtifactPairBytes(publishedCanonical, publishedLedger, pair);
  return {
    ...pair,
    canonicalPath: resolvedCanonicalPath,
    ledgerPath: resolvedLedgerPath
  };
}

/**
 * Publish only the canonical half of an existing split artifact pair. This is
 * used by enrichers that mutate canonical evidence fields but must preserve
 * the operational ledger byte-for-byte. Both files are hash-checked before
 * the atomic rename so a stale checkpoint cannot overwrite concurrent work.
 */
export async function writePublicEvidenceCanonicalArtifactAtomic({
  rootDir = process.cwd(),
  canonicalPath,
  canonical,
  expectedCanonicalSha256,
  expectedLedgerSha256,
  expectedLedgerPath = PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_PATH,
  readFileImpl = readFile,
  writeFileImpl = writeFile,
  renameImpl = rename,
  removeImpl = rm,
  mkdirImpl = mkdir,
  statImpl = stat
} = {}) {
  const rootPath = resolve(rootDir);
  const resolvedCanonicalPath = resolve(
    rootPath,
    requiredText(canonicalPath, "canonicalPath")
  );
  assertPlainObject(canonical, "Canonical public evidence artifact");
  if (!Object.hasOwn(canonical, "operationalLedgerRef")) {
    throw new Error(
      "Canonical-only publication requires an existing split public evidence artifact."
    );
  }

  const normalizedLedgerPath = validateLedgerRelativePath(expectedLedgerPath);
  validateOperationalLedgerReference(canonical.operationalLedgerRef, {
    expectedLedgerPath: normalizedLedgerPath
  });
  const resolvedLedgerPath = resolveArtifactPath(
    rootPath,
    canonical.operationalLedgerRef.path
  );
  const [currentCanonical, currentLedger] = await Promise.all([
    readOptionalBytes(resolvedCanonicalPath, readFileImpl),
    readOptionalBytes(resolvedLedgerPath, readFileImpl)
  ]);
  if (currentCanonical === null) {
    throw new Error("Canonical public evidence artifact is missing.");
  }
  if (currentLedger === null) {
    throw new Error("Public evidence operational ledger is missing.");
  }
  if (expectedCanonicalSha256 === undefined || expectedLedgerSha256 === undefined) {
    throw new TypeError(
      "Canonical-only publication requires initial canonical and ledger SHA-256 values."
    );
  }
  assertExpectedHash(
    currentCanonical,
    expectedCanonicalSha256,
    "Canonical public evidence artifact"
  );
  assertExpectedHash(
    currentLedger,
    expectedLedgerSha256,
    "Public evidence operational ledger"
  );

  const currentCanonicalValue = parseJsonSource(
    currentCanonical,
    "Current canonical public evidence artifact"
  );
  if (!Object.hasOwn(currentCanonicalValue, "operationalLedgerRef")) {
    throw new Error(
      "Canonical-only publication cannot replace a legacy public evidence artifact."
    );
  }
  validateOperationalLedgerReference(currentCanonicalValue.operationalLedgerRef, {
    expectedLedgerPath: normalizedLedgerPath
  });
  if (
    JSON.stringify(currentCanonicalValue.operationalLedgerRef) !==
    JSON.stringify(canonical.operationalLedgerRef)
  ) {
    throw new Error(
      "Canonical-only publication must preserve the operational ledger reference exactly."
    );
  }

  // This validates the hash, byte count, schema, and row counts without
  // changing either member of the artifact pair.
  hydratePublicEvidenceArtifact(canonical, currentLedger, {
    expectedLedgerPath: normalizedLedgerPath
  });
  const canonicalBody = serializeCompactPublicEvidenceArtifact(canonical);
  const canonicalSha256 = sha256(canonicalBody);
  const ledgerSha256 = sha256(currentLedger);
  const canonicalMode = await existingMode(resolvedCanonicalPath, statImpl, 0o644);
  await mkdirImpl(dirname(resolvedCanonicalPath), { recursive: true });
  const canonicalTemporary = `${resolvedCanonicalPath}.${process.pid}-${randomUUID()}.tmp`;
  try {
    await writeFileImpl(canonicalTemporary, canonicalBody, {
      flag: "wx",
      mode: canonicalMode
    });
    const temporaryCanonical = await readFileImpl(canonicalTemporary);
    if (sha256(temporaryCanonical) !== canonicalSha256) {
      throw new Error(
        "Temporary canonical public evidence artifact did not match its planned SHA-256."
      );
    }
    hydratePublicEvidenceArtifact(
      parseJsonSource(temporaryCanonical, "Temporary canonical public evidence artifact"),
      currentLedger,
      { expectedLedgerPath: normalizedLedgerPath }
    );
    await assertUnchanged(
      resolvedCanonicalPath,
      currentCanonical,
      readFileImpl,
      "Canonical public evidence artifact"
    );
    await assertUnchanged(
      resolvedLedgerPath,
      currentLedger,
      readFileImpl,
      "Public evidence operational ledger"
    );
    await renameImpl(canonicalTemporary, resolvedCanonicalPath);
  } finally {
    await removeImpl(canonicalTemporary, { force: true });
  }

  const [publishedCanonical, publishedLedger] = await Promise.all([
    readFileImpl(resolvedCanonicalPath),
    readFileImpl(resolvedLedgerPath)
  ]);
  if (sha256(publishedCanonical) !== canonicalSha256) {
    throw new Error(
      "Published canonical public evidence artifact did not match its planned SHA-256."
    );
  }
  if (sha256(publishedLedger) !== ledgerSha256) {
    throw new Error(
      "Public evidence operational ledger changed during canonical-only publication."
    );
  }
  hydratePublicEvidenceArtifact(
    parseJsonSource(publishedCanonical, "Published canonical public evidence artifact"),
    publishedLedger,
    { expectedLedgerPath: normalizedLedgerPath }
  );
  return {
    canonical,
    canonicalBody,
    canonicalSha256,
    canonicalPath: resolvedCanonicalPath,
    ledgerPath: resolvedLedgerPath,
    ledgerSha256,
    reference: canonical.operationalLedgerRef
  };
}

function verifyArtifactPairBytes(canonicalSource, ledgerSource, expectedPair) {
  const canonicalBytes = sourceBytes(canonicalSource);
  const ledgerBytes = sourceBytes(ledgerSource);
  if (sha256(canonicalBytes) !== expectedPair.canonicalSha256) {
    throw new Error("Published public evidence artifact did not match its planned SHA-256.");
  }
  if (sha256(ledgerBytes) !== expectedPair.ledgerSha256) {
    throw new Error("Published public evidence operational ledger did not match its planned SHA-256.");
  }
  const canonical = parseJsonSource(canonicalBytes, "Published public evidence artifact");
  hydratePublicEvidenceArtifact(canonical, ledgerBytes);
}

function publicEvidenceWithoutOperationalCollections(snapshot, reference) {
  const result = {};
  let insertedReference = false;
  for (const [key, value] of Object.entries(snapshot)) {
    if (PUBLIC_EVIDENCE_OPERATIONAL_KEYS.includes(key) || key === "operationalLedgerRef") {
      continue;
    }
    result[key] = value;
    if (key === "source") {
      result.operationalLedgerRef = reference;
      insertedReference = true;
    }
  }
  if (!insertedReference) {
    return { operationalLedgerRef: reference, ...result };
  }
  return result;
}

function normalizeOperationalCollections(value, { requireOwnProperties, label }) {
  const defaults = {
    failures: [],
    attempts: {},
    discoveryAttempts: [],
    sourceDiscoveryPaths: []
  };
  if (requireOwnProperties) {
    for (const key of PUBLIC_EVIDENCE_OPERATIONAL_KEYS) {
      if (!Object.hasOwn(value, key)) throw new Error(`${label}.${key} is required.`);
    }
  }
  const result = Object.fromEntries(
    PUBLIC_EVIDENCE_OPERATIONAL_KEYS.map((key) => [key, value[key] ?? defaults[key]])
  );
  for (const key of ["failures", "discoveryAttempts", "sourceDiscoveryPaths"]) {
    if (!Array.isArray(result[key])) throw new TypeError(`${label}.${key} must be an array.`);
  }
  assertPlainObject(result.attempts, `${label}.attempts`);
  return result;
}

function operationalCounts(operational) {
  return {
    failures: operational.failures.length,
    attempts: Object.keys(operational.attempts).length,
    discoveryAttempts: operational.discoveryAttempts.length,
    sourceDiscoveryPaths: operational.sourceDiscoveryPaths.length
  };
}

function validateOperationalLedgerReference(reference, { expectedLedgerPath }) {
  assertPlainObject(reference, "Public evidence operational ledger reference");
  if (reference.schemaVersion !== PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_REFERENCE_VERSION) {
    throw new Error(
      `Unsupported public evidence operational ledger reference version: ${reference.schemaVersion ?? "missing"}.`
    );
  }
  const normalizedPath = validateLedgerRelativePath(reference.path);
  if (normalizedPath !== validateLedgerRelativePath(expectedLedgerPath)) {
    throw new Error(
      `Public evidence operational ledger path must be ${expectedLedgerPath}; received ${normalizedPath}.`
    );
  }
  if (!SHA256_PATTERN.test(String(reference.sha256 ?? ""))) {
    throw new Error("Public evidence operational ledger reference requires a lowercase SHA-256.");
  }
  if (!Number.isSafeInteger(reference.bytes) || reference.bytes <= 0) {
    throw new Error("Public evidence operational ledger reference bytes must be positive.");
  }
  assertPlainObject(reference.counts, "Public evidence operational ledger reference counts");
  for (const key of PUBLIC_EVIDENCE_OPERATIONAL_KEYS) {
    if (!Number.isSafeInteger(reference.counts[key]) || reference.counts[key] < 0) {
      throw new Error(`Public evidence operational ledger reference count ${key} is invalid.`);
    }
  }
}

function validateOperationalLedger(ledger) {
  assertPlainObject(ledger, "Public evidence operational ledger");
  if (ledger.schemaVersion !== PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_VERSION) {
    throw new Error(
      `Unsupported public evidence operational ledger version: ${ledger.schemaVersion ?? "missing"}.`
    );
  }
  const expected = new Set(["schemaVersion", ...PUBLIC_EVIDENCE_OPERATIONAL_KEYS]);
  const unexpected = Object.keys(ledger).filter((key) => !expected.has(key));
  if (unexpected.length > 0) {
    throw new Error(
      `Public evidence operational ledger contains unexpected keys: ${unexpected.join(", ")}.`
    );
  }
}

function validateLedgerRelativePath(value) {
  const path = requiredText(value, "Public evidence operational ledger path").replace(/\\/g, "/");
  if (isAbsolute(path) || path.startsWith("/") || path.split("/").includes("..")) {
    throw new Error(`Unsafe public evidence operational ledger path: ${path}.`);
  }
  return path.replace(/^\.\//, "");
}

function resolveArtifactPath(rootPath, relativePath) {
  const normalized = validateLedgerRelativePath(relativePath);
  const resolved = resolve(rootPath, normalized);
  const child = relative(rootPath, resolved);
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`Public evidence operational ledger escapes repository root: ${relativePath}.`);
  }
  return resolved;
}

function assertArtifactSize(body, maxBytes, label) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError(`${label} maxBytes must be a positive safe integer.`);
  }
  const bytes = Buffer.isBuffer(body)
    ? body.length
    : Buffer.byteLength(String(body), "utf8");
  if (bytes >= maxBytes) {
    throw new Error(`${label} is ${bytes} bytes; it must remain below ${maxBytes} bytes.`);
  }
  return bytes;
}

function serializeCompactJson(value, label) {
  const json = JSON.stringify(value);
  if (typeof json !== "string") throw new TypeError(`${label} must be JSON serializable.`);
  return `${json}\n`;
}

function parseJsonSource(source, label) {
  try {
    return JSON.parse(sourceBytes(source).toString("utf8"));
  } catch (error) {
    throw new Error(
      `${label} is malformed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

function sourceBytes(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
}

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new TypeError(`${label} is required.`);
  return text;
}

async function readOptionalBytes(path, readFileImpl) {
  try {
    return sourceBytes(await readFileImpl(path));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function assertExpectedHash(bytes, expected, label) {
  if (expected === undefined) return;
  if (expected === null) {
    if (bytes !== null) throw new Error(`${label} appeared during publication.`);
    return;
  }
  if (!SHA256_PATTERN.test(String(expected))) {
    throw new TypeError(`${label} expected SHA-256 is invalid.`);
  }
  const actual = bytes === null ? null : sha256(bytes);
  if (actual !== expected) {
    throw new Error(`${label} changed before publication; expected ${expected}, received ${actual ?? "missing"}.`);
  }
}

async function assertUnchanged(path, expectedBytes, readFileImpl, label) {
  const current = await readOptionalBytes(path, readFileImpl);
  const expectedHash = expectedBytes === null ? null : sha256(expectedBytes);
  const currentHash = current === null ? null : sha256(current);
  if (expectedHash !== currentHash) {
    throw new Error(`${label} changed during pair publication; refusing to overwrite concurrent work.`);
  }
}

async function existingMode(path, statImpl, fallback) {
  try {
    return (await statImpl(path)).mode & 0o777;
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function restoreArtifact({
  path,
  previous,
  mode,
  writeFileImpl,
  renameImpl,
  removeImpl
}) {
  if (previous === null) {
    await removeImpl(path, { force: true });
    return;
  }
  const temporary = `${path}.${process.pid}-${randomUUID()}.rollback.tmp`;
  try {
    await writeFileImpl(temporary, previous, { flag: "wx", mode });
    await renameImpl(temporary, path);
  } finally {
    await removeImpl(temporary, { force: true });
  }
}
