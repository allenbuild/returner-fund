#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";

const root = process.cwd();
const outputDir = resolve(root, argValue("--output-dir") ?? "work/volume-target-2026-08-05");
const outputPath = resolve(outputDir, "post-ledger.ndjson");
const uniquePath = resolve(outputDir, "unique-native-posts.ndjson");
const summaryPath = resolve(outputDir, "summary.json");

const sourceFiles = [
  ["public", "src/lib/social/public-evidence-current.json"],
  ["targeted", "src/lib/social/targeted-evidence-current.json"],
  ["logged-in", "src/lib/social/logged-in-evidence-current.json"],
  ["public-volume-a16z", "work/public-volume-expansion-2026-08-05/public-a16zsr006.json"],
  ["public-volume-s2026", "work/public-volume-expansion-2026-08-05/public-s2026.json"],
  ["public-volume-s26", "work/public-volume-expansion-2026-08-05/public-s26.json"],
  ["public-youtube-s2026-all", "work/public-volume-expansion-2026-08-05/youtube-s2026-all.json"],
  ["public-youtube-s26-all", "work/public-volume-expansion-2026-08-05/youtube-s26-all.json"],
  ["public-youtube-a16z-all", "work/public-volume-expansion-2026-08-05/youtube-a16zsr006-all.json"],
  ["public-social-s2026-refresh", "work/public-volume-expansion-2026-08-05/social-s2026-refresh.json"],
  ["public-social-s26-refresh", "work/public-volume-expansion-2026-08-05/social-s26-refresh.json"],
  ["public-social-a16z-refresh", "work/public-volume-expansion-2026-08-05/social-a16zsr006-refresh.json"],
  ["a16z-seeded-source-hunt", "src/lib/social/a16z-speedrun-006-social-evidence.json"],
  ["source-hunt-s26-recent", "outputs/source-hunt/2026-07-19-s26-new-companies-recent.json"],
  ["source-hunt-community-video", "outputs/source-hunt/2026-07-19-cross-batch-community-video-recent.json"],
  ["source-hunt-s2026-youtube", "outputs/source-hunt/2026-07-22-two-hour-official-youtube-s2026.json"],
  ["supplemental-social-candidates", "work/volume-target-2026-08-05/supplemental-social-candidate.json"],
  ["supplemental-x-worker-candidate", "work/volume-target-2026-08-05/supplemental-x-worker-candidate.json"],
  ["supplemental-enjamb-x-candidate", "work/volume-target-2026-08-05/supplemental-enjamb-candidate.json"],
  ["supplemental-live-linkedin-s2026", "work/volume-target-2026-08-05/supplemental-live-linkedin-s2026.json"],
  ["supplemental-web-retry-new", "work/volume-target-2026-08-05/supplemental-web-retry-new.json"],
  ["supplemental-x-public-rerun", "work/volume-target-2026-08-05/supplemental-x-public-rerun.json"],
  ["public-linkedin-a16z", "work/public-linkedin-volume-2026-08-05/public-9853.json"],
  ["public-linkedin-s2026", "work/public-linkedin-volume-2026-08-05/public-9851.json"],
  ["public-linkedin-s26", "work/public-linkedin-volume-2026-08-05/public-9852.json"]
];
const historicalJournals = [
  "work/historical-backfill/volume-expansion-2026-08-05/pages.ndjson",
  "work/historical-backfill/historical-web-highcap-2026-08-05/pages.ndjson",
  "work/historical-backfill/historical-web-highcap-s2026-2026-08-05/pages.ndjson",
  "work/historical-backfill/historical-web-highcap-a16z-2026-08-05/pages.ndjson",
  "work/historical-backfill/historical-rss-highcap-2026-08-05/pages.ndjson",
  "work/historical-backfill/historical-web-deep-2026-08-05/pages.ndjson",
  "work/historical-backfill/youtube-depth-worker-2026-08-05/pages.ndjson"
];
const externalVerifiedNdjson = "/Users/allenxu/Documents/Codex/2026-07-09/pu/returner-fund/work/collection-throughput/new-verified-42-20260803T050615Z/evidence-global-new-union-284.ndjson";

const ledger = [];
const unique = new Map();
const counters = {
  acceptedEvidenceRows: 0,
  reviewCandidateRows: 0,
  reviewRowsWithNativeId: 0,
  historicalEvidenceRows: 0,
  totalLedgerRows: 0,
  skippedMissingSources: 0
};

for (const [label, relativePath] of sourceFiles) {
  const path = resolve(root, relativePath);
  let payload;
  try {
    payload = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      counters.skippedMissingSources += 1;
      continue;
    }
    throw error;
  }
  addRows(payload.evidence, "accepted", { label, path: relativePath });
  addRows(payload.needsReview, "review", { label, path: relativePath });
}

try {
  const externalText = await readFile(externalVerifiedNdjson, "utf8");
  for (const [index, rowText] of externalText.split(/\r?\n/).entries()) {
    if (!rowText.trim()) continue;
    const row = JSON.parse(rowText);
    // The companion summary reports the X follow-up as requiring reconciliation;
    // only the independently verified YouTube/LinkedIn rows enter this ledger.
    if (!new Set(["youtube", "linkedin"]).has(String(row?.platform ?? "").toLowerCase())) continue;
    addRow(row, "accepted", {
      label: "external-verified-continuation",
      path: externalVerifiedNdjson,
      sourceIndex: index
    });
    counters.acceptedEvidenceRows += 1;
  }
} catch (error) {
  if (error?.code === "ENOENT") counters.skippedMissingSources += 1;
  else throw error;
}

for (const relativePath of historicalJournals) {
  const historicalJournal = resolve(root, relativePath);
  try {
    await streamNdjson(historicalJournal, (event) => {
      if (event.type !== "page_checkpoint") return;
      for (const [index, row] of (event.evidence ?? []).entries()) {
        addRow(row, "historical", {
          label: "historical-volume-expansion",
          path: relativePath,
          pageSequence: event.sequence,
          pageEvidenceIndex: index,
          targetKey: event.targetKey
        });
        counters.historicalEvidenceRows += 1;
      }
    });
  } catch (error) {
    if (error?.code === "ENOENT") {
      counters.skippedMissingSources += 1;
      continue;
    }
    throw error;
  }
}

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, ledger.map((row) => `${JSON.stringify(row)}\n`).join(""));
await writeFile(uniquePath, [...unique.values()].map((row) => `${JSON.stringify(row)}\n`).join(""));

const summary = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  output: {
    ledger: outputPath,
    uniqueNativePosts: uniquePath
  },
  counts: {
    ...counters,
    uniqueNativePostKeys: unique.size,
    acceptedAndHistoricalRows: counters.acceptedEvidenceRows + counters.historicalEvidenceRows,
    totalRecordsIncludingReviewCandidates: counters.totalLedgerRows,
    targetRange: { min: 40000, max: 70000 },
    targetRangeReachedByTotalRecords: counters.totalLedgerRows >= 40000 && counters.totalLedgerRows <= 70000,
    targetRangeReachedByUniqueNativePosts: unique.size >= 40000 && unique.size <= 70000
  },
  notes: [
    "Ledger rows retain source and review status; rows are not silently deduplicated.",
    "unique-native-posts.ndjson keeps one accepted or historical row per platform/native ID; review rows are used only when no accepted row exists.",
    "Review candidates without a native platform post ID remain ledger records and are not counted as unique native posts."
  ]
};
await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

function addRows(rows, status, source) {
  if (!Array.isArray(rows)) return;
  for (const [index, row] of rows.entries()) {
    const effectiveStatus = status === "accepted" && isReviewRow(row) ? "review" : status;
    addRow(row, effectiveStatus, { ...source, sourceIndex: index });
    if (effectiveStatus === "accepted") counters.acceptedEvidenceRows += 1;
    else counters.reviewCandidateRows += 1;
  }
}

function isReviewRow(row) {
  const state = String(row?.review_state ?? row?.reviewState ?? row?.status ?? "").trim().toLowerCase();
  return state === "needs_review" || state === "needs-review" || state === "review";
}

function addRow(row, status, source) {
  const nativeId = nativePostId(row);
  const platform = String(row?.platform ?? "").trim().toLowerCase() || null;
  const ledgerRow = {
    schemaVersion: 1,
    status,
    platform,
    nativeId,
    nativeKey: platform && nativeId ? `${platform}:${nativeId}` : null,
    source,
    row
  };
  ledger.push(ledgerRow);
  counters.totalLedgerRows += 1;
  if (status === "review" && nativeId) counters.reviewRowsWithNativeId += 1;
  if (!platform || !nativeId) return;
  const key = `${platform}:${nativeId}`;
  const current = unique.get(key);
  if (!current || rank(ledgerRow) < rank(current)) unique.set(key, ledgerRow);
}

function rank(row) {
  if (row.status === "accepted") return 0;
  if (row.status === "historical") return 1;
  return 2;
}

async function streamNdjson(path, onRecord) {
  const input = createReadStream(path, { encoding: "utf8" });
  const reader = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      if (!line.trim()) continue;
      await onRecord(JSON.parse(line));
    }
  } finally {
    reader.close();
    input.destroy();
  }
}

function nativePostId(row) {
  const value = row?.platformPostId ?? row?.nativeId ?? row?.native_id ??
    row?.postId ?? row?.externalId ?? row?.external_id;
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function argValue(name) {
  const prefix = `${name}=`;
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}
