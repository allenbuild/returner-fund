import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const AUTONOMOUS_BATCHES = Object.freeze([
  {
    slug: "S2026",
    label: "YC Spring 2026 (P26)",
    graphFile: "s2026.json",
    githubSourcePath: "src/lib/yc/spring-2026-companies.json"
  },
  {
    slug: "S26",
    label: "YC Summer 2026 (S26)",
    graphFile: "s26.json",
    catalogFile: "src/lib/yc/summer-2026-companies.json",
    catalogFormat: "yc_snapshot",
    expectedCompanyCount: 115,
    githubSourcePath: "src/lib/yc/summer-2026-companies.json"
  },
  {
    slug: "A16ZSR006",
    label: "a16z Speedrun 006",
    graphFile: "a16zsr006.json",
    githubSourcePath: "src/lib/graph/a16z-speedrun-006-dataset.ts"
  }
]);

const MINUTE_MS = 60_000;

export const AUTONOMOUS_PROCESS_BUDGETS = Object.freeze({
  collectorAttempts: 1,
  collectorRetryDelayMaxMs: 5_000,
  publicCollectorAttemptMs: 65 * MINUTE_MS,
  githubCollectorAttemptMs: 10 * MINUTE_MS,
  topVoiceCollectorMs: 22 * MINUTE_MS,
  productionBuildMs: 10 * MINUTE_MS,
  benchmarkPublicationMs: 6 * MINUTE_MS,
  artifactManifestMs: MINUTE_MS,
  artifactValidationMs: 4 * MINUTE_MS,
  gitConfigMs: 30_000,
  gitStageMs: MINUTE_MS,
  gitDiffMs: 30_000,
  gitCommitMs: 2 * MINUTE_MS,
  gitPushMs: 4 * MINUTE_MS,
  processKillGraceMs: 5_000,
  durablePersistenceHeadroomMs: 25 * MINUTE_MS,
  lockReleaseHeadroomMs: 2 * MINUTE_MS
});

export function maxAutonomousRunnerProcessBudgetMs(budgets = AUTONOMOUS_PROCESS_BUDGETS) {
  const retriedCollectorWindow =
    budgets.collectorAttempts * Math.max(
      budgets.publicCollectorAttemptMs,
      budgets.githubCollectorAttemptMs
    ) +
    (budgets.collectorAttempts - 1) * budgets.collectorRetryDelayMaxMs +
    budgets.collectorAttempts * budgets.processKillGraceMs;
  const collectorWindow = Math.max(
    retriedCollectorWindow,
    budgets.topVoiceCollectorMs + budgets.processKillGraceMs
  );
  const publicationWindow =
    budgets.productionBuildMs +
    budgets.benchmarkPublicationMs +
    budgets.artifactManifestMs +
    budgets.artifactValidationMs +
    (2 * budgets.gitConfigMs) +
    budgets.gitStageMs +
    budgets.gitDiffMs +
    budgets.gitCommitMs +
    budgets.gitPushMs;
  return (
    collectorWindow +
    publicationWindow +
    budgets.processKillGraceMs +
    budgets.durablePersistenceHeadroomMs +
    budgets.lockReleaseHeadroomMs
  );
}

export const AUTONOMOUS_PLATFORMS = Object.freeze([
  "github",
  "x",
  "instagram",
  "linkedin",
  "youtube",
  "product_hunt",
  "reddit",
  "hacker_news",
  "rss",
  "web",
  "bilibili",
  "tiktok",
  "bluesky"
]);

const PUBLIC_PLATFORM_COLLECTORS = new Set([
  "x",
  "instagram",
  "linkedin",
  "youtube",
  "product_hunt",
  "reddit",
  "hacker_news",
  "rss",
  "web"
]);
const FOUNDER_SOCIAL_PLATFORMS = new Set(["github", "x", "instagram", "linkedin"]);
const EXPLICITLY_UNAVAILABLE = new Set(["bilibili", "tiktok", "bluesky"]);

export async function loadAutonomousCatalogs(root) {
  return Promise.all(
    AUTONOMOUS_BATCHES.map(async (batch) => {
      const path = batch.catalogFile
        ? join(root, batch.catalogFile)
        : join(root, "public", "graph", batch.graphFile);
      const source = JSON.parse(await readFile(path, "utf8"));
      if (batch.catalogFormat === "yc_snapshot") {
        if (!Array.isArray(source.companies)) {
          throw new Error(`${batch.catalogFile} does not contain a company array.`);
        }
        if (source.companies.length !== batch.expectedCompanyCount) {
          throw new Error(
            `${batch.catalogFile} contains ${source.companies.length} companies; expected ${batch.expectedCompanyCount}.`
          );
        }
        return {
          ...batch,
          sourcePath: path,
          generatedAt: source.source?.fetchedAt ?? null,
          companies: source.companies.map((company) => normalizeYcCompany(company, batch))
        };
      }
      const graph = source;
      if (!Array.isArray(graph.nodes)) {
        throw new Error(`${batch.graphFile} does not contain a graph node array.`);
      }
      const companies = graph.nodes
        .filter((node) => node?.entityType === "company" && node.entityId && node.label)
        .map((node) => normalizeCompanyNode(node, batch));
      return {
        ...batch,
        sourcePath: path,
        generatedAt: graph.generatedAt ?? null,
        companies
      };
    })
  );
}

export function buildAutonomousTaskPlan(catalogs, { runKey }) {
  const tasks = [];
  for (const batch of catalogs) {
    for (const company of batch.companies) {
      for (const platform of AUTONOMOUS_PLATFORMS) {
        tasks.push(taskForEntity({ runKey, batch, company, entity: company, platform }));
      }
      for (const founder of company.founders) {
        for (const platform of AUTONOMOUS_PLATFORMS) {
          tasks.push(taskForEntity({ runKey, batch, company, entity: founder, platform }));
        }
      }
    }
  }
  return tasks.sort((left, right) => left.checkpointKey.localeCompare(right.checkpointKey));
}

export function summarizeTaskCoverage(tasks) {
  const summary = {
    expected: tasks.length,
    queued: 0,
    terminal: 0,
    missingMappings: 0,
    unsupported: 0,
    byPlatform: {}
  };
  for (const task of tasks) {
    const platform = (summary.byPlatform[task.platform] ??= {
      expected: 0,
      queued: 0,
      terminal: 0,
      missingMappings: 0,
      unsupported: 0
    });
    platform.expected += 1;
    if (task.status === "queued") {
      summary.queued += 1;
      platform.queued += 1;
    } else {
      summary.terminal += 1;
      platform.terminal += 1;
    }
    if (task.terminalReason === "missing_account_mapping") {
      summary.missingMappings += 1;
      platform.missingMappings += 1;
    }
    if (task.terminalReason?.startsWith("collector_")) {
      summary.unsupported += 1;
      platform.unsupported += 1;
    }
  }
  return summary;
}

export function validateAutonomousCollectorSnapshot(
  snapshot,
  { kind, batchSlug, expectedSourcePath = null, notBefore = null }
) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error(`Invalid ${kind} collector snapshot: expected an object.`);
  }
  if (!snapshot.source || typeof snapshot.source !== "object" || Array.isArray(snapshot.source)) {
    throw new Error(`Invalid ${kind} collector snapshot: expected source metadata.`);
  }
  if (snapshot.source.batchSlug !== batchSlug) {
    throw new Error(
      `Invalid ${kind} collector snapshot: expected batch ${batchSlug}, received ${snapshot.source.batchSlug ?? "none"}.`
    );
  }
  if (typeof snapshot.source.label !== "string" || !snapshot.source.label.trim()) {
    throw new Error(`Invalid ${kind} collector snapshot: source label is required.`);
  }
  if (kind === "public" && snapshot.source.label !== "Public unauthenticated platform/page ingestion") {
    throw new Error(`Invalid public collector snapshot: unexpected source label ${snapshot.source.label}.`);
  }
  if (kind === "github" && !snapshot.source.label.startsWith("GitHub public API")) {
    throw new Error(`Invalid github collector snapshot: unexpected source label ${snapshot.source.label}.`);
  }
  if (expectedSourcePath && snapshot.source.sourcePath !== expectedSourcePath) {
    throw new Error(
      `Invalid ${kind} collector snapshot: expected source path ${expectedSourcePath}, received ${snapshot.source.sourcePath ?? "none"}.`
    );
  }
  const fetchedAt = Date.parse(snapshot.source.fetchedAt);
  if (!Number.isFinite(fetchedAt)) {
    throw new Error(`Invalid ${kind} collector snapshot: source fetchedAt must be a valid timestamp.`);
  }
  if (notBefore !== null && fetchedAt < notBefore) {
    throw new Error(`Invalid ${kind} collector snapshot: source fetchedAt predates this collector attempt.`);
  }

  const collections = kind === "github"
    ? [["accounts", snapshot.accounts]]
    : [
        ["evidence", snapshot.evidence],
        ["needsReview", snapshot.needsReview],
        ["failures", snapshot.failures]
      ];
  for (const [name, rows] of collections) {
    if (!Array.isArray(rows)) {
      throw new Error(`Invalid ${kind} collector snapshot: expected a ${name} array.`);
    }
    if (rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) {
      throw new Error(`Invalid ${kind} collector snapshot: ${name} must contain only objects.`);
    }
  }
  if (collections.reduce((count, [, rows]) => count + rows.length, 0) === 0) {
    throw new Error(`Invalid ${kind} collector snapshot: collector output is empty.`);
  }
  return snapshot;
}

export function countSuccessfulAutonomousCollectorRows(snapshot, kind) {
  if (kind === "github") {
    return (snapshot?.accounts ?? []).filter((account) => account.fetched === true).length;
  }
  return (snapshot?.evidence ?? []).filter(isSuccessfulPublicEvidenceRow).length;
}

export function indexAutonomousCollectorTaskOutcomes(snapshot, { kind, batchSlug }) {
  const outcomes = new Map();
  const record = (row, platform, status, reason) => {
    const entityType = row?.entityType ?? "company";
    const rawEntityId = row?.entityId ?? row?.attachedCompanyId ?? row?.companySlug ?? row?.companyName;
    const entityId = normalizeAutonomousFailureEntityId(
      { ...row, entityType, entityId: rawEntityId },
      { batchSlug }
    );
    if (!entityId) return;
    const key = autonomousCollectorEntityKey(platform, entityType, entityId);
    const candidate = { status, reason };
    const previous = outcomes.get(key);
    if (!previous || collectorOutcomePriority(candidate.status) > collectorOutcomePriority(previous.status)) {
      outcomes.set(key, candidate);
    }
  };

  if (kind === "github") {
    for (const account of snapshot?.accounts ?? []) {
      record(
        account,
        "github",
        account.fetched === true ? "completed" : "failed",
        account.fetched === true
          ? "collector_account_fetched"
          : "collector_reported_failure"
      );
    }
    return outcomes;
  }

  for (const evidence of snapshot?.evidence ?? []) {
    const successful = isSuccessfulPublicEvidenceRow(evidence);
    record(
      evidence,
      evidence.platform,
      successful ? "completed" : "needs_review",
      successful
        ? "collector_evidence_collected"
        : "collector_needs_review"
    );
  }
  for (const review of snapshot?.needsReview ?? []) {
    record(
      review,
      review.platform,
      "needs_review",
      "collector_needs_review"
    );
  }
  for (const failure of snapshot?.failures ?? []) {
    record(
      failure,
      failure.platform,
      "failed",
      "collector_reported_failure"
    );
  }
  return outcomes;
}

export function classifyAutonomousCollectorTaskOutcome(
  outcomeIndex,
  { platform, entityType, entityId, collectorOk = true, collectorError = null }
) {
  if (!collectorOk) {
    return { status: "failed", reason: collectorError ?? "collector_process_failed" };
  }
  return outcomeIndex?.get(autonomousCollectorEntityKey(platform, entityType, entityId)) ?? {
    status: "blocked_or_empty",
    reason: "collector_returned_no_entity_rows"
  };
}

export function autonomousCollectorEntityKey(platform, entityType, entityId) {
  return `${normalizePlatform(platform)}:${entityType ?? "company"}:${normalizeIdentity(entityId)}`;
}

export function normalizeAutonomousFailureEntityId(failure, { batchSlug }) {
  const rawEntityId = failure?.entityId ?? failure?.companyName ?? failure?.companySlug;
  if (batchSlug !== "A16ZSR006") return rawEntityId;

  const companySlug = slugify(
    failure?.companySlug ?? String(rawEntityId ?? "").replace(/^(?:company-|a16z-speedrun-006-)/, "")
  );
  if (!companySlug) return rawEntityId;
  if ((failure?.entityType ?? "company") === "company") {
    return `a16z-speedrun-006-${companySlug}`;
  }

  const planPrefix = `a16z-speedrun-006-${companySlug}-founder-`;
  const embeddedPlanIdIndex = String(rawEntityId ?? "").indexOf(planPrefix);
  if (embeddedPlanIdIndex >= 0) return String(rawEntityId).slice(embeddedPlanIdIndex);
  const founderSlug = slugify(failure?.entityName);
  return founderSlug ? `${planPrefix}${founderSlug}` : rawEntityId;
}

export function mergePublicEvidenceSnapshots(
  snapshots,
  { fetchedAt = new Date().toISOString(), durableStorageConfigured = true } = {}
) {
  const evidence = dedupeRows(snapshots.flatMap((snapshot) => snapshot.evidence ?? []), evidenceKey);
  const needsReview = dedupeRows(
    snapshots.flatMap((snapshot) => snapshot.needsReview ?? []),
    (row) => row.id ?? `${row.platform}:${row.companySlug}:${row.candidateUrl ?? row.sourceUrl ?? row.title}`
  );
  const failures = dedupeRows(
    snapshots.flatMap((snapshot) => snapshot.failures ?? []),
    (row) => row.id ?? `${row.platform}:${row.companySlug}:${row.sourceUrl ?? ""}:${row.message ?? ""}`
  );
  return {
    source: {
      label: "Autonomous public ingestion merged export",
      fetchedAt,
      batchSlugs: snapshots.map((snapshot) => snapshot.source?.batchSlug).filter(Boolean),
      evidenceCount: evidence.length,
      needsReviewCount: needsReview.length,
      failureCount: failures.length,
      notes: [
        durableStorageConfigured
          ? "Generated export only; this run also imported validated evidence into durable Supabase tables."
          : "Durable Supabase import was skipped because complete optional credentials were not configured; this export is file-backed.",
        "Rows are deduplicated by entity attribution plus native identity or canonical URL before publication."
      ]
    },
    evidence,
    needsReview,
    failures
  };
}

export function mergeGithubTractionSnapshots(previous, fresh, { fetchedAt = new Date().toISOString() } = {}) {
  const accounts = new Map();
  for (const account of previous?.accounts ?? []) accounts.set(githubAccountKey(account), account);
  let retainedLastGood = 0;
  for (const account of fresh?.accounts ?? []) {
    const key = githubAccountKey(account);
    if (account.fetched === false && accounts.has(key)) {
      retainedLastGood += 1;
      continue;
    }
    accounts.set(key, account);
  }
  return {
    source: {
      ...(previous?.source ?? {}),
      ...(fresh?.source ?? {}),
      fetchedAt,
      retainedLastGood,
      notes: [
        ...(fresh?.source?.notes ?? []),
        ...(retainedLastGood ? [`Retained ${retainedLastGood} last-good account rows after failed refreshes.`] : [])
      ]
    },
    accounts: [...accounts.values()]
  };
}

function normalizeCompanyNode(node, batch) {
  return {
    entityType: "company",
    sourceKey: node.entityId,
    name: node.label,
    batchSlug: batch.slug,
    profileUrl: node.ycProfileUrl ?? node.sourceUrl ?? null,
    websiteUrl: node.websiteUrl ?? null,
    tagline: node.tagline ?? null,
    description: node.description ?? null,
    groupPartner: node.groupPartner ?? null,
    reviewState: node.review_state ?? "needs_review",
    accounts: normalizeAccounts(node.socialAccounts),
    founders: (node.founders ?? []).map((founder) => ({
      entityType: "founder",
      sourceKey: founder.id,
      name: founder.name,
      batchSlug: batch.slug,
      companySourceKey: node.entityId,
      profileUrl: founder.ycProfileUrl ?? null,
      websiteUrl: founder.websiteUrl ?? null,
      reviewState: founder.review_state ?? "verified",
      accounts: normalizeAccounts(founder.socialAccounts)
    }))
  };
}

function normalizeYcCompany(company, batch) {
  if (!company?.slug || !company?.name) {
    throw new Error(`${batch.catalogFile} contains a company without a slug and name.`);
  }
  const sourceKey = `company-${company.slug}`;
  const profileUrl = company.ycProfileUrl ?? null;
  return {
    entityType: "company",
    sourceKey,
    name: company.name,
    batchSlug: batch.slug,
    profileUrl,
    websiteUrl: company.websiteUrl ?? null,
    tagline: company.tagline ?? null,
    description: company.description ?? null,
    groupPartner: company.groupPartner ?? null,
    reviewState: "verified",
    accounts: normalizeYcAccounts(company.socialLinks, {
      entityType: "company",
      entitySourceKey: sourceKey,
      discoveredFromUrl: profileUrl
    }),
    founders: (company.founders ?? []).map((founder) => normalizeYcFounder(founder, company, batch))
  };
}

function normalizeYcFounder(founder, company, batch) {
  if (!founder?.id || !founder?.name) {
    throw new Error(`${batch.catalogFile} contains a founder without an id and name for ${company.slug}.`);
  }
  const sourceKey = `founder-${company.slug}-${slugify(founder.name)}-${founder.id}`;
  const profileUrl = founder.ycProfileUrl ?? company.ycProfileUrl ?? null;
  return {
    entityType: "founder",
    sourceKey,
    name: founder.name,
    batchSlug: batch.slug,
    companySourceKey: `company-${company.slug}`,
    profileUrl: founder.ycProfileUrl ?? null,
    websiteUrl: founder.websiteUrl ?? null,
    reviewState: "verified",
    accounts: normalizeYcAccounts(founder.socialLinks, {
      entityType: "founder",
      entitySourceKey: sourceKey,
      discoveredFromUrl: profileUrl
    })
  };
}

function normalizeYcAccounts(links, { entityType, entitySourceKey, discoveredFromUrl }) {
  return Object.entries(links ?? {})
    .filter(([, url]) => typeof url === "string" && url.trim())
    .map(([rawPlatform, url]) => {
      const platform = normalizePlatform(rawPlatform);
      if (!socialUrlMatchesPlatform(platform, url)) {
        throw new Error(`Official YC ${platform} account URL does not match its platform: ${url}`);
      }
      const canonicalUrl = canonicalSocialAccountUrl(platform, url);
      const handle = socialHandle(canonicalUrl);
      if (!handle) throw new Error(`Official YC ${platform} account URL has no account identity: ${url}`);
      return {
        sourceKey: `acct:${entityType}:${entitySourceKey}:${platform}:${encodeURIComponent(canonicalUrl)}`,
        platform,
        handle,
        url,
        accountId: null,
        reviewState: "verified",
        verified: true,
        discoveredFromUrl,
        matchReason: "Linked from the official public YC profile."
      };
    });
}

function githubAccountKey(account) {
  return [
    account.entityType ?? "company",
    account.entityId ?? account.companySlug ?? account.companyName ?? "unknown",
    String(account.login ?? "").toLowerCase(),
    String(account.repo ?? "").toLowerCase()
  ].join(":");
}

function normalizeAccounts(accounts) {
  return (accounts ?? [])
    .filter((account) => account?.platform && account?.url)
    .map((account) => ({
      sourceKey: account.id ?? `${account.platform}:${account.url}`,
      platform: normalizePlatform(account.platform),
      handle: account.handle ?? null,
      url: account.url,
      accountId: account.accountId ?? null,
      reviewState: account.review_state ?? "needs_review",
      verified: account.review_state === "verified",
      discoveredFromUrl: account.discoveredFromUrl ?? null,
      matchReason: account.matchReason ?? null
    }));
}

function taskForEntity({ runKey, batch, company, entity, platform }) {
  const entityType = entity.entityType;
  const account = entity.accounts.find((candidate) => candidate.platform === platform) ?? null;
  const base = {
    batchSlug: batch.slug,
    companySourceKey: company.sourceKey,
    companyName: company.name,
    entityType,
    entitySourceKey: entity.sourceKey,
    entityName: entity.name,
    platform,
    account,
    checkpointKey: `${runKey}:${batch.slug}:${entityType}:${entity.sourceKey}:${platform}`,
    status: "queued",
    terminalReason: null
  };

  if (EXPLICITLY_UNAVAILABLE.has(platform)) {
    return { ...base, status: "skipped", terminalReason: "collector_not_available" };
  }
  if (entityType === "founder" && !FOUNDER_SOCIAL_PLATFORMS.has(platform)) {
    return { ...base, status: "skipped", terminalReason: "collector_not_applicable_to_founder" };
  }
  if (entityType === "founder" && FOUNDER_SOCIAL_PLATFORMS.has(platform) && !account) {
    return { ...base, status: "needs_review", terminalReason: "missing_account_mapping" };
  }
  if (platform === "github" && !account && !(batch.slug === "A16ZSR006" && entityType === "company")) {
    return { ...base, status: "needs_review", terminalReason: "missing_account_mapping" };
  }
  if (platform !== "github" && !PUBLIC_PLATFORM_COLLECTORS.has(platform)) {
    return { ...base, status: "skipped", terminalReason: "collector_not_available" };
  }
  return base;
}

function normalizePlatform(platform) {
  if (platform === "twitter") return "x";
  if (platform === "website") return "web";
  return platform;
}

function normalizeIdentity(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function collectorOutcomePriority(status) {
  return ({ failed: 1, needs_review: 2, completed: 3 })[status] ?? 0;
}

function isSuccessfulPublicEvidenceRow(row) {
  return !["needs_review", "rejected"].includes(row?.review_state);
}

function canonicalSocialAccountUrl(platform, rawUrl) {
  try {
    const url = new URL(rawUrl);
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    if (platform === "github" && host === "github.com") {
      const handle = parts[0]?.toLowerCase() === "orgs" ? parts[1] : parts[0];
      if (handle) return `https://github.com/${handle.toLowerCase().replace(/\.git$/i, "")}`;
    }
    if (platform === "linkedin" && (host === "linkedin.com" || host.endsWith(".linkedin.com"))) {
      const markerIndex = parts.findIndex((part) => ["company", "in", "school"].includes(part.toLowerCase()));
      const namespace = markerIndex >= 0 ? parts[markerIndex]?.toLowerCase() : null;
      const handle = markerIndex >= 0 ? parts[markerIndex + 1] : null;
      if (namespace && handle) return `https://linkedin.com/${namespace}/${handle.toLowerCase()}`;
    }
    if (platform === "x" && (host === "x.com" || host === "twitter.com")) {
      const handle = parts[0]?.replace(/^@/, "");
      if (handle) return `https://x.com/${handle.toLowerCase()}`;
    }
    url.hash = "";
    url.search = "";
    url.protocol = "https:";
    url.hostname = host;
    url.pathname = `/${parts.join("/")}`.replace(/\/$/, "");
    return url.toString();
  } catch {
    return String(rawUrl).trim().toLowerCase();
  }
}

function socialUrlMatchesPlatform(platform, rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.replace(/^www\./i, "").toLowerCase();
    if (platform === "github") return host === "github.com";
    if (platform === "linkedin") return host === "linkedin.com" || host.endsWith(".linkedin.com");
    if (platform === "x") return host === "x.com" || host === "twitter.com";
    if (platform === "instagram") return host === "instagram.com";
    if (platform === "tiktok") return host === "tiktok.com" || host === "m.tiktok.com";
    if (platform === "bluesky") return host === "bsky.app";
    return true;
  } catch {
    return false;
  }
}

function socialHandle(url) {
  try {
    return new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? null;
  } catch {
    return null;
  }
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function evidenceKey(row) {
  const platform = normalizePlatform(row.platform ?? "other");
  const entityId = row.entityId ?? row.attachedCompanyId ?? row.companySlug ?? row.companyName ?? "unknown-entity";
  const nativeId = row.platformObjectId ?? row.platform_post_id ?? row.nativeId;
  if (nativeId) return `${entityId}:${platform}:id:${nativeId}`;
  const url = canonicalUrl(row.sourceUrl ?? row.canonicalUrl ?? row.url);
  if (url) return `${entityId}:${platform}:url:${url}`;
  return row.id ?? `${entityId}:${platform}:${row.title ?? row.text ?? "unknown"}`;
}

function canonicalUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|ref$|ref_|source$|si$|feature$)/i.test(key)) url.searchParams.delete(key);
    }
    url.hostname = url.hostname.replace(/^www\./, "").replace(/^twitter\.com$/, "x.com");
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return null;
  }
}

function dedupeRows(rows, keyForRow) {
  const byKey = new Map();
  for (const row of rows) {
    const key = keyForRow(row);
    const previous = byKey.get(key);
    if (!previous || rowTimestamp(row) >= rowTimestamp(previous)) {
      byKey.set(key, row);
    }
  }
  return [...byKey.values()];
}

function rowTimestamp(row) {
  const parsed = Date.parse(
    row.last_checked_at ?? row.lastCheckedAt ?? row.checkedAt ?? row.collected_at ?? row.collectedAt ?? 0
  );
  return Number.isFinite(parsed) ? parsed : 0;
}
