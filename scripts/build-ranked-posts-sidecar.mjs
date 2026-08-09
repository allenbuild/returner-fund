#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BATCHES = [
  { slug: "S26", file: "s26" },
  { slug: "S2026", file: "s2026" },
  { slug: "A16ZSR006", file: "a16zsr006" }
];
const AUDIENCES = ["off", "yc_partners", "insiders"];
const SIDECAR_VERSION = "ranked-posts-full-corpus-v1";
const DEFAULT_OUTPUT = path.join("src", "lib", "graph", "ranked-posts-sidecar.generated.json");
const EVIDENCE_FIELDS = [
  "id",
  "batchSlug",
  "entityType",
  "entityId",
  "platform",
  "authorName",
  "authorHandle",
  "postedAt",
  "publishedAtPrecision",
  "title",
  "text",
  "mediaType",
  "mediaUrl",
  "mediaUrls",
  "thumbnailUrl",
  "thumbnailSource",
  "linkStatus",
  "metrics",
  "contributionScore",
  "rawEngagement",
  "normalizedScore",
  "tractionStatus",
  "sourceUrl",
  "platformPostId",
  "platformObjectId",
  "why",
  "attachedCompanyId",
  "attachedCompanyName",
  "socialAccountId",
  "canonicalAccountId",
  "accountUrl",
  "review_state",
  "topVoice",
  "topics"
];

export async function buildRankedPostsSidecarSnapshot({
  rootDir = process.cwd(),
  buildGraphResponse,
  rankableEvidence,
  canonicalPostKey
} = {}) {
  const dependencies = await rankingDependencies({
    buildGraphResponse,
    rankableEvidence,
    canonicalPostKey
  });
  const batches = {};
  const previewGeneratedAt = [];

  for (const batch of BATCHES) {
    batches[batch.slug] = {};
    for (const audience of AUDIENCES) {
      const previewGraph = JSON.parse(await readFile(
        path.join(rootDir, "public", "graph", `${batch.file}${audienceSuffix(audience)}.json`),
        "utf8"
      ));
      const fullGraph = dependencies.buildGraphResponse({
        batchSlug: batch.slug,
        topVoices: audience
      });
      const scope = buildRankedPostsSidecarScope({
        fullGraph,
        previewGraph,
        rankableEvidence: dependencies.rankableEvidence,
        canonicalPostKey: dependencies.canonicalPostKey
      });
      batches[batch.slug][audience] = scope;
      previewGeneratedAt.push(scope.previewGeneratedAt);
    }
  }

  return {
    version: SIDECAR_VERSION,
    generatedAt: latestTimestamp(previewGeneratedAt),
    batches
  };
}

export function buildRankedPostsSidecarScope({
  fullGraph,
  previewGraph,
  rankableEvidence,
  canonicalPostKey
}) {
  if (fullGraph.batch.slug !== previewGraph.batch.slug) {
    throw new Error("Ranked Posts sidecar inputs must describe the same batch.");
  }
  if (fullGraph.selectedTopVoiceAudience.id !== previewGraph.selectedTopVoiceAudience.id) {
    throw new Error("Ranked Posts sidecar inputs must describe the same audience.");
  }

  const fullCompanyByEntity = companyOwnershipIndex(fullGraph.nodes ?? []);
  const previewCompanyByEntity = companyOwnershipIndex(previewGraph.nodes ?? []);
  const fullRankable = rankableEvidence(fullGraph.evidence ?? []);
  const previewRankable = rankableEvidence(previewGraph.evidence ?? []);
  const fullByKey = new Map(fullRankable.map((item) => [canonicalPostKey(item), item]));
  const previewKeys = new Set(previewRankable.map(canonicalPostKey));
  const overflow = [...fullByKey]
    .filter(([postKey]) => !previewKeys.has(postKey))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, item]) => compactEvidence(item, companyIdForEvidence(item, fullCompanyByEntity)));
  const overflowKeys = new Set(overflow.map(canonicalPostKey));
  const fullKeys = [...fullByKey.keys()].sort();
  const representedKeys = fullKeys.filter((postKey) => previewKeys.has(postKey) || overflowKeys.has(postKey));

  if (representedKeys.length !== fullKeys.length) {
    throw new Error(
      `Ranked Posts sidecar omitted ${fullKeys.length - representedKeys.length} rankable full-corpus posts.`
    );
  }

  return {
    previewGeneratedAt: previewGraph.generatedAt,
    sourceEvidenceCount: fullGraph.evidence?.length ?? 0,
    previewEvidenceCount: previewGraph.evidence?.length ?? 0,
    fullRankableCount: fullRankable.length,
    previewRankableCount: previewRankable.length,
    overflowRankableCount: overflow.length,
    fullRankableDigest: postKeyDigest(fullKeys),
    representedRankableDigest: postKeyDigest(representedKeys),
    previewRankableByCompany: countByCompany(previewRankable, previewCompanyByEntity),
    fullRankableByCompany: countByCompany(fullRankable, fullCompanyByEntity),
    evidence: overflow
  };
}

export async function main(rawArgs = process.argv.slice(2)) {
  const validate = rawArgs.includes("--validate");
  const outputArg = rawArgs.find((arg) => arg.startsWith("--output="));
  const rootDir = process.cwd();
  const outputPath = path.resolve(rootDir, outputArg?.slice("--output=".length) || DEFAULT_OUTPUT);
  const snapshot = await buildRankedPostsSidecarSnapshot({ rootDir });

  if (validate) {
    const current = JSON.parse(await readFile(outputPath, "utf8"));
    if (JSON.stringify(current) !== JSON.stringify(snapshot)) {
      throw new Error(
        `Ranked Posts sidecar is stale. Rebuild it with ${publicationCommand()}.`
      );
    }
    process.stdout.write(`${JSON.stringify(summary(snapshot, "valid"))}\n`);
    return snapshot;
  }

  const temporary = `${outputPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, "utf8");
  await rename(temporary, outputPath);
  process.stdout.write(`${JSON.stringify(summary(snapshot, "written"))}\n`);
  return snapshot;
}

async function rankingDependencies(overrides) {
  const [{ buildGraphResponse }, rankedPosts, dedupe] = await Promise.all([
    overrides.buildGraphResponse ? Promise.resolve(overrides) : import("../src/lib/graph/graph-builder.ts"),
    overrides.rankableEvidence ? Promise.resolve(overrides) : import("../src/lib/graph/ranked-posts.ts"),
    overrides.canonicalPostKey ? Promise.resolve(overrides) : import("../src/lib/graph/dedupe.ts")
  ]);
  return {
    buildGraphResponse: overrides.buildGraphResponse ?? buildGraphResponse,
    rankableEvidence: overrides.rankableEvidence ?? rankedPosts.rankableEvidence,
    canonicalPostKey: overrides.canonicalPostKey ?? dedupe.canonicalPostKey
  };
}

function compactEvidence(item, companyId) {
  const compact = Object.fromEntries(
    EVIDENCE_FIELDS
      .filter((field) => item[field] !== undefined)
      .map((field) => [field, item[field]])
  );
  if (companyId) compact.attachedCompanyId = companyId;
  return compact;
}

function companyOwnershipIndex(nodes) {
  const result = new Map();
  for (const node of nodes) {
    if (node.entityType !== "company") continue;
    result.set(node.entityId, node.entityId);
    for (const founder of node.founders ?? []) result.set(founder.id, node.entityId);
  }
  return result;
}

function companyIdForEvidence(item, companyByEntity) {
  return item.attachedCompanyId ??
    (item.entityType === "company" ? item.entityId : companyByEntity.get(item.entityId)) ??
    null;
}

function countByCompany(items, companyByEntity) {
  const counts = new Map();
  for (const item of items) {
    const companyId = companyIdForEvidence(item, companyByEntity);
    if (!companyId) continue;
    counts.set(companyId, (counts.get(companyId) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
}

function postKeyDigest(keys) {
  return createHash("sha256").update(keys.join("\n")).digest("hex");
}

function latestTimestamp(values) {
  const valid = values.filter((value) => Number.isFinite(Date.parse(value))).sort();
  return valid.at(-1) ?? new Date(0).toISOString();
}

function audienceSuffix(audience) {
  if (audience === "off") return "";
  return audience === "yc_partners" ? "-yc-partners" : "-insiders";
}

function summary(snapshot, status) {
  const scopes = Object.values(snapshot.batches).flatMap((batch) => Object.values(batch));
  return {
    status,
    output: DEFAULT_OUTPUT,
    scopes: scopes.length,
    sourceEvidence: scopes.reduce((sum, scope) => sum + scope.sourceEvidenceCount, 0),
    fullRankable: scopes.reduce((sum, scope) => sum + scope.fullRankableCount, 0),
    previewRankable: scopes.reduce((sum, scope) => sum + scope.previewRankableCount, 0),
    overflowRankable: scopes.reduce((sum, scope) => sum + scope.overflowRankableCount, 0)
  };
}

function publicationCommand() {
  return "node --experimental-strip-types --loader ./scripts/lib/scoring-diagnostics-ts-loader.mjs scripts/build-ranked-posts-sidecar.mjs";
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
