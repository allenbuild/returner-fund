import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const RETURNER_FUND_SHARD_ROOT = "/private/tmp/returner-fund-shards";

const INSTAGRAM_FILES = [
  "instagram-youtube/instagram/public-a16zsr006.json",
  "instagram-youtube/instagram/public-s2026.json",
  "instagram-youtube/instagram/public-s26.json"
];

const OPEN_PLATFORM_FILES = [
  "open-platforms/checkpoint-a16zsr006.json",
  "open-platforms/checkpoint-s2026.json",
  "open-platforms/checkpoint-s26.json"
];

export async function loadReturnerFundShardRows(
  root = RETURNER_FUND_SHARD_ROOT
) {
  const rows = [];

  for (const relativePath of INSTAGRAM_FILES) {
    const snapshot = await readJson(join(root, relativePath));
    for (const [rowIndex, row] of (snapshot.evidence ?? []).entries()) {
      rows.push({
        lane: "instagram",
        sourcePath: relativePath,
        sourceIndex: rowIndex,
        row
      });
    }
  }

  for (const relativePath of OPEN_PLATFORM_FILES) {
    const snapshot = await readJson(join(root, relativePath));
    for (const [rowIndex, row] of (snapshot.evidence ?? []).entries()) {
      rows.push({
        lane: "open-platforms",
        sourcePath: relativePath,
        sourceIndex: rowIndex,
        row
      });
    }
  }

  const youtubePath = "instagram-youtube/youtube/pages.ndjson";
  const journal = await readFile(join(root, youtubePath), "utf8");
  for (const [lineIndex, line] of journal.trimEnd().split("\n").entries()) {
    const event = JSON.parse(line);
    if (!Array.isArray(event.evidence)) continue;
    for (const [evidenceIndex, row] of event.evidence.entries()) {
      rows.push({
        lane: "youtube",
        sourcePath: youtubePath,
        sourceIndex: lineIndex + 1,
        evidenceIndex,
        targetKey: event.targetKey ?? null,
        sequence: event.sequence ?? null,
        row
      });
    }
  }

  return rows;
}

export function adaptReturnerFundRow(entry) {
  if (entry.lane !== "youtube") return structuredClone(entry.row);
  const row = entry.row;
  const entityId = requiredText(row.entityId, "YouTube entityId");
  const entityType = requiredText(row.entityType, "YouTube entityType");
  const batchSlug = requiredText(row.batchSlug, "YouTube batchSlug");
  const nativeId = requiredText(row.nativeId, "YouTube nativeId");
  const sourceUrl = requiredText(row.canonicalUrl ?? row.sourceUrl, "YouTube sourceUrl");
  const companySlug = String(row.companyId ?? entityId)
    .replace(/^a16z-speedrun-006-/, "");
  return {
    id: `youtube-${batchSlug.toLowerCase()}-${entityId}-${nativeId}`,
    batchSlug,
    entityType,
    entityId,
    companyId: row.companyId ?? entityId,
    companySlug,
    companyName: row.companyName ?? row.entityName ?? entityId,
    officialDomain: row.officialDomain ?? null,
    platform: "youtube",
    sourceUrl,
    canonicalUrl: sourceUrl,
    platformPostId: nativeId,
    nativeId,
    accountUrl: row.accountUrl ?? null,
    title: row.title ?? null,
    text: row.text ?? row.title ?? null,
    authorName: row.author ?? row.entityName ?? null,
    postedAt: row.publishedAt ?? null,
    publishedAt: row.publishedAt ?? null,
    metrics: row.metrics ?? {},
    rawVisibleText: JSON.stringify({
      source: row.discoveryMethod ?? "historical-depth-backfill",
      attribution: row.attribution ?? null,
      nativeChannelId: row.attribution?.nativeChannelId ?? null
    }),
    matchReason: row.attribution?.method ?? "verified official YouTube channel feed",
    review_state: "verified",
    attributionStatus: row.attribution?.status ?? null,
    attributionMode: "account_owner",
    attributionSignals: [
      "verified_channel_id",
      "official_youtube_atom_feed"
    ]
  };
}

export function sourceLabel(entry) {
  const suffix = entry.evidenceIndex === undefined
    ? `evidence[${entry.sourceIndex}]`
    : `line[${entry.sourceIndex}].evidence[${entry.evidenceIndex}]`;
  return `${entry.sourcePath}#${suffix}`;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new TypeError(`${label} is required.`);
  return text;
}
