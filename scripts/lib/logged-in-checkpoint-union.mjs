export function canonicalCheckpointPayloads(
  checkpointEntries,
  { activePath = null, activeCheckpoint = null } = {}
) {
  return (checkpointEntries ?? []).map((entry) =>
    activeCheckpoint && entry?.path === activePath
      ? activeCheckpoint
      : (entry?.payload ?? {})
  );
}

export function checkpointCanonicalRows(checkpointPayloads, field) {
  return (checkpointPayloads ?? []).flatMap((payload) =>
    Array.isArray(payload?.[field]) ? payload[field] : []
  );
}
