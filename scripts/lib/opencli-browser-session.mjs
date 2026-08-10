import {
  createOpenCliProcessOwner,
  drainOpenCliProcessOwner,
  withOpenCliProcessOwner
} from "./opencli-runtime.mjs";

export async function withOpenCliBrowserSession({
  session,
  runOpenCli,
  operation,
  closeTimeoutMs = 12_000
}) {
  const processOwner = createOpenCliProcessOwner();
  return withOpenCliProcessOwner(processOwner, async () => {
    let result;
    let primaryError = null;
    try {
      result = await runBrowserSessionOperation({
        session,
        runOpenCli,
        operation,
        closeTimeoutMs
      });
    } catch (error) {
      primaryError = error;
    }

    let processDrainFailure = null;
    try {
      await drainOpenCliProcessOwner(processOwner);
    } catch {
      processDrainFailure = browserSessionCleanupFailure();
    }

    if (processDrainFailure) {
      throw primaryError
        ? primaryErrorWithCleanupFailure(primaryError, processDrainFailure)
        : processDrainFailure;
    }
    if (primaryError) throw primaryError;
    return result;
  });
}

async function runBrowserSessionOperation({
  session,
  runOpenCli,
  operation,
  closeTimeoutMs
}) {
  let result;
  let operationFailed = false;
  let primaryError = null;
  try {
    result = await operation();
  } catch (error) {
    operationFailed = true;
    primaryError = error;
  }

  let cleanupFailure = null;
  try {
    await runOpenCli(
      ["browser", session, "close"],
      { timeoutMs: closeTimeoutMs }
    );
  } catch {
    cleanupFailure = browserSessionCleanupFailure();
  }

  if (operationFailed) {
    throw cleanupFailure
      ? primaryErrorWithCleanupFailure(primaryError, cleanupFailure)
      : primaryError;
  }

  if (cleanupFailure) throw cleanupFailure;
  return result;
}

function browserSessionCleanupFailure() {
  const error = new Error(
    "OpenCLI browser session cleanup failed; the authenticated session lease may still be active and the collection outcome is failed."
  );
  error.name = "OpenCliBrowserSessionCleanupError";
  error.code = "OPENCLI_BROWSER_SESSION_CLOSE_FAILED";
  return error;
}

function primaryErrorWithCleanupFailure(primaryError, cleanupFailure) {
  if (
    (typeof primaryError === "object" || typeof primaryError === "function") &&
    primaryError !== null
  ) {
    try {
      Object.defineProperty(primaryError, "sessionCleanupFailure", {
        configurable: false,
        enumerable: false,
        writable: false,
        value: cleanupFailure
      });
      return primaryError;
    } catch {
      // Preserve the primary value through a wrapper when it cannot be extended.
    }
  }

  const combined = new Error(
    "OpenCLI browser operation failed and authenticated session cleanup also failed."
  );
  combined.name = "OpenCliBrowserOperationAndCleanupError";
  combined.code = "OPENCLI_BROWSER_OPERATION_AND_CLOSE_FAILED";
  Object.defineProperties(combined, {
    primaryError: {
      configurable: false,
      enumerable: false,
      writable: false,
      value: primaryError
    },
    sessionCleanupFailure: {
      configurable: false,
      enumerable: false,
      writable: false,
      value: cleanupFailure
    }
  });
  return combined;
}
