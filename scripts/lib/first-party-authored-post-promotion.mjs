import {
  authoredContentFingerprint,
  buildFirstPartyReferenceIndex,
  buildOfficialDomainCatalog,
  evaluateFirstPartyAuthoredPost,
  normalizeUrl,
  sha256
} from "./first-party-authored-post-recovery.mjs";

const CANDIDATE_SCHEMA = "first-party-authored-post-promotion-candidate.v1";
const PROTECTED_LEDGER_KEYS = Object.freeze([
  "attributionReconciliationLedger",
  "failures",
  "attempts",
  "discoveryAttempts",
  "sourceDiscoveryPaths"
]);

export function planFirstPartyAuthoredPostPromotion({
  canonical,
  candidate,
  graphDocuments,
  referenceDocuments
}) {
  if (candidate?.schemaVersion !== CANDIDATE_SCHEMA) {
    throw new Error(`Candidate schema must be ${CANDIDATE_SCHEMA}.`);
  }
  const evidence = requiredRows(candidate?.evidence, "candidate evidence");
  if (evidence.length === 0) throw new Error("Candidate evidence must not be empty.");
  if (
    candidate?.audit?.zeroDuplicateAudit !== true ||
    Number(candidate?.audit?.referenceUrlOverlap ?? -1) !== 0 ||
    Number(candidate?.audit?.referenceContentOverlap ?? -1) !== 0 ||
    Number(candidate?.counts?.total ?? -1) !== evidence.length
  ) {
    throw new Error("Candidate does not carry a complete zero-duplicate audit.");
  }

  const canonicalEvidence = requiredRows(canonical?.evidence, "canonical evidence");
  const canonicalReview = requiredRows(canonical?.needsReview, "canonical review");
  const catalog = buildOfficialDomainCatalog(graphDocuments);
  const referenceIndex = buildFirstPartyReferenceIndex([
    { evidence: canonicalEvidence },
    ...(referenceDocuments ?? []).map((document) => ({
      evidence: Array.isArray(document?.evidence) ? document.evidence : []
    }))
  ]);
  const canonicalIds = new Set(canonicalEvidence.map(requiredId));
  const candidateIds = new Set();
  const candidateUrls = new Set();
  const candidateContent = new Set();
  const additions = [];

  for (const row of evidence) {
    const id = requiredId(row);
    const sourceUrl = normalizeUrl(row?.sourceUrl);
    const contentKey = authoredContentFingerprint(row);
    if (!sourceUrl || !contentKey) throw rowError(row, "lacks stable URL/content identity");
    if (candidateIds.has(id)) throw rowError(row, `duplicates candidate id ${id}`);
    if (candidateUrls.has(sourceUrl)) throw rowError(row, `duplicates candidate URL ${sourceUrl}`);
    if (candidateContent.has(contentKey)) {
      throw rowError(row, `duplicates candidate authored content ${contentKey}`);
    }
    if (canonicalIds.has(id)) throw rowError(row, `collides with canonical id ${id}`);
    candidateIds.add(id);
    candidateUrls.add(sourceUrl);
    candidateContent.add(contentKey);

    const provenance = row?._recoveryProvenance;
    const evaluation = evaluateFirstPartyAuthoredPost(row, {
      catalog,
      referenceIndex,
      sourcePath: provenance?.sourcePath,
      sourceKind: provenance?.sourceKind
    });
    if (!evaluation.accepted || !evaluation.owner) {
      throw rowError(row, `failed current recovery gates: ${evaluation.reasons.join(",")}`);
    }
    assertCandidateTrust(row, evaluation);
    additions.push(row);
  }

  const resolvedReview = canonicalReview.filter((row) =>
    candidateUrls.has(normalizeUrl(reviewUrl(row)))
  );
  const retainedReview = canonicalReview.filter((row) =>
    !candidateUrls.has(normalizeUrl(reviewUrl(row)))
  );
  const promoted = {
    ...canonical,
    source: {
      ...(canonical?.source ?? {}),
      fetchedAt: newestTimestamp(canonical?.source?.fetchedAt, candidate?.generatedAt),
      evidenceCount: canonicalEvidence.length + additions.length,
      needsReviewCount: retainedReview.length
    },
    evidence: [...canonicalEvidence, ...additions],
    needsReview: retainedReview
  };
  for (const key of PROTECTED_LEDGER_KEYS) {
    if (JSON.stringify(promoted?.[key]) !== JSON.stringify(canonical?.[key])) {
      throw new Error(`Promotion unexpectedly changed protected ledger ${key}.`);
    }
  }
  return {
    promoted,
    additions,
    resolvedReview,
    retainedReview,
    zeroEngagementAdditions: additions.filter(isZeroEngagement).length,
    addedByBatch: countBy(additions, (row) => String(row.batchSlug)),
    addedByPlatform: countBy(additions, (row) => String(row.platform))
  };
}

function assertCandidateTrust(row, evaluation) {
  const owner = evaluation.owner;
  const fields = [
    ["batchSlug", row?.batchSlug, owner.batchSlug],
    ["entityType", row?.entityType, owner.entityType],
    ["entityId", row?.entityId, owner.entityId],
    ["entityName", row?.entityName, owner.entityName],
    ["companySlug", row?.companySlug, owner.companySlug],
    ["companyName", row?.companyName, owner.companyName]
  ];
  const mismatch = fields.find(([, left, right]) => String(left ?? "") !== String(right ?? ""));
  if (mismatch) throw rowError(row, `current official owner disagrees on ${mismatch[0]}`);

  const provenance = row?._recoveryProvenance;
  const expectedId = `first-party-${row.platform}-${sha256(
    `${row.batchSlug}|${row.entityId}|${evaluation.sourceUrl}`
  ).slice(0, 24)}`;
  if (
    provenance?.schemaVersion !== 1 ||
    provenance?.contentSha256 !== evaluation.contentKey ||
    normalizeUrl(provenance?.officialWebsiteUrl) !== normalizeUrl(owner.websiteUrl) ||
    String(provenance?.officialHost) !== new URL(owner.websiteUrl).hostname.replace(/^www\./i, "") ||
    provenance?.zeroEngagementAccepted !== true ||
    row.id !== expectedId
  ) {
    throw rowError(row, "has incomplete or mismatched recovery provenance");
  }
  if (
    row?.review_state !== "verified" ||
    row?.linkStatus !== "verified" ||
    row?.attributionStatus !== "verified" ||
    Number(row?.attributionVersion ?? 0) < 3 ||
    row?.contributionScore !== 0 ||
    !isZeroEngagement(row)
  ) {
    throw rowError(row, "is not verified zero-engagement context evidence");
  }
  const requiredSignals = [
    "current_cohort_owner",
    "exact_current_official_domain",
    "stable_authored_item_url",
    "title_text_date_provenance"
  ];
  if (!requiredSignals.every((signal) => row?.attributionSignals?.includes(signal))) {
    throw rowError(row, "is missing first-party attribution signals");
  }
}

function reviewUrl(row) {
  return row?.sourceUrl ?? row?.candidateUrl ?? row?.url ?? row?.canonicalUrl ?? null;
}

function requiredRows(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function requiredId(row) {
  const id = String(row?.id ?? "").trim();
  if (!id) throw new Error("Evidence row is missing an id.");
  return id;
}

function rowError(row, message) {
  return new Error(`First-party recovery row ${row?.id ?? "unknown"} ${message}.`);
}

function isZeroEngagement(row) {
  return Object.values(row?.metrics ?? {}).every((value) => Number(value) === 0) &&
    Number(row?.contributionScore ?? 0) === 0;
}

function countBy(items, keyFor) {
  const counts = {};
  for (const item of items) {
    const key = keyFor(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) =>
    left.localeCompare(right)
  ));
}

function newestTimestamp(left, right) {
  const candidates = [left, right].filter((value) =>
    Number.isFinite(Date.parse(String(value ?? "")))
  );
  return candidates.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? left ?? right ?? null;
}
