const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_IDENTITY_LENGTH = 512;

const ARGUMENTS = Object.freeze({
  attemptId: "--autonomous-attempt-nonce",
  campaignKey: "--autonomous-campaign-key",
  idempotencyKey: "--autonomous-idempotency-key",
  executionNonce: "--autonomous-run-nonce",
  startedAt: "--autonomous-not-before"
});

export function readAutonomousCollectorLaunchProvenance(
  rawArguments = process.argv.slice(2),
  { required = false } = {}
) {
  const values = Object.fromEntries(
    Object.entries(ARGUMENTS).map(([key, argumentName]) => [
      key,
      argumentValue(rawArguments, argumentName)
    ])
  );
  const present = Object.values(values).filter((value) => value !== null).length;
  if (present === 0 && !required) return null;
  if (present !== Object.keys(ARGUMENTS).length) {
    throw new Error("Autonomous collector launch provenance must be complete and indivisible.");
  }

  for (const key of ["campaignKey", "idempotencyKey"]) {
    values[key] = boundedIdentity(values[key], ARGUMENTS[key]);
  }
  for (const key of ["attemptId", "executionNonce"]) {
    values[key] = boundedIdentity(values[key], ARGUMENTS[key]);
    if (!UUID_PATTERN.test(values[key])) {
      throw new Error(`${ARGUMENTS[key]} must be a UUID nonce.`);
    }
  }
  values.startedAt = canonicalTimestamp(values.startedAt, ARGUMENTS.startedAt);
  return Object.freeze(values);
}

export function completeAutonomousCollectorProvenance(
  launch,
  {
    kind,
    batchSlug,
    shardIndex,
    shardCount,
    fetchedAt,
    completedAt = new Date().toISOString()
  }
) {
  if (!launch) return null;
  const normalizedFetchedAt = canonicalTimestamp(fetchedAt, "collector source.fetchedAt");
  const normalizedCompletedAt = canonicalTimestamp(completedAt, "collector completion timestamp");
  const startedAtMs = Date.parse(launch.startedAt);
  const fetchedAtMs = Date.parse(normalizedFetchedAt);
  const completedAtMs = Date.parse(normalizedCompletedAt);
  if (completedAtMs < startedAtMs || fetchedAtMs < startedAtMs || fetchedAtMs > completedAtMs) {
    throw new Error("Collector-authored provenance timestamps fall outside the launched attempt.");
  }
  if (!String(kind ?? "").trim() || !String(batchSlug ?? "").trim()) {
    throw new Error("Collector-authored provenance requires kind and batchSlug.");
  }
  if (!Number.isInteger(shardCount) || shardCount <= 0) {
    throw new Error("Collector-authored provenance requires a positive shardCount.");
  }
  if (!Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex >= shardCount) {
    throw new Error("Collector-authored provenance requires an in-range shardIndex.");
  }
  return Object.freeze({
    schemaVersion: 1,
    attemptId: launch.attemptId,
    campaignKey: launch.campaignKey,
    idempotencyKey: launch.idempotencyKey,
    executionNonce: launch.executionNonce,
    kind: String(kind),
    batchSlug: String(batchSlug),
    shardIndex,
    shardCount,
    startedAt: launch.startedAt,
    completedAt: normalizedCompletedAt
  });
}

function argumentValue(rawArguments, name) {
  const prefix = `${name}=`;
  const matches = rawArguments.filter((argument) => String(argument).startsWith(prefix));
  if (matches.length > 1) throw new Error(`${name} may be supplied only once.`);
  return matches.length === 1 ? String(matches[0]).slice(prefix.length) : null;
}

function boundedIdentity(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > MAX_IDENTITY_LENGTH || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} must be a bounded non-control identity.`);
  }
  return normalized;
}

function canonicalTimestamp(value, label) {
  const normalized = String(value ?? "");
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== normalized) {
    throw new Error(`${label} must be a canonical ISO timestamp.`);
  }
  return normalized;
}
