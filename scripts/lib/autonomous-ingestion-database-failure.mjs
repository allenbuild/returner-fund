const DATABASE_FAILURE_DOMAIN = "database";
const POSTGRES_SQLSTATE = /^[0-9A-Z]{5}$/;
const POSTGREST_ERROR_CODE = /^PGRST[0-9]{3}$/;

// These failures describe infrastructure contention or availability. Integrity,
// schema, input, and transaction-resolution ambiguity codes deliberately remain
// terminal so a replay cannot turn an unknown mutation into a second mutation.
const RETRYABLE_DATABASE_FAILURE_CODES = new Set([
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "08P01",
  "40001",
  "40P01",
  "55P03",
  "53300",
  "57014",
  "57P01",
  "57P02",
  "57P03",
  "PGRST000",
  "PGRST002",
  "PGRST003"
]);

export function autonomousDatabaseOperationError(operation, error) {
  const message = error instanceof Error ? error.message : error?.message ?? String(error);
  const wrapped = new Error(`Failed to ${operation}: ${message}`, { cause: error });
  wrapped.name = "AutonomousDatabaseOperationError";
  wrapped.failureDomain = DATABASE_FAILURE_DOMAIN;
  wrapped.failureCode = normalizeDatabaseFailureCode(error?.code) ?? "";
  return wrapped;
}

export function autonomousDatabaseFailureMetadata(error) {
  const seen = new Set();
  let current = error;
  let databaseFailure = false;
  let code = null;

  for (let depth = 0; current && depth < 12; depth += 1) {
    if ((typeof current !== "object" && typeof current !== "function") || seen.has(current)) {
      break;
    }
    seen.add(current);
    if (current.failureDomain === DATABASE_FAILURE_DOMAIN) databaseFailure = true;
    if (databaseFailure && !code) {
      code = normalizeDatabaseFailureCode(current.failureCode) ??
        normalizeDatabaseFailureCode(current.code);
    }
    current = current.cause;
  }

  if (!databaseFailure) return null;
  return Object.freeze({
    domain: DATABASE_FAILURE_DOMAIN,
    code: code ?? ""
  });
}

export function isRetryableAutonomousDatabaseFailure({ domain, code } = {}) {
  return domain === DATABASE_FAILURE_DOMAIN &&
    RETRYABLE_DATABASE_FAILURE_CODES.has(normalizeDatabaseFailureCode(code) ?? "");
}

function normalizeDatabaseFailureCode(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  if (!POSTGRES_SQLSTATE.test(normalized) && !POSTGREST_ERROR_CODE.test(normalized)) {
    return null;
  }
  return normalized;
}
