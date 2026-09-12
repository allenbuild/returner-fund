import { resolveAuthenticatedBackfillTarget } from "./authenticated-backfill-target.mjs";
import {
  LINKEDIN_SAFETY_QUARANTINE_REASONS,
  linkedinGlobalLockKey
} from "./logged-in-linkedin-collection.mjs";

const LOCK_TABLE = "ingestion_runtime_locks";
const LOCK_COLUMNS = [
  "lock_key",
  "owner_id",
  "lease_token",
  "heartbeat_at",
  "lease_expires_at",
  "metadata_json",
  "updated_at"
].join(",");
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/;
const RECOGNIZED_SAFETY_QUARANTINES = new Set(
  LINKEDIN_SAFETY_QUARANTINE_REASONS
);

export function validateAuthenticatedLinkedInLockRecoveryRequest(env = process.env) {
  if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_EVENT_NAME !== "workflow_dispatch") {
    throw recoveryError("is available only inside a manual GitHub Actions dispatch");
  }
  if (env.RECOVER_AUTHENTICATED_LINKEDIN_LOCK !== "true") {
    throw recoveryError("requires the explicit manual recovery input");
  }
  if (env.AUTHENTICATED_SOCIAL_PREFLIGHT_PASSED !== "true") {
    throw recoveryError("requires the authenticated browser preflight to pass first");
  }
  if (env.AUTHENTICATED_SOCIAL_REPLAY !== "true") {
    throw recoveryError("requires authenticated social replay");
  }
  if (env.AUTHENTICATED_BACKFILL_SCOPE !== "linkedin") {
    throw recoveryError("requires the LinkedIn-only authenticated scope");
  }

  let requestedTarget;
  try {
    requestedTarget = resolveAuthenticatedBackfillTarget({
      authenticatedReplay: true,
      requestedScope: "linkedin",
      batchSlug: env.AUTHENTICATED_BACKFILL_BATCH ?? "all",
      companySlug: env.AUTHENTICATED_BACKFILL_COMPANY_SLUG ?? ""
    });
  } catch {
    throw recoveryError("requires one exact supported batch and canonical company slug");
  }
  if (!requestedTarget) {
    throw recoveryError("requires one exact supported batch and canonical company slug");
  }

  const namespace = String(env.LINKEDIN_GLOBAL_LOCK_NAMESPACE ?? "").trim();
  if (!NAMESPACE_PATTERN.test(namespace)) {
    throw recoveryError("requires an explicit stable global-lock namespace");
  }

  return Object.freeze({
    lockKey: linkedinGlobalLockKey(namespace),
    requestedTarget
  });
}

export async function recoverAuthenticatedLinkedInSafetyQuarantine(
  client,
  { lockKey, operationTimeoutMs = 15_000 } = {}
) {
  if (!client || typeof client.from !== "function" || typeof client.rpc !== "function") {
    throw new TypeError("Authenticated LinkedIn lock recovery requires a Supabase client.");
  }
  const lockPrefix = "authenticated-linkedin:";
  const lockNamespace = typeof lockKey === "string"
    ? lockKey.slice(lockPrefix.length)
    : "";
  if (
    typeof lockKey !== "string" ||
    !lockKey.startsWith(lockPrefix) ||
    !NAMESPACE_PATTERN.test(lockNamespace) ||
    linkedinGlobalLockKey(lockNamespace) !== lockKey
  ) {
    throw recoveryError("requires one exact authenticated LinkedIn lock key");
  }
  if (!Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs < 1_000 || operationTimeoutMs > 60_000) {
    throw new RangeError("Authenticated LinkedIn lock recovery timeout must be 1-60 seconds.");
  }

  const initial = await runBoundedRecoveryOperation(
    () => client
      .from(LOCK_TABLE)
      .select(LOCK_COLUMNS)
      .eq("lock_key", lockKey)
      .maybeSingle(),
    operationTimeoutMs,
    "exact lock lookup"
  );
  if (initial?.error) {
    throw recoveryError("could not prove the exact quarantined lock row");
  }
  const proof = validateSafetyQuarantineRow(initial?.data, lockKey);

  const released = await runBoundedRecoveryOperation(
    () => client.rpc("release_ingestion_runtime_lock", {
      p_lock_key: lockKey,
      p_owner_id: proof.ownerId,
      p_lease_token: proof.leaseToken
    }),
    operationTimeoutMs,
    "owner-bound release"
  );
  if (released?.error || released?.data !== true) {
    throw recoveryError("exact owner-bound release was not confirmed");
  }

  const verification = await runBoundedRecoveryOperation(
    () => client
      .from(LOCK_TABLE)
      .select("lock_key")
      .eq("lock_key", lockKey)
      .maybeSingle(),
    operationTimeoutMs,
    "post-release verification"
  );
  if (verification?.error || verification?.data !== null) {
    throw recoveryError("could not verify exact lock deletion");
  }

  return Object.freeze({
    status: "released",
    lockKey,
    collector: "authenticated-linkedin",
    safetyQuarantine: proof.safetyQuarantine,
    quarantinedAt: proof.quarantinedAt
  });
}

function validateSafetyQuarantineRow(row, lockKey) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw recoveryError("found no exact safety-quarantined lock row");
  }
  const metadata = row.metadata_json;
  const ownerId = typeof row.owner_id === "string" ? row.owner_id.trim() : "";
  const leaseToken = typeof row.lease_token === "string" ? row.lease_token.trim() : "";
  const quarantinedAt = typeof metadata?.quarantinedAt === "string"
    ? metadata.quarantinedAt.trim()
    : "";
  const safetyQuarantine = metadata?.safetyQuarantine;
  if (
    row.lock_key !== lockKey ||
    !UUID_PATTERN.test(ownerId) ||
    !UUID_PATTERN.test(leaseToken) ||
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    metadata.collector !== "authenticated-linkedin" ||
    metadata.manualRecoveryRequired !== true ||
    !RECOGNIZED_SAFETY_QUARANTINES.has(safetyQuarantine) ||
    !quarantinedAt ||
    !Number.isFinite(Date.parse(quarantinedAt))
  ) {
    throw recoveryError("refused a lock row without the exact recognized safety-quarantine proof");
  }
  return { ownerId, leaseToken, quarantinedAt, safetyQuarantine };
}

async function runBoundedRecoveryOperation(operation, timeoutMs, label) {
  const controller = new AbortController();
  const timeoutError = recoveryError(`${label} timed out`);
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  try {
    const request = operation();
    const abortBound = typeof request?.abortSignal === "function"
      ? request.abortSignal(controller.signal)
      : request;
    return await Promise.race([
      Promise.resolve(abortBound),
      new Promise((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(timeoutError),
          { once: true }
        );
      })
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Authenticated LinkedIn lock recovery ")) {
      throw error;
    }
    throw recoveryError(`${label} failed closed`);
  } finally {
    clearTimeout(timer);
  }
}

function recoveryError(reason) {
  return new Error(`Authenticated LinkedIn lock recovery ${reason}.`);
}
