import { appendFile, mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const SCHEMA_VERSION = 1;
const DEFAULT_MAX_RECORD_BYTES = 8 * 1024 * 1024;

export const ARCHIVE_FILES = Object.freeze({
  rawEnvelopes: "raw-envelopes.ndjson",
  normalizedPosts: "normalized-posts.ndjson",
  metricSnapshots: "metric-snapshots.ndjson",
  accountIdentities: "account-identities.ndjson",
  checkpoints: "checkpoints.ndjson",
  tombstones: "tombstones.ndjson"
});

export class LosslessArchiveConflictError extends Error {
  constructor({ recordType, key, slot, existingHash, incomingHash }) {
    super(
      `Immutable ${recordType} conflict for ${key}${slot ? ` (${slot})` : ""}: ` +
        `existing ${existingHash}, incoming ${incomingHash}`
    );
    this.name = "LosslessArchiveConflictError";
    this.code = "LOSSLESS_ARCHIVE_CONFLICT";
    this.recordType = recordType;
    this.key = key;
    this.slot = slot ?? null;
    this.existingHash = existingHash;
    this.incomingHash = incomingHash;
  }
}

export class LosslessArchiveBoundsError extends Error {
  constructor(fileName, bytes, maxBytes) {
    super(`Archive record for ${fileName} is ${bytes} bytes; maximum is ${maxBytes}`);
    this.name = "LosslessArchiveBoundsError";
    this.code = "LOSSLESS_ARCHIVE_RECORD_TOO_LARGE";
    this.fileName = fileName;
    this.bytes = bytes;
    this.maxBytes = maxBytes;
  }
}

export class LosslessArchiveDestructiveAmbiguityError extends Error {
  constructor({ key, field }) {
    super(`Refusing to erase previously archived ${field} for ${key} without an unambiguous replacement`);
    this.name = "LosslessArchiveDestructiveAmbiguityError";
    this.code = "LOSSLESS_ARCHIVE_DESTRUCTIVE_AMBIGUITY";
    this.key = key;
    this.field = field;
  }
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function contentHash(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function nativePostKey(platform, nativeId) {
  return `${normalizePlatform(platform)}:${normalizeNativeId(nativeId)}`;
}

export class LosslessPostArchive {
  constructor(rootDirOrOptions, options = {}) {
    const config = typeof rootDirOrOptions === "string"
      ? { ...options, rootDir: rootDirOrOptions }
      : { ...(rootDirOrOptions ?? {}) };

    if (typeof config.rootDir !== "string" || config.rootDir.length === 0) {
      throw new TypeError("LosslessPostArchive requires a rootDir");
    }

    this.rootDir = path.resolve(config.rootDir);
    this.maxRecordBytes = config.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
    if (!Number.isInteger(this.maxRecordBytes) || this.maxRecordBytes <= 0) {
      throw new TypeError("maxRecordBytes must be a positive integer");
    }
    this.clock = config.clock ?? (() => new Date().toISOString());
    this._writeQueue = Promise.resolve();
    this._ready = this._load();
  }

  async ready() {
    await this._ready;
    return this;
  }

  async appendPost(input) {
    await this._ready;

    return this._enqueue(async () => {
      const key = postRequestKey(input);
      const observedAt = input.observedAt ?? this.clock();
      const slot = observationSlot(key, observedAt);
      const request = preparePostRequest(
        input,
        observedAt,
        this._indexes.normalizedObservations.get(slot)?.content.post ??
          this._indexes.posts.get(key)?.content.post
      );
      this._assertRawObservationCompatibility(request.rawRecord);
      this._assertNormalizedObservationCompatibility(request.normalizedRecord);
      const metricRequests = request.metricInputs.map((metric) =>
        prepareMetricRequest({
          ...metric,
          platform: request.platform,
          nativeId: request.nativeId,
          observedAt: metric.observedAt ?? request.observedAt
        })
      );
      for (const metric of metricRequests) this._assertMetricCompatibility(metric);

      const raw = await this._appendRawIfNew(request.rawRecord);
      const normalized = await this._appendNormalizedIfNew(request.normalizedRecord);
      const metrics = [];
      for (const metric of metricRequests) {
        metrics.push(await this._appendMetricIfNew(metric));
      }

      return { key: request.key, raw, normalized, metrics };
    });
  }

  async recordMetricSnapshot(input) {
    await this._ready;
    const request = prepareMetricRequest(input, this.clock);
    return this._enqueue(async () => {
      this._assertMetricCompatibility(request);
      return this._appendMetricIfNew(request);
    });
  }

  async recordAccountIdentity(input) {
    await this._ready;
    const request = prepareIdentityRequest(input, this.clock);
    return this._enqueue(async () => {
      const slot = identitySlot(request.key, request.snapshotAt);
      const existingHash = this._indexes.identityHashes.get(slot);
      if (existingHash && existingHash !== request.record.contentHash) {
        throw conflict("account_identity", request.key, slot, existingHash, request.record.contentHash);
      }
      if (existingHash) return result("duplicate", request.record);

      await this._append(ARCHIVE_FILES.accountIdentities, request.record);
      this._indexes.identityHashes.set(slot, request.record.contentHash);
      this._indexes.identities.push(request.record);
      return result("appended", request.record);
    });
  }

  async updateCheckpoint(input) {
    await this._ready;
    const request = prepareCheckpointRequest(input, this.clock);
    return this._enqueue(async () => {
      const existing = this._indexes.checkpoints.get(request.key);
      if (existing?.contentHash === request.record.contentHash) {
        return result("duplicate", existing);
      }

      await this._append(ARCHIVE_FILES.checkpoints, request.record);
      this._indexes.checkpoints.set(request.key, request.record);
      this._indexes.checkpointHistory.push(request.record);
      return result("appended", request.record);
    });
  }

  async recordTombstone(input) {
    await this._ready;
    const request = prepareTombstoneRequest(input, this.clock);
    return this._enqueue(async () => {
      const existingHash = this._indexes.tombstoneHashes.get(request.slot);
      if (existingHash && existingHash !== request.record.contentHash) {
        throw conflict("tombstone", request.key, request.slot, existingHash, request.record.contentHash);
      }
      if (existingHash) return result("duplicate", request.record);

      await this._append(ARCHIVE_FILES.tombstones, request.record);
      this._indexes.tombstoneHashes.set(request.slot, request.record.contentHash);
      this._indexes.tombstones.push(request.record);
      return result("appended", request.record);
    });
  }

  getPost(platform, nativeId) {
    const record = this._indexes.posts.get(nativePostKey(platform, nativeId));
    return record ? cloneJson(record.content.post) : null;
  }

  getPostRecord(platform, nativeId) {
    const record = this._indexes.posts.get(nativePostKey(platform, nativeId));
    return record ? cloneJson(record) : null;
  }

  listPosts() {
    return [...this._indexes.posts.values()].map((record) => cloneJson(record.content.post));
  }

  listPostRevisions({ platform, nativeId } = {}) {
    const key = platform === undefined ? null : nativePostKey(platform, nativeId);
    return this._indexes.postRevisions
      .filter((record) => key === null || record.key === key)
      .map(cloneJson);
  }

  listRawEnvelopes({ platform, nativeId } = {}) {
    const key = platform === undefined ? null : nativePostKey(platform, nativeId);
    return this._indexes.rawEnvelopes
      .filter((record) => key === null || record.key === key)
      .map(cloneJson);
  }

  listMetricSnapshots({ platform, nativeId } = {}) {
    const key = platform === undefined ? null : nativePostKey(platform, nativeId);
    return this._indexes.metrics
      .filter((record) => key === null || record.key === key)
      .map(cloneJson);
  }

  getAccountIdentityHistory(platformOrKey, accountKey) {
    const key = accountKey === undefined
      ? String(platformOrKey)
      : `${normalizePlatform(platformOrKey)}:${String(accountKey)}`;
    return this._indexes.identities
      .filter((record) => record.key === key)
      .map(cloneJson);
  }

  getCheckpoint(platform, scope = "default") {
    const key = `${normalizePlatform(platform)}:${String(scope)}`;
    const record = this._indexes.checkpoints.get(key);
    return record ? cloneJson(record.content) : null;
  }

  listCheckpointHistory({ platform, scope } = {}) {
    const key = platform === undefined ? null : `${normalizePlatform(platform)}:${String(scope ?? "default")}`;
    return this._indexes.checkpointHistory
      .filter((record) => key === null || record.key === key)
      .map(cloneJson);
  }

  listTombstones({ platform, nativeId, kind } = {}) {
    const key = platform === undefined ? null : nativePostKey(platform, nativeId);
    const normalizedKind = kind === undefined ? null : normalizeTombstoneKind(kind);
    return this._indexes.tombstones
      .filter((record) =>
        (key === null || record.key === key) &&
        (normalizedKind === null || record.content.kind === normalizedKind)
      )
      .map(cloneJson);
  }

  async _load() {
    await mkdir(this.rootDir, { recursive: true });
    this._indexes = {
      rawObservations: new Map(),
      rawEnvelopes: [],
      posts: new Map(),
      normalizedObservationRevisions: new Map(),
      normalizedObservations: new Map(),
      postRevisions: [],
      metricObservations: new Map(),
      metrics: [],
      identityHashes: new Map(),
      identities: [],
      checkpoints: new Map(),
      checkpointHistory: [],
      tombstoneHashes: new Map(),
      tombstones: []
    };

    await this._loadFile(ARCHIVE_FILES.rawEnvelopes, (record) => {
      const slot = observationSlot(record.key, record.observedAt);
      const existing = this._indexes.rawObservations.get(slot);
      if (existing && !sameRawObservationCore(existing, record)) {
        throw conflict("raw_envelope", record.key, slot, existing.contentHash, record.contentHash);
      }
      if (existing) return;
      this._indexes.rawObservations.set(slot, record);
      this._indexes.rawEnvelopes.push(record);
    });
    await this._loadFile(ARCHIVE_FILES.normalizedPosts, (record) => {
      const slot = observationSlot(record.key, record.observedAt);
      const revisions = this._indexes.normalizedObservationRevisions.get(slot) ?? new Map();
      if (revisions.has(record.contentHash)) return;
      const existing = revisions.values().next().value;
      if (existing && !sameNormalizedObservationCore(existing, record)) {
        throw conflict("normalized_post", record.key, slot, existing.contentHash, record.contentHash);
      }
      revisions.set(record.contentHash, record);
      this._indexes.normalizedObservationRevisions.set(slot, revisions);
      this._indexes.normalizedObservations.set(slot, record);
      this._indexes.postRevisions.push(record);
      this._indexes.posts.set(record.key, record);
    });
    await this._loadFile(ARCHIVE_FILES.metricSnapshots, (record) => {
      const slot = metricSlot(record.key, record.content.snapshotAt);
      const existing = this._indexes.metricObservations.get(slot);
      if (existing && !sameMetricObservationCore(existing, record)) {
        throw conflict("metric_snapshot", record.key, slot, existing.contentHash, record.contentHash);
      }
      if (!existing) {
        this._indexes.metricObservations.set(slot, record);
        this._indexes.metrics.push(record);
      }
    });
    await this._loadFile(ARCHIVE_FILES.accountIdentities, (record) => {
      const slot = identitySlot(record.key, record.content.snapshotAt);
      const existingHash = this._indexes.identityHashes.get(slot);
      if (existingHash && existingHash !== record.contentHash) {
        throw conflict("account_identity", record.key, slot, existingHash, record.contentHash);
      }
      if (!existingHash) {
        this._indexes.identityHashes.set(slot, record.contentHash);
        this._indexes.identities.push(record);
      }
    });
    await this._loadFile(ARCHIVE_FILES.checkpoints, (record) => {
      this._indexes.checkpoints.set(record.key, record);
      this._indexes.checkpointHistory.push(record);
    });
    await this._loadFile(ARCHIVE_FILES.tombstones, (record) => {
      const slot = tombstoneSlot(record.key, record.content.kind, record.content.snapshotAt);
      const existingHash = this._indexes.tombstoneHashes.get(slot);
      if (existingHash && existingHash !== record.contentHash) {
        throw conflict("tombstone", record.key, slot, existingHash, record.contentHash);
      }
      if (!existingHash) {
        this._indexes.tombstoneHashes.set(slot, record.contentHash);
        this._indexes.tombstones.push(record);
      }
    });
  }

  async _loadFile(fileName, consume) {
    let source;
    try {
      source = await readFile(path.join(this.rootDir, fileName), "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }

    for (const [lineNumber, line] of source.split("\n").entries()) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch (error) {
        throw new Error(`Malformed ${fileName} at line ${lineNumber + 1}`, { cause: error });
      }
      validateRecord(record, fileName, lineNumber + 1);
      consume(record);
    }
  }

  _assertRawObservationCompatibility(record) {
    const slot = observationSlot(record.key, record.observedAt);
    const existing = this._indexes.rawObservations.get(slot);
    if (existing && !sameRawObservationCore(existing, record)) {
      throw conflict("raw_envelope", record.key, slot, existing.contentHash, record.contentHash);
    }
  }

  _assertNormalizedObservationCompatibility(record) {
    const slot = observationSlot(record.key, record.observedAt);
    const revisions = this._indexes.normalizedObservationRevisions.get(slot);
    if (!revisions || revisions.has(record.contentHash)) return;
    const existing = revisions.values().next().value;
    if (existing && !sameNormalizedObservationCore(existing, record)) {
      throw conflict("normalized_post", record.key, slot, existing.contentHash, record.contentHash);
    }
  }

  _assertMetricCompatibility(request) {
    const existing = this._indexes.metricObservations.get(request.slot);
    if (existing && !sameMetricObservationCore(existing, request.record)) {
      throw conflict("metric_snapshot", request.key, request.slot, existing.contentHash, request.record.contentHash);
    }
  }

  async _appendRawIfNew(record) {
    const slot = observationSlot(record.key, record.observedAt);
    const existing = this._indexes.rawObservations.get(slot);
    if (existing) return result("duplicate", existing);
    await this._append(ARCHIVE_FILES.rawEnvelopes, record);
    this._indexes.rawObservations.set(slot, record);
    this._indexes.rawEnvelopes.push(record);
    return result("appended", record);
  }

  async _appendNormalizedIfNew(record) {
    const slot = observationSlot(record.key, record.observedAt);
    const revisions = this._indexes.normalizedObservationRevisions.get(slot) ?? new Map();
    const existing = revisions.get(record.contentHash);
    if (existing) return result("duplicate", existing);
    await this._append(ARCHIVE_FILES.normalizedPosts, record);
    revisions.set(record.contentHash, record);
    this._indexes.normalizedObservationRevisions.set(slot, revisions);
    this._indexes.normalizedObservations.set(slot, record);
    this._indexes.postRevisions.push(record);
    this._indexes.posts.set(record.key, record);
    return result("appended", record);
  }

  async _appendMetricIfNew(request) {
    const existing = this._indexes.metricObservations.get(request.slot);
    if (existing) return result("duplicate", existing);
    await this._append(ARCHIVE_FILES.metricSnapshots, request.record);
    this._indexes.metricObservations.set(request.slot, request.record);
    this._indexes.metrics.push(request.record);
    return result("appended", request.record);
  }

  async _append(fileName, record) {
    const line = `${canonicalJson(record).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")}\n`;
    const bytes = Buffer.byteLength(line);
    if (bytes > this.maxRecordBytes) {
      throw new LosslessArchiveBoundsError(fileName, bytes, this.maxRecordBytes);
    }
    await appendFile(path.join(this.rootDir, fileName), line, { encoding: "utf8", flag: "a" });
  }

  _enqueue(operation) {
    const next = this._writeQueue.then(operation, operation);
    this._writeQueue = next.catch(() => undefined);
    return next;
  }
}

export async function openLosslessPostArchive(rootDirOrOptions, options) {
  return new LosslessPostArchive(rootDirOrOptions, options).ready();
}

export const createLosslessPostArchive = openLosslessPostArchive;

function preparePostRequest(input, observedAt, previousPost) {
  if (!input || typeof input !== "object") throw new TypeError("appendPost requires an object");
  const platform = normalizePlatform(input.platform);
  const nativeId = normalizeNativeId(input.nativeId);
  const key = nativePostKey(platform, nativeId);
  const rawEnvelope = input.rawEnvelope !== undefined ? input.rawEnvelope : input.raw;
  if (rawEnvelope === undefined) throw new TypeError("appendPost requires rawEnvelope");
  const normalizedInput = input.normalizedPost ?? input.post;
  if (!normalizedInput || typeof normalizedInput !== "object") {
    throw new TypeError("appendPost requires normalizedPost");
  }

  const normalizedPost = normalizePost(normalizedInput, platform, nativeId, previousPost, key);
  const rawContent = {
    platform,
    nativeId,
    rawEnvelope: cloneJson(rawEnvelope),
    ...(input.source === undefined ? {} : { source: cloneJson(input.source) })
  };
  const rawRecord = makeRecord("raw_envelope", key, rawContent, observedAt);
  const normalizedRecord = makeRecord(
    "normalized_post",
    key,
    { platform, nativeId, post: normalizedPost },
    observedAt
  );
  const metricInputs = input.metricSnapshots ?? (
    input.metrics === undefined ? [] : [{ metrics: input.metrics, observedAt: input.observedAt }]
  );
  if (!Array.isArray(metricInputs)) throw new TypeError("metricSnapshots must be an array");

  return {
    platform,
    nativeId,
    key,
    observedAt,
    rawRecord,
    normalizedRecord,
    metricInputs
  };
}

function prepareMetricRequest(input, clock = () => new Date().toISOString()) {
  if (!input || typeof input !== "object") throw new TypeError("recordMetricSnapshot requires an object");
  const platform = normalizePlatform(input.platform);
  const nativeId = normalizeNativeId(input.nativeId);
  const key = nativePostKey(platform, nativeId);
  if (input.metrics === undefined) throw new TypeError("metric snapshot requires metrics");
  const snapshotAt = input.snapshotAt ?? input.observedAt ?? null;
  const content = {
    platform,
    nativeId,
    snapshotAt,
    metrics: cloneJson(input.metrics),
    ...(input.source === undefined ? {} : { source: cloneJson(input.source) })
  };
  return {
    key,
    slot: metricSlot(key, snapshotAt),
    record: makeRecord("metric_snapshot", key, content, input.observedAt ?? clock())
  };
}

function prepareIdentityRequest(input, clock = () => new Date().toISOString()) {
  if (!input || typeof input !== "object") throw new TypeError("recordAccountIdentity requires an object");
  const platform = normalizePlatform(input.platform);
  const identityKey = String(
    input.accountKey ?? input.nativeAccountId ?? input.accountId ?? input.handle ?? input.username ?? ""
  ).trim();
  if (!identityKey) throw new TypeError("account identity requires accountKey or native account identity");
  const snapshotAt = input.snapshotAt ?? input.observedAt ?? null;
  const identity = input.identity === undefined
    ? withoutKeys(input, ["platform", "accountKey", "nativeAccountId", "accountId", "snapshotAt", "observedAt", "identity"])
    : cloneJson(input.identity);
  const key = `${platform}:${identityKey}`;
  const content = {
    platform,
    identityKey,
    ...(input.nativeAccountId === undefined ? {} : { nativeAccountId: cloneJson(input.nativeAccountId) }),
    snapshotAt,
    identity
  };
  return {
    key,
    snapshotAt,
    record: makeRecord("account_identity", key, content, input.observedAt ?? clock())
  };
}

function prepareCheckpointRequest(input, clock = () => new Date().toISOString()) {
  if (!input || typeof input !== "object") throw new TypeError("updateCheckpoint requires an object");
  const platform = normalizePlatform(input.platform);
  const scope = String(input.scope ?? input.accountKey ?? "default");
  const key = `${platform}:${scope}`;
  const content = {
    platform,
    scope,
    cursor: input.cursor === undefined ? null : cloneJson(input.cursor),
    checkpoint: input.checkpoint === undefined ? null : cloneJson(input.checkpoint),
    ...(input.metadata === undefined ? {} : { metadata: cloneJson(input.metadata) })
  };
  return {
    key,
    record: makeRecord("checkpoint", key, content, input.observedAt ?? clock())
  };
}

function prepareTombstoneRequest(input, clock = () => new Date().toISOString()) {
  if (!input || typeof input !== "object") throw new TypeError("recordTombstone requires an object");
  const platform = normalizePlatform(input.platform);
  const nativeId = normalizeNativeId(input.nativeId);
  const key = nativePostKey(platform, nativeId);
  const kind = normalizeTombstoneKind(input.kind ?? input.type);
  const snapshotAt = input.snapshotAt ?? input.observedAt ?? null;
  const content = {
    platform,
    nativeId,
    kind,
    snapshotAt,
    ...(input.reason === undefined ? {} : { reason: cloneJson(input.reason) }),
    ...(input.source === undefined ? {} : { source: cloneJson(input.source) }),
    ...(input.metadata === undefined ? {} : { metadata: cloneJson(input.metadata) })
  };
  return {
    key,
    slot: tombstoneSlot(key, kind, snapshotAt),
    record: makeRecord("tombstone", key, content, input.observedAt ?? clock())
  };
}

function normalizePost(post, platform, nativeId, previousPost, key) {
  const normalized = { ...cloneJson(post), platform, nativeId };
  for (const field of ["parent", "parentId", "thread", "threadId", "quote", "quoteId"]) {
    if (!Object.hasOwn(post, field) && Object.hasOwn(previousPost ?? {}, field)) {
      normalized[field] = cloneJson(previousPost[field]);
    }
  }
  const suppliedMedia = Object.hasOwn(post, "media");
  if (!suppliedMedia) normalized.media = cloneJson(previousPost?.media ?? []);
  if (!Array.isArray(normalized.media)) throw new TypeError("normalizedPost.media must be an array");
  if (suppliedMedia && normalized.media.length === 0 && (previousPost?.media?.length ?? 0) > 0) {
    throw new LosslessArchiveDestructiveAmbiguityError({ key, field: "media" });
  }

  const suppliedRelationships = post.relationships;
  if (suppliedRelationships !== undefined && (
    suppliedRelationships === null ||
    typeof suppliedRelationships !== "object" ||
    Array.isArray(suppliedRelationships)
  )) {
    throw new TypeError("normalizedPost.relationships must be an object");
  }
  const previousRelationships = previousPost?.relationships ?? {};
  normalized.relationships = {
    parent: relationshipValue(post, suppliedRelationships, "parent", "parentId", previousRelationships.parent),
    thread: relationshipValue(post, suppliedRelationships, "thread", "threadId", previousRelationships.thread),
    quote: relationshipValue(post, suppliedRelationships, "quote", "quoteId", previousRelationships.quote)
  };
  for (const relationship of ["parent", "thread", "quote"]) {
    if (previousRelationships[relationship] != null && normalized.relationships[relationship] == null) {
      throw new LosslessArchiveDestructiveAmbiguityError({ key, field: `${relationship} relationship` });
    }
  }
  return normalized;
}

function relationshipValue(post, suppliedRelationships, field, alias, previousValue) {
  if (suppliedRelationships && Object.hasOwn(suppliedRelationships, field)) return cloneJson(suppliedRelationships[field]);
  if (Object.hasOwn(post, field)) return cloneJson(post[field]);
  if (Object.hasOwn(post, alias)) return cloneJson(post[alias]);
  return cloneJson(previousValue ?? null);
}

function makeRecord(recordType, key, content, observedAt) {
  const immutable = { schemaVersion: SCHEMA_VERSION, recordType, key, content };
  return {
    ...immutable,
    observedAt: observedAt ?? null,
    contentHash: contentHash(immutable)
  };
}

function validateRecord(record, fileName, lineNumber) {
  if (!record || record.schemaVersion !== SCHEMA_VERSION || typeof record.recordType !== "string" ||
      typeof record.key !== "string" || !record.content || typeof record.content !== "object" ||
      typeof record.contentHash !== "string") {
    throw new Error(`Invalid archive record in ${fileName} at line ${lineNumber}`);
  }
  const expectedHash = contentHash({
    schemaVersion: record.schemaVersion,
    recordType: record.recordType,
    key: record.key,
    content: record.content
  });
  if (record.contentHash !== expectedHash) {
    throw new Error(`Content hash mismatch in ${fileName} at line ${lineNumber}`);
  }
}

function conflict(recordType, key, slot, existingHash, incomingHash) {
  return new LosslessArchiveConflictError({ recordType, key, slot, existingHash, incomingHash });
}

// Collector-run snapshot provenance is useful on the first archived
// observation, but it can change when that same observation is merged into a
// later snapshot. Strip only that volatile wrapper; every other immutable
// record field remains part of same-slot compatibility.
function sameRawObservationCore(left, right) {
  return sameStableObservationCore(left, right);
}

function sameMetricObservationCore(left, right) {
  return sameStableObservationCore(left, right);
}

// Canonical roster refreshes can add or remove descriptor tokens without
// changing the native post observation. Preserve each exact representation as
// an immutable revision, but require every other normalized field to match.
function sameNormalizedObservationCore(left, right) {
  const leftCore = stableNormalizedObservationCore(left);
  const rightCore = stableNormalizedObservationCore(right);
  return leftCore !== null && rightCore !== null && canonicalJson(leftCore) === canonicalJson(rightCore);
}

function stableNormalizedObservationCore(record) {
  const content = record?.content;
  const post = content?.post;
  if (!content || typeof content !== "object" || !post || typeof post !== "object" || Array.isArray(post)) {
    return null;
  }
  const stablePost = { ...post };
  delete stablePost.attributionDescriptorMatches;
  return {
    schemaVersion: record.schemaVersion,
    recordType: record.recordType,
    key: record.key,
    content: { ...content, post: stablePost }
  };
}

function sameStableObservationCore(left, right) {
  const leftCore = stableObservationCore(left);
  const rightCore = stableObservationCore(right);
  return leftCore !== null && rightCore !== null && canonicalJson(leftCore) === canonicalJson(rightCore);
}

function stableObservationCore(record) {
  const content = record?.content;
  if (!content || typeof content !== "object") return null;
  let stableContent = content;
  if (content.source && typeof content.source === "object" &&
      !Array.isArray(content.source) && Object.hasOwn(content.source, "snapshot")) {
    const { snapshot: _snapshot, ...stableSource } = content.source;
    stableContent = { ...content, source: stableSource };
  }
  return {
    schemaVersion: record.schemaVersion,
    recordType: record.recordType,
    key: record.key,
    content: stableContent
  };
}

function result(status, record) {
  return { status, contentHash: record.contentHash, record: cloneJson(record) };
}

function metricSlot(key, snapshotAt) {
  return `${key}\u001f${snapshotAt ?? ""}`;
}

function observationSlot(key, observedAt) {
  return `${key}\u001f${observedAt ?? ""}`;
}

function postRequestKey(input) {
  if (!input || typeof input !== "object") throw new TypeError("appendPost requires an object");
  return nativePostKey(input.platform, input.nativeId);
}

function identitySlot(key, snapshotAt) {
  return `${key}\u001f${snapshotAt ?? ""}`;
}

function tombstoneSlot(key, kind, snapshotAt) {
  return `${key}\u001f${kind}\u001f${snapshotAt ?? ""}`;
}

function normalizeTombstoneKind(kind) {
  const normalized = String(kind ?? "").trim().toLowerCase().replaceAll("_", "-");
  if (normalized !== "deleted" && normalized !== "not-observed") {
    throw new TypeError('tombstone kind must be "deleted" or "not-observed"');
  }
  return normalized;
}

function normalizePlatform(platform) {
  const normalized = String(platform ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(normalized)) throw new TypeError("invalid platform");
  return normalized;
}

function normalizeNativeId(nativeId) {
  if (nativeId === null || nativeId === undefined || String(nativeId).trim() === "") {
    throw new TypeError("nativeId is required");
  }
  return String(nativeId);
}

function withoutKeys(value, keys) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}

function cloneJson(value) {
  return JSON.parse(canonicalJson(value));
}

function canonicalize(value, location = "$") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`Non-finite number at ${location}`);
    return value;
  }
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw new TypeError(`Unsupported JSON value at ${location}`);
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalize(item, `${location}[${index}]`));
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Only plain JSON objects are supported at ${location}`);
    }
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key], `${location}.${key}`)])
    );
  }
  throw new TypeError(`Unsupported JSON value at ${location}`);
}
