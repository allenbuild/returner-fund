#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  buildAutonomousPublicNativeAuthorResolver,
  buildLegacyPublicEvidenceBatchResolver,
  loadAutonomousCatalogs,
  mergePublicEvidenceSnapshots
} from "./lib/autonomous-ingestion-plan.mjs";
import {
  adaptReturnerFundRow,
  loadReturnerFundShardRows,
  RETURNER_FUND_SHARD_ROOT,
  sourceLabel
} from "./lib/returner-fund-shard-adapter.mjs";
import { normalizeCanonicalEvidence } from "../src/lib/ingestion/canonical-evidence.ts";

const root = process.cwd();
const shardRoot = process.env.RETURNER_FUND_SHARD_ROOT ?? RETURNER_FUND_SHARD_ROOT;
const outputDir = process.env.RETURNER_FUND_AUDIT_DIR ??
  "/private/tmp/returner-fund-shards/evidence-adapters";
const observedAt = "2026-08-04T00:00:00.000Z";

const entries = await loadReturnerFundShardRows(shardRoot);
const rawAdaptedRows = entries.map((entry) => adaptReturnerFundRow(entry));
const catalogs = await loadAutonomousCatalogs(root);
const resolveBatchSlug = buildLegacyPublicEvidenceBatchResolver(catalogs);
const resolveNativeAuthor = buildAutonomousPublicNativeAuthorResolver(catalogs);
const adaptedRows = rawAdaptedRows.map((row) => {
  const batchSlug = row.batchSlug ?? resolveBatchSlug(row);
  return batchSlug ? { ...row, batchSlug } : row;
});
const baselineBytes = execFileSync("git", [
  "show",
  "c01c366:src/lib/social/public-evidence-current.json"
], { cwd: root, maxBuffer: 256 * 1024 * 1024 });
const baseline = JSON.parse(baselineBytes.toString("utf8"));
const baselineRows = baseline.evidence ?? [];
const candidate = {
  source: {
    label: "Returner fund isolated Instagram/YouTube/open-platform shard",
    fetchedAt: observedAt,
    batchSlugs: [...new Set(adaptedRows.map((row) => row.batchSlug).filter(Boolean))].sort()
  },
  evidence: adaptedRows,
  needsReview: [],
  failures: [],
  attempts: {}
};

const merged = mergePublicEvidenceSnapshots([baseline, candidate], {
  fetchedAt: observedAt,
  durableStorageConfigured: false,
  resolveBatchSlug,
  resolveNativeAuthor,
  contentIdentityReferenceRows: []
});

const baselinePhysical = indexPhysicalRows(baselineRows);
const candidatePhysical = indexPhysicalRows(adaptedRows);
const acceptedById = new Map(
  (merged.evidence ?? []).map((row) => [String(row.id ?? ""), row])
);
const reviewsBySourceId = new Map();
for (const review of merged.needsReview ?? []) {
  const sourceId = String(review.sourceEvidenceId ?? "");
  if (sourceId) reviewsBySourceId.set(sourceId, review);
}
const ledgerByPhysical = new Map();
for (const entry of merged.attributionReconciliationLedger ?? []) {
  const key = physicalKeyFromFields(entry.platform, entry.sourceUrl, entry.platformPostId);
  if (!key) continue;
  const list = ledgerByPhysical.get(key) ?? [];
  list.push(entry);
  ledgerByPhysical.set(key, list);
}

const auditRows = entries.map((entry, index) => {
  const stagedRow = adaptedRows[index];
  const canonical = normalizeCanonicalRow(stagedRow);
  const rowPhysicalKey = physicalKey(canonical);
  const baselineMatches = (baselinePhysical.get(rowPhysicalKey) ?? []).map(compactBaselineRow);
  const withinShardMatches = (candidatePhysical.get(rowPhysicalKey) ?? [])
    .filter((candidate) => candidate !== stagedRow)
    .map((row) => ({ id: row.id ?? null, entityId: row.entityId ?? null }));
  const accepted = acceptedById.get(String(stagedRow.id ?? "")) ?? null;
  const review = reviewsBySourceId.get(String(stagedRow.id ?? "")) ?? null;
  const attributionConflict = attributionConflictFor({
    stagedRow,
    accepted,
    review,
    baselineMatches,
    ledger: ledgerByPhysical.get(rowPhysicalKey) ?? []
  });
  const repostSignals = detectRepostSignals(stagedRow, review);
  const schemaSafe = canonical.tractionEligible && canonical.validNativeObject;
  const mergeAccepted = Boolean(accepted);
  const exactBaselineDuplicate = baselineMatches.some((row) => sameAttribution(row, stagedRow));
  const baselineAttributionConflict = baselineMatches.some((row) => !sameAttribution(row, stagedRow));
  const noPhysicalConflict = !canonical.nativeIdConflict && !baselineAttributionConflict;
  const importSafe = schemaSafe && mergeAccepted && noPhysicalConflict &&
    stagedRow.review_state === "verified" && !repostSignals.length &&
    attributionConflict.length === 0;
  const instagramPromotionSafe = importSafe && stagedRow.platform === "instagram" &&
    !exactBaselineDuplicate && isPromotableInstagramRow(accepted);

  return {
    ordinal: index,
    source: sourceLabel(entry),
    lane: entry.lane,
    batchSlug: stagedRow.batchSlug ?? null,
    entityType: stagedRow.entityType ?? null,
    entityId: stagedRow.entityId ?? null,
    companySlug: stagedRow.companySlug ?? null,
    companyName: stagedRow.companyName ?? stagedRow.entityName ?? null,
    normalized: canonical,
    nativeId: canonical.nativeId,
    canonicalUrl: canonical.canonicalUrl,
    attribution: {
      input: attributionOf(stagedRow),
      accepted: accepted ? attributionOf(accepted) : null,
      conflict: attributionConflict,
      reconciliationLedger: ledgerByPhysical.get(rowPhysicalKey) ?? []
    },
    dedupe: {
      physicalKey: rowPhysicalKey,
      c01BaselineMatches: baselineMatches,
      withinShardMatches,
      exactBaselineDuplicate,
      baselineAttributionConflict
    },
    excludedRepostOrReshare: repostSignals,
    merge: {
      accepted: mergeAccepted,
      status: mergeAccepted
        ? "accepted"
        : baselineMatches.length > 0
          ? "deduped_against_c01"
          : "not_present_in_merged_evidence",
      quarantineReasons: review?.quarantineReasons ?? [],
      reviewId: review?.id ?? null
    },
    normalizedRow: accepted ?? stagedRow,
    safeToPass: {
      canonicalSchema: schemaSafe,
      importSourceHuntEvidence: importSafe,
      promotePublicEvidenceBatch: instagramPromotionSafe,
      netNew: importSafe && !exactBaselineDuplicate
    },
    stagedRow
  };
});

const normalizedRows = auditRows.map((row) => row.normalizedRow);
const safeImportRows = auditRows.filter((row) => row.safeToPass.netNew &&
  row.lane !== "instagram").map((row) => acceptedById.get(row.stagedRow.id) ?? row.stagedRow);
const safeInstagramRows = auditRows.filter((row) => row.safeToPass.promotePublicEvidenceBatch)
  .map((row) => acceptedById.get(row.stagedRow.id) ?? row.stagedRow);
const safeYoutubeRows = safeImportRows.filter((row) => row.platform === "youtube");
const safeHackerNewsRows = safeImportRows.filter((row) => row.platform === "hacker_news");

await mkdir(outputDir, { recursive: true });
await writeJson(join(outputDir, "normalized-candidate-rows.json"), {
  schemaVersion: "returner-fund-evidence-adapter.v1",
  generatedAt: observedAt,
  rows: normalizedRows
});
await writeJson(join(outputDir, "safe-instagram-promotion-candidate.json"), candidateSnapshot(safeInstagramRows));
await writeJson(join(outputDir, "safe-youtube-a16z-import-candidate.json"), candidateSnapshot(safeYoutubeRows));
await writeJson(join(outputDir, "safe-hacker-news-yc-import-candidate.json"), candidateSnapshot(safeHackerNewsRows));

const importChecks = await runImportChecks({
  outputDir,
  youtubeRows: safeYoutubeRows,
  hackerNewsRows: safeHackerNewsRows
});
const promotionChecks = await runPromotionChecks({ outputDir, rows: safeInstagramRows });

const summary = summarize(auditRows, merged, entries, baselineRows, {
  baselineSha256: sha256(baselineBytes),
  importChecks,
  promotionChecks
});
const report = {
  schemaVersion: "returner-fund-evidence-adapter-audit.v1",
  generatedAt: observedAt,
  scope: {
    shardRoot,
    outputDir,
    continuationSchema: "src/lib/ingestion/canonical-evidence.ts",
    mergeGate: "scripts/lib/autonomous-ingestion-plan.mjs#mergePublicEvidenceSnapshots",
    c01Baseline: {
      gitObject: "c01c366:src/lib/social/public-evidence-current.json",
      sha256: sha256(baselineBytes),
      evidenceRows: baselineRows.length
    }
  },
  summary,
  artifacts: {
    normalizedCandidateRows: join(outputDir, "normalized-candidate-rows.json"),
    safeInstagramPromotionCandidate: join(outputDir, "safe-instagram-promotion-candidate.json"),
    safeYoutubeA16zImportCandidate: join(outputDir, "safe-youtube-a16z-import-candidate.json"),
    safeHackerNewsYcImportCandidate: join(outputDir, "safe-hacker-news-yc-import-candidate.json")
  },
  exactNormalizedRows: auditRows
};
await writeJson(join(outputDir, "reconciliation-report.json"), report);
await writeFile(join(outputDir, "reconciliation-report.md"), renderMarkdown(report), "utf8");
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

function normalizeCanonicalRow(row) {
  const canonical = normalizeWithContinuationSchema({
    platform: row.platform,
    sourceUrl: row.sourceUrl ?? row.canonicalUrl,
    nativeId: row.platformPostId ?? row.nativeId,
    author: row.authorName ?? row.author,
    timestamp: row.postedAt ?? row.publishedAt,
    title: row.title,
    text: row.text,
    content: row.content,
    metrics: row.metrics
  });
  return {
    sourcePlatform: canonical.sourcePlatform,
    platform: canonical.platform,
    sourceUrl: canonical.sourceUrl,
    canonicalUrl: canonical.canonicalUrl,
    suppliedNativeId: canonical.suppliedNativeId,
    nativeId: canonical.nativeId,
    nativeIdSource: canonical.nativeIdSource,
    objectType: canonical.objectType,
    classification: canonical.classification,
    author: canonical.author,
    timestamp: canonical.timestamp,
    content: canonical.content,
    metrics: canonical.metrics,
    visiblePositiveMetrics: canonical.visiblePositiveMetrics,
    validNativeObject: canonical.validNativeObject,
    tractionEligible: canonical.tractionEligible,
    rejectionReasons: canonical.rejectionReasons,
    dedupeKey: canonical.dedupeKey
  };
}

function normalizeWithContinuationSchema(input) {
  return normalizeCanonicalEvidence(input);
}

function physicalKey(canonical) {
  return physicalKeyFromFields(canonical.platform, canonical.canonicalUrl, canonical.nativeId);
}

function physicalKeyFromFields(platform, rawUrl, nativeId) {
  const normalizedPlatform = String(platform ?? "").trim().toLowerCase();
  const id = String(nativeId ?? "").trim();
  if (normalizedPlatform && id) return `${normalizedPlatform}:native:${id}`;
  const url = String(rawUrl ?? "").trim();
  return normalizedPlatform && url ? `${normalizedPlatform}:url:${url}` : null;
}

function indexPhysicalRows(rows) {
  const index = new Map();
  for (const row of rows) {
    const canonical = normalizeCanonicalRow(row);
    const key = physicalKey(canonical);
    if (!key) continue;
    const list = index.get(key) ?? [];
    list.push(row);
    index.set(key, list);
  }
  return index;
}

function attributionOf(row) {
  return {
    batchSlug: row?.batchSlug ?? row?.batch_slug ?? null,
    entityType: row?.entityType ?? row?.entity_type ?? null,
    entityId: row?.entityId ?? row?.entity_id ?? null,
    companySlug: row?.companySlug ?? row?.company_slug ?? null,
    companyName: row?.companyName ?? row?.company_name ?? null,
    attributionStatus: row?.attributionStatus ?? row?.attribution?.status ?? null,
    attributionMode: row?.attributionMode ?? null,
    attributionSignals: row?.attributionSignals ?? []
  };
}

function sameAttribution(left, right) {
  const leftBatch = String(left?.batchSlug ?? left?.batch_slug ?? "").toUpperCase();
  const rightBatch = String(right?.batchSlug ?? right?.batch_slug ?? "").toUpperCase();
  return (!leftBatch || !rightBatch || leftBatch === rightBatch) &&
    String(left?.entityType ?? "company") === String(right?.entityType ?? "company") &&
    String(left?.entityId ?? "") === String(right?.entityId ?? "");
}

function compactBaselineRow(row) {
  return {
    id: row?.id ?? null,
    batchSlug: row?.batchSlug ?? row?.batch_slug ?? null,
    entityType: row?.entityType ?? null,
    entityId: row?.entityId ?? null,
    platform: row?.platform ?? null,
    sourceUrl: row?.sourceUrl ?? null,
    platformPostId: row?.platformPostId ?? null,
    attribution: attributionOf(row)
  };
}

function attributionConflictFor({ stagedRow, accepted, review, baselineMatches, ledger }) {
  const conflicts = [];
  for (const baseline of baselineMatches) {
    if (!sameAttribution(baseline, stagedRow)) {
      conflicts.push({
        kind: "c01_baseline_attribution_conflict",
        baseline: attributionOf(baseline),
        incoming: attributionOf(stagedRow)
      });
    }
  }
  if (accepted && !sameAttribution(accepted, stagedRow)) {
    conflicts.push({
      kind: "merge_reattributed",
      incoming: attributionOf(stagedRow),
      accepted: attributionOf(accepted)
    });
  }
  if (review?.quarantineReasons?.some((reason) => /attribution|owner|identity/i.test(reason))) {
    conflicts.push({ kind: "merge_quarantined", reasons: review.quarantineReasons });
  }
  for (const entry of ledger) conflicts.push({ kind: "reconciliation_ledger", entry });
  return conflicts;
}

function detectRepostSignals(row, review) {
  const signals = [];
  const serialized = JSON.stringify(row).toLowerCase();
  if (/repost|reshar|retweet|reposted_by|shared post/.test(serialized)) signals.push("explicit_repost_or_reshare_marker");
  for (const reason of review?.quarantineReasons ?? []) {
    if (/repost|reshar|retweet/.test(String(reason).toLowerCase())) signals.push(`quarantine:${reason}`);
  }
  return [...new Set(signals)];
}

function isPromotableInstagramRow(row) {
  const owner = row?.nativeAuthorResolution?.owner;
  return row?.platform === "instagram" &&
    row?.review_state === "verified" &&
    row?.attributionStatus === "verified" &&
    row?.nativeAuthorResolution?.status === "matched" &&
    owner?.batchSlug === row?.batchSlug &&
    owner?.companySlug === row?.companySlug &&
    owner?.entityType === row?.entityType &&
    owner?.entityId === row?.entityId &&
    Number(row?.contributionScore) > 0 &&
    Array.isArray(row?.attributionSignals) && row.attributionSignals.length > 0;
}

function candidateSnapshot(rows) {
  return {
    source: {
      label: "Returner fund isolated shard staged candidate",
      fetchedAt: observedAt,
      batchSlugs: [...new Set(rows.map((row) => row.batchSlug).filter(Boolean))].sort()
    },
    evidence: rows,
    needsReview: [],
    failures: [],
    attempts: {}
  };
}

async function runImportChecks({ outputDir, youtubeRows, hackerNewsRows }) {
  const checks = [];
  for (const [name, target, file] of [
    ["youtube-a16z", "a16z", "safe-youtube-a16z-import-candidate.json"],
    ["hacker-news-yc", "yc", "safe-hacker-news-yc-import-candidate.json"]
  ]) {
    const candidatePath = join(outputDir, file);
    const auditPath = join(outputDir, `${name}-import-audit.json`);
    const rows = name === "youtube-a16z" ? youtubeRows : hackerNewsRows;
    const args = [
      "scripts/import-source-hunt-evidence.mjs",
      `--target=${target}`,
      `--input=${candidatePath}`,
      `--observed-at=${observedAt}`,
      `--audit-output=${auditPath}`,
      "--dry-run",
      "--strict"
    ];
    try {
      const stdout = execFileSync(process.execPath, args, { cwd: root, encoding: "utf8" });
      checks.push({ name, candidateRows: rows.length, status: "passed", stdout: lastJson(stdout) });
    } catch (error) {
      checks.push({
        name,
        candidateRows: rows.length,
        status: "failed",
        stdout: lastJson(error.stdout?.toString?.() ?? ""),
        stderr: String(error.stderr ?? "").slice(-4_000)
      });
    }
  }
  return checks;
}

async function runPromotionChecks({ outputDir, rows }) {
  const checks = [];
  for (const batch of ["S2026", "S26", "A16ZSR006"]) {
    const batchRows = rows.filter((row) => row.batchSlug === batch);
    if (batchRows.length === 0) {
      checks.push({ batch, candidateRows: 0, status: "not_run" });
      continue;
    }
    const candidatePath = join(outputDir, `safe-instagram-${batch.toLowerCase()}-promotion-candidate.json`);
    await writeJson(candidatePath, candidateSnapshot(batchRows));
    const args = [
      "scripts/promote-public-evidence-batch.mjs",
      `--candidate=${candidatePath}`,
      `--batch=${batch}`,
      "--platform=instagram",
      `--max-added=${batchRows.length}`,
      "--dry-run"
    ];
    try {
      const stdout = execFileSync(process.execPath, args, { cwd: root, encoding: "utf8" });
      checks.push({ batch, candidateRows: batchRows.length, status: "passed", stdout: lastJson(stdout) });
    } catch (error) {
      checks.push({
        batch,
        candidateRows: batchRows.length,
        status: "failed",
        stdout: lastJson(error.stdout?.toString?.() ?? ""),
        stderr: String(error.stderr ?? "").slice(-4_000)
      });
    }
  }
  return checks;
}

function summarize(rows, merged, entries, baselineRows, checks) {
  const counts = (predicate) => rows.filter(predicate).length;
  const byLane = Object.fromEntries([...new Set(entries.map((entry) => entry.lane))].sort().map((lane) => [
    lane,
    {
      received: counts((row) => row.lane === lane),
      canonicalSchemaEligible: counts((row) => row.lane === lane && row.safeToPass.canonicalSchema),
      mergeAccepted: counts((row) => row.lane === lane && row.merge.accepted),
      c01PhysicalCollisions: counts((row) => row.lane === lane && row.dedupe.c01BaselineMatches.length > 0),
      c01AttributionConflicts: counts((row) => row.lane === lane && row.dedupe.baselineAttributionConflict),
      excludedRepostOrReshare: counts((row) => row.lane === lane && row.excludedRepostOrReshare.length > 0),
      safeNetNew: counts((row) => row.lane === lane && row.safeToPass.netNew)
    }
  ]));
  return {
    received: rows.length,
    baselineEvidenceRows: baselineRows.length,
    mergedEvidenceRows: (merged.evidence ?? []).length,
    mergedReviewRows: (merged.needsReview ?? []).length,
    attributionReconciliationRows: (merged.attributionReconciliationLedger ?? []).length,
    c01PhysicalCollisions: counts((row) => row.dedupe.c01BaselineMatches.length > 0),
    c01AttributionConflicts: counts((row) => row.dedupe.baselineAttributionConflict),
    withinShardPhysicalCollisions: counts((row) => row.dedupe.withinShardMatches.length > 0),
    excludedRepostOrReshare: counts((row) => row.excludedRepostOrReshare.length > 0),
    canonicalSchemaEligible: counts((row) => row.safeToPass.canonicalSchema),
    mergeAccepted: counts((row) => row.merge.accepted),
    safeNetNewRows: counts((row) => row.safeToPass.netNew),
    safeInstagramPromotionRows: counts((row) => row.safeToPass.promotePublicEvidenceBatch),
    safeImportRows: counts((row) => row.safeToPass.importSourceHuntEvidence),
    byLane,
    importChecks: checks.importChecks,
    promotionChecks: checks.promotionChecks
  };
}

function renderMarkdown(report) {
  const s = report.summary;
  const rows = report.exactNormalizedRows;
  const lines = [
    "# Returner-fund shard evidence adapter audit",
    "",
    `Generated ${report.generatedAt}. Canonical files were not written. Baseline: \`${report.scope.c01Baseline.gitObject}\` (${report.scope.c01Baseline.evidenceRows} evidence rows, SHA-256 \`${report.scope.c01Baseline.sha256}\`).`,
    "",
    "## Outcome",
    "",
    `Received **${s.received}** rows: ${Object.entries(s.byLane).map(([lane, value]) => `${lane} ${value.received}`).join(", ")}. **${s.safeNetNewRows}** are net-new and safe for the existing import/promote lanes after schema, attribution, and dedupe checks.`,
    "",
    "| lane | received | schema eligible | merge accepted | c01 collisions | c01 attribution conflicts | repost/reshare excluded | safe net-new |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...Object.entries(s.byLane).map(([lane, value]) => `| ${lane} | ${value.received} | ${value.canonicalSchemaEligible} | ${value.mergeAccepted} | ${value.c01PhysicalCollisions} | ${value.c01AttributionConflicts} | ${value.excludedRepostOrReshare} | ${value.safeNetNew} |`),
    "",
    "## Safe staged files",
    "",
    `- Instagram promotion candidate: \`${report.artifacts.safeInstagramPromotionCandidate}\``,
    `- YouTube/a16z strict-import candidate: \`${report.artifacts.safeYoutubeA16zImportCandidate}\``,
    `- Hacker News/YC strict-import candidate: \`${report.artifacts.safeHackerNewsYcImportCandidate}\``,
    `- Exact normalized rows and per-row reconciliation: \`${report.artifacts.normalizedCandidateRows}\` and \`${join(report.scope.outputDir, "reconciliation-report.json")}\``,
    "",
    "## Existing-script dry runs",
    "",
    ...[...(s.importChecks ?? []), ...(s.promotionChecks ?? [])].map((check) => `- ${check.name ?? check.batch}: **${check.status}** (${check.candidateRows} candidate rows).`),
    "",
    "## Per-row exact normalized audit",
    "",
    "| # | source | platform | batch | native ID | canonical URL | c01 collision | attribution conflict | merge | import safe | promote safe |",
    "|---:|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map((row) => `| ${row.ordinal} | ${row.source} | ${row.normalized.platform ?? ""} | ${row.batchSlug ?? ""} | ${row.nativeId ?? ""} | ${row.canonicalUrl ?? ""} | ${row.dedupe.c01BaselineMatches.length ? "yes" : "no"} | ${row.attribution.conflict.length ? "yes" : "no"} | ${row.merge.status}${row.merge.quarantineReasons.length ? ` (${row.merge.quarantineReasons.join(", ")})` : ""} | ${row.safeToPass.importSourceHuntEvidence ? "yes" : "no"} | ${row.safeToPass.promotePublicEvidenceBatch ? "yes" : "no"} |`),
    "",
    "The JSON report is authoritative for full row fields, exact canonical-schema normalization, attribution objects, dedupe matches, quarantine reasons, repost/reshare signals, and staged row payloads."
  ];
  return `${lines.join("\n")}\n`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function lastJson(value) {
  const lines = String(value ?? "").trim().split("\n").reverse();
  for (const line of lines) {
    try { return JSON.parse(line); } catch {}
  }
  return null;
}
