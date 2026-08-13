import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { loadAutonomousCatalogs } from "./autonomous-ingestion-plan.mjs";
import {
  fetchGitHubJsonResponse,
  githubApiFailureReceipt,
  GitHubApiError
} from "./github-api-client.mjs";
import { githubNextLink } from "./github-api-pagination.mjs";
import { isFullyAuthoritativeGithubReceipt } from "./github-authoritative-reconciliation.mjs";
import {
  canonicalGithubTargetUrl,
  parseGithubTargetUrl
} from "./github-url.mjs";

export const GITHUB_EXHAUSTIVE_SCHEMA_VERSION = 1;
export const GITHUB_EXHAUSTIVE_RUNNER_VERSION = "2026-08-02.v1";
export const GITHUB_EXHAUSTIVE_BATCHES = Object.freeze([
  "S2026",
  "S26",
  "A16ZSR006"
]);
export const GITHUB_EXHAUSTIVE_LIMITS = Object.freeze({
  globalConcurrency: 4,
  requestTimeoutMs: 20_000,
  requestAttempts: 3,
  maxRateLimitWaitMs: 65_000,
  maxHttpAttemptsPerRun: 10_000,
  perPage: 100,
  recentActivityDays: 90
});

const API_ORIGIN = "https://api.github.com";
const CANONICAL_SNAPSHOTS = Object.freeze({
  S2026: "src/lib/social/github-traction.json",
  S26: "src/lib/social/github-traction-summer-2026.json",
  A16ZSR006: "src/lib/social/github-traction-a16z-speedrun-006.json"
});
const AUTHORITATIVE_DISCOVERY_SOURCES = new Set([
  "yc_profile",
  "a16z_speedrun_profile",
  "official_profile",
  "official_website"
]);
const SAFE_QUERY_PARAMETERS = new Set([
  "direction",
  "page",
  "per_page",
  "since",
  "sort",
  "type",
  "until"
]);

export class GithubRunBudgetExceeded extends Error {
  constructor(limit) {
    super(`GitHub exhaustive backfill reached its per-run HTTP-attempt budget of ${limit}.`);
    this.name = "GithubRunBudgetExceeded";
    this.limit = limit;
  }
}

export class GithubCollectionPause extends Error {
  constructor(blocker, { cause } = {}) {
    super(blocker.message, cause === undefined ? undefined : { cause });
    this.name = "GithubCollectionPause";
    this.blocker = blocker;
  }
}

/**
 * Build the complete verified GitHub mapping plan. Canonical catalog mappings
 * are unioned with mappings from a whole-cohort authoritative GitHub receipt.
 * Search-only candidates are deliberately rejected: only official profile or
 * official website discovery may become a verified collection target.
 */
export function buildGithubExhaustiveTargets(catalogs, {
  snapshots = [],
  batches,
  requireAuthoritativeSnapshots = true,
  sourceManifest = []
} = {}) {
  if (!Array.isArray(catalogs) || catalogs.length === 0) {
    throw new TypeError("catalogs must be a non-empty array.");
  }
  const selectedBatches = normalizeBatches(batches);
  const catalogByBatch = new Map(
    catalogs
      .filter((catalog) => selectedBatches.includes(catalog.slug))
      .map((catalog) => [catalog.slug, catalog])
  );
  for (const batchSlug of selectedBatches) {
    if (!catalogByBatch.has(batchSlug)) {
      throw new Error(`Missing canonical catalog for ${batchSlug}.`);
    }
  }

  const snapshotByBatch = new Map();
  for (const snapshot of snapshots ?? []) {
    const batchSlug = clean(snapshot?.source?.batchSlug);
    if (!selectedBatches.includes(batchSlug)) continue;
    if (snapshotByBatch.has(batchSlug)) {
      throw new Error(`Duplicate authoritative GitHub snapshot for ${batchSlug}.`);
    }
    if (!isFullyAuthoritativeGithubReceipt(snapshot)) {
      throw new Error(`${batchSlug} GitHub snapshot is not a whole-cohort authoritative receipt.`);
    }
    snapshotByBatch.set(batchSlug, snapshot);
  }
  if (requireAuthoritativeSnapshots) {
    const missing = selectedBatches.filter((batchSlug) => !snapshotByBatch.has(batchSlug));
    if (missing.length > 0) {
      throw new Error(`Missing authoritative GitHub snapshot(s): ${missing.join(", ")}.`);
    }
  }

  const entities = new Map();
  const batchRows = [];
  let companiesEvaluated = 0;
  let foundersEvaluated = 0;
  for (const batchSlug of selectedBatches) {
    const catalog = catalogByBatch.get(batchSlug);
    let batchFounders = 0;
    for (const company of catalog.companies ?? []) {
      indexEntity(entities, batchSlug, company);
      companiesEvaluated += 1;
      for (const founder of company.founders ?? []) {
        indexEntity(entities, batchSlug, founder);
        foundersEvaluated += 1;
        batchFounders += 1;
      }
    }
    batchRows.push({
      batchSlug,
      companies: catalog.companies?.length ?? 0,
      founders: batchFounders,
      canonicalSourcePath: portableCatalogPath(catalog)
    });
  }

  const attributionTasks = new Map();
  let excludedUnverifiedCatalogMappings = 0;
  for (const batchSlug of selectedBatches) {
    const catalog = catalogByBatch.get(batchSlug);
    for (const company of catalog.companies ?? []) {
      for (const entity of [company, ...(company.founders ?? [])]) {
        for (const account of entity.accounts ?? []) {
          if (account?.platform !== "github") continue;
          if (account.verified !== true && account.reviewState !== "verified") {
            excludedUnverifiedCatalogMappings += 1;
            continue;
          }
          addAttributionTask(attributionTasks, {
            batchSlug,
            entity,
            rawUrl: account.url,
            provenance: {
              sourceType: "canonical_catalog_mapping",
              sourceUrl: account.discoveredFromUrl ?? entity.profileUrl ?? null,
              matchReason: account.matchReason ?? "Verified GitHub account in the canonical catalog.",
              sourceKey: account.sourceKey ?? null
            }
          });
        }
      }
    }
  }

  for (const batchSlug of selectedBatches) {
    const snapshot = snapshotByBatch.get(batchSlug);
    if (!snapshot) continue;
    for (const row of snapshot.accounts) {
      if (!AUTHORITATIVE_DISCOVERY_SOURCES.has(row.discoverySource)) {
        throw new Error(
          `${batchSlug} authoritative receipt contains non-verifying discovery source ` +
          `${row.discoverySource ?? "missing"} for ${row.githubUrl ?? "an unknown target"}.`
        );
      }
      const entityKey = `${batchSlug}:${row.entityType}:${row.entityId}`;
      const entity = entities.get(entityKey);
      if (!entity) {
        throw new Error(`${batchSlug} authoritative GitHub row references unknown entity ${entityKey}.`);
      }
      addAttributionTask(attributionTasks, {
        batchSlug,
        entity,
        rawUrl: row.githubUrl,
        provenance: {
          sourceType: "authoritative_github_receipt",
          sourceUrl: row.sourceUrl ?? null,
          matchReason: row.matchReason ?? "Collected from an official public identity source.",
          discoverySource: row.discoverySource,
          receiptFetchedAt: snapshot.source.fetchedAt ?? null
        }
      });
    }
  }

  const physical = new Map();
  for (const task of attributionTasks.values()) {
    const physicalKey = githubPhysicalTargetKey(task.accountUrl);
    const existing = physical.get(physicalKey) ?? {
      targetKey: physicalKey,
      platform: "github",
      accountUrl: task.accountUrl,
      login: task.login,
      repo: task.repo,
      scope: task.repo ? "exact_repository" : "owner_public_repositories",
      attributions: []
    };
    existing.attributions.push({
      taskKey: task.taskKey,
      batchSlug: task.batchSlug,
      entityType: task.entityType,
      entityId: task.entityId,
      entityName: task.entityName,
      companySourceKey: task.companySourceKey,
      provenance: task.provenance
    });
    physical.set(physicalKey, existing);
  }

  const targets = [...physical.values()].map((target) => ({
    ...target,
    attributions: target.attributions
      .map((attribution) => ({
        ...attribution,
        provenance: [...attribution.provenance].sort(compareProvenance)
      }))
      .sort(compareAttributions),
    requiresAttributionReview: new Set(
      target.attributions.map((attribution) =>
        `${attribution.batchSlug}:${attribution.entityType}:${attribution.entityId}`
      )
    ).size > 1
  })).sort((left, right) => left.targetKey.localeCompare(right.targetKey));
  const tasks = [...attributionTasks.values()]
    .map((task) => ({ ...task, provenance: [...task.provenance].sort(compareProvenance) }))
    .sort((left, right) => left.taskKey.localeCompare(right.taskKey));
  const attributionReviews = targets
    .filter((target) => target.requiresAttributionReview)
    .map((target) => ({
      reviewKey: `github-attribution-review:${sha256(target.targetKey).slice(0, 20)}`,
      targetKey: target.targetKey,
      accountUrl: target.accountUrl,
      status: "manual_review_required",
      scoringPolicy: "deduplicate_physical_evidence_before_owner_attribution",
      attributionTaskKeys: target.attributions.map((row) => row.taskKey)
    }));
  const detailedBatchRows = batchRows.map((batch) => {
    const batchTasks = tasks.filter((task) => task.batchSlug === batch.batchSlug);
    const batchTargetKeys = new Set(batchTasks.map((task) => githubPhysicalTargetKey(task.accountUrl)));
    const batchTargets = targets.filter((target) => batchTargetKeys.has(target.targetKey));
    return {
      ...batch,
      verifiedAttributionTasks: batchTasks.length,
      physicalTargets: batchTargets.length,
      ownerTargets: batchTargets.filter((target) => target.repo === null).length,
      exactRepositoryTargets: batchTargets.filter((target) => target.repo !== null).length,
      catalogVerifiedMappings: batchTasks.filter((task) =>
        task.provenance.some((source) => source.sourceType === "canonical_catalog_mapping")
      ).length,
      authoritativeReceiptOnlyMappings: batchTasks.filter((task) =>
        !task.provenance.some((source) => source.sourceType === "canonical_catalog_mapping")
      ).length,
      multiAttributionReviews: attributionReviews.filter((review) =>
        batchTargets.some((target) => target.targetKey === review.targetKey)
      ).length
    };
  });

  const planCore = {
    schemaVersion: GITHUB_EXHAUSTIVE_SCHEMA_VERSION,
    runnerVersion: GITHUB_EXHAUSTIVE_RUNNER_VERSION,
    batches: detailedBatchRows,
    companiesEvaluated,
    foundersEvaluated,
    canonicalOwnersEvaluated: companiesEvaluated + foundersEvaluated,
    verifiedAttributionTasks: tasks.length,
    physicalTargets: targets.length,
    ownerTargets: targets.filter((target) => target.repo === null).length,
    exactRepositoryTargets: targets.filter((target) => target.repo !== null).length,
    catalogVerifiedMappings: tasks.filter((task) =>
      task.provenance.some((source) => source.sourceType === "canonical_catalog_mapping")
    ).length,
    authoritativeReceiptOnlyMappings: tasks.filter((task) =>
      !task.provenance.some((source) => source.sourceType === "canonical_catalog_mapping")
    ).length,
    excludedUnverifiedCatalogMappings,
    multiAttributionReviews: attributionReviews.length,
    sourceManifest: [...sourceManifest].sort((left, right) =>
      String(left.path).localeCompare(String(right.path))
    ),
    attributionTasks: tasks,
    attributionReviews,
    targets
  };
  return {
    ...planCore,
    planHash: sha256(stableJson(planCore))
  };
}

export async function buildGithubExhaustivePlan(root = process.cwd(), options = {}) {
  const selectedBatches = normalizeBatches(options.batches);
  const catalogs = options.catalogs ?? await loadAutonomousCatalogs(root);
  const snapshots = [];
  const sourceManifest = [];
  for (const batchSlug of selectedBatches) {
    const catalog = catalogs.find((candidate) => candidate.slug === batchSlug);
    if (catalog?.sourcePath) {
      sourceManifest.push(await fileManifestEntry(root, catalog.sourcePath, "canonical_catalog"));
    }
    if (options.snapshots) continue;
    const relativePath = CANONICAL_SNAPSHOTS[batchSlug];
    const absolutePath = join(root, relativePath);
    const bytes = await readFile(absolutePath);
    snapshots.push(JSON.parse(bytes));
    sourceManifest.push({
      kind: "authoritative_github_receipt",
      path: relativePath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length
    });
  }
  return buildGithubExhaustiveTargets(catalogs, {
    snapshots: options.snapshots ?? snapshots,
    batches: selectedBatches,
    requireAuthoritativeSnapshots: options.requireAuthoritativeSnapshots ?? true,
    sourceManifest: options.sourceManifest ?? sourceManifest
  });
}

export async function runGithubExhaustiveBackfill({
  root = process.cwd(),
  outputDir,
  plan,
  catalogs,
  snapshots,
  batches,
  resume = false,
  limits: limitOverrides,
  activitySince,
  activityUntil,
  fetch: fetchImplementation = globalThis.fetch,
  token = process.env.GITHUB_TOKEN ?? null,
  signal,
  now = () => new Date(),
  sleep = delay,
  onPageCommitted
} = {}) {
  if (!outputDir) throw new Error("runGithubExhaustiveBackfill requires an outputDir.");
  if (typeof fetchImplementation !== "function") throw new TypeError("A fetch implementation is required.");
  const limits = normalizeLimits(limitOverrides);
  const priorConfig = resume
    ? await readCheckpointConfig(resolve(outputDir))
    : null;
  const until = canonicalTimestamp(
    activityUntil ?? priorConfig?.activityUntil ?? now().toISOString(),
    "activityUntil"
  );
  const since = canonicalTimestamp(
    activitySince ?? priorConfig?.activitySince ??
      new Date(Date.parse(until) - limits.recentActivityDays * 86_400_000).toISOString(),
    "activitySince"
  );
  if (Date.parse(since) >= Date.parse(until)) {
    throw new Error("activitySince must be earlier than activityUntil.");
  }
  const resolvedPlan = plan ?? await buildGithubExhaustivePlan(root, {
    catalogs,
    snapshots,
    batches
  });
  const config = {
    schemaVersion: GITHUB_EXHAUSTIVE_SCHEMA_VERSION,
    runnerVersion: GITHUB_EXHAUSTIVE_RUNNER_VERSION,
    planHash: resolvedPlan.planHash,
    targetKeys: resolvedPlan.targets.map((target) => target.targetKey),
    activitySince: since,
    activityUntil: until,
    perPage: limits.perPage
  };
  const configFingerprint = sha256(stableJson(config));
  const store = await GithubCheckpointStore.open(resolve(outputDir), {
    config,
    configFingerprint,
    plan: resolvedPlan,
    resume,
    now
  });
  const requester = createGithubRequester({
    fetchImplementation,
    token,
    limits,
    signal,
    now,
    sleep,
    onReceipt: (receipt) => store.recordRequest(receipt)
  });
  const context = {
    limits,
    requester,
    store,
    signal,
    now,
    activitySince: since,
    activityUntil: until,
    onPageCommitted
  };
  const pending = resolvedPlan.targets.filter((target) => !store.isTerminal(target.targetKey));
  await runWorkerPool(pending, limits.globalConcurrency, async (target) => {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    try {
      await collectPhysicalTarget(target, context);
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      if (error instanceof GithubRunBudgetExceeded || causedBy(error, GithubRunBudgetExceeded)) {
        await store.pauseTarget(target, {
          code: "github_run_request_budget_exhausted",
          provider: "github_rest_api",
          message: error.message,
          retryable: true,
          retryAt: null,
          nextAction: "Resume the same output directory with a fresh per-run request budget."
        });
        return;
      }
      if (error instanceof GithubCollectionPause) {
        await store.pauseTarget(target, error.blocker);
        return;
      }
      const blocker = githubBlocker(error, null);
      if (blocker.retryable) {
        await store.pauseTarget(target, blocker);
      } else {
        await store.completeTarget(target, terminalTargetReceipt(target, store.targetState(target), {
          outcome: blocker.credentialRequired ? "manual_review" : "access_blocked",
          blocker
        }));
      }
    }
  });
  const summary = buildSummary(resolvedPlan, store.state, {
    activitySince: since,
    activityUntil: until,
    limits,
    completedAt: now().toISOString(),
    httpAttemptsThisInvocation: requester.attemptsUsed()
  });
  await store.finish(summary);
  return summary;
}

async function collectPhysicalTarget(target, context) {
  let state = await context.store.beginTarget(target);
  if (!state.profile) {
    const profileUrl = `${API_ORIGIN}/users/${encodeURIComponent(target.login)}`;
    let result;
    try {
      result = await requestOrPause(context, target, "account_profile", profileUrl);
    } catch (error) {
      if (isGithubStatus(error, 404)) {
        await context.store.completeTarget(target, terminalTargetReceipt(target, state, {
          outcome: "manual_review",
          blocker: githubBlocker(error, "github_mapped_account_not_found_or_inaccessible")
        }));
        return;
      }
      throw error;
    }
    const validation = validateMappedProfile(target, result.data);
    if (!validation.ok) {
      await context.store.completeTarget(target, terminalTargetReceipt(target, state, {
        outcome: "manual_review",
        blocker: validation.blocker
      }));
      return;
    }
    const profile = normalizeAccountProfile(result.data);
    await context.store.commit(target.targetKey, {
      type: "account_profile_collected",
      targetKey: target.targetKey,
      profile
    }, (draft) => {
      draft.targets[target.targetKey].profile = profile;
      draft.targets[target.targetKey].status = "in_progress";
      draft.targets[target.targetKey].blocker = null;
    });
    state = context.store.targetState(target.targetKey);
  }

  if (target.repo) {
    await ensureExactRepository(target, context);
    await drainRepositoryScopes(target, context);
  } else {
    await drainRepositoryScopes(target, context);
    await enumerateOwnerRepositories(target, context);
    await drainRepositoryScopes(target, context);
  }
  state = context.store.targetState(target.targetKey);
  if (state.status === "terminal") return;
  const repositories = Object.values(state.repositories ?? {});
  const blockedScopes = repositories.flatMap((repository) =>
    Object.entries(repository.streams ?? {})
      .filter(([, scope]) => scope.status === "blocked")
      .map(([resource, scope]) => ({
        repositoryId: repository.repository.id,
        fullName: repository.repository.fullName,
        resource,
        blocker: scope.blocker
      }))
  );
  const listingBlocked = state.repositoryListing?.status === "blocked"
    ? [{ resource: "repositories", blocker: state.repositoryListing.blocker }]
    : [];
  const blocked = [...listingBlocked, ...blockedScopes];
  await context.store.completeTarget(target, terminalTargetReceipt(target, state, {
    outcome: blocked.length > 0 ? "access_blocked" : "collected",
    blocker: blocked.length > 0
      ? {
          code: "github_partial_source_blockers",
          provider: "github_rest_api",
          message: `${blocked.length} GitHub collection scope(s) were blocked.`,
          retryable: false,
          blockedScopes: blocked,
          nextAction: "Retry the exact blocked scopes in a new proof-bound run after resolving their recorded blockers."
        }
      : null
  }));
}

async function ensureExactRepository(target, context) {
  const state = context.store.targetState(target.targetKey);
  if (Object.keys(state.repositories ?? {}).length > 0) return;
  const url = `${API_ORIGIN}/repos/${encodeURIComponent(target.login)}/${encodeURIComponent(target.repo)}`;
  let result;
  try {
    result = await requestOrPause(context, target, "exact_repository", url);
  } catch (error) {
    if (isGithubStatus(error, 404)) {
      await context.store.completeTarget(target, terminalTargetReceipt(target, state, {
        outcome: "manual_review",
        blocker: githubBlocker(error, "github_mapped_repository_not_found_or_inaccessible")
      }));
      return;
    }
    throw error;
  }
  const validation = validateRepository(result.data, state.profile, target);
  if (!validation.ok) {
    await context.store.completeTarget(target, terminalTargetReceipt(target, state, {
      outcome: "manual_review",
      blocker: validation.blocker
    }));
    return;
  }
  const repository = normalizeRepository(result.data);
  await commitRepositories(target, context, [repository], {
    resource: "exact_repository",
    endpoint: safeGithubEndpointDescriptor(url),
    sourceExhausted: true,
    nextUrl: null,
    rejectedNonPublic: 0,
    rejectedOwnershipMismatch: 0
  });
}

async function enumerateOwnerRepositories(target, context) {
  let state = context.store.targetState(target.targetKey);
  if (state.repositoryListing?.status === "complete" || state.repositoryListing?.status === "blocked") return;
  const profile = state.profile;
  const initialUrl = ownerRepositoriesUrl(profile, context.limits.perPage);
  if (!state.repositoryListing) {
    await context.store.commit(target.targetKey, {
      type: "repository_listing_initialized",
      targetKey: target.targetKey,
      endpoint: safeGithubEndpointDescriptor(initialUrl)
    }, (draft) => {
      draft.targets[target.targetKey].repositoryListing = freshScope(initialUrl);
    });
  }

  while (true) {
    state = context.store.targetState(target.targetKey);
    const scope = state.repositoryListing;
    if (!scope || scope.status !== "pending" || !scope.nextUrl) return;
    assertUnvisitedPage(scope, scope.nextUrl);
    let result;
    try {
      result = await requestOrPause(context, target, "repositories", scope.nextUrl);
    } catch (error) {
      if (error instanceof GithubCollectionPause || error instanceof GithubRunBudgetExceeded || causedBy(error, GithubRunBudgetExceeded)) {
        throw error;
      }
      const blocker = githubBlocker(error, null);
      await context.store.commit(target.targetKey, {
        type: "repository_listing_blocked",
        targetKey: target.targetKey,
        blocker
      }, (draft) => {
        const listing = draft.targets[target.targetKey].repositoryListing;
        listing.status = "blocked";
        listing.blocker = blocker;
      });
      return;
    }
    if (!Array.isArray(result.data)) {
      throw new Error("GitHub repository listing response was not an array.");
    }
    const repositories = [];
    let rejectedNonPublic = 0;
    let rejectedOwnershipMismatch = 0;
    for (const raw of result.data) {
      const validation = validateRepository(raw, profile, target);
      if (!validation.ok) {
        if (validation.reason === "not_public") rejectedNonPublic += 1;
        else rejectedOwnershipMismatch += 1;
        continue;
      }
      repositories.push(normalizeRepository(raw));
    }
    const nextUrl = safeNextUrl(result.headers, scope.nextUrl);
    await commitRepositories(target, context, repositories, {
      resource: "repositories",
      endpoint: safeGithubEndpointDescriptor(scope.nextUrl),
      sourceExhausted: nextUrl === null,
      nextUrl,
      rejectedNonPublic,
      rejectedOwnershipMismatch
    });
    await drainRepositoryScopes(target, context, repositories.map((repository) => String(repository.id)));
  }
}

async function commitRepositories(target, context, repositories, page) {
  const unique = [...new Map(repositories.map((repository) => [String(repository.id), repository])).values()]
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const evidence = unique.map((repository) => repositoryEvidence(target, repository, context.now));
  await context.store.commit(target.targetKey, {
    type: "repository_page_committed",
    targetKey: target.targetKey,
    page,
    evidence
  }, (draft) => {
    const targetState = draft.targets[target.targetKey];
    targetState.repositories ??= {};
    for (const repository of unique) {
      const key = String(repository.id);
      targetState.repositories[key] ??= {
        repository,
        streams: repositoryStreams(repository, context)
      };
    }
    targetState.repositoryListing ??= freshScope(null);
    const listing = targetState.repositoryListing;
    listing.pagesFetched += 1;
    listing.recordsSeen += repositories.length + page.rejectedNonPublic + page.rejectedOwnershipMismatch;
    listing.recordsAccepted += unique.length;
    listing.recordsRejected += page.rejectedNonPublic + page.rejectedOwnershipMismatch;
    listing.rejectedNonPublic += page.rejectedNonPublic;
    listing.rejectedOwnershipMismatch += page.rejectedOwnershipMismatch;
    listing.seenPageDigests.push(sha256(stableJson(page.endpoint)));
    listing.nextUrl = page.nextUrl;
    listing.status = page.sourceExhausted ? "complete" : "pending";
    listing.sourceExhausted = page.sourceExhausted;
  });
  await context.onPageCommitted?.({ targetKey: target.targetKey, resource: page.resource, count: unique.length });
}

async function drainRepositoryScopes(target, context, repositoryIds = null) {
  const state = context.store.targetState(target.targetKey);
  const ids = repositoryIds ?? Object.keys(state.repositories ?? {});
  for (const repositoryId of ids.sort((left, right) => left.localeCompare(right))) {
    const current = context.store.targetState(target.targetKey)?.repositories?.[repositoryId];
    if (!current) continue;
    for (const resource of ["releases", "tags", "commits"]) {
      const scope = context.store.targetState(target.targetKey).repositories[repositoryId].streams[resource];
      if (["complete", "blocked", "not_applicable"].includes(scope.status)) continue;
      await collectRepositoryResource(target, repositoryId, resource, context);
    }
  }
}

async function collectRepositoryResource(target, repositoryId, resource, context) {
  while (true) {
    const targetState = context.store.targetState(target.targetKey);
    const repoState = targetState.repositories[repositoryId];
    const scope = repoState.streams[resource];
    if (scope.status !== "pending" || !scope.nextUrl) return;
    assertUnvisitedPage(scope, scope.nextUrl);
    let result;
    try {
      result = await requestOrPause(context, target, resource, scope.nextUrl);
    } catch (error) {
      if (resource === "commits" && isGithubStatus(error, 409)) {
        await completeEmptyRepositoryScope(target, repositoryId, resource, context, {
          code: "github_repository_empty_or_unborn",
          message: "GitHub returned 409 for the repository commit history; the repository has no readable commit history."
        });
        return;
      }
      if (error instanceof GithubCollectionPause || error instanceof GithubRunBudgetExceeded || causedBy(error, GithubRunBudgetExceeded)) {
        throw error;
      }
      const blocker = githubBlocker(error, null);
      await context.store.commit(target.targetKey, {
        type: "repository_scope_blocked",
        targetKey: target.targetKey,
        repositoryId,
        resource,
        blocker
      }, (draft) => {
        const current = draft.targets[target.targetKey].repositories[repositoryId].streams[resource];
        current.status = "blocked";
        current.blocker = blocker;
      });
      return;
    }
    if (!Array.isArray(result.data)) {
      throw new Error(`GitHub ${resource} response was not an array.`);
    }
    const normalized = normalizeResourcePage(resource, result.data, repoState.repository, target, context);
    const nextUrl = safeNextUrl(result.headers, scope.nextUrl);
    const page = {
      resource,
      endpoint: safeGithubEndpointDescriptor(scope.nextUrl),
      sourceExhausted: nextUrl === null,
      nextUrl,
      seen: result.data.length,
      accepted: normalized.evidence.length,
      rejected: normalized.rejected
    };
    await context.store.commit(target.targetKey, {
      type: "repository_resource_page_committed",
      targetKey: target.targetKey,
      repositoryId,
      resource,
      page,
      evidence: normalized.evidence
    }, (draft) => {
      const current = draft.targets[target.targetKey].repositories[repositoryId].streams[resource];
      current.pagesFetched += 1;
      current.recordsSeen += page.seen;
      current.recordsAccepted += page.accepted;
      current.recordsRejected += page.rejected;
      current.seenPageDigests.push(sha256(stableJson(page.endpoint)));
      current.nextUrl = nextUrl;
      current.status = page.sourceExhausted ? "complete" : "pending";
      current.sourceExhausted = page.sourceExhausted;
    });
    await context.onPageCommitted?.({
      targetKey: target.targetKey,
      repositoryId,
      resource,
      count: normalized.evidence.length
    });
  }
}

async function completeEmptyRepositoryScope(target, repositoryId, resource, context, reason) {
  await context.store.commit(target.targetKey, {
    type: "repository_scope_exhausted_empty",
    targetKey: target.targetKey,
    repositoryId,
    resource,
    reason
  }, (draft) => {
    const current = draft.targets[target.targetKey].repositories[repositoryId].streams[resource];
    current.status = "complete";
    current.sourceExhausted = true;
    current.emptyReason = reason;
    current.nextUrl = null;
  });
}

function normalizeResourcePage(resource, rows, repository, target, context) {
  const byId = new Map();
  let rejected = 0;
  for (const row of rows) {
    let evidence = null;
    if (resource === "releases") {
      if (row?.draft === true) {
        rejected += 1;
        continue;
      }
      evidence = releaseEvidence(target, repository, row, context.now);
    } else if (resource === "tags") {
      evidence = tagEvidence(target, repository, row, context.now);
    } else if (resource === "commits") {
      evidence = commitEvidence(target, repository, row, context);
      if (evidence?.publishedAt && (
        Date.parse(evidence.publishedAt) < Date.parse(context.activitySince) ||
        Date.parse(evidence.publishedAt) > Date.parse(context.activityUntil)
      )) {
        rejected += 1;
        continue;
      }
    }
    if (!evidence?.evidenceId) {
      rejected += 1;
      continue;
    }
    const previous = byId.get(evidence.evidenceId);
    if (!previous || stableJson(evidence) < stableJson(previous)) byId.set(evidence.evidenceId, evidence);
  }
  return {
    evidence: [...byId.values()].sort((left, right) => left.evidenceId.localeCompare(right.evidenceId)),
    rejected
  };
}

function repositoryStreams(repository, context) {
  const base = `${API_ORIGIN}/repos/${encodeURIComponent(repository.owner.login)}/${encodeURIComponent(repository.name)}`;
  const releases = freshScope(`${base}/releases?per_page=${context.limits.perPage}`);
  const tags = freshScope(`${base}/tags?per_page=${context.limits.perPage}`);
  const commits = repository.defaultBranch && !repository.fork
    ? freshScope(
        `${base}/commits?per_page=${context.limits.perPage}` +
        `&since=${encodeURIComponent(context.activitySince)}` +
        `&until=${encodeURIComponent(context.activityUntil)}`
      )
    : {
        ...freshScope(null),
        status: "not_applicable",
        sourceExhausted: true,
        emptyReason: {
          code: repository.fork
            ? "fork_default_branch_history_not_attributable"
            : "repository_has_no_default_branch",
          message: repository.fork
            ? "Default-branch commit history for a fork is not attributed as owner activity."
            : "The repository has no default branch."
        }
      };
  return { releases, tags, commits };
}

function freshScope(nextUrl) {
  return {
    status: nextUrl ? "pending" : "complete",
    nextUrl,
    sourceExhausted: nextUrl === null,
    pagesFetched: 0,
    recordsSeen: 0,
    recordsAccepted: 0,
    recordsRejected: 0,
    rejectedNonPublic: 0,
    rejectedOwnershipMismatch: 0,
    seenPageDigests: [],
    blocker: null
  };
}

async function requestOrPause(context, target, resource, url) {
  try {
    return await context.requester.get(url, { targetKey: target.targetKey, resource });
  } catch (error) {
    if (error instanceof GithubRunBudgetExceeded || causedBy(error, GithubRunBudgetExceeded)) throw error;
    const blocker = githubBlocker(error, null);
    if (blocker.retryable) throw new GithubCollectionPause(blocker, { cause: error });
    throw error;
  }
}

export function createGithubRequester({
  fetchImplementation = globalThis.fetch,
  token = null,
  limits: rawLimits,
  signal,
  now = () => new Date(),
  sleep = delay,
  onReceipt = async () => {}
} = {}) {
  const limits = normalizeLimits(rawLimits);
  let attemptsUsed = 0;
  let circuit = null;

  return {
    attemptsUsed: () => attemptsUsed,
    async get(rawUrl, { targetKey, resource }) {
      const url = assertSafeGithubApiUrl(rawUrl);
      const descriptor = safeGithubEndpointDescriptor(url);
      const requestId = `github-request:${sha256(`${targetKey}:${resource}:${stableJson(descriptor)}`).slice(0, 24)}`;
      if (circuit && (!circuit.retryAt || Date.parse(circuit.retryAt) > now().getTime())) {
        const receipt = {
          requestId,
          targetKey,
          resource,
          endpoint: descriptor,
          status: "blocked_without_request",
          startedAt: now().toISOString(),
          completedAt: now().toISOString(),
          attempts: [],
          blocker: circuit
        };
        await onReceipt(receipt);
        throw new GithubCollectionPause(circuit);
      }
      if (circuit?.retryAt && Date.parse(circuit.retryAt) <= now().getTime()) circuit = null;

      const attemptReceipts = [];
      const startedAt = now().toISOString();
      const trackedFetch = async (requestUrl, options = {}) => {
        if (attemptsUsed >= limits.maxHttpAttemptsPerRun) {
          throw new GithubRunBudgetExceeded(limits.maxHttpAttemptsPerRun);
        }
        attemptsUsed += 1;
        const attempt = attemptReceipts.length + 1;
        const attemptStartedAt = now().toISOString();
        const timeoutSignal = AbortSignal.timeout(limits.requestTimeoutMs);
        const combinedSignal = signal
          ? AbortSignal.any([signal, timeoutSignal])
          : timeoutSignal;
        try {
          const response = await fetchImplementation(requestUrl, {
            ...options,
            signal: combinedSignal
          });
          attemptReceipts.push({
            attempt,
            startedAt: attemptStartedAt,
            completedAt: now().toISOString(),
            httpStatus: response.status,
            rateLimit: rateLimitReceipt(response.headers)
          });
          return response;
        } catch (error) {
          attemptReceipts.push({
            attempt,
            startedAt: attemptStartedAt,
            completedAt: now().toISOString(),
            httpStatus: null,
            errorCode: safeErrorCode(error),
            errorName: clean(error?.name) || "Error"
          });
          throw error;
        }
      };
      const headers = {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "returner-fund-exhaustive-github-backfill-readonly"
      };
      if (token) headers.authorization = `Bearer ${token}`;
      try {
        const result = await fetchGitHubJsonResponse(url, {
          headers,
          fetchImplementation: trackedFetch,
          sleep,
          now: () => now().getTime(),
          maxAttempts: limits.requestAttempts,
          maxRateLimitWaitMs: limits.maxRateLimitWaitMs
        });
        await onReceipt({
          requestId,
          targetKey,
          resource,
          endpoint: descriptor,
          status: "succeeded",
          startedAt,
          completedAt: now().toISOString(),
          attempts: attemptReceipts,
          response: {
            httpStatus: attemptReceipts.at(-1)?.httpStatus ?? 200,
            etag: clean(result.headers?.get?.("etag")) || null,
            nextEndpoint: safeNextUrl(result.headers, url)
              ? safeGithubEndpointDescriptor(safeNextUrl(result.headers, url))
              : null,
            rateLimit: rateLimitReceipt(result.headers)
          }
        });
        const successfulRateLimit = rateLimitReceipt(result.headers);
        if (successfulRateLimit.remaining === 0) {
          circuit = {
            code: "github_rate_limit_preemptive_pause",
            provider: "github_rest_api",
            message: "The successful GitHub response consumed the final request in the current rate-limit window.",
            endpoint: descriptor,
            httpStatus: null,
            rateLimitRemaining: 0,
            retryAt: successfulRateLimit.resetAt,
            retryable: true,
            credentialRequired: false,
            nextAction: "Resume after the recorded GitHub rate-limit reset; do not send a guaranteed-failing request."
          };
        }
        return result;
      } catch (error) {
        const budgetError = findCause(error, GithubRunBudgetExceeded);
        const failure = budgetError
          ? {
              error: budgetError.message,
              failureReason: "github_run_request_budget_exhausted",
              endpoint: descriptor.pathname,
              httpStatus: null,
              rateLimitRemaining: null,
              rateLimitResetAt: null,
              attempts: attemptReceipts.length,
              retryable: true
            }
          : githubApiFailureReceipt(error);
        let blocker = budgetError
          ? {
              code: "github_run_request_budget_exhausted",
              provider: "github_rest_api",
              message: budgetError.message,
              endpoint: descriptor,
              httpStatus: null,
              retryable: true,
              retryAt: null,
              credentialRequired: false,
              nextAction: "Resume the exact checkpoint with a fresh per-run request budget."
            }
          : githubBlocker(error, null, descriptor);
        if (failure.httpStatus === 403 && failure.retryable && failure.failureReason !== "github_rate_limit_exhausted") {
          blocker = {
            ...blocker,
            code: "github_secondary_rate_or_abuse_limit",
            message: "GitHub returned a retryable 403, consistent with a secondary rate or abuse limit.",
            nextAction: "Resume only after the recorded reset/cooldown and keep concurrency at or below four."
          };
        }
        failure.error = redactSecret(failure.error, token);
        blocker.message = redactSecret(blocker.message, token);
        if (
          failure.failureReason === "github_rate_limit_exhausted" ||
          failure.httpStatus === 429 ||
          (failure.httpStatus === 403 && failure.retryable)
        ) {
          circuit = blocker;
        }
        await onReceipt({
          requestId,
          targetKey,
          resource,
          endpoint: descriptor,
          status: budgetError ? "paused_before_request_budget" : "failed",
          startedAt,
          completedAt: now().toISOString(),
          attempts: attemptReceipts,
          failure,
          blocker
        });
        if (budgetError) throw budgetError;
        throw error;
      }
    }
  };
}

export function safeGithubEndpointDescriptor(rawUrl) {
  const url = new URL(assertSafeGithubApiUrl(rawUrl));
  const query = {};
  for (const key of [...url.searchParams.keys()].sort()) {
    if (!SAFE_QUERY_PARAMETERS.has(key)) continue;
    const values = url.searchParams.getAll(key);
    query[key] = values.length === 1 ? values[0] : values.sort();
  }
  return {
    pathname: url.pathname,
    query
  };
}

export function validateRepository(raw, account, target) {
  if (!raw || raw.private === true || (raw.visibility && raw.visibility !== "public")) {
    return {
      ok: false,
      reason: "not_public",
      blocker: {
        code: "github_repository_not_public",
        provider: "github_rest_api",
        message: "The mapped repository is not publicly visible and was not retained.",
        retryable: false,
        credentialRequired: false,
        nextAction: "Do not ingest token-visible private or internal repository data."
      }
    };
  }
  if (!Number.isInteger(Number(raw.id)) || !clean(raw.full_name) || !clean(raw.owner?.login)) {
    return invalidRepository("github_repository_response_invalid", "GitHub repository identity fields were missing.");
  }
  if (
    String(raw.owner?.id ?? "") !== String(account?.id ?? "") ||
    clean(raw.owner?.login).toLowerCase() !== clean(account?.login).toLowerCase()
  ) {
    return invalidRepository(
      "github_repository_owner_mismatch",
      "GitHub returned a repository that is not owned by the verified mapped account."
    );
  }
  if (target?.repo) {
    const expected = `${target.login}/${target.repo}`.toLowerCase();
    if (clean(raw.full_name).toLowerCase() !== expected) {
      return invalidRepository(
        "github_mapped_repository_redirect_or_transfer",
        "The mapped repository resolved to a different owner/name and requires attribution review."
      );
    }
  }
  return { ok: true };
}

function invalidRepository(code, message) {
  return {
    ok: false,
    reason: "ownership_mismatch",
    blocker: {
      code,
      provider: "github_rest_api",
      message,
      retryable: false,
      credentialRequired: false,
      nextAction: "Queue the exact mapping for manual owner-attribution review before publication."
    }
  };
}

function validateMappedProfile(target, raw) {
  if (!raw || !Number.isInteger(Number(raw.id)) || !clean(raw.login)) {
    return {
      ok: false,
      blocker: {
        code: "github_account_response_invalid",
        provider: "github_rest_api",
        message: "GitHub account profile response lacked an immutable id or login.",
        retryable: false,
        credentialRequired: false,
        nextAction: "Queue the account mapping for manual review."
      }
    };
  }
  if (clean(raw.login).toLowerCase() !== target.login.toLowerCase()) {
    return {
      ok: false,
      blocker: {
        code: "github_mapped_account_redirect_or_rename",
        provider: "github_rest_api",
        message: "The mapped GitHub login resolved to a different login and cannot be expanded automatically.",
        retryable: false,
        credentialRequired: false,
        nextAction: "Verify the rename or transfer and update the canonical account mapping."
      }
    };
  }
  return { ok: true };
}

function normalizeAccountProfile(raw) {
  return {
    id: Number(raw.id),
    login: clean(raw.login),
    type: ["Organization", "User", "Bot"].includes(raw.type) ? raw.type : "User",
    htmlUrl: canonicalGithubTargetUrl(raw.html_url ?? `https://github.com/${raw.login}`),
    publicRepos: nonNegativeInteger(raw.public_repos),
    followers: nonNegativeInteger(raw.followers),
    createdAt: validTimestamp(raw.created_at),
    updatedAt: validTimestamp(raw.updated_at)
  };
}

function normalizeRepository(raw) {
  return {
    id: Number(raw.id),
    name: clean(raw.name),
    fullName: clean(raw.full_name),
    htmlUrl: canonicalGithubTargetUrl(raw.html_url ?? `https://github.com/${raw.full_name}`),
    owner: {
      id: Number(raw.owner.id),
      login: clean(raw.owner.login),
      type: clean(raw.owner.type) || null
    },
    public: true,
    fork: raw.fork === true,
    archived: raw.archived === true,
    disabled: raw.disabled === true,
    defaultBranch: clean(raw.default_branch) || null,
    language: clean(raw.language) || null,
    createdAt: validTimestamp(raw.created_at),
    updatedAt: validTimestamp(raw.updated_at),
    pushedAt: validTimestamp(raw.pushed_at),
    stars: nonNegativeInteger(raw.stargazers_count),
    forks: nonNegativeInteger(raw.forks_count),
    watchers: nonNegativeInteger(raw.watchers_count),
    openIssues: nonNegativeInteger(raw.open_issues_count),
    parent: raw.fork && raw.parent?.id
      ? { id: Number(raw.parent.id), fullName: clean(raw.parent.full_name) || null }
      : null,
    source: raw.fork && raw.source?.id
      ? { id: Number(raw.source.id), fullName: clean(raw.source.full_name) || null }
      : null
  };
}

function repositoryEvidence(target, repository, observed) {
  return baseEvidence(target, repository, {
    evidenceId: `github:repository:${repository.id}`,
    kind: "github_repository",
    nativeId: String(repository.id),
    canonicalUrl: repository.htmlUrl,
    publishedAt: repository.createdAt,
    timestampProvenance: "github_repository.created_at",
    observedAt: observed().toISOString(),
    metrics: {
      stars: repository.stars,
      forks: repository.forks,
      watchers: repository.watchers,
      openIssues: repository.openIssues
    },
    metadata: {
      fullName: repository.fullName,
      fork: repository.fork,
      archived: repository.archived,
      disabled: repository.disabled,
      language: repository.language,
      pushedAt: repository.pushedAt,
      updatedAt: repository.updatedAt,
      parent: repository.parent,
      source: repository.source
    }
  });
}

function releaseEvidence(target, repository, row, observed) {
  const canonicalUrl = safeGithubContentUrl(row?.html_url, repository, "releases");
  if (!Number.isInteger(Number(row?.id)) || !canonicalUrl) return null;
  const assets = Array.isArray(row.assets) ? row.assets : [];
  return baseEvidence(target, repository, {
    evidenceId: `github:release:${row.id}`,
    kind: "github_release",
    nativeId: String(row.id),
    canonicalUrl,
    publishedAt: validTimestamp(row.published_at ?? row.created_at),
    timestampProvenance: row.published_at ? "github_release.published_at" : "github_release.created_at",
    observedAt: observed().toISOString(),
    metrics: {
      assets: assets.length,
      assetDownloads: assets.reduce((total, asset) => total + nonNegativeInteger(asset.download_count), 0)
    },
    metadata: {
      tagName: clean(row.tag_name) || null,
      prerelease: row.prerelease === true,
      immutable: row.immutable === true
    }
  });
}

function tagEvidence(target, repository, row, observed) {
  const name = clean(row?.name);
  const sha = clean(row?.commit?.sha);
  if (!name || !/^[0-9a-f]{7,64}$/i.test(sha)) return null;
  return baseEvidence(target, repository, {
    evidenceId: `github:tag:${repository.id}:${sha.toLowerCase()}:${sha256(name).slice(0, 12)}`,
    kind: "github_tag",
    nativeId: `${name}:${sha}`,
    canonicalUrl: `${repository.htmlUrl}/tree/${encodeURIComponent(name)}`,
    publishedAt: null,
    timestampProvenance: "unavailable_from_github_rest_tag_listing",
    observedAt: observed().toISOString(),
    metrics: {},
    metadata: { name, commitSha: sha.toLowerCase(), archiveVerified: false }
  });
}

function commitEvidence(target, repository, row, context) {
  const sha = clean(row?.sha).toLowerCase();
  if (!/^[0-9a-f]{7,64}$/.test(sha)) return null;
  const publishedAt = validTimestamp(
    row?.commit?.committer?.date ?? row?.commit?.author?.date
  );
  const canonicalUrl = safeGithubContentUrl(row.html_url, repository, "commit") ??
    `${repository.htmlUrl}/commit/${sha}`;
  return baseEvidence(target, repository, {
    evidenceId: `github:commit:${repository.id}:${sha}`,
    kind: "github_commit",
    nativeId: sha,
    canonicalUrl,
    publishedAt,
    timestampProvenance: row?.commit?.committer?.date
      ? "github_commit.committer.date"
      : "github_commit.author.date",
    observedAt: context.now().toISOString(),
    metrics: {},
    metadata: {
      authorLogin: clean(row.author?.login) || null,
      committerLogin: clean(row.committer?.login) || null,
      activityWindow: {
        since: context.activitySince,
        until: context.activityUntil
      }
    }
  });
}

function baseEvidence(target, repository, evidence) {
  return {
    ...evidence,
    platform: "github",
    physicalRepository: {
      repositoryId: String(repository.id),
      fullName: repository.fullName,
      canonicalUrl: repository.htmlUrl
    },
    attributions: target.attributions.map((attribution) => ({
      taskKey: attribution.taskKey,
      batchSlug: attribution.batchSlug,
      entityType: attribution.entityType,
      entityId: attribution.entityId,
      entityName: attribution.entityName
    })),
    requiresAttributionReview: target.requiresAttributionReview,
    publicationState: "stored_but_unpublished",
    scoringEligible: false,
    scoringEligibilityReason:
      "Exhaustive GitHub evidence must pass canonical merge, physical deduplication, and owner-attribution review before scoring."
  };
}

function ownerRepositoriesUrl(profile, perPage) {
  const login = encodeURIComponent(profile.login);
  return profile.type === "Organization"
    ? `${API_ORIGIN}/orgs/${login}/repos?type=public&sort=full_name&direction=asc&per_page=${perPage}`
    : `${API_ORIGIN}/users/${login}/repos?type=owner&sort=full_name&direction=asc&per_page=${perPage}`;
}

function safeGithubContentUrl(rawUrl, repository, pathKind) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || url.hostname.replace(/^www\./i, "").toLowerCase() !== "github.com") {
      return null;
    }
    const expectedPrefix = `/${repository.fullName}/${pathKind === "releases" ? "releases/" : "commit/"}`.toLowerCase();
    if (!url.pathname.toLowerCase().startsWith(expectedPrefix)) return null;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    url.hostname = "github.com";
    return url.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

function terminalTargetReceipt(target, state, { outcome, blocker }) {
  const repositories = Object.values(state?.repositories ?? {});
  return {
    targetKey: target.targetKey,
    accountUrl: target.accountUrl,
    scope: target.scope,
    outcome,
    blocker,
    attributionTaskKeys: target.attributions.map((row) => row.taskKey),
    repositoryEnumeration: target.repo
      ? "exact_mapped_repository_only"
      : state?.repositoryListing?.sourceExhausted
        ? "all_public_owner_repositories_exhausted"
        : "owner_repository_enumeration_incomplete",
    repositoriesCollected: repositories.length,
    repositoryStreams: countRepositoryStreams(repositories),
    attributionReviewRequired: target.requiresAttributionReview,
    coverageExtent: {
      releases: "all_public_releases_paginated_until_source_exhaustion_or_exact_blocker",
      tags: "all_public_tag_refs_paginated_until_source_exhaustion_or_exact_blocker",
      commits: "default_branch_commits_within_explicit_activity_window;fork_history_not_attributed",
      nonPublicData: "rejected"
    }
  };
}

function countRepositoryStreams(repositories) {
  const result = {
    releases: { complete: 0, blocked: 0 },
    tags: { complete: 0, blocked: 0 },
    commits: { complete: 0, blocked: 0, notApplicable: 0 }
  };
  for (const repository of repositories) {
    for (const [resource, scope] of Object.entries(repository.streams ?? {})) {
      if (scope.status === "complete") result[resource].complete += 1;
      else if (scope.status === "blocked") result[resource].blocked += 1;
      else if (scope.status === "not_applicable") result[resource].notApplicable += 1;
    }
  }
  return result;
}

function githubBlocker(error, overrideCode = null, endpoint = null) {
  if (error instanceof GithubCollectionPause) return error.blocker;
  const receipt = githubApiFailureReceipt(error);
  const code = overrideCode ?? receipt.failureReason ?? "github_unknown_error";
  const credentialRequired = receipt.httpStatus === 401 || receipt.httpStatus === 407;
  return {
    code,
    provider: "github_rest_api",
    message: receipt.error,
    endpoint: endpoint ?? (receipt.endpoint ? { pathname: receipt.endpoint, query: {} } : null),
    httpStatus: receipt.httpStatus,
    rateLimitRemaining: receipt.rateLimitRemaining,
    retryAt: receipt.rateLimitResetAt,
    retryable: receipt.retryable === true,
    credentialRequired,
    nextAction: code === "github_rate_limit_exhausted"
      ? "Resume after the recorded GitHub rate-limit reset; do not increase concurrency."
      : credentialRequired
        ? "Queue approved GitHub API credential review; never use a signed-in browser session."
        : receipt.retryable
          ? "Resume the exact checkpoint after the provider or network condition recovers."
          : "Record the exact target for manual review before changing its canonical mapping."
  };
}

function isGithubStatus(error, status) {
  return error instanceof GitHubApiError && error.httpStatus === status;
}

function safeNextUrl(headers, currentUrl) {
  const next = githubNextLink(headers?.get?.("link"), currentUrl);
  return next ? assertSafeGithubApiUrl(next) : null;
}

function assertSafeGithubApiUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (url.origin !== API_ORIGIN) {
    throw new Error(`Refusing GitHub API URL outside ${API_ORIGIN}: ${url.origin}.`);
  }
  for (const key of url.searchParams.keys()) {
    if (!SAFE_QUERY_PARAMETERS.has(key)) {
      throw new Error(`Refusing unrecognized GitHub API query parameter: ${key}.`);
    }
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  return url.href;
}

function assertUnvisitedPage(scope, url) {
  const digest = sha256(stableJson(safeGithubEndpointDescriptor(url)));
  if (scope.seenPageDigests.includes(digest)) {
    throw new Error(`GitHub pagination cycle detected at ${safeGithubEndpointDescriptor(url).pathname}.`);
  }
}

function rateLimitReceipt(headers) {
  return {
    resource: clean(headers?.get?.("x-ratelimit-resource")) || null,
    limit: numericHeader(headers, "x-ratelimit-limit"),
    remaining: numericHeader(headers, "x-ratelimit-remaining"),
    used: numericHeader(headers, "x-ratelimit-used"),
    resetAt: epochSecondsTimestamp(headers?.get?.("x-ratelimit-reset")),
    retryAfterSeconds: numericHeader(headers, "retry-after")
  };
}

class GithubCheckpointStore {
  static async open(outputDir, options) {
    const store = new GithubCheckpointStore(outputDir, options);
    await store.initialize();
    return store;
  }

  constructor(outputDir, { config, configFingerprint, plan, resume, now }) {
    this.outputDir = outputDir;
    this.journalPath = join(outputDir, "events.ndjson");
    this.checkpointPath = join(outputDir, "checkpoint-current.json");
    this.summaryPath = join(outputDir, "summary.json");
    this.config = config;
    this.configFingerprint = configFingerprint;
    this.plan = plan;
    this.resume = resume;
    this.now = now;
    this.writeTail = Promise.resolve();
    this.writeFailure = null;
    this.state = null;
  }

  async initialize() {
    await mkdir(this.outputDir, { recursive: true });
    const checkpoint = await readJsonIfExists(this.checkpointPath);
    const journalExists = await fileExists(this.journalPath);
    if (!this.resume && (checkpoint || journalExists)) {
      throw new Error(`GitHub backfill output exists at ${this.outputDir}; use --resume or a new directory.`);
    }
    if (this.resume && !checkpoint) {
      throw new Error(`No resumable GitHub backfill exists at ${this.outputDir}.`);
    }
    if (journalExists) await repairTruncatedNdjsonTail(this.journalPath);
    const journalAudit = journalExists
      ? await scanGithubJournal(this.journalPath)
      : { lastSequence: 0, requests: emptyRequestCounters() };
    const lastSequence = journalAudit.lastSequence;
    const startedAt = checkpoint?.startedAt ?? this.now().toISOString();
    this.state = checkpoint ?? {
      schemaVersion: GITHUB_EXHAUSTIVE_SCHEMA_VERSION,
      runnerVersion: GITHUB_EXHAUSTIVE_RUNNER_VERSION,
      config: this.config,
      configFingerprint: this.configFingerprint,
      planSummary: publicPlanSummary(this.plan),
      startedAt,
      updatedAt: startedAt,
      lastSequence,
      requests: emptyRequestCounters(),
      targets: {},
      completed: {}
    };
    this.state.lastSequence = Math.max(this.state.lastSequence ?? 0, lastSequence);
    this.state.requests = journalAudit.requests;
    if (this.state.configFingerprint !== this.configFingerprint) {
      throw new Error("GitHub backfill resume configuration or canonical mapping plan changed.");
    }
    if (!journalExists || (await stat(this.journalPath)).size === 0) {
      await this.commit(null, {
        type: "run_initialized",
        config: this.config,
        configFingerprint: this.configFingerprint,
        planSummary: publicPlanSummary(this.plan)
      }, () => {});
    } else {
      await this.writeCheckpoint();
    }
  }

  targetState(targetKey) {
    return this.state.targets[targetKey] ?? null;
  }

  isTerminal(targetKey) {
    return Boolean(this.state.completed[targetKey]);
  }

  async beginTarget(target) {
    if (!this.state.targets[target.targetKey]) {
      await this.commit(target.targetKey, {
        type: "target_started",
        targetKey: target.targetKey,
        accountUrl: target.accountUrl,
        scope: target.scope,
        attributionTaskKeys: target.attributions.map((row) => row.taskKey)
      }, (draft) => {
        draft.targets[target.targetKey] = {
          status: "in_progress",
          profile: null,
          repositoryListing: target.repo ? { ...freshScope(null), status: "complete" } : null,
          repositories: {},
          blocker: null
        };
      });
    } else if (this.state.targets[target.targetKey].status === "paused") {
      await this.commit(target.targetKey, {
        type: "target_resumed",
        targetKey: target.targetKey
      }, (draft) => {
        draft.targets[target.targetKey].status = "in_progress";
        draft.targets[target.targetKey].blocker = null;
      });
    }
    return this.targetState(target.targetKey);
  }

  async recordRequest(receipt) {
    await this.commit(null, { type: "request_receipt", receipt }, (draft) => {
      addRequestCounters(draft.requests, receipt);
    }, { checkpoint: false });
  }

  async pauseTarget(target, blocker) {
    await this.commit(target.targetKey, {
      type: "target_paused",
      targetKey: target.targetKey,
      blocker
    }, (draft) => {
      const state = draft.targets[target.targetKey] ?? {
        profile: null,
        repositoryListing: null,
        repositories: {}
      };
      state.status = "paused";
      state.blocker = blocker;
      draft.targets[target.targetKey] = state;
    });
  }

  async completeTarget(target, receipt) {
    await this.commit(target.targetKey, {
      type: "target_completed",
      targetKey: target.targetKey,
      receipt
    }, (draft) => {
      const state = draft.targets[target.targetKey] ?? {
        profile: null,
        repositoryListing: null,
        repositories: {}
      };
      state.status = "terminal";
      state.blocker = receipt.blocker;
      draft.targets[target.targetKey] = state;
      draft.completed[target.targetKey] = receipt;
    });
  }

  async finish(summary) {
    await this.commit(null, { type: "run_invocation_finished", summary }, (draft) => {
      draft.lastSummary = summary;
      draft.status = summary.status;
    });
    await atomicJsonWrite(this.summaryPath, summary);
  }

  async commit(_targetKey, payload, mutate, { checkpoint = true } = {}) {
    const operation = async () => {
      if (this.writeFailure) throw this.writeFailure;
      const event = {
        schemaVersion: GITHUB_EXHAUSTIVE_SCHEMA_VERSION,
        sequence: this.state.lastSequence + 1,
        recordedAt: this.now().toISOString(),
        ...payload
      };
      await appendFile(this.journalPath, `${JSON.stringify(event)}\n`, "utf8");
      this.state.lastSequence = event.sequence;
      this.state.updatedAt = event.recordedAt;
      mutate(this.state);
      if (checkpoint) await this.writeCheckpoint();
      return event;
    };
    const promise = this.writeTail.then(operation);
    this.writeTail = promise.catch((error) => {
      this.writeFailure ??= error;
    });
    return promise;
  }

  writeCheckpoint() {
    return atomicJsonWrite(this.checkpointPath, this.state);
  }
}

function buildSummary(plan, state, { activitySince, activityUntil, limits, completedAt, httpAttemptsThisInvocation }) {
  const completed = Object.values(state.completed ?? {});
  const paused = Object.entries(state.targets ?? {}).filter(([, target]) => target.status === "paused");
  const byOutcome = countBy(completed, (row) => row.outcome);
  const attributionOutcomes = {};
  for (const receipt of completed) {
    for (const taskKey of receipt.attributionTaskKeys ?? []) attributionOutcomes[taskKey] = receipt.outcome;
  }
  const byBatch = {};
  for (const task of plan.attributionTasks) {
    byBatch[task.batchSlug] ??= {
      attributionTasks: 0,
      terminal: 0,
      collected: 0,
      accessBlocked: 0,
      manualReview: 0,
      queuedForResume: 0
    };
    const row = byBatch[task.batchSlug];
    row.attributionTasks += 1;
    const outcome = attributionOutcomes[task.taskKey];
    if (outcome) {
      row.terminal += 1;
      if (outcome === "collected") row.collected += 1;
      else if (outcome === "access_blocked") row.accessBlocked += 1;
      else if (outcome === "manual_review") row.manualReview += 1;
    } else {
      row.queuedForResume += 1;
    }
  }
  const terminalAttributionTasks = Object.keys(attributionOutcomes).length;
  return {
    schemaVersion: GITHUB_EXHAUSTIVE_SCHEMA_VERSION,
    runnerVersion: GITHUB_EXHAUSTIVE_RUNNER_VERSION,
    planHash: plan.planHash,
    status: completed.length === plan.physicalTargets ? "completed" : "incomplete_resumable",
    startedAt: state.startedAt,
    completedAt,
    activityWindow: { since: activitySince, until: activityUntil },
    companiesEvaluated: plan.companiesEvaluated,
    foundersEvaluated: plan.foundersEvaluated,
    canonicalOwnersEvaluated: plan.canonicalOwnersEvaluated,
    verifiedAttributionTasks: plan.verifiedAttributionTasks,
    terminalAttributionTasks,
    physicalTargets: plan.physicalTargets,
    terminalPhysicalTargets: completed.length,
    pausedPhysicalTargets: paused.length,
    byOutcome,
    byBatch,
    requests: state.requests,
    httpAttemptsThisInvocation,
    limits: {
      globalConcurrency: limits.globalConcurrency,
      requestTimeoutMs: limits.requestTimeoutMs,
      requestAttempts: limits.requestAttempts,
      maxHttpAttemptsPerRun: limits.maxHttpAttemptsPerRun,
      perPage: limits.perPage
    },
    technicalLimits: {
      releases: "GitHub REST exposes public releases; drafts visible through token scopes are rejected.",
      tags: "GitHub REST tag listings do not expose a native publication timestamp for lightweight tags.",
      commits: "Only default-branch commits inside the explicit activity window are collected; fork history is not attributed as owner activity.",
      deletionsAndPrivateHistory: "Deleted, private, internal, legally withheld, and API-inaccessible history cannot be recovered from the public REST API.",
      dynamicEnumeration: "Repository listings are exhausted through Link pagination, but GitHub does not provide an immutable cross-page snapshot."
    },
    artifacts: {
      journal: "events.ndjson",
      checkpoint: "checkpoint-current.json",
      summary: "summary.json"
    }
  };
}

/**
 * External-memory journal materializer. Evidence is hash-partitioned on disk,
 * deduped by stable physical id, and emitted as deterministic NDJSON. Identity
 * conflicts are withheld in a separate quarantine artifact.
 */
export async function materializeGithubExhaustiveJournal({
  journalPath,
  outputDir,
  partitions = 128,
  maxPartitionRecords = 100_000
} = {}) {
  if (!journalPath || !outputDir) throw new Error("journalPath and outputDir are required.");
  if (!Number.isInteger(partitions) || partitions < 2 || partitions > 4096) {
    throw new Error("partitions must be an integer between 2 and 4096.");
  }
  if (!Number.isInteger(maxPartitionRecords) || maxPartitionRecords < 100) {
    throw new Error("maxPartitionRecords must be at least 100.");
  }
  await mkdir(outputDir, { recursive: true });
  const tempDir = await mkdtemp(join(resolve(outputDir), ".github-materialize-"));
  const partitionPaths = Array.from({ length: partitions }, (_, index) =>
    join(tempDir, `partition-${String(index).padStart(4, "0")}.ndjson`)
  );
  let rawEvidenceRows = 0;
  try {
    const lines = createInterface({
      input: createReadStream(resolve(journalPath), { encoding: "utf8" }),
      crlfDelay: Infinity
    });
    let lastSequence = 0;
    let initialized = false;
    let configFingerprint = null;
    for await (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.schemaVersion !== GITHUB_EXHAUSTIVE_SCHEMA_VERSION) {
        throw new Error(`GitHub materialization journal has unsupported schema at sequence ${event.sequence ?? "unknown"}.`);
      }
      if (!Number.isInteger(event.sequence) || event.sequence !== lastSequence + 1) {
        throw new Error(`GitHub materialization journal sequence is not contiguous after ${lastSequence}.`);
      }
      lastSequence = event.sequence;
      if (event.type === "run_initialized") {
        if (initialized || !clean(event.configFingerprint)) {
          throw new Error("GitHub materialization journal has an invalid run initialization receipt.");
        }
        initialized = true;
        configFingerprint = event.configFingerprint;
      }
      for (const evidence of event.evidence ?? []) {
        if (!clean(evidence?.evidenceId)) continue;
        if (evidence.scoringEligible !== false || evidence.publicationState !== "stored_but_unpublished") {
          throw new Error(
            `GitHub materialization refuses evidence ${evidence.evidenceId} without stored-but-unpublished scoring gates.`
          );
        }
        const partition = parseInt(sha256(evidence.evidenceId).slice(0, 8), 16) % partitions;
        await appendFile(partitionPaths[partition], `${JSON.stringify(evidence)}\n`, "utf8");
        rawEvidenceRows += 1;
      }
    }
    if (!initialized) throw new Error("GitHub materialization journal is missing run_initialized.");

    const evidenceTemp = join(tempDir, "evidence.ndjson");
    const quarantineTemp = join(tempDir, "quarantine.ndjson");
    let evidenceRows = 0;
    let quarantineRows = 0;
    let duplicates = 0;
    for (const partitionPath of partitionPaths) {
      if (!(await fileExists(partitionPath))) continue;
      const records = new Map();
      const partitionLines = createInterface({
        input: createReadStream(partitionPath, { encoding: "utf8" }),
        crlfDelay: Infinity
      });
      let rowsInPartition = 0;
      for await (const line of partitionLines) {
        if (!line.trim()) continue;
        rowsInPartition += 1;
        if (rowsInPartition > maxPartitionRecords) {
          throw new Error(
            `Materialization partition exceeded ${maxPartitionRecords} rows; rerun with more partitions.`
          );
        }
        const candidate = JSON.parse(line);
        const previous = records.get(candidate.evidenceId);
        if (!previous) {
          records.set(candidate.evidenceId, { evidence: candidate, conflicts: [] });
          continue;
        }
        duplicates += 1;
        if (evidenceIdentity(previous.evidence) !== evidenceIdentity(candidate)) {
          previous.conflicts.push(candidate);
          continue;
        }
        previous.evidence = mergeEvidenceVersions(previous.evidence, candidate);
      }
      for (const [evidenceId, record] of [...records].sort(([left], [right]) => left.localeCompare(right))) {
        if (record.conflicts.length > 0) {
          const versions = [record.evidence, ...record.conflicts]
            .map((row) => ({
              kind: row.kind,
              nativeId: row.nativeId,
              canonicalUrl: row.canonicalUrl,
              observedAt: row.observedAt
            }))
            .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
          await appendFile(quarantineTemp, `${JSON.stringify({
            quarantineId: `github-evidence-conflict:${sha256(evidenceId).slice(0, 24)}`,
            evidenceId,
            reason: "github_physical_identity_conflict",
            scoringEligible: false,
            versions
          })}\n`, "utf8");
          quarantineRows += 1;
        } else {
          await appendFile(evidenceTemp, `${JSON.stringify(record.evidence)}\n`, "utf8");
          evidenceRows += 1;
        }
      }
    }
    if (!(await fileExists(evidenceTemp))) await writeFile(evidenceTemp, "", "utf8");
    if (!(await fileExists(quarantineTemp))) await writeFile(quarantineTemp, "", "utf8");
    const evidencePath = join(resolve(outputDir), "evidence-deduped.ndjson");
    const quarantinePath = join(resolve(outputDir), "evidence-quarantine.ndjson");
    await rename(evidenceTemp, evidencePath);
    await rename(quarantineTemp, quarantinePath);
    const summary = {
      schemaVersion: GITHUB_EXHAUSTIVE_SCHEMA_VERSION,
      materializerVersion: GITHUB_EXHAUSTIVE_RUNNER_VERSION,
      journalPath: resolve(journalPath),
      journalSha256: await sha256File(resolve(journalPath)),
      journalLastSequence: lastSequence,
      configFingerprint,
      rawEvidenceRows,
      evidenceRows,
      quarantinedPhysicalIdentities: quarantineRows,
      duplicateRowsMerged: duplicates,
      partitions,
      artifacts: {
        evidence: basename(evidencePath),
        evidenceSha256: await sha256File(evidencePath),
        quarantine: basename(quarantinePath),
        quarantineSha256: await sha256File(quarantinePath)
      }
    };
    await atomicJsonWrite(join(resolve(outputDir), "materialization-summary.json"), summary);
    return summary;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function mergeEvidenceVersions(left, right) {
  const candidate = laterEvidence(left, right);
  const attributions = new Map();
  for (const attribution of [...(left.attributions ?? []), ...(right.attributions ?? [])]) {
    attributions.set(attribution.taskKey, attribution);
  }
  return {
    ...candidate,
    attributions: [...attributions.values()].sort(compareAttributions),
    requiresAttributionReview: left.requiresAttributionReview || right.requiresAttributionReview ||
      attributions.size > 1
  };
}

function laterEvidence(left, right) {
  const leftTime = Date.parse(left.observedAt ?? "") || 0;
  const rightTime = Date.parse(right.observedAt ?? "") || 0;
  if (leftTime !== rightTime) return rightTime > leftTime ? right : left;
  return stableJson(right) > stableJson(left) ? right : left;
}

function evidenceIdentity(row) {
  return stableJson({
    evidenceId: row.evidenceId,
    kind: row.kind,
    nativeId: row.nativeId,
    canonicalUrl: row.canonicalUrl,
    repositoryId: row.physicalRepository?.repositoryId
  });
}

function addAttributionTask(tasks, { batchSlug, entity, rawUrl, provenance }) {
  const accountUrl = canonicalGithubTargetUrl(rawUrl);
  const parsed = parseGithubTargetUrl(accountUrl);
  if (!accountUrl || !parsed) {
    throw new Error(`Invalid verified GitHub account URL for ${batchSlug}:${entity.sourceKey}: ${rawUrl}.`);
  }
  const taskKey = [
    batchSlug,
    entity.entityType,
    entity.sourceKey,
    accountUrl.toLowerCase()
  ].join(":");
  const existing = tasks.get(taskKey) ?? {
    taskKey,
    batchSlug,
    entityType: entity.entityType,
    entityId: entity.sourceKey,
    entityName: entity.name,
    companySourceKey: entity.companySourceKey ?? (entity.entityType === "company" ? entity.sourceKey : null),
    accountUrl,
    login: parsed.login,
    repo: parsed.repo,
    provenance: []
  };
  if (!existing.provenance.some((row) => stableJson(row) === stableJson(provenance))) {
    existing.provenance.push(provenance);
  }
  tasks.set(taskKey, existing);
}

function indexEntity(index, batchSlug, entity) {
  const key = `${batchSlug}:${entity.entityType}:${entity.sourceKey}`;
  if (!entity.sourceKey || !entity.entityType || index.has(key)) {
    throw new Error(`Duplicate or invalid canonical entity ${key}.`);
  }
  index.set(key, entity);
}

function githubPhysicalTargetKey(rawUrl) {
  const canonical = canonicalGithubTargetUrl(rawUrl);
  if (!canonical) throw new Error(`Invalid GitHub physical target URL: ${rawUrl}.`);
  return `github:${canonical.toLowerCase()}`;
}

function compareAttributions(left, right) {
  return String(left.taskKey).localeCompare(String(right.taskKey));
}

function compareProvenance(left, right) {
  return stableJson(left).localeCompare(stableJson(right));
}

function normalizeBatches(value) {
  const requested = value == null
    ? [...GITHUB_EXHAUSTIVE_BATCHES]
    : (Array.isArray(value) ? value : String(value).split(","))
        .map((batch) => String(batch).trim().toUpperCase())
        .filter(Boolean);
  const unique = [...new Set(requested)];
  const invalid = unique.filter((batch) => !GITHUB_EXHAUSTIVE_BATCHES.includes(batch));
  if (invalid.length > 0) throw new Error(`Unsupported GitHub batch(es): ${invalid.join(", ")}.`);
  if (unique.length === 0) throw new Error("At least one GitHub batch is required.");
  return GITHUB_EXHAUSTIVE_BATCHES.filter((batch) => unique.includes(batch));
}

function portableCatalogPath(catalog) {
  const sourcePath = clean(catalog?.sourcePath).replaceAll("\\", "/");
  for (const marker of ["/src/", "/public/"]) {
    const index = sourcePath.lastIndexOf(marker);
    if (index >= 0) return sourcePath.slice(index + 1);
  }
  if (catalog?.catalogFile) return catalog.catalogFile;
  if (catalog?.graphFile) {
    return String(catalog.graphFile).includes("/")
      ? catalog.graphFile
      : `public/graph/${catalog.graphFile}`;
  }
  return sourcePath || null;
}

function normalizeLimits(overrides = {}) {
  const limits = { ...GITHUB_EXHAUSTIVE_LIMITS, ...(overrides ?? {}) };
  for (const [key, raw] of Object.entries(limits)) {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) throw new Error(`${key} must be a positive integer.`);
    limits[key] = value;
  }
  if (limits.globalConcurrency > 4) {
    throw new Error("GitHub exhaustive globalConcurrency cannot exceed the safe maximum of 4.");
  }
  if (limits.requestAttempts > 3) throw new Error("GitHub requestAttempts cannot exceed 3.");
  if (limits.perPage > 100) throw new Error("GitHub perPage cannot exceed the API maximum of 100.");
  return limits;
}

async function fileManifestEntry(root, rawPath, kind) {
  const absolutePath = resolve(root, rawPath);
  const path = absolutePath.startsWith(`${resolve(root)}/`)
    ? absolutePath.slice(resolve(root).length + 1)
    : absolutePath;
  const bytes = await readFile(absolutePath);
  return {
    kind,
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length
  };
}

function publicPlanSummary(plan) {
  return {
    planHash: plan.planHash,
    companiesEvaluated: plan.companiesEvaluated,
    foundersEvaluated: plan.foundersEvaluated,
    canonicalOwnersEvaluated: plan.canonicalOwnersEvaluated,
    verifiedAttributionTasks: plan.verifiedAttributionTasks,
    physicalTargets: plan.physicalTargets,
    ownerTargets: plan.ownerTargets,
    exactRepositoryTargets: plan.exactRepositoryTargets,
    multiAttributionReviews: plan.multiAttributionReviews,
    batches: plan.batches
  };
}

async function readCheckpointConfig(outputDir) {
  const checkpoint = await readJsonIfExists(join(outputDir, "checkpoint-current.json"));
  if (!checkpoint?.config) throw new Error(`No checkpoint configuration found in ${outputDir}.`);
  return checkpoint.config;
}

async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function repairTruncatedNdjsonTail(path) {
  const handle = await open(path, "r+");
  try {
    const info = await handle.stat();
    if (info.size === 0) return false;
    const readSize = Math.min(info.size, 64 * 1024);
    const buffer = Buffer.alloc(readSize);
    await handle.read(buffer, 0, readSize, info.size - readSize);
    const text = buffer.toString("utf8");
    if (text.endsWith("\n")) return false;
    const lastNewline = text.lastIndexOf("\n");
    const truncateAt = lastNewline < 0 ? 0 : info.size - readSize + Buffer.byteLength(text.slice(0, lastNewline + 1));
    await handle.truncate(truncateAt);
    return true;
  } finally {
    await handle.close();
  }
}

async function scanGithubJournal(path) {
  let sequence = 0;
  const requests = emptyRequestCounters();
  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity
  });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    if (!Number.isInteger(event.sequence) || event.sequence <= sequence) {
      throw new Error(`GitHub backfill journal sequence is invalid after ${sequence}.`);
    }
    sequence = event.sequence;
    if (event.type === "request_receipt") addRequestCounters(requests, event.receipt);
  }
  return { lastSequence: sequence, requests };
}

function emptyRequestCounters() {
  return { logical: 0, httpAttempts: 0, succeeded: 0, failed: 0, blockedWithoutRequest: 0 };
}

function addRequestCounters(counters, receipt) {
  counters.logical += 1;
  counters.httpAttempts += receipt?.attempts?.length ?? 0;
  if (receipt?.status === "succeeded") counters.succeeded += 1;
  else if (receipt?.status === "blocked_without_request") counters.blockedWithoutRequest += 1;
  else counters.failed += 1;
}

async function atomicJsonWrite(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function runWorkerPool(items, concurrency, worker) {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(items.length, concurrency) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  });
  await Promise.all(workers);
}

function countBy(rows, key) {
  const result = {};
  for (const row of rows) {
    const value = key(row);
    result[value] = (result[value] ?? 0) + 1;
  }
  return result;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function numericHeader(headers, name) {
  const value = Number(headers?.get?.(name));
  return Number.isFinite(value) ? value : null;
}

function epochSecondsTimestamp(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return new Date(seconds * 1000).toISOString();
}

function canonicalTimestamp(value, label) {
  const timestamp = validTimestamp(value);
  if (!timestamp) throw new Error(`${label} must be a valid timestamp.`);
  return timestamp;
}

function validTimestamp(value) {
  const time = Date.parse(value ?? "");
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function safeErrorCode(error) {
  const code = error?.cause?.code ?? error?.code;
  return /^[A-Z0-9_-]{1,40}$/.test(String(code ?? "")) ? String(code) : null;
}

function redactSecret(value, secret) {
  const text = String(value ?? "");
  if (!secret) return text;
  return text.split(String(secret)).join("[REDACTED]");
}

function causedBy(error, Constructor) {
  return Boolean(findCause(error, Constructor));
}

function findCause(error, Constructor) {
  const seen = new Set();
  let current = error;
  while (current && !seen.has(current)) {
    if (current instanceof Constructor) return current;
    seen.add(current);
    current = current.cause;
  }
  return null;
}

function clean(value) {
  return String(value ?? "").trim();
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])])
  );
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
