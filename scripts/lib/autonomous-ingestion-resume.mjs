export async function resumeValidatedSnapshotOrRun({
  resume,
  readSnapshot,
  validateSnapshot,
  runFresh
}) {
  if (resume) {
    const snapshot = await readSnapshot();
    try {
      validateSnapshot(snapshot);
      return { snapshot, resumed: true };
    } catch {
      // A missing, partial, or malformed snapshot is not resumable. Running
      // the collector is safer than turning a fresh sweep into a false failure.
    }
  }

  return {
    snapshot: await runFresh(),
    resumed: false
  };
}
