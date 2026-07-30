export async function withOpenCliBrowserSession({
  session,
  runOpenCli,
  operation,
  closeTimeoutMs = 12_000
}) {
  try {
    return await operation();
  } finally {
    // Releasing a lease is best-effort cleanup. A close failure must never
    // replace either the collection result or the original collection error.
    await runOpenCli(
      ["browser", session, "close"],
      { timeoutMs: closeTimeoutMs }
    ).catch(() => undefined);
  }
}
