#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validatedRepositoryDataRoot } from "./lib/validated-repository-data-root.mjs";

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
  "originalText",
  "attributionProvenance",
  "verbatimContributingSentences",
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
  canonicalPostKey,
  canonicalEvidenceUrl
} = {}) {
  const dependencies = await rankingDependencies({
    buildGraphResponse,
    rankableEvidence,
    canonicalPostKey,
    canonicalEvidenceUrl
  });
  const batches = {};
  const previewGeneratedAt = [];
  const parityScopes = [];

  for (const batch of BATCHES) {
    batches[batch.slug] = {};
    const fullGraphs = new Map(
      AUDIENCES.map((audience) => [
        audience,
        dependencies.buildGraphResponse({
          batchSlug: batch.slug,
          topVoices: audience
        })
      ])
    );
    const canonicalGraph = fullGraphs.get("off");
    if (!canonicalGraph) {
      throw new Error(`Ranked Posts sidecar is missing the canonical ${batch.slug} graph.`);
    }
    const canonicalRankableByKey = rankablePhysicalMap({
      evidence: canonicalGraph.evidence ?? [],
      rankableEvidence: dependencies.rankableEvidence,
      canonicalPostKey: dependencies.canonicalPostKey,
      label: `${batch.slug}/off full graph`
    });
    const canonicalCompanyByEntity = companyOwnershipIndex(canonicalGraph.nodes ?? []);

    for (const audience of AUDIENCES) {
      const previewGraph = JSON.parse(await readFile(
        path.join(rootDir, "public", "graph", `${batch.file}${audienceSuffix(audience)}.json`),
        "utf8"
      ));
      const fullGraph = fullGraphs.get(audience);
      if (!fullGraph) {
        throw new Error(`Ranked Posts sidecar is missing the ${batch.slug}/${audience} full graph.`);
      }
      const scope = buildRankedPostsSidecarScope({
        fullGraph,
        previewGraph,
        rankableEvidence: dependencies.rankableEvidence,
        canonicalPostKey: dependencies.canonicalPostKey,
        canonicalEvidenceUrl: dependencies.canonicalEvidenceUrl,
        canonicalPreviewOnlyByKey: audience === "off" ? undefined : canonicalRankableByKey,
        canonicalCompanyByEntity: audience === "off" ? undefined : canonicalCompanyByEntity
      });
      batches[batch.slug][audience] = scope;
      previewGeneratedAt.push(scope.previewGeneratedAt);
      parityScopes.push({
        batchSlug: batch.slug,
        audience,
        fullKeys: rankablePhysicalKeys({
          graph: fullGraph,
          rankableEvidence: dependencies.rankableEvidence,
          canonicalPostKey: dependencies.canonicalPostKey,
          label: `${batch.slug}/${audience} full graph`
        }),
        previewKeys: rankablePhysicalKeys({
          graph: previewGraph,
          rankableEvidence: dependencies.rankableEvidence,
          canonicalPostKey: dependencies.canonicalPostKey,
          label: `${batch.slug}/${audience} preview graph`
        }),
        overflowKeys: scope.evidence.map(dependencies.canonicalPostKey),
        crossAudiencePreviewProjectionKeys: scope.crossAudiencePreviewProjectionKeys
      });
    }
  }

  return {
    version: SIDECAR_VERSION,
    generatedAt: latestTimestamp(previewGeneratedAt),
    canonicalParity: buildCanonicalParity(parityScopes),
    batches
  };
}

export function buildRankedPostsSidecarScope({
  fullGraph,
  previewGraph,
  rankableEvidence,
  canonicalPostKey,
  canonicalEvidenceUrl,
  canonicalPreviewOnlyByKey,
  canonicalCompanyByEntity
}) {
  if (fullGraph.batch.slug !== previewGraph.batch.slug) {
    throw new Error("Ranked Posts sidecar inputs must describe the same batch.");
  }
  if (fullGraph.selectedTopVoiceAudience.id !== previewGraph.selectedTopVoiceAudience.id) {
    throw new Error("Ranked Posts sidecar inputs must describe the same audience.");
  }

  const fullCompanyByEntity = companyOwnershipIndex(fullGraph.nodes ?? []);
  const previewCompanyByEntity = companyOwnershipIndex(previewGraph.nodes ?? []);
  const scopeLabel = `${fullGraph.batch.slug}/${fullGraph.selectedTopVoiceAudience.id}`;
  const fullByKey = rankablePhysicalMap({
    evidence: fullGraph.evidence ?? [],
    rankableEvidence,
    canonicalPostKey,
    label: `${scopeLabel} full graph`
  });
  const previewByKey = rankablePhysicalMap({
    evidence: previewGraph.evidence ?? [],
    rankableEvidence,
    canonicalPostKey,
    label: `${scopeLabel} preview graph`
  });
  const fullRankable = [...fullByKey.values()];
  const previewRankable = [...previewByKey.values()];
  const previewKeys = new Set(previewByKey.keys());
  const canonicalPreviewByKey = new Map(canonicalPreviewOnlyByKey ?? []);
  const canonicalProjectionCompanyByEntity = new Map(
    canonicalCompanyByEntity ?? fullCompanyByEntity
  );
  const previewOnlyKeys = [...previewKeys]
    .filter((postKey) => !fullByKey.has(postKey))
    .sort();
  const previewOnlyKeySet = new Set(previewOnlyKeys);
  const unexpectedPreviewOnlyKeys = previewOnlyKeys.filter(
    (postKey) => !canonicalPreviewByKey.has(postKey)
  );

  if (unexpectedPreviewOnlyKeys.length > 0) {
    throw new Error(
      `Ranked Posts sidecar ${scopeLabel} preview contains ` +
      `${unexpectedPreviewOnlyKeys.length} rankable physical posts absent from both its full scope ` +
      `and the canonical cohort corpus: ${formatPostKeys(unexpectedPreviewOnlyKeys)}.`
    );
  }

  const projectionIdentityMismatches = previewOnlyKeys.flatMap((postKey) => {
    const projected = previewByKey.get(postKey);
    const canonical = canonicalPreviewByKey.get(postKey);
    if (!projected || !canonical) return [];
    const mismatches = canonicalProjectionIdentityMismatches({
      postKey,
      projected,
      canonical,
      canonicalPostKey,
      canonicalEvidenceUrl,
      canonicalCompanyByEntity: canonicalProjectionCompanyByEntity
    });
    return mismatches.length > 0 ? [{ postKey, mismatches }] : [];
  });

  if (projectionIdentityMismatches.length > 0) {
    const details = projectionIdentityMismatches
      .slice(0, 10)
      .map(({ postKey, mismatches }) => `${postKey} (${mismatches.join(", ")})`)
      .join(", ");
    throw new Error(
      `Ranked Posts sidecar ${scopeLabel} preview contains ` +
      `${projectionIdentityMismatches.length} canonical projection identity mismatches: ${details}.`
    );
  }

  assertAttributableRankable(fullRankable, fullCompanyByEntity, `${scopeLabel} full graph`);
  assertAttributableRankable(
    previewRankable.filter((item) => !previewOnlyKeySet.has(canonicalPostKey(item))),
    previewCompanyByEntity,
    `${scopeLabel} preview graph`
  );
  assertAttributableRankable(
    previewOnlyKeys.map((postKey) => previewByKey.get(postKey)).filter(Boolean),
    canonicalProjectionCompanyByEntity,
    `${scopeLabel} canonical preview projections`
  );
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
    crossAudiencePreviewProjectionCount: previewOnlyKeys.length,
    crossAudiencePreviewProjectionKeys: previewOnlyKeys,
    previewRankableByCompany: countByCompany(previewRankable, previewCompanyByEntity),
    fullRankableByCompany: countByCompany(fullRankable, fullCompanyByEntity),
    evidence: overflow
  };
}

function buildCanonicalParity(scopes) {
  const fullKeys = unionSorted(scopes.flatMap((scope) =>
    scope.fullKeys.map((postKey) => scopedPostKey(scope, postKey))
  ));
  const previewKeys = unionSorted(scopes.flatMap((scope) => {
    const fullKeySet = new Set(scope.fullKeys);
    const allowedCrossAudienceKeys = new Set(scope.crossAudiencePreviewProjectionKeys);
    const unclassifiedPreviewOnlyKeys = scope.previewKeys.filter(
      (postKey) => !fullKeySet.has(postKey) && !allowedCrossAudienceKeys.has(postKey)
    );
    if (unclassifiedPreviewOnlyKeys.length > 0) {
      throw new Error(
        `Ranked Posts ${scope.batchSlug}/${scope.audience} preview contains unclassified ` +
        `preview-only physical posts: ${formatPostKeys(unclassifiedPreviewOnlyKeys)}.`
      );
    }
    return scope.previewKeys
      .filter((postKey) => fullKeySet.has(postKey))
      .map((postKey) => scopedPostKey(scope, postKey));
  }));
  const overflowKeys = unionSorted(scopes.flatMap((scope) =>
    scope.overflowKeys.map((postKey) => scopedPostKey(scope, postKey))
  ));
  const representedKeys = unionSorted([...previewKeys, ...overflowKeys]);
  const fullKeySet = new Set(fullKeys);
  const representedKeySet = new Set(representedKeys);
  const previewOnlyKeys = previewKeys.filter((postKey) => !fullKeySet.has(postKey));
  const omittedFullKeys = fullKeys.filter((postKey) => !representedKeySet.has(postKey));
  const representedOnlyKeys = representedKeys.filter((postKey) => !fullKeySet.has(postKey));

  if (previewOnlyKeys.length > 0) {
    throw new Error(
      `Ranked Posts canonical preview contains ${previewOnlyKeys.length} rankable physical posts ` +
      `absent from the full corpus: ${formatPostKeys(previewOnlyKeys)}.`
    );
  }
  if (omittedFullKeys.length > 0 || representedOnlyKeys.length > 0) {
    throw new Error(
      `Ranked Posts canonical representation drifted ` +
      `(omitted=${omittedFullKeys.length}, unexpected=${representedOnlyKeys.length}).`
    );
  }

  const crossAudiencePreviewProjectionKeys = unionSorted(
    scopes.flatMap((scope) => scope.crossAudiencePreviewProjectionKeys)
  );
  return {
    fullRankableCount: fullKeys.length,
    previewRankableCount: previewKeys.length,
    representedRankableCount: representedKeys.length,
    overflowRankableCount: overflowKeys.length,
    crossAudiencePreviewProjectionCount: crossAudiencePreviewProjectionKeys.length,
    fullRankableDigest: postKeyDigest(fullKeys),
    previewRankableDigest: postKeyDigest(previewKeys),
    representedRankableDigest: postKeyDigest(representedKeys),
    crossAudiencePreviewProjectionKeys
  };
}

export async function main(rawArgs = process.argv.slice(2)) {
  const validate = rawArgs.includes("--validate");
  const outputArg = rawArgs.find((arg) => arg.startsWith("--output="));
  const rootArg = rawArgs.find((arg) => arg.startsWith("--root="));
  const rootDir = validatedRepositoryDataRoot(
    rootArg?.slice("--root=".length) ?? process.env.SCORING_DATA_ROOT ?? process.env.SCORING_ROOT,
    { fallbackRoot: process.cwd(), label: "Ranked Posts data root" }
  );
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
  const serialized = `${JSON.stringify(snapshot)}\n`;
  await writeFile(temporary, serialized, "utf8");
  await rename(temporary, outputPath);
  const written = await readFile(outputPath, "utf8");
  if (written !== serialized) {
    throw new Error("Ranked Posts sidecar publication verification failed after atomic rename.");
  }
  process.stdout.write(`${JSON.stringify(summary(snapshot, "written_and_validated"))}\n`);
  return snapshot;
}

async function rankingDependencies(overrides) {
  const needsDedupe = !overrides.canonicalPostKey || !overrides.canonicalEvidenceUrl;
  const [{ buildGraphResponse }, rankedPosts, dedupe] = await Promise.all([
    overrides.buildGraphResponse ? Promise.resolve(overrides) : import("../src/lib/graph/graph-builder.ts"),
    overrides.rankableEvidence ? Promise.resolve(overrides) : import("../src/lib/graph/ranked-posts.ts"),
    needsDedupe ? import("../src/lib/graph/dedupe.ts") : Promise.resolve(overrides)
  ]);
  return {
    buildGraphResponse: overrides.buildGraphResponse ?? buildGraphResponse,
    rankableEvidence: overrides.rankableEvidence ?? rankedPosts.rankableEvidence,
    canonicalPostKey: overrides.canonicalPostKey ?? dedupe.canonicalPostKey,
    canonicalEvidenceUrl: overrides.canonicalEvidenceUrl ?? dedupe.canonicalEvidenceUrl
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
  if (item.attachedCompanyId) {
    return companyByEntity.get(item.attachedCompanyId) ?? null;
  }
  return companyByEntity.get(item.entityId) ?? null;
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

function rankablePhysicalKeys({ graph, rankableEvidence, canonicalPostKey, label }) {
  return [...rankablePhysicalMap({
    evidence: graph.evidence ?? [],
    rankableEvidence,
    canonicalPostKey,
    label
  }).keys()].sort();
}

function rankablePhysicalMap({ evidence, rankableEvidence, canonicalPostKey, label }) {
  const rankable = rankableEvidence(evidence);
  const result = new Map();
  for (const item of rankable) {
    const postKey = canonicalPostKey(item);
    if (typeof postKey !== "string" || postKey.length === 0) {
      throw new Error(`Ranked Posts ${label} emitted an empty canonical physical-post key.`);
    }
    if (result.has(postKey)) {
      throw new Error(
        `Ranked Posts ${label} rankability contract returned duplicate physical key ${postKey}.`
      );
    }
    result.set(postKey, item);
  }
  return result;
}

function assertAttributableRankable(items, companyByEntity, label) {
  const missing = items
    .filter((item) => !companyIdForEvidence(item, companyByEntity))
    .map((item) => item.id)
    .sort();
  if (missing.length > 0) {
    throw new Error(
      `Ranked Posts ${label} contains ${missing.length} rankable posts without company attribution: ` +
      `${missing.slice(0, 10).join(", ")}.`
    );
  }
}

function canonicalProjectionIdentityMismatches({
  postKey,
  projected,
  canonical,
  canonicalPostKey,
  canonicalEvidenceUrl,
  canonicalCompanyByEntity
}) {
  const mismatches = [];
  if (canonicalPostKey(canonical) !== postKey || canonicalPostKey(projected) !== postKey) {
    mismatches.push("physical key");
  }

  const canonicalUrl = canonicalEvidenceUrl(canonical.sourceUrl);
  const projectedUrl = canonicalEvidenceUrl(projected.sourceUrl);
  if (!canonicalUrl || !projectedUrl || canonicalUrl !== projectedUrl) {
    mismatches.push("canonical URL");
  }

  const canonicalOwner = nativeOwnerIdentity(canonical, canonicalUrl);
  const projectedOwner = nativeOwnerIdentity(projected, projectedUrl);
  if (!canonicalOwner || !projectedOwner || canonicalOwner !== projectedOwner) {
    mismatches.push("native owner");
  }

  if (canonical.entityType !== projected.entityType || canonical.entityId !== projected.entityId) {
    mismatches.push("entity identity");
  }

  const canonicalCompanyId = companyIdForEvidence(canonical, canonicalCompanyByEntity);
  const projectedCompanyId = companyIdForEvidence(projected, canonicalCompanyByEntity);
  if (!canonicalCompanyId || !projectedCompanyId || canonicalCompanyId !== projectedCompanyId) {
    mismatches.push("attached company identity");
  }

  return mismatches;
}

function nativeOwnerIdentity(item, canonicalUrl) {
  try {
    const url = new URL(canonicalUrl);
    const pathParts = url.pathname.split("/").filter(Boolean);
    let owner = null;
    if (item.platform === "x" && pathParts[1]?.toLowerCase() === "status") {
      owner = pathParts[0];
    } else if (item.platform === "tiktok" && pathParts[0]?.startsWith("@")) {
      owner = pathParts[0];
    } else if (item.platform === "bluesky" && pathParts[0]?.toLowerCase() === "profile") {
      owner = pathParts[1];
    } else if (item.platform === "linkedin" && pathParts[0]?.toLowerCase() === "posts") {
      owner = pathParts[1]?.replace(/[_-]activity[-:].*$/i, "");
    } else if (item.platform === "github" && pathParts.length >= 2) {
      owner = pathParts[0];
    }
    if (owner) return `${item.platform}:${normalizeOwnerIdentity(owner)}`;
  } catch {
    // Fall through to an explicit account identity when the URL has no owner segment.
  }

  const accountIdentity = item.canonicalAccountId ??
    item.socialAccountId ??
    item.authorHandle ??
    null;
  return accountIdentity
    ? `${item.platform}:${normalizeOwnerIdentity(accountIdentity)}`
    : null;
}

function normalizeOwnerIdentity(value) {
  return String(value).trim().replace(/^@/, "").replace(/\/$/, "").toLowerCase();
}

function unionSorted(keys) {
  return [...new Set(keys)].sort();
}

function scopedPostKey(scope, postKey) {
  return `${scope.batchSlug}:${scope.audience}:${postKey}`;
}

function formatPostKeys(keys) {
  const visible = keys.slice(0, 10).join(", ");
  return keys.length > 10 ? `${visible}, ...` : visible;
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
    fullRankable: snapshot.canonicalParity.fullRankableCount,
    previewRankable: snapshot.canonicalParity.previewRankableCount,
    representedRankable: snapshot.canonicalParity.representedRankableCount,
    overflowRankable: snapshot.canonicalParity.overflowRankableCount,
    crossAudiencePreviewProjections:
      snapshot.canonicalParity.crossAudiencePreviewProjectionCount
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
