import fs from "node:fs";
import path from "node:path";
import { classifyPostTopics, normalizePostTopics } from "../src/lib/graph/post-topics.ts";

const BATCHES = [
  { slug: "S2026", file: "s2026" },
  { slug: "S26", file: "s26" },
  { slug: "A16ZSR006", file: "a16zsr006" }
];
const AUDIENCES = ["off", "yc_partners", "insiders"];
const VOLUME_PATH = path.join("src", "lib", "social", "volume-evidence-current.json");
const OUTPUT_DIR = path.join("public", "topic-facets");
const snapshotVersion = "2026-08-05-volume-topics";

const volume = readJson(VOLUME_PATH).evidence ?? [];
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

for (const batch of BATCHES) {
  const records = new Map();
  const aliasToRecord = new Map();

  for (const audience of AUDIENCES) {
    const graph = readJson(path.join("public", "graph", `${batch.file}${audienceSuffix(audience)}.json`));
    const companyByEntity = companyOwnershipIndex(graph.nodes ?? []);
    for (const item of graph.evidence ?? []) {
      addEvidence(records, aliasToRecord, item, {
        audienceId: audience,
        companyId: item.attachedCompanyId ?? companyByEntity.get(item.entityId),
        source: "published"
      });
    }
  }

  const offGraph = readJson(path.join("public", "graph", `${batch.file}.json`));
  const companyByEntity = companyOwnershipIndex(offGraph.nodes ?? []);
  for (const item of volume.filter((candidate) => batchSlug(candidate) === batch.slug)) {
    addEvidence(records, aliasToRecord, item, {
      audienceId: "off",
      companyId: item.attachedCompanyId ?? companyByEntity.get(item.entityId),
      source: "volume"
    });
  }

  const rows = [...records.values()]
    .flatMap((record) => record.topics.map((topic) => ({
      topic,
      postKey: record.postKey,
      platform: record.platform,
      companyId: record.companyId,
      contributionScore: record.contributionScore,
      audienceId: record.audienceId
    })))
    .sort((left, right) =>
      left.audienceId.localeCompare(right.audienceId) ||
      left.topic.localeCompare(right.topic) ||
      left.postKey.localeCompare(right.postKey) ||
      left.companyId.localeCompare(right.companyId)
    );

  const output = {
    version: snapshotVersion,
    batchSlug: batch.slug,
    rowCount: rows.length,
    rows
  };
  fs.writeFileSync(
    path.join(OUTPUT_DIR, `${batch.file}.json`),
    JSON.stringify(output)
  );
  console.log(JSON.stringify({ batch: batch.slug, records: records.size, rows: rows.length }));
}

function addEvidence(records, aliasToRecord, item, options) {
  if (!options.companyId || !item.platform || !item.sourceUrl) return;
  const topics = topicsForEvidence(item);
  if (!topics.length) return;

  const aliases = postAliases(item);
  const scopedAliases = aliases.map((alias) => `${options.audienceId}:${alias}`);
  const existingKey = scopedAliases.map((alias) => aliasToRecord.get(alias)).find(Boolean);
  if (existingKey) return;

  const postKey = aliases[0];
  const recordKey = `${options.audienceId}:${postKey}`;
  records.set(recordKey, {
    audienceId: options.audienceId,
    companyId: options.companyId,
    contributionScore: Number.isFinite(item.contributionScore) ? item.contributionScore : 0,
    platform: item.platform,
    postKey,
    source: options.source,
    topics
  });
  for (const alias of scopedAliases) aliasToRecord.set(alias, recordKey);
}

function topicsForEvidence(item) {
  const existing = normalizePostTopics(Array.isArray(item.topics) ? item.topics : []);
  if (existing.length && item.topicClassification?.method === "manual") return existing;
  const classification = classifyPostTopics({
    title: item.title,
    text: item.text,
    rawVisibleText: item.rawVisibleText,
    platform: item.platform,
    mediaType: item.mediaType,
    authorType: item.entityType === "founder" ? "founder" : "company"
  });
  return normalizePostTopics(classification.topics);
}

function companyOwnershipIndex(nodes) {
  const index = new Map();
  for (const node of nodes) {
    if (node.entityType !== "company") continue;
    index.set(node.entityId, node.entityId);
    for (const founder of node.founders ?? []) index.set(founder.id, node.entityId);
  }
  return index;
}

function batchSlug(item) {
  return String(item.batchSlug ?? item.batch_slug ?? "").trim().toUpperCase();
}

function postAliases(item) {
  const platform = String(item.platform).toLowerCase();
  const aliases = new Set();
  const sourceUrl = canonicalUrl(item.sourceUrl);
  if (sourceUrl) aliases.add(`${platform}:url:${sourceUrl}`);

  const nativeId = String(item.platformPostId ?? "").trim();
  if (nativeId) aliases.add(`${platform}:id:${nativeId}`);
  if (platform === "x") {
    const match = sourceUrl.match(/\/status\/(\d+)/i);
    if (match) aliases.add(`${platform}:post:${match[1]}`);
  }
  if (platform === "instagram") {
    const match = sourceUrl.match(/\/(?:p|reel|tv)\/([^/]+)/i);
    if (match) aliases.add(`${platform}:post:${match[1]}`);
  }
  if (platform === "youtube") {
    const match = sourceUrl.match(/[?&]v=([^&]+)/i) ?? sourceUrl.match(/youtu\.be\/([^/]+)/i);
    if (match) aliases.add(`${platform}:post:${match[1]}`);
  }
  if (platform === "linkedin") {
    const match = sourceUrl.match(/activity[-:](\d+)/i) ?? sourceUrl.match(/urn:li:activity:(\d+)/i);
    if (match) aliases.add(`${platform}:post:${match[1]}`);
  }
  return [...aliases];
}

function canonicalUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.hostname = url.hostname.replace(/^www\./i, "").toLowerCase();
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_|fbclid$|gclid$|igshid$|mc_|ref$|ref_src$|s$|t$)/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    if (url.hostname === "twitter.com" || url.hostname === "mobile.twitter.com") url.hostname = "x.com";
    url.pathname = url.pathname.replace(/\/$/, "");
    return url.toString();
  } catch {
    return "";
  }
}

function audienceSuffix(audience) {
  if (audience === "off") return "";
  return audience === "yc_partners" ? "-yc-partners" : "-insiders";
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
