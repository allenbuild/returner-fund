import {
  authoredContentFingerprint,
  stableJson,
} from "./first-party-authored-post-recovery.mjs";

const FIRST_PARTY_PLATFORMS = new Set(["rss", "web"]);
const FUTURE_CLOCK_SKEW_MS = 60_000;

export function planFuturePublicationDateRemediation(
  snapshot,
  { now = new Date() } = {},
) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError("Public evidence snapshot must be an object.");
  }
  if (!Array.isArray(snapshot.evidence)) {
    throw new TypeError("Public evidence snapshot evidence must be an array.");
  }

  const nowTimestamp = clockTimestamp(now);
  const repairs = [];
  const newRepairs = [];
  const alreadyRemediated = [];
  const unresolved = [];
  const snapshotObservedAt = trustedTimestamp(
    snapshot?.source?.fetchedAt,
    nowTimestamp,
  );
  const evidence = snapshot.evidence.map((row) => {
    const completed = completedRemediation(row, nowTimestamp);
    if (completed?.valid) {
      repairs.push(completed.repair);
      alreadyRemediated.push(completed.repair);
      return row;
    }
    if (completed && !completed.valid) {
      unresolved.push({
        id: clean(row?.id) ?? "unknown",
        reason: "invalid_existing_future_date_remediation",
      });
      return row;
    }

    const firstParty = isFirstPartyRecoveredRow(row);
    const observationAt = preferredTrustedTimestamp(
      [
        row?.first_seen_at,
        row?.observedAt,
        row?.last_checked_at,
        row?.linkCheckedAt,
        row?.metricsCheckedAt,
        snapshotObservedAt,
      ],
      nowTimestamp,
    );
    if (firstParty && !observationAt) {
      unresolved.push({
        id: clean(row?.id) ?? "unknown",
        reason: "first_party_recovery_observation_missing_or_untrusted",
      });
      return row;
    }
    const issue = futurePublicationDateIssue(row, observationAt, { now });
    if (!issue) return row;
    if (!firstParty) {
      unresolved.push({
        id: clean(row?.id) ?? "unknown",
        reason: "future_publication_date_outside_first_party_recovery",
        ...issue,
      });
      return row;
    }

    const remediated = remediateFirstPartyRow(row, issue);
    const repair = {
      id: remediated.id,
      platform: remediated.platform,
      sourceUrl: remediated.sourceUrl,
      reportedPostedAt: issue.reportedPostedAt,
      observationFallbackAt: issue.observedAt,
    };
    repairs.push(repair);
    newRepairs.push(repair);
    return remediated;
  });

  return {
    snapshot: { ...snapshot, evidence },
    repairs,
    newRepairs,
    alreadyRemediated,
    unresolved,
  };
}

export function futurePublicationDateIssue(
  row,
  fallbackObservedAt = null,
  { now = new Date() } = {},
) {
  const nowTimestamp = clockTimestamp(now);
  const reportedPostedAt = timestampValue(row?.postedAt);
  if (!reportedPostedAt) return null;
  const observedAt = preferredTrustedTimestamp(
    [
      row?.first_seen_at,
      row?.observedAt,
      row?.last_checked_at,
      row?.linkCheckedAt,
      row?.metricsCheckedAt,
      fallbackObservedAt,
    ],
    nowTimestamp,
  );
  if (!observedAt || Date.parse(reportedPostedAt) <= Date.parse(observedAt)) {
    return null;
  }
  return { reportedPostedAt, observedAt };
}

function completedRemediation(row, nowTimestamp) {
  const provenance = row?._recoveryProvenance;
  if (provenance?.publicationDateDisposition !== "rejected_after_observation") {
    return null;
  }
  const reportedPostedAt = timestampValue(provenance?.reportedPostedAt);
  const observationFallbackAt = trustedTimestamp(
    provenance?.observationFallbackAt,
    nowTimestamp,
  );
  const postedAt = timestampValue(row?.postedAt);
  const lastUpdatedAt = timestampValue(row?.last_updated_at);
  const signals = Array.isArray(row?.attributionSignals)
    ? row.attributionSignals
    : [];
  const receipt = parseReceipt(row?.rawVisibleText);
  const valid =
    isFirstPartyRecoveredRow(row) &&
    Boolean(reportedPostedAt && observationFallbackAt && postedAt) &&
    Date.parse(reportedPostedAt) > Date.parse(observationFallbackAt) &&
    postedAt === observationFallbackAt &&
    row?.publishedAtPrecision === "unknown" &&
    (!lastUpdatedAt ||
      Date.parse(lastUpdatedAt) <= Date.parse(observationFallbackAt)) &&
    signals.includes("publication_date_observation_fallback") &&
    !signals.includes("title_text_date_provenance") &&
    receipt?.publicationDateDisposition === "rejected_after_observation" &&
    timestampValue(receipt?.reportedPostedAt) === reportedPostedAt &&
    trustedTimestamp(receipt?.observationFallbackAt, nowTimestamp) ===
      observationFallbackAt;
  return {
    valid,
    repair: valid
      ? {
          id: row.id,
          platform: row.platform,
          sourceUrl: row.sourceUrl,
          reportedPostedAt,
          observationFallbackAt,
        }
      : null,
  };
}

function remediateFirstPartyRow(row, issue) {
  const receipt = parseReceipt(row.rawVisibleText);
  delete receipt.postedAt;
  const rawVisibleText = stableJson({
    ...receipt,
    observationFallbackAt: issue.observedAt,
    publicationDateDisposition: "rejected_after_observation",
    reportedPostedAt: issue.reportedPostedAt,
  }).trim();
  const attributionSignals = [
    ...new Set([
      ...(Array.isArray(row.attributionSignals)
        ? row.attributionSignals.filter(
            (signal) => signal !== "title_text_date_provenance",
          )
        : []),
      "publication_date_observation_fallback",
    ]),
  ];
  const lastUpdatedAt = timestampValue(row.last_updated_at);
  const contentSha256 = authoredContentFingerprint(row);
  if (!contentSha256) {
    throw new Error(`First-party row ${row?.id ?? "unknown"} lacks authored content.`);
  }

  return {
    ...row,
    postedAt: issue.observedAt,
    publishedAtPrecision: "unknown",
    last_updated_at:
      lastUpdatedAt && Date.parse(lastUpdatedAt) <= Date.parse(issue.observedAt)
        ? lastUpdatedAt
        : issue.observedAt,
    rawVisibleText,
    matchReason:
      `Verified first-party ${String(row.platform).toUpperCase()} authored item on the current official ` +
      `${row.companyName} domain; title, text, and stable item URL are preserved. ` +
      "The source-reported publication date followed first observation and was rejected; " +
      "postedAt records the observation fallback with unknown publication precision.",
    attributionSignals,
    _recoveryProvenance: {
      ...row._recoveryProvenance,
      contentSha256,
      observationFallbackAt: issue.observedAt,
      publicationDateDisposition: "rejected_after_observation",
      reportedPostedAt: issue.reportedPostedAt,
    },
  };
}

function isFirstPartyRecoveredRow(row) {
  return (
    FIRST_PARTY_PLATFORMS.has(String(row?.platform ?? "").toLowerCase()) &&
    String(row?.id ?? "").startsWith("first-party-") &&
    row?._recoveryProvenance?.schemaVersion === 1
  );
}

function parseReceipt(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ...value };
  }
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : { originalRawVisibleText: value };
  } catch {
    return { originalRawVisibleText: value };
  }
}

function preferredTrustedTimestamp(values, nowTimestamp) {
  for (const value of values ?? []) {
    const timestamp = trustedTimestamp(value, nowTimestamp);
    if (timestamp) return timestamp;
  }
  return null;
}

function trustedTimestamp(value, nowTimestamp) {
  const timestamp = timestampValue(value);
  if (!timestamp) return null;
  return Date.parse(timestamp) <= nowTimestamp + FUTURE_CLOCK_SKEW_MS
    ? timestamp
    : null;
}

function clockTimestamp(value) {
  const timestamp = value instanceof Date
    ? value.getTime()
    : Date.parse(String(value ?? ""));
  if (!Number.isFinite(timestamp)) {
    throw new TypeError("Remediation clock must be a valid timestamp.");
  }
  return timestamp;
}

function timestampValue(value) {
  const raw = clean(value);
  if (!raw) return null;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function clean(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}
