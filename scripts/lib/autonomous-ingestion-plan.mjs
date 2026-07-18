import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const AUTONOMOUS_BATCHES = Object.freeze([
  { slug: "S2026", label: "YC Spring 2026 (P26)", graphFile: "s2026.json" },
  { slug: "S26", label: "YC Summer 2026 (S26)", graphFile: "s26.json" },
  { slug: "A16ZSR006", label: "a16z Speedrun 006", graphFile: "a16zsr006.json" }
]);

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
      const path = join(root, "public", "graph", batch.graphFile);
      const graph = JSON.parse(await readFile(path, "utf8"));
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

export function mergePublicEvidenceSnapshots(snapshots, { fetchedAt = new Date().toISOString() } = {}) {
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
        "Generated export only; durable Supabase tables are the production ingestion source of truth.",
        "Rows are deduplicated by native identity or canonical URL before publication."
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

function evidenceKey(row) {
  const platform = normalizePlatform(row.platform ?? "other");
  const nativeId = row.platformObjectId ?? row.platform_post_id ?? row.nativeId;
  if (nativeId) return `${platform}:id:${nativeId}`;
  const url = canonicalUrl(row.sourceUrl ?? row.canonicalUrl ?? row.url);
  if (url) return `${platform}:url:${url}`;
  return row.id ?? `${platform}:${row.companySlug}:${row.title ?? row.text ?? "unknown"}`;
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
