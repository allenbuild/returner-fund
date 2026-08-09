import { createHash } from "node:crypto";

export const SCORING_AUDIT_SCHEMA_VERSION = 5;
export const SCORING_AUDIT_DETAIL_EXAMPLE_LIMIT = 32;
export const SCORING_AUDIT_MAX_BYTES = 48 * 1024 * 1024;

const BOUNDED_DETAIL_KEYS = new Set([
  "alias_changed_rows",
  "canonical_urls",
  "company_changes",
  "entity_ids",
  "evidence_ids",
  "findings",
  "groups",
  "owner_company_ids",
  "platform_post_ids",
  "ranked_companies",
  "removed_evidence_ids",
  "removed_rows",
  "rows"
]);

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RETENTION_FORMAT = "bounded_examples_with_full_collection_digests_v1";
const SELECTION_STRATEGY =
  "diagnostic_signature_coverage_then_evenly_spaced_source_order";

/**
 * Mutates an already validated full audit into its release-safe representation.
 * Aggregate fields and invariants remain untouched. Only repetitive detail arrays
 * longer than the configured example limit are replaced with deterministic
 * examples, with a full-array digest retained in the central manifest.
 */
export function applyBoundedScoringAuditRetention(payload, options = {}) {
  const exampleLimit = options.exampleLimit ?? SCORING_AUDIT_DETAIL_EXAMPLE_LIMIT;
  const artifactByteLimit = options.artifactByteLimit ?? SCORING_AUDIT_MAX_BYTES;

  assertPositiveInteger(exampleLimit, "exampleLimit");
  assertPositiveInteger(artifactByteLimit, "artifactByteLimit");
  if (exampleLimit > SCORING_AUDIT_DETAIL_EXAMPLE_LIMIT) {
    throw new Error(
      `Scoring audit detail limit ${exampleLimit} exceeds the release maximum ${SCORING_AUDIT_DETAIL_EXAMPLE_LIMIT}.`
    );
  }
  if (artifactByteLimit > SCORING_AUDIT_MAX_BYTES) {
    throw new Error(
      `Scoring audit byte limit ${artifactByteLimit} exceeds the release maximum ${SCORING_AUDIT_MAX_BYTES}.`
    );
  }
  if (!payload?.metadata || typeof payload.metadata !== "object") {
    throw new Error("Scoring audit metadata is required before detail retention.");
  }
  if (payload.metadata.detail_retention) {
    throw new Error("Scoring audit detail retention was already applied.");
  }

  const collections = [];
  boundValue(payload, [], collections, exampleLimit);
  collections.sort((left, right) => compareText(left.json_pointer, right.json_pointer));

  const totals = collections.reduce(
    (result, collection) => ({
      full_record_count: result.full_record_count + collection.total_count,
      retained_record_count: result.retained_record_count + collection.retained_count,
      omitted_record_count: result.omitted_record_count + collection.omitted_count
    }),
    { full_record_count: 0, retained_record_count: 0, omitted_record_count: 0 }
  );
  const fullDetailDigest = sha256(
    collections
      .map(
        (collection) =>
          `${collection.json_pointer}\0${collection.total_count}\0${collection.full_collection_sha256}\n`
      )
      .join("")
  );

  payload.metadata.schema_version = SCORING_AUDIT_SCHEMA_VERSION;
  payload.metadata.detail_retention = {
    format: RETENTION_FORMAT,
    selection_strategy: SELECTION_STRATEGY,
    example_limit_per_collection: exampleLimit,
    artifact_byte_limit: artifactByteLimit,
    bounded_collection_count: collections.length,
    ...totals,
    full_detail_sha256: fullDetailDigest,
    collection_manifest_sha256: sha256(canonicalJson(collections)),
    collections
  };

  validateBoundedScoringAuditRetention(payload);
  return payload;
}

export function serializeBoundedScoringAudit(payload) {
  const retention = validateBoundedScoringAuditRetention(payload);
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  const bytes = Buffer.byteLength(json);
  if (bytes > retention.artifact_byte_limit) {
    throw new Error(
      `Scoring diagnostics audit is ${bytes} bytes, exceeding the release limit of ${retention.artifact_byte_limit} bytes.`
    );
  }
  return { json, bytes };
}

export function validateBoundedScoringAuditRetention(payload) {
  if (payload?.metadata?.schema_version !== SCORING_AUDIT_SCHEMA_VERSION) {
    throw new Error(
      `Bounded scoring audit requires schema version ${SCORING_AUDIT_SCHEMA_VERSION}.`
    );
  }
  const retention = payload.metadata.detail_retention;
  if (!retention || retention.format !== RETENTION_FORMAT) {
    throw new Error("Bounded scoring audit detail-retention metadata is missing or invalid.");
  }
  assertPositiveInteger(
    retention.example_limit_per_collection,
    "detail_retention.example_limit_per_collection"
  );
  assertPositiveInteger(
    retention.artifact_byte_limit,
    "detail_retention.artifact_byte_limit"
  );
  if (retention.example_limit_per_collection > SCORING_AUDIT_DETAIL_EXAMPLE_LIMIT) {
    throw new Error("Bounded scoring audit example limit exceeds the release maximum.");
  }
  if (retention.artifact_byte_limit > SCORING_AUDIT_MAX_BYTES) {
    throw new Error("Bounded scoring audit byte limit exceeds the release maximum.");
  }
  if (!Array.isArray(retention.collections)) {
    throw new Error("Bounded scoring audit collection manifest must be an array.");
  }

  const sortedPointers = retention.collections
    .map((collection) => collection.json_pointer)
    .sort(compareText);
  if (
    new Set(sortedPointers).size !== sortedPointers.length ||
    canonicalJson(sortedPointers) !==
      canonicalJson(retention.collections.map((collection) => collection.json_pointer))
  ) {
    throw new Error("Bounded scoring audit collection pointers must be unique and sorted.");
  }

  const totals = {
    full_record_count: 0,
    retained_record_count: 0,
    omitted_record_count: 0
  };
  for (const collection of retention.collections) {
    assertNonNegativeInteger(collection.total_count, `${collection.json_pointer}.total_count`);
    assertNonNegativeInteger(
      collection.retained_count,
      `${collection.json_pointer}.retained_count`
    );
    assertNonNegativeInteger(collection.omitted_count, `${collection.json_pointer}.omitted_count`);
    assertNonNegativeInteger(
      collection.diagnostic_signature_count,
      `${collection.json_pointer}.diagnostic_signature_count`
    );
    assertNonNegativeInteger(
      collection.retained_signature_count,
      `${collection.json_pointer}.retained_signature_count`
    );
    if (
      collection.total_count !== collection.retained_count + collection.omitted_count ||
      collection.omitted_count <= 0 ||
      collection.retained_count > retention.example_limit_per_collection ||
      collection.retained_signature_count > collection.diagnostic_signature_count
    ) {
      throw new Error(`Invalid bounded scoring audit counts at ${collection.json_pointer}.`);
    }
    for (const field of ["full_collection_sha256", "retained_examples_sha256"]) {
      if (!SHA256_PATTERN.test(collection[field] ?? "")) {
        throw new Error(`Invalid ${field} at ${collection.json_pointer}.`);
      }
    }
    const retained = resolveJsonPointer(payload, collection.json_pointer);
    if (!Array.isArray(retained) || retained.length !== collection.retained_count) {
      throw new Error(`Retained scoring audit examples mismatch at ${collection.json_pointer}.`);
    }
    if (sha256(canonicalJson(retained)) !== collection.retained_examples_sha256) {
      throw new Error(`Retained scoring audit digest mismatch at ${collection.json_pointer}.`);
    }
    if (
      new Set(retained.map(diagnosticSignature)).size !== collection.retained_signature_count
    ) {
      throw new Error(`Retained scoring audit signature count mismatch at ${collection.json_pointer}.`);
    }

    totals.full_record_count += collection.total_count;
    totals.retained_record_count += collection.retained_count;
    totals.omitted_record_count += collection.omitted_count;
  }

  if (
    retention.bounded_collection_count !== retention.collections.length ||
    totals.full_record_count !== retention.full_record_count ||
    totals.retained_record_count !== retention.retained_record_count ||
    totals.omitted_record_count !== retention.omitted_record_count
  ) {
    throw new Error("Bounded scoring audit retention totals are inconsistent.");
  }
  if (
    retention.collection_manifest_sha256 !== sha256(canonicalJson(retention.collections))
  ) {
    throw new Error("Bounded scoring audit collection-manifest digest mismatch.");
  }
  const expectedFullDetailDigest = sha256(
    retention.collections
      .map(
        (collection) =>
          `${collection.json_pointer}\0${collection.total_count}\0${collection.full_collection_sha256}\n`
      )
      .join("")
  );
  if (
    !SHA256_PATTERN.test(retention.full_detail_sha256 ?? "") ||
    retention.full_detail_sha256 !== expectedFullDetailDigest
  ) {
    throw new Error("Bounded scoring audit full-detail digest mismatch.");
  }

  return retention;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort(compareText)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function resolveJsonPointer(value, pointer) {
  if (pointer === "") return value;
  if (typeof pointer !== "string" || !pointer.startsWith("/")) {
    throw new Error(`Invalid JSON pointer: ${pointer}`);
  }
  return pointer
    .slice(1)
    .split("/")
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce((current, token) => {
      if (current === null || current === undefined || !(token in Object(current))) {
        throw new Error(`JSON pointer does not resolve: ${pointer}`);
      }
      return current[token];
    }, value);
}

function boundValue(value, path, collections, exampleLimit) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => boundValue(item, [...path, index], collections, exampleLimit));
    return;
  }
  if (!value || typeof value !== "object") return;

  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    if (!Array.isArray(child) || !BOUNDED_DETAIL_KEYS.has(key) || child.length <= exampleLimit) {
      boundValue(child, childPath, collections, exampleLimit);
      continue;
    }

    const totalCount = child.length;
    const fullCollectionSha256 = sha256(canonicalJson(child));
    const diagnosticSignatureCount = new Set(child.map(diagnosticSignature)).size;
    const retained = selectDiagnosticExamples(child, exampleLimit);
    value[key] = retained;
    retained.forEach((item, index) =>
      boundValue(item, [...childPath, index], collections, exampleLimit)
    );

    collections.push({
      json_pointer: jsonPointer(childPath),
      field: key,
      total_count: totalCount,
      retained_count: retained.length,
      omitted_count: totalCount - retained.length,
      diagnostic_signature_count: diagnosticSignatureCount,
      retained_signature_count: new Set(retained.map(diagnosticSignature)).size,
      full_collection_sha256: fullCollectionSha256,
      retained_examples_sha256: sha256(canonicalJson(retained))
    });
  }
}

function selectDiagnosticExamples(items, limit) {
  if (items.length <= limit) return items;
  const indexed = items.map((value, index) => ({ value, index }));
  const buckets = new Map();
  for (const item of indexed) {
    const signature = diagnosticSignature(item.value);
    buckets.set(signature, [...(buckets.get(signature) ?? []), item]);
  }
  const bucketEntries = [...buckets.entries()].sort(([left], [right]) =>
    compareText(left, right)
  );
  const selectedIndexes = new Set();
  const bucketIndexes = evenlySpacedIndexes(
    bucketEntries.length,
    Math.min(limit, bucketEntries.length)
  );
  for (const bucketIndex of bucketIndexes) {
    selectedIndexes.add(bucketEntries[bucketIndex][1][0].index);
  }

  if (selectedIndexes.size < limit) {
    const unselected = indexed.filter((item) => !selectedIndexes.has(item.index));
    const fillIndexes = evenlySpacedIndexes(
      unselected.length,
      Math.min(limit - selectedIndexes.size, unselected.length)
    );
    for (const fillIndex of fillIndexes) {
      selectedIndexes.add(unselected[fillIndex].index);
    }
  }

  return [...selectedIndexes]
    .sort((left, right) => left - right)
    .map((index) => items[index]);
}

function diagnosticSignature(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return `${typeof value}:${String(value)}`;
  }
  const parts = [];
  for (const key of [
    "issue",
    "reason",
    "alias_group",
    "direction",
    "platform",
    "owner_scope",
    "name",
    "top_platform",
    "published_at_precision",
    "scored"
  ]) {
    if (value[key] !== undefined && value[key] !== null) {
      parts.push(`${key}=${String(value[key])}`);
    }
  }
  for (const key of ["reasons", "alias_groups", "platforms"]) {
    if (Array.isArray(value[key])) {
      parts.push(`${key}=${[...value[key]].map(String).sort(compareText).join(",")}`);
    }
  }
  if (Number.isFinite(value.score_delta) || Number.isFinite(value.rank_delta)) {
    parts.push(`score_delta=${deltaClass(value.score_delta)}`);
    parts.push(`rank_delta=${deltaClass(value.rank_delta)}`);
  }
  return parts.length
    ? parts.join("|")
    : `shape=${Object.keys(value).sort(compareText).join(",")}`;
}

function deltaClass(value) {
  const numeric = Number(value);
  return numeric > 0 ? "positive" : numeric < 0 ? "negative" : "zero";
}

function evenlySpacedIndexes(length, count) {
  if (length <= 0 || count <= 0) return [];
  if (count >= length) return Array.from({ length }, (_, index) => index);
  if (count === 1) return [0];
  const indexes = new Set();
  for (let index = 0; index < count; index += 1) {
    indexes.add(Math.round((index * (length - 1)) / (count - 1)));
  }
  for (let index = 0; indexes.size < count && index < length; index += 1) {
    indexes.add(index);
  }
  return [...indexes].sort((left, right) => left - right);
}

function jsonPointer(path) {
  return `/${path
    .map((token) => String(token).replace(/~/g, "~0").replace(/\//g, "~1"))
    .join("/")}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
}

function assertNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
}

function compareText(left, right) {
  const leftText = String(left ?? "");
  const rightText = String(right ?? "");
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}
