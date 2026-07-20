import { createHash } from "node:crypto";

export const STRICT_METRIC_ALLOWLIST_ROWS = 164;

export const STRICT_METRIC_SOURCE_FILES = Object.freeze({
  targeted: "src/lib/social/targeted-evidence-current.json",
  a16z: "src/lib/social/a16z-speedrun-006-social-evidence.json"
});

export const STRICT_METRIC_INPUT_SHA256 = Object.freeze({
  "src/lib/social/public-evidence-current.json": "8b236b76fe209ae51e0a2689dcb43acbf279d7d791139b5469528d1251ef168f",
  "src/lib/social/logged-in-evidence-current.json": "5cf7b80c986ee5821f22cabe87de5f5cf5446991a2d03df1944ac498c25eb0fc",
  [STRICT_METRIC_SOURCE_FILES.targeted]: "52dd61695f30e84563f3cb02c2548368d54f4d3ee904385ad6e4097db8fa4360",
  [STRICT_METRIC_SOURCE_FILES.a16z]: "423681da6acfb9ae62470169be4dd54a7c776f6904c990db8a54a1663cee56b6",
  "public/graph/s2026.json": "c6210bb4ff4477b883f2eeffcf3bcb0ce14ada2f6b2dd61675fc626330768a2b",
  "public/graph/s26.json": "9f1223546ede10df63cc3b469066b11e89290a08ca4cb55640e205b3d499a04c",
  "public/graph/a16zsr006.json": "b694139baf8e093b48b6bd6f5dd6d596cb875a81ec2b7d185c8e44208be765c3"
});

// These semantic hashes normalize only the explicitly allowlisted metadata
// moves and aliases. They remain identical before and after remediation while
// detecting any other source drift, including changes to non-target rows.
export const STRICT_METRIC_NORMALIZED_SOURCE_SHA256 = Object.freeze({
  [STRICT_METRIC_SOURCE_FILES.targeted]: "b48bc57a588f372d97726a4a512447684f9ae841d973464f2e5eedd20358a3db",
  [STRICT_METRIC_SOURCE_FILES.a16z]: "95cbe838485a89bb09b03ea1f6e73f298b4b5879c4ae7dce352ab15f2213e507"
});

export const STRICT_METRIC_GRAPH_FILES = Object.freeze({
  S2026: "public/graph/s2026.json",
  S26: "public/graph/s26.json",
  A16ZSR006: "public/graph/a16zsr006.json"
});

export const STRICT_METRIC_METADATA_DESTINATIONS = Object.freeze({
  authorFollowers: "authorFollowers",
  commits: "totalCommits",
  followers: "repositoryOwnerFollowers",
  language: "repositoryLanguage",
  lastActivityAt: "lastActivityAt",
  metricSource: "metricSource",
  network: "network",
  repository_size_kb: "repositorySizeKb",
  sizeKb: "repositorySizeKb"
});

export const STRICT_METRIC_SOURCE_GRAPH_DISCREPANCIES = Object.freeze([
  Object.freeze({
    kind: "metadata_key",
    allowlistRows: Object.freeze([34, 57, 69, 70]),
    canonicalFile: STRICT_METRIC_SOURCE_FILES.a16z,
    graphMetricKey: "followers",
    canonicalMetricKey: "language",
    canonicalDestination: "sourceMetadata.repositoryLanguage",
    action: "Preserve and move the canonical language value; do not synthesize or delete a nonexistent followers value."
  }),
  Object.freeze({
    kind: "metric_value",
    allowlistRows: Object.freeze([69]),
    canonicalFile: STRICT_METRIC_SOURCE_FILES.a16z,
    physicalIdentity: "github:modaic-ai/modaic",
    graphValue: Object.freeze({ issues: 9 }),
    canonicalValue: Object.freeze({ issues: 10 }),
    action: "Retain the canonical maximum across openIssues, open_issues, and issues; do not back-propagate the stale graph value."
  })
]);

export const STRICT_METRIC_EXPECTED_ALIAS_COUNTS = Object.freeze({
  openIssues: 24,
  open_issues: 15,
  "linkedin:likes": 19,
  plays: 24,
  retweets: 1,
  points: 0,
  "x:comments": 0,
  "x:saves": 0
});

const SOURCE_GRAPH_DISCREPANCY_ROWS = new Set([34, 57, 69, 70]);
const SUPPORTED_SCORING_METRICS = Object.freeze({
  github: Object.freeze(["stars", "forks", "issues", "recent_commits_30d"]),
  x: Object.freeze(["views", "likes", "replies", "reposts", "quotes"]),
  linkedin: Object.freeze(["views", "reactions", "comments", "reposts"]),
  instagram: Object.freeze(["views", "likes", "comments", "shares", "saves"]),
  youtube: Object.freeze(["views", "likes", "comments"])
});

const ALIAS_RULES = Object.freeze([
  Object.freeze({ from: "plays", to: "views" }),
  Object.freeze({ from: "points", to: "upvotes" }),
  Object.freeze({ from: "retweets", to: "reposts" }),
  Object.freeze({ from: "openIssues", to: "issues" }),
  Object.freeze({ from: "open_issues", to: "issues" }),
  Object.freeze({ from: "comments", to: "replies", platform: "x" }),
  Object.freeze({ from: "saves", to: "bookmarks", platform: "x" }),
  Object.freeze({ from: "likes", to: "reactions", platform: "linkedin" })
]);

export function parseStrictMetricAllowlist(markdown) {
  const rows = String(markdown)
    .split(/\r?\n/)
    .filter((line) => /^\| \d+ \|/.test(line))
    .map((line) => parseAllowlistLine(line));

  assert(rows.length === STRICT_METRIC_ALLOWLIST_ROWS,
    `Strict metric allowlist must contain exactly ${STRICT_METRIC_ALLOWLIST_ROWS} rows; found ${rows.length}.`);
  assert(rows.every((row, index) => row.number === index + 1),
    "Strict metric allowlist row numbers must be consecutive from 1 through 164.");
  assert(new Set(rows.map((row) => row.pointer)).size === rows.length,
    "Strict metric allowlist contains duplicate canonical JSON pointers.");

  const sourceCounts = countBy(rows, (row) => row.sourceFile);
  assert(sourceCounts[STRICT_METRIC_SOURCE_FILES.targeted] === 30,
    "Strict metric allowlist must contain exactly 30 targeted evidence rows.");
  assert(sourceCounts[STRICT_METRIC_SOURCE_FILES.a16z] === 134,
    "Strict metric allowlist must contain exactly 134 A16Z evidence rows.");
  assert(Object.keys(sourceCounts).length === 2,
    "Strict metric allowlist may reference only the two approved canonical source files.");

  return rows;
}

function parseAllowlistLine(line) {
  const columns = line.split("|").slice(1, -1).map((value) => value.trim());
  assert(columns.length === 12, `Malformed strict metric allowlist row: ${line}`);
  const [rawNumber, batch, platform, pointer, rawCanonicalId, graphId, entityId,
    physicalIdentity, rawPositiveMetrics, rawMetadataKeys, identityAttribution, disposition] = columns;
  const number = Number(rawNumber);
  const pointerMatch = pointer.match(/^(src\/lib\/social\/(?:targeted-evidence-current|a16z-speedrun-006-social-evidence)\.json)#\/evidence\/(\d+)$/);
  assert(Number.isInteger(number) && number > 0, `Invalid allowlist row number: ${rawNumber}`);
  assert(pointerMatch, `Invalid or out-of-scope canonical pointer at allowlist row ${number}: ${pointer}`);
  assert(Object.hasOwn(STRICT_METRIC_GRAPH_FILES, batch), `Unsupported batch at allowlist row ${number}: ${batch}`);
  assert(Object.hasOwn(SUPPORTED_SCORING_METRICS, platform), `Unsupported platform at allowlist row ${number}: ${platform}`);
  assert(graphId && graphId !== "—", `Missing graph evidence ID at allowlist row ${number}.`);
  assert(entityId && entityId !== "—", `Missing entity attribution at allowlist row ${number}.`);
  assert(identityAttribution === "match/match", `Allowlist row ${number} is not identity/attribution validated.`);
  assert(disposition === "keep", `Allowlist row ${number} has an unexpected disposition: ${disposition}`);

  const metadataKeys = rawMetadataKeys.split(",").map((value) => value.trim()).filter(Boolean);
  assert(metadataKeys.length > 0, `Allowlist row ${number} must declare at least one metadata move.`);
  for (const key of metadataKeys) {
    assert(Object.hasOwn(STRICT_METRIC_METADATA_DESTINATIONS, key),
      `Allowlist row ${number} declares unsupported metadata key ${key}.`);
  }

  if (SOURCE_GRAPH_DISCREPANCY_ROWS.has(number)) {
    assert(metadataKeys.length === 1 && ["followers", "language"].includes(metadataKeys[0]),
      `Allowlist row ${number} must retain the documented graph/source metadata discrepancy.`);
  }

  const positiveMetrics = parseMetricProjection(rawPositiveMetrics, number);
  if (number === 69) {
    assert(positiveMetrics.issues === 9 || positiveMetrics.issues === 10,
      "Allowlist row 69 must retain its documented graph/source issues discrepancy.");
    positiveMetrics.issues = 10;
  }

  return Object.freeze({
    number,
    batch,
    platform,
    pointer,
    sourceFile: pointerMatch[1],
    evidenceIndex: Number(pointerMatch[2]),
    canonicalId: rawCanonicalId === "—" ? null : rawCanonicalId,
    graphId,
    entityId,
    physicalIdentity,
    positiveMetrics: Object.freeze(positiveMetrics),
    metadataKeys: Object.freeze(SOURCE_GRAPH_DISCREPANCY_ROWS.has(number) ? ["language"] : metadataKeys)
  });
}

function parseMetricProjection(value, rowNumber) {
  const result = {};
  for (const part of String(value).split(",")) {
    const match = part.trim().match(/^([A-Za-z0-9_]+)=(-?(?:\d+(?:\.\d+)?|\.\d+))$/);
    assert(match, `Invalid positive metric projection at allowlist row ${rowNumber}: ${part}`);
    const numeric = Number(match[2]);
    assert(Number.isFinite(numeric) && numeric > 0,
      `Allowlist row ${rowNumber} contains a non-positive supported metric: ${part}`);
    result[match[1]] = numeric;
  }
  assert(Object.keys(result).length > 0, `Allowlist row ${rowNumber} must retain a positive supported metric.`);
  return result;
}

export function cleanupAllowlistedRow(row, { platform, metadataKeys }) {
  assert(isRecord(row), "Strict metric cleanup requires an evidence object.");
  assert(isRecord(row.metrics), "Strict metric cleanup requires a metrics object.");
  assert(Object.hasOwn(SUPPORTED_SCORING_METRICS, platform), `Unsupported strict metric platform: ${platform}`);
  assert(Array.isArray(metadataKeys) && metadataKeys.length > 0,
    "Strict metric cleanup requires an explicit non-empty metadata key allowlist.");

  const metrics = { ...row.metrics };
  const sourceMetadata = row.sourceMetadata === undefined ? {} : cloneRecord(row.sourceMetadata, "sourceMetadata");
  const metadata = [];
  const aliases = [];

  for (const sourceKey of metadataKeys) {
    const destinationKey = STRICT_METRIC_METADATA_DESTINATIONS[sourceKey];
    assert(destinationKey, `Unsupported metadata cleanup key: ${sourceKey}`);
    const inMetrics = Object.hasOwn(metrics, sourceKey);
    const inMetadata = Object.hasOwn(sourceMetadata, destinationKey);
    assert(inMetrics !== inMetadata,
      `Expected exactly one of metrics.${sourceKey} or sourceMetadata.${destinationKey}.`);
    const value = inMetrics ? metrics[sourceKey] : sourceMetadata[destinationKey];
    if (inMetrics) {
      delete metrics[sourceKey];
      sourceMetadata[destinationKey] = value;
    }
    metadata.push(Object.freeze({
      sourceKey,
      destinationKey,
      value,
      status: inMetrics ? "moved" : "preserved"
    }));
  }

  for (const rule of ALIAS_RULES) {
    if (rule.platform && rule.platform !== platform) continue;
    if (!Object.hasOwn(metrics, rule.from)) continue;
    const aliasValue = verifiedMetricValue(metrics[rule.from], `metrics.${rule.from}`);
    const canonicalValue = Object.hasOwn(metrics, rule.to)
      ? verifiedMetricValue(metrics[rule.to], `metrics.${rule.to}`)
      : undefined;
    const retainedValue = canonicalValue === undefined ? aliasValue : Math.max(aliasValue, canonicalValue);
    metrics[rule.to] = retainedValue;
    delete metrics[rule.from];
    aliases.push(Object.freeze({
      from: rule.from,
      to: rule.to,
      aliasValue,
      canonicalValue: canonicalValue ?? null,
      retainedValue
    }));
  }

  const cleaned = {
    ...row,
    metrics,
    sourceMetadata
  };
  return Object.freeze({
    row: cleaned,
    metadata: Object.freeze(metadata),
    aliases: Object.freeze(aliases),
    positiveSupportedMetrics: Object.freeze(positiveSupportedMetrics(platform, metrics))
  });
}

export function positiveSupportedMetrics(platform, metrics) {
  const supported = SUPPORTED_SCORING_METRICS[platform];
  assert(supported, `Unsupported strict metric platform: ${platform}`);
  const positive = {};
  for (const key of supported) {
    const value = metrics?.[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) positive[key] = value;
  }
  return positive;
}

export function quarantineValidatedMetriclessRow(row, {
  nativeIdentityValidated,
  attributionValidated,
  ordinal = 0
}) {
  assert(nativeIdentityValidated === true,
    "Metricless evidence cannot be quarantined until native identity validation passes.");
  assert(attributionValidated === true,
    "Metricless evidence cannot be quarantined until entity attribution validation passes.");
  assert(Object.keys(positiveSupportedMetrics(row.platform, row.metrics)).length === 0,
    "Only a row with no positive supported metric may enter metricless quarantine.");

  const reason = "no_positive_supported_metric_after_metadata_cleanup";
  const sourceEvidenceId = row.id ?? null;
  return {
    ...row,
    id: sourceEvidenceId ? `quarantined-${sourceEvidenceId}` : `quarantined-strict-metric-row-${ordinal}`,
    sourceEvidenceId,
    candidateUrl: row.sourceUrl ?? null,
    review_state: "needs_review",
    contributionScore: 0,
    quarantineReasons: uniqueStrings([...(row.quarantineReasons ?? []), reason]),
    matchReason: `Quarantined during strict metric remediation: ${reason}.`
  };
}

export function derivePhysicalIdentity(platform, rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl ?? ""));
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  const path = decodeURIComponent(url.pathname).replace(/\/+$/, "");
  let match = null;

  if (platform === "x" && ["x.com", "twitter.com", "mobile.twitter.com"].includes(host)) {
    match = path.match(/^\/(?:[A-Za-z0-9_]+|i\/web)\/status\/(\d+)$/i);
  } else if (platform === "linkedin" && (host === "linkedin.com" || host.endsWith(".linkedin.com"))) {
    match = path.match(/(?:urn:li:activity:|activity-)(\d{10,})(?:-[^/]*)?$/i);
  } else if (platform === "instagram" && (host === "instagram.com" || host.endsWith(".instagram.com"))) {
    match = path.match(/^\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)$/i);
  } else if (platform === "youtube" && ["youtube.com", "m.youtube.com"].includes(host)) {
    match = path.match(/^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]+)$/i);
    if (!match && path === "/watch") match = String(url.searchParams.get("v") ?? "").match(/^([A-Za-z0-9_-]+)$/);
  } else if (platform === "youtube" && host === "youtu.be") {
    match = path.match(/^\/([A-Za-z0-9_-]+)$/);
  } else if (platform === "github" && host === "github.com") {
    match = path.match(/^\/([^/]+\/[^/]+)$/);
  }

  return match?.[1] ? `${platform}:${match[1]}` : null;
}

export function normalizedSourceSemanticSha256(document, specs) {
  const normalized = structuredClone(document);
  assert(Array.isArray(normalized.evidence), "Canonical strict metric source must contain an evidence array.");
  for (const spec of specs) {
    const row = normalized.evidence[spec.evidenceIndex];
    assert(row, `Missing canonical row at ${spec.pointer}.`);
    normalized.evidence[spec.evidenceIndex] = cleanupAllowlistedRow(row, spec).row;
  }
  return sha256(stableStringify(normalized));
}

export function sourceRowGuardSha256(document, specs) {
  return sha256(stableStringify(specs.map((spec) => {
    const row = document.evidence?.[spec.evidenceIndex];
    assert(row, `Missing canonical row at ${spec.pointer}.`);
    const cleaned = cleanupAllowlistedRow(row, spec).row;
    return {
      number: spec.number,
      pointer: spec.pointer,
      canonicalId: spec.canonicalId,
      physicalIdentity: derivePhysicalIdentity(spec.platform, cleaned.sourceUrl),
      entityType: cleaned.entityType ?? null,
      entityId: cleaned.entityId ?? null,
      companySlug: cleaned.companySlug ?? null,
      founderName: cleaned.founderName ?? null,
      metrics: cleaned.metrics,
      sourceMetadata: cleaned.sourceMetadata
    };
  })));
}

export function validateCanonicalRowGuard(row, spec, { sourceDocument, graphDocument }) {
  assert(row, `Missing canonical row at ${spec.pointer}.`);
  if (spec.canonicalId !== null) {
    assert(row.id === spec.canonicalId,
      `Canonical ID drift at ${spec.pointer}: expected ${spec.canonicalId}; found ${row.id ?? "missing"}.`);
  }
  assert(row.platform === spec.platform,
    `Platform drift at ${spec.pointer}: expected ${spec.platform}; found ${row.platform ?? "missing"}.`);
  assert(row.review_state === "verified",
    `Review-state drift at ${spec.pointer}: expected verified; found ${row.review_state ?? "missing"}.`);

  const nativeIdentity = derivePhysicalIdentity(spec.platform, row.sourceUrl);
  assert(nativeIdentity === spec.physicalIdentity,
    `Native URL identity drift at ${spec.pointer}: expected ${spec.physicalIdentity}; found ${nativeIdentity ?? "invalid"}.`);
  const suppliedIdentity = `${spec.platform}:${String(row.platformPostId ?? "")}`;
  assert(suppliedIdentity === spec.physicalIdentity,
    `Supplied platformPostId drift at ${spec.pointer}: expected ${spec.physicalIdentity}; found ${suppliedIdentity}.`);

  const matchingSourceRows = sourceDocument.evidence.filter((candidate) =>
    candidate?.platform === spec.platform && derivePhysicalIdentity(spec.platform, candidate?.sourceUrl) === spec.physicalIdentity);
  assert(matchingSourceRows.length === 1 && matchingSourceRows[0] === row,
    `Canonical physical identity ${spec.physicalIdentity} must resolve uniquely to ${spec.pointer}; found ${matchingSourceRows.length} rows.`);

  const graphMatches = graphDocument.evidence?.filter((candidate) => candidate?.id === spec.graphId) ?? [];
  assert(graphMatches.length === 1,
    `Graph evidence ID ${spec.graphId} must resolve exactly once for allowlist row ${spec.number}.`);
  const graphRow = graphMatches[0];
  assert(graphRow.platform === spec.platform,
    `Graph platform drift for ${spec.graphId}: expected ${spec.platform}; found ${graphRow.platform ?? "missing"}.`);
  assert(derivePhysicalIdentity(spec.platform, graphRow.sourceUrl) === spec.physicalIdentity,
    `Graph native identity drift for ${spec.graphId}.`);
  assert(`${spec.platform}:${String(graphRow.platformPostId ?? "")}` === spec.physicalIdentity,
    `Graph platformPostId drift for ${spec.graphId}.`);
  assert(graphRow.entityId === spec.entityId,
    `Graph entity attribution drift for ${spec.graphId}: expected ${spec.entityId}; found ${graphRow.entityId ?? "missing"}.`);

  if (spec.sourceFile === STRICT_METRIC_SOURCE_FILES.targeted) {
    assert(graphRow.entityType === row.entityType,
      `Canonical/graph entity-type drift at ${spec.pointer}.`);
    assert(row.entityId === spec.entityId,
      `Canonical entity attribution drift at ${spec.pointer}: expected ${spec.entityId}; found ${row.entityId ?? "missing"}.`);
  } else {
    const expectedCompanyId = `a16z-speedrun-006-${row.companySlug ?? ""}`;
    assert(graphRow.attachedCompanyId === expectedCompanyId,
      `A16Z company attachment drift at ${spec.pointer}: expected ${expectedCompanyId}; found ${graphRow.attachedCompanyId ?? "missing"}.`);
    if (row.entityType === "company") {
      assert(graphRow.entityType === "company",
        `A16Z company evidence changed graph entity type at ${spec.pointer}.`);
      assert(spec.entityId === expectedCompanyId,
        `A16Z company entity drift at ${spec.pointer}.`);
    } else {
      assert(row.entityType === "founder" && nonempty(row.founderName),
        `A16Z founder attribution is incomplete at ${spec.pointer}.`);
      assert(nonempty(graphRow.targetFounderId),
        `A16Z founder attachment is missing at ${spec.pointer}.`);
      if (graphRow.entityType === "founder") {
        assert(graphRow.targetFounderId === spec.entityId,
          `A16Z founder entity drift at ${spec.pointer}.`);
      } else {
        assert(graphRow.entityType === "company" && graphRow.entityId === expectedCompanyId,
          `A16Z founder-authored repository did not resolve to its company at ${spec.pointer}.`);
      }
    }
  }

  const companyNode = graphDocument.nodes?.find((node) => node?.entityId === graphRow.attachedCompanyId);
  assert(companyNode, `Graph roster company ${graphRow.attachedCompanyId ?? "missing"} was not found for ${spec.graphId}.`);
  if (row.entityType === "founder") {
    const rosterFounderId = spec.sourceFile === STRICT_METRIC_SOURCE_FILES.targeted
      ? spec.entityId
      : graphRow.targetFounderId;
    assert(companyNode.founders?.some((founder) =>
      founder?.id === rosterFounderId &&
      (spec.sourceFile === STRICT_METRIC_SOURCE_FILES.targeted || founder?.name === row.founderName)),
    `Graph roster founder ${row.founderName ?? spec.entityId} (${rosterFounderId ?? "missing"}) was not found under ${companyNode.entityId}.`);
  }

  const cleaned = cleanupAllowlistedRow(row, spec);
  assert(stableStringify(cleaned.positiveSupportedMetrics) === stableStringify(spec.positiveMetrics),
    `Supported metric guard drift at ${spec.pointer}: expected ${stableStringify(spec.positiveMetrics)}; found ${stableStringify(cleaned.positiveSupportedMetrics)}.`);

  return Object.freeze({
    nativeIdentityValidated: true,
    attributionValidated: true,
    cleaned
  });
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

export function formatCanonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function verifiedMetricValue(value, label) {
  assert(typeof value === "number" && Number.isFinite(value) && value >= 0,
    `${label} must be a finite non-negative number before alias normalization.`);
  return value;
}

function cloneRecord(value, label) {
  assert(isRecord(value), `${label} must be an object when present.`);
  return { ...value };
}

function countBy(values, keyFor) {
  const counts = {};
  for (const value of values) {
    const key = keyFor(value);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))];
}

function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
