import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { readRequiredCanonicalJson } from "./lib/canonical-json.mjs";

const root = process.cwd();
const batchConfig = resolveBatchConfig(stringArg("--batch") ?? stringArg("--batch-slug") ?? "S26");
const outputPath = resolveOutputPath(stringArg("--output") ?? stringArg("--out") ?? batchConfig.outputPath);
const apiBase = "https://api.github.com";
const workers = Math.max(1, Math.min(numberArg("--workers") ?? 6, 16));
const searchWorkers = Math.max(1, Math.min(numberArg("--search-workers") ?? 1, 4));
const companyLimit = numberArg("--max-companies") ?? Number.POSITIVE_INFINITY;
const maxSearches = numberArg("--max-searches") ?? 80;
const enableWebsiteDiscovery = hasArg("--no-website") ? false : hasArg("--website") || batchConfig.defaultWebsiteDiscovery;
const enableSearchDiscovery = hasArg("--no-search") ? false : hasArg("--search") || batchConfig.defaultSearchDiscovery;
const planOnly = hasArg("--plan");
const verifiedSocialOverridesPath = join(root, "src", "lib", "social", "verified-social-overrides.json");

const rawSnapshot = await batchConfig.loadSnapshot();
const verifiedSocialOverrides = await readRequiredCanonicalJson(
  verifiedSocialOverridesPath,
  "Verified social overrides"
);
const snapshot = {
  ...rawSnapshot,
  companies: mergeVerifiedGithubOverrides(rawSnapshot.companies, verifiedSocialOverrides)
};
const companies = snapshot.companies.slice(0, companyLimit);
const owners = collectGithubOwners(companies);
const explicitTargets = collectExplicitGithubTargets(companies);
const discovery = planOnly
  ? { targets: [], websiteTargets: 0, profileTargets: 0, searchTargets: 0, searchesUsed: 0, searchFailures: [], sourceChecks: [], reviewCandidates: [] }
  : await discoverGithubTargets(companies, explicitTargets, owners);
const githubTargets = dedupeTargets([...explicitTargets, ...discovery.targets]);
if (planOnly) {
  await writeStdout(`${JSON.stringify({
    batchSlug: batchConfig.slug,
    sourcePath: batchConfig.sourcePath,
    companyCount: companies.length,
    targets: githubTargets
  }, null, 2)}\n`);
  process.exit(0);
}
console.log(
  `GitHub targets for ${batchConfig.slug}: ${githubTargets.length} (${explicitTargets.length} explicit, ${discovery.targets.length} discovered, ${discovery.searchesUsed} searches).`
);

const results = [];
await runWorkerPool(githubTargets, workers, async (target) => {
  try {
    const account = await fetchJson(`${apiBase}/users/${target.login}`);
    const repos = target.repo
      ? [await fetchJson(`${apiBase}/repos/${target.login}/${target.repo}`)]
      : await fetchJson(`${apiBase}/users/${target.login}/repos?sort=updated&per_page=100&type=owner`);
    results.push(normalizeTarget(target, account, repos));
    console.log(`Fetched GitHub traction for ${target.companyName}: ${target.login}${target.repo ? `/${target.repo}` : ""}`);
  } catch (error) {
    results.push({
      ...target,
      fetched: false,
      error: errorMessage(error)
    });
    console.warn(`GitHub fetch failed for ${target.login}${target.repo ? `/${target.repo}` : ""}: ${errorMessage(error)}`);
  }
});

const payload = {
  source: {
    label: batchConfig.sourceLabel,
    batchSlug: batchConfig.slug,
    batchLabel: batchConfig.label,
    sourcePath: batchConfig.sourcePath,
    fetchedAt: new Date().toISOString(),
    targetCount: githubTargets.length,
    fetchedCount: results.filter((result) => result.fetched).length,
    activeAccountMappings: owners.flatMap((owner) => owner.mappedUrls.map((url) => ({
      entityType: owner.entityType,
      entityId: owner.entityId,
      url
    }))),
    retiredAccountMappings: owners.flatMap((owner) => owner.retiredUrls.map((url) => ({
      entityType: owner.entityType,
      entityId: owner.entityId,
      url
    }))),
    discovery: {
      explicitTargetCount: explicitTargets.length,
      discoveredTargetCount: discovery.targets.length,
      websiteTargets: discovery.websiteTargets,
      profileTargets: discovery.profileTargets,
      officialSourceChecks: discovery.sourceChecks.length,
      sourceChecks: discovery.sourceChecks,
      searchTargets: discovery.searchTargets,
      searchConcurrency: searchWorkers,
      searchesUsed: discovery.searchesUsed,
      searchFailures: discovery.searchFailures
    },
    notes: batchConfig.notes
  },
  attempts: githubOwnerAttempts(owners, results, discovery),
  accounts: results.sort((a, b) => (b.aggregate?.profileScore ?? 0) - (a.aggregate?.profileScore ?? 0))
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`Wrote ${outputPath}`);

function collectExplicitGithubTargets(companies) {
  const targets = [];

  for (const company of companies) {
    for (const companyGithubUrl of githubUrlsForOwner(company)) {
      targets.push({
        entityType: "company",
        entityId: batchConfig.companyId(company),
        companySlug: company.slug,
        companyName: company.name,
        name: company.name,
        sourceUrl: batchConfig.companyProfileUrl(company),
        githubUrl: companyGithubUrl,
        discoverySource: batchConfig.explicitDiscoverySource,
        matchReason: batchConfig.explicitCompanyMatchReason,
        ...parseGithubUrl(companyGithubUrl)
      });
    }

    for (const founder of company.founders ?? []) {
      for (const founderGithubUrl of githubUrlsForOwner(founder)) {
        targets.push({
          entityType: "founder",
          entityId: batchConfig.founderId(company, founder),
          companySlug: company.slug,
          companyName: company.name,
          name: founder.name,
          sourceUrl: batchConfig.founderProfileUrl(company, founder),
          githubUrl: founderGithubUrl,
          discoverySource: batchConfig.explicitDiscoverySource,
          matchReason: batchConfig.explicitFounderMatchReason,
          ...parseGithubUrl(founderGithubUrl)
        });
      }
    }
  }

  return targets.filter((target) => target.login);
}

function collectGithubOwners(companies) {
  return companies.flatMap((company) => [
    {
      entityType: "company",
      entityId: batchConfig.companyId(company),
      entityName: company.name,
      companySlug: company.slug,
      companyName: company.name,
      profileUrl: batchConfig.companyProfileUrl(company),
      websiteUrl: company.websiteUrl ?? null,
      mappedUrls: githubUrlsForOwner(company),
      retiredUrls: (company.retiredGithub ?? []).map((record) => record.url)
    },
    ...(company.founders ?? []).map((founder) => ({
      entityType: "founder",
      entityId: batchConfig.founderId(company, founder),
      entityName: founder.name,
      companySlug: company.slug,
      companyName: company.name,
      // Some manually verified founders do not have a standalone accelerator
      // profile. Keep the discovery attempt real by scanning their verified
      // source first, then the company's official profile/site as a bounded
      // fallback. githubOwnerAttempts only reports sources actually fetched.
      profileUrl: batchConfig.founderProfileUrl(company, founder)
        ?? founder.sourceUrl
        ?? batchConfig.companyProfileUrl(company),
      websiteUrl: founder.websiteUrl ?? company.websiteUrl ?? null,
      mappedUrls: githubUrlsForOwner(founder),
      retiredUrls: (founder.retiredGithub ?? []).map((record) => record.url)
    }))
  ]);
}

function githubOwnerAttempts(owners, results, discovery) {
  const rows = {};
  const resultsByOwner = new Map();
  for (const result of results) {
    resultsByOwner.set(result.entityId, [...(resultsByOwner.get(result.entityId) ?? []), result]);
  }
  const reviewByOwner = new Map();
  for (const candidate of discovery.reviewCandidates ?? []) {
    reviewByOwner.set(candidate.entityId, [...(reviewByOwner.get(candidate.entityId) ?? []), candidate]);
  }
  const checksByOwner = new Map();
  for (const check of discovery.sourceChecks ?? []) {
    checksByOwner.set(check.entityId, [...(checksByOwner.get(check.entityId) ?? []), check]);
  }
  for (const owner of owners) {
    const ownerResults = resultsByOwner.get(owner.entityId) ?? [];
    const reviewCandidates = reviewByOwner.get(owner.entityId) ?? [];
    const sourceChecks = checksByOwner.get(owner.entityId) ?? [];
    const successfulSourceChecks = sourceChecks.filter((check) =>
      ["checked_empty", "found_candidates"].includes(check.status)
    );
    const mapped = owner.mappedUrls.length > 0;
    let outcomeStatus = "failed";
    let outcomeReason = mapped
      ? "collector_returned_no_account_attempt"
      : "collector_returned_no_owner_source_attempt";
    if (ownerResults.some((result) => result.fetched === true)) {
      outcomeStatus = "completed";
      outcomeReason = "collector_account_fetched";
    } else if (reviewCandidates.length) {
      outcomeStatus = "needs_review";
      outcomeReason = "collector_discovery_candidate_needs_review";
    } else if (ownerResults.some((result) => result.fetched === false)) {
      outcomeStatus = "failed";
      outcomeReason = "collector_reported_failure";
    } else if (successfulSourceChecks.length) {
      outcomeStatus = "blocked_or_empty";
      outcomeReason = "collector_official_sources_checked_empty_or_blocked";
    }
    rows[`${owner.entityType}:${owner.entityId}`] = {
      platform: "github",
      entityType: owner.entityType,
      entityId: owner.entityId,
      entityName: owner.entityName,
      companySlug: owner.companySlug,
      companyName: owner.companyName,
      profileUrl: owner.profileUrl,
      websiteUrl: owner.websiteUrl,
      mappedAccountCount: owner.mappedUrls.length,
      checkedSources: sourceChecks.map((check) => ({
        sourceKind: check.sourceKind,
        sourceUrl: check.sourceUrl,
        status: check.status,
        error: check.error
      })),
      successfulSourceCheckCount: successfulSourceChecks.length,
      failedSourceCheckCount: sourceChecks.length - successfulSourceChecks.length,
      status: "done",
      outcomeStatus,
      outcomeReason,
      reviewCandidates: reviewCandidates.map((candidate) => candidate.githubUrl),
      checkedAt: new Date().toISOString()
    };
  }
  return rows;
}

async function discoverGithubTargets(companies, explicitTargets, owners) {
  const targets = [];
  const explicitCompanySlugs = new Set(explicitTargets.filter((target) => target.entityType === "company").map((target) => target.companySlug));
  const stats = {
    targets,
    reviewCandidates: [],
    websiteTargets: 0,
    profileTargets: 0,
    searchTargets: 0,
    searchesUsed: 0,
    searchFailures: [],
    sourceChecks: []
  };

  const ownerById = new Map(owners.map((owner) => [owner.entityId, owner]));
  const missingOwners = owners.filter((owner) => owner.mappedUrls.length === 0);
  await runWorkerPool(missingOwners, workers, async (owner) => {
    const sources = [
      owner.profileUrl ? { kind: "official_profile", url: owner.profileUrl } : null,
      enableWebsiteDiscovery && owner.websiteUrl ? { kind: "official_website", url: owner.websiteUrl } : null
    ].filter(Boolean);
    const seenSources = new Set();
    for (const source of sources) {
      if (seenSources.has(source.url)) continue;
      seenSources.add(source.url);
      let urls = [];
      let error = null;
      try {
        urls = await discoverGithubLinksFromUrl(source.url);
      } catch (caught) {
        error = errorMessage(caught);
      }
      stats.sourceChecks.push({
        entityType: owner.entityType,
        entityId: owner.entityId,
        sourceKind: source.kind,
        sourceUrl: source.url,
        status: error ? "failed" : urls.length ? "found_candidates" : "checked_empty",
        githubUrls: urls,
        error
      });
      for (const url of urls) {
        if (owner.retiredUrls.some((retiredUrl) => sameGithubUrl(retiredUrl, url))) continue;
        const parsed = parseGithubUrl(url);
        if (!parsed.login) continue;
        targets.push({
          entityType: owner.entityType,
          entityId: owner.entityId,
          companySlug: owner.companySlug,
          companyName: owner.companyName,
          name: owner.entityName,
          sourceUrl: source.url,
          githubUrl: githubUrlFromParsed(parsed),
          discoverySource: source.kind,
          matchReason: source.kind === "official_website"
            ? batchConfig.websiteMatchReason
            : `GitHub URL linked from the official public profile for ${owner.entityName}.`,
          ...parsed
        });
        if (source.kind === "official_website") stats.websiteTargets += 1;
        else stats.profileTargets += 1;
      }
    }
  });

  await runWorkerPool(companies, searchWorkers, async (company) => {
    if (!enableSearchDiscovery || stats.searchesUsed >= maxSearches) return;
    if (explicitCompanySlugs.has(company.slug)) return;
    const searchTargets = await searchGithubForCompany(company, stats);
    for (const target of searchTargets) {
      if (isRetiredGithubUrl(company, target.githubUrl)) continue;
      // Name/domain search is discovery debt only. It must never become scored
      // GitHub traction until a human or an official owner page verifies it.
      stats.reviewCandidates.push(target);
      stats.searchTargets += 1;
    }
  });

  // Ensure a source-discovered target still resolves to the exact owner record.
  stats.targets = targets.filter((target) => ownerById.has(target.entityId));

  return stats;
}

function mergeVerifiedGithubOverrides(companies, overrides) {
  return companies.map((company) => {
    const override = overrides?.[company.slug];
    if (!override) return company;
    const companyLinks = override.companySocialLinks ?? override.company ?? {};
    const matchedFounderOverrides = new Set();
    const founders = (company.founders ?? []).map((founder) => {
      const founderOverride = (override.founders ?? []).find(
        (candidate) =>
          String(candidate.id ?? "") === String(founder.id ?? "") ||
          slugify(candidate.name) === slugify(founder.name)
      );
      if (founderOverride) matchedFounderOverrides.add(founderOverride);
      return founderOverride
        ? mergeGithubOwnerOverride(founder, founderOverride, founderOverride.socialLinks ?? {})
        : founder;
    });
    for (const founderOverride of override.founders ?? []) {
      if (!founderOverride?.id || !founderOverride?.name || matchedFounderOverrides.has(founderOverride)) continue;
      founders.push(mergeGithubOwnerOverride(
        { ...founderOverride, socialLinks: {} },
        founderOverride,
        founderOverride.socialLinks ?? {}
      ));
    }
    return {
      ...mergeGithubOwnerOverride(company, override, companyLinks),
      founders
    };
  });
}

function mergeGithubOwnerOverride(owner, ownerOverride, positiveLinks) {
  const retiredGithub = retiredGithubRecords(ownerOverride);
  const existingGithub = owner.socialLinks?.github;
  const github = existingGithub && retiredGithub.some((record) => sameGithubUrl(record.url, existingGithub))
    ? null
    : existingGithub;
  const githubAccounts = [
    ...(owner.githubAccounts ?? []),
    ...(github ? [{ platform: "github", url: github }] : []),
    ...(positiveLinks?.github ? [{ platform: "github", url: positiveLinks.github }] : [])
  ].filter((account) => !retiredGithub.some((record) => sameGithubUrl(record.url, account.url)));
  return {
    ...owner,
    socialLinks: {
      ...(owner.socialLinks ?? {}),
      ...(github ? { github } : { github: undefined }),
      ...(positiveLinks?.github ? { github: positiveLinks.github } : {})
    },
    githubAccounts: [...new Map(
      githubAccounts.map((account) => [normalizeGithubUrl(account.url).toLowerCase(), account])
    ).values()],
    retiredGithub
  };
}

function githubUrlsForOwner(owner) {
  return [...new Map([
    ...(owner?.githubAccounts ?? []).map((account) => account?.url),
    owner?.socialLinks?.github
  ].filter(Boolean).map((url) => [normalizeGithubUrl(url).toLowerCase(), url])).values()];
}

function retiredGithubRecords(ownerOverride) {
  return [
    ...(ownerOverride?.rejectedGithub ?? []),
    ...(ownerOverride?.retiredAccounts ?? []).filter((record) => record?.platform === "github")
  ].filter((record) => record?.url);
}

function isRetiredGithubUrl(owner, rawUrl) {
  return (owner.retiredGithub ?? []).some((record) => sameGithubUrl(record.url, rawUrl));
}

function sameGithubUrl(left, right) {
  return normalizeGithubUrl(left).toLowerCase() === normalizeGithubUrl(right).toLowerCase();
}

function writeStdout(value) {
  return new Promise((resolve, reject) => {
    process.stdout.write(value, (error) => error ? reject(error) : resolve());
  });
}

async function discoverGithubLinksFromWebsite(company) {
  return company.websiteUrl ? discoverGithubLinksFromUrl(company.websiteUrl) : [];
}

async function discoverGithubLinksFromUrl(sourceUrl) {
  if (!sourceUrl) return [];
  const response = await fetch(sourceUrl, {
    signal: AbortSignal.timeout(8_000),
    headers: {
      "user-agent": "yc-network-intelligence-readonly-github-discovery",
      accept: "text/html,text/plain,*/*"
    }
  });
  if (!response.ok) {
    throw new Error(
      `Official source fetch failed for ${sourceUrl}: ${response.status} ${response.statusText || "HTTP error"}`
    );
  }
  const html = await response.text();
  const urls = new Set();
  const regex = /https?:\/\/(?:www\.)?github\.com\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?/gi;
  let match;
  while ((match = regex.exec(html))) {
    const url = normalizeGithubUrl(match[0]);
    const parsed = parseGithubUrl(url);
    if (!parsed.login || invalidGithubPath(parsed)) continue;
    if (!/\/(?:topics|marketplace|features|pricing|login|signup)\b/i.test(url)) urls.add(url);
  }
  return [...urls].slice(0, 6);
}

async function searchGithubForCompany(company, stats) {
  const root = domainRoot(company.websiteUrl);
  const queries = [
    `"${company.name}" in:name,description,readme`,
    root ? `${root} in:name,description,readme` : null
  ].filter(Boolean);
  const found = [];

  for (const query of queries) {
    if (stats.searchesUsed >= maxSearches) break;
    stats.searchesUsed += 1;
    try {
      const url = `${apiBase}/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=8`;
      const data = await fetchJson(url);
      for (const repo of data.items ?? []) {
        if (!candidateRepoMatchesCompany(company, repo)) continue;
        found.push({
          entityType: "company",
          entityId: batchConfig.companyId(company),
          companySlug: company.slug,
          companyName: company.name,
          name: company.name,
          sourceUrl: batchConfig.companyProfileUrl(company),
          githubUrl: repo.html_url,
          discoverySource: "github_search",
          matchReason: batchConfig.searchMatchReason,
          login: repo.owner?.login ?? "",
          repo: repo.name
        });
      }
    } catch (error) {
      stats.searchFailures.push({ company: company.name, query, error: errorMessage(error) });
    }
  }

  return found.slice(0, 4);
}

function candidateRepoMatchesCompany(company, repo) {
  const root = domainRoot(company.websiteUrl);
  if (!root || root.length <= 3) return false;
  if (company.websiteUrl && repo.homepage && sameHost(company.websiteUrl, repo.homepage)) return true;
  const normalizedRoot = normalizeIdentifier(root);
  const owner = normalizeIdentifier(repo.owner?.login ?? "");
  return owner === normalizedRoot || owner.includes(normalizedRoot) || normalizedRoot.includes(owner);
}

function parseGithubUrl(url) {
  try {
    const parsed = new URL(normalizeGithubUrl(url));
    const parts = parsed.pathname.split("/").filter(Boolean);
    const [login, repo] = parts[0] === "orgs" ? [parts[1], parts[2]] : parts;
    return {
      login: login?.trim() ?? "",
      repo: repo?.trim() || null
    };
  } catch {
    return { login: "", repo: null };
  }
}

function invalidGithubPath(parsed) {
  return [parsed.login, parsed.repo]
    .filter(Boolean)
    .some((part) => /\.(?:png|jpe?g|gif|webp|svg|ico|css|js|map|json|txt)$/i.test(part));
}

function normalizeGithubUrl(url) {
  return String(url)
    .replace(/^http:\/\//i, "https://")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");
}

function githubUrlFromParsed(parsed) {
  return `https://github.com/${parsed.login}${parsed.repo ? `/${parsed.repo}` : ""}`;
}

async function fetchJson(url) {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "yc-network-intelligence-readonly"
  };
  if (process.env.GITHUB_TOKEN) {
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(url, { headers });
    if (response.ok) return response.json();
    if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
      const resetAt = Number(response.headers.get("x-ratelimit-reset") ?? 0) * 1000;
      const waitMs = Math.min(Math.max(resetAt - Date.now() + 1_000, 5_000), 65_000);
      await delay(waitMs);
      continue;
    }
    if (response.status >= 500 && attempt < 2) {
      await delay(1_000 * (attempt + 1));
      continue;
    }
    throw new Error(`${response.status} ${response.statusText}`);
  }
  throw new Error("GitHub request failed after retries.");
}

function normalizeTarget(target, account, repos) {
  const normalizedRepos = repos
    .filter(Boolean)
    .filter((repo) => !repo.fork)
    .map((repo) => ({
      id: repo.id,
      name: repo.name,
      fullName: repo.full_name,
      description: repo.description ?? "",
      htmlUrl: repo.html_url,
      stars: repo.stargazers_count ?? 0,
      forks: repo.forks_count ?? 0,
      watchers: repo.watchers_count ?? 0,
      openIssues: repo.open_issues_count ?? 0,
      language: repo.language ?? null,
      pushedAt: repo.pushed_at,
      updatedAt: repo.updated_at,
      createdAt: repo.created_at,
      score: repoScore(repo)
    }))
    .sort((a, b) => b.score - a.score || b.stars - a.stars);

  return {
    ...target,
    fetched: true,
    account: {
      login: account.login,
      name: account.name,
      type: account.type,
      htmlUrl: account.html_url,
      bio: account.bio ?? "",
      followers: account.followers ?? 0,
      following: account.following ?? 0,
      publicRepos: account.public_repos ?? 0,
      publicGists: account.public_gists ?? 0,
      createdAt: account.created_at,
      updatedAt: account.updated_at
    },
    aggregate: {
      repoCount: normalizedRepos.length,
      totalStars: sum(normalizedRepos, "stars"),
      totalForks: sum(normalizedRepos, "forks"),
      totalWatchers: sum(normalizedRepos, "watchers"),
      maxRepoScore: normalizedRepos[0]?.score ?? 0,
      profileScore: profileScore(account, normalizedRepos)
    },
    repos: normalizedRepos.slice(0, 20)
  };
}

function repoScore(repo) {
  const stars = repo.stargazers_count ?? 0;
  const forks = repo.forks_count ?? 0;
  const watchers = repo.watchers_count ?? 0;
  const issues = repo.open_issues_count ?? 0;
  const recent = daysSince(repo.pushed_at) <= 45 ? 8 : daysSince(repo.pushed_at) <= 180 ? 3 : 0;
  return clamp(Math.round(Math.log1p(stars) * 14 + Math.log1p(forks) * 9 + Math.log1p(watchers) * 3 + Math.log1p(issues) * 1.5 + recent), 1, 100);
}

function profileScore(account, repos) {
  const topRepos = repos.slice(0, 5);
  const repoMomentum = topRepos.reduce((sumScore, repo) => sumScore + repo.score, 0) / Math.max(topRepos.length, 1);
  return clamp(Math.round(Math.log1p(account.followers ?? 0) * 7 + Math.log1p(account.public_repos ?? 0) * 2 + repoMomentum * 0.7), 1, 100);
}

async function runWorkerPool(items, concurrency, fn) {
  let nextIndex = 0;
  const runners = Array.from({ length: concurrency }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      await fn(item);
    }
  });
  await Promise.all(runners);
}

function dedupeTargets(targets) {
  const byKey = new Map();
  for (const target of targets.filter((item) => item.login)) {
    const key = `${target.entityId}:${target.login.toLowerCase()}:${target.repo?.toLowerCase() ?? "*"}`;
    if (!byKey.has(key) || sourceRank(target.discoverySource) < sourceRank(byKey.get(key).discoverySource)) {
      byKey.set(key, target);
    }
  }
  const deduped = [...byKey.values()];
  const orgTargets = new Set(
    deduped.filter((target) => !target.repo).map((target) => `${target.entityId}:${target.login.toLowerCase()}`)
  );
  return deduped.filter((target) => !target.repo || !orgTargets.has(`${target.entityId}:${target.login.toLowerCase()}`));
}

function sourceRank(source) {
  return source === batchConfig.explicitDiscoverySource ? 0 : source === "official_website" ? 1 : 2;
}

function significantTokens(value) {
  const stopWords = new Set(["ai", "inc", "labs", "lab", "technologies", "technology", "systems", "hq", "the", "and"]);
  return String(value)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !stopWords.has(token));
}

function normalizeIdentifier(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function domainRoot(url) {
  try {
    if (!url) return "";
    return new URL(url).hostname.replace(/^www\./, "").split(".")[0].toLowerCase();
  } catch {
    return "";
  }
}

function sameHost(a, b) {
  try {
    const hostA = new URL(a).hostname.replace(/^www\./, "").toLowerCase();
    const hostB = new URL(b).hostname.replace(/^www\./, "").toLowerCase();
    return hostA === hostB || hostA.endsWith(`.${hostB}`) || hostB.endsWith(`.${hostA}`);
  } catch {
    return false;
  }
}

function daysSince(value) {
  if (!value) return Number.POSITIVE_INFINITY;
  return (Date.now() - new Date(value).getTime()) / 86_400_000;
}

function sum(items, key) {
  return items.reduce((total, item) => total + (item[key] ?? 0), 0);
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function numberArg(name) {
  const raw = process.argv.find((arg) => arg.startsWith(`${name}=`))?.split("=")[1];
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringArg(name) {
  return process.argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function resolveOutputPath(value) {
  return resolve(root, value);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function resolveBatchConfig(value) {
  const key = normalizeBatchKey(value);
  const config = batchConfigs().find((candidate) =>
    candidate.aliases.some((alias) => normalizeBatchKey(alias) === key)
  );
  if (!config) {
    const supported = batchConfigs().map((candidate) => candidate.slug).join(", ");
    throw new Error(`Unsupported --batch=${value}. Supported batches: ${supported}.`);
  }
  return config;
}

function batchConfigs() {
  const ycSnapshotPath = join(root, "src", "lib", "yc", "summer-2026-companies.json");
  const ycSpringSnapshotPath = join(root, "src", "lib", "yc", "spring-2026-companies.json");
  const a16zDatasetPath = join(root, "src", "lib", "graph", "a16z-speedrun-006-dataset.ts");

  return [
    {
      slug: "S26",
      aliases: ["S26", "YC_S26", "YC_SUMMER_2026", "YC_SUMMER_2026_S26", "SUMMER_2026"],
      label: "YC Summer 2026 (S26)",
      sourceLabel: "GitHub public API for official YC Summer 2026 GitHub links",
      sourcePath: relativePath(ycSnapshotPath),
      outputPath: join(root, "src", "lib", "social", "github-traction-summer-2026.json"),
      explicitDiscoverySource: "yc_profile",
      explicitCompanyMatchReason: "GitHub URL explicitly listed on YC public company profile.",
      explicitFounderMatchReason: "GitHub URL explicitly listed on YC public founder profile.",
      websiteMatchReason: "GitHub URL linked from the official company website.",
      searchMatchReason: "Conservative GitHub repository search match on company name, domain root, or homepage.",
      defaultWebsiteDiscovery: false,
      defaultSearchDiscovery: false,
      loadSnapshot: async () => JSON.parse(await readFile(ycSnapshotPath, "utf8")),
      companyId: (company) => `company-${company.slug}`,
      founderId: (company, founder) => `founder-${company.slug}-${slugify(founder.name)}-${founder.id}`,
      companyProfileUrl: (company) => company.ycProfileUrl,
      founderProfileUrl: (_company, founder) => founder.ycProfileUrl,
      notes: [
        "Read-only public GitHub API data.",
        "GITHUB_TOKEN is optional and only increases API rate limits; gh auth token can be exported before running.",
        "No stars, follows, forks, issues, pull requests, comments, or account mutations are performed.",
        "Only GitHub URLs explicitly listed on public YC Summer 2026 company profiles are scored by default.",
        "GitHub search discovery is available with --search, but is disabled by default because same-name repositories need review before scoring."
      ]
    },
    {
      slug: "S2026",
      aliases: ["S2026", "P26", "YC_S2026", "YC_P26", "YC_SPRING_2026", "SPRING_2026"],
      label: "YC Spring 2026 (P26)",
      sourceLabel: "GitHub public API for official YC Spring 2026 GitHub links",
      sourcePath: relativePath(ycSpringSnapshotPath),
      outputPath: join(root, "src", "lib", "social", "github-traction.json"),
      explicitDiscoverySource: "yc_profile",
      explicitCompanyMatchReason: "GitHub URL explicitly listed on YC public company profile.",
      explicitFounderMatchReason: "GitHub URL explicitly listed on YC public founder profile.",
      websiteMatchReason: "GitHub URL linked from the official company website.",
      searchMatchReason: "Conservative GitHub repository search match on company name, domain root, or homepage.",
      defaultWebsiteDiscovery: false,
      defaultSearchDiscovery: false,
      loadSnapshot: async () => JSON.parse(await readFile(ycSpringSnapshotPath, "utf8")),
      companyId: (company) => `company-${company.slug}`,
      founderId: (company, founder) => `founder-${company.slug}-${slugify(founder.name)}-${founder.id}`,
      companyProfileUrl: (company) => company.ycProfileUrl,
      founderProfileUrl: (_company, founder) => founder.ycProfileUrl,
      notes: [
        "Read-only public GitHub API data.",
        "GITHUB_TOKEN is optional and only increases API rate limits.",
        "No GitHub mutations are performed.",
        "Only GitHub URLs explicitly listed on public YC Spring 2026 profiles are scored by default."
      ]
    },
    {
      slug: "A16ZSR006",
      aliases: ["A16ZSR006", "A16Z_SPEEDRUN_006", "A16Z_SPEEDRUN006", "A16Z_SPEEDRUN", "SPEEDRUN_006"],
      label: "a16z Speedrun 006",
      sourceLabel: "GitHub public API for a16z Speedrun 006 company GitHub links",
      sourcePath: relativePath(a16zDatasetPath),
      outputPath: join(root, "src", "lib", "social", "github-traction-a16z-speedrun-006.json"),
      explicitDiscoverySource: "a16z_speedrun_profile",
      explicitCompanyMatchReason: "GitHub URL explicitly listed on the a16z Speedrun 006 company profile.",
      explicitFounderMatchReason: "GitHub URL explicitly listed on the a16z Speedrun 006 founder profile.",
      websiteMatchReason: "GitHub URL linked from the official company website for an a16z Speedrun 006 company.",
      searchMatchReason: "Conservative GitHub repository search match on company name, domain root, or homepage for an a16z Speedrun 006 company.",
      defaultWebsiteDiscovery: true,
      defaultSearchDiscovery: false,
      loadSnapshot: () => loadA16zSpeedrun006Snapshot(a16zDatasetPath),
      companyId: (company) => company.entityId ?? `a16z-speedrun-006-${company.slug}`,
      founderId: (company, founder) => founder.entityId ?? `a16z-speedrun-006-${company.slug}-founder-${slugifyA16z(founder.name)}`,
      companyProfileUrl: (company) => company.ycProfileUrl,
      founderProfileUrl: (_company, founder) => founder.ycProfileUrl,
      notes: [
        "Read-only public GitHub API data.",
        "GITHUB_TOKEN is optional and only increases API rate limits; gh auth token can be exported before running.",
        "No stars, follows, forks, issues, pull requests, comments, or account mutations are performed.",
        "a16z Speedrun 006 profiles in the local graph dataset do not include explicit GitHub social links, so official company websites are scanned by default.",
        "GitHub search discovery is available with --search for conservative same-domain or same-owner matches; use --no-website to disable official website discovery."
      ]
    }
  ];
}

function normalizeBatchKey(value) {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "");
}

function relativePath(path) {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

async function loadA16zSpeedrun006Snapshot(datasetPath) {
  // Use the same normalized, override-aware owner inventory as the autonomous
  // planner. The TypeScript profile seed intentionally omits most social links;
  // rebuilding from it made 27 of 28 active a16z GitHub mappings disappear.
  const { loadAutonomousCatalogs } = await import("./lib/autonomous-ingestion-plan.mjs");
  const catalog = (await loadAutonomousCatalogs(root)).find(
    (candidate) => candidate.slug === "A16ZSR006"
  );
  if (!catalog) throw new Error(`Unable to load the A16ZSR006 autonomous catalog from ${datasetPath}.`);
  return {
    source: {
      directoryUrl: "https://speedrun.a16z.com/",
      expectedCompanyCount: 59,
      observedCompanyCount: catalog.companies.length
    },
    companies: catalog.companies.map((company) => ({
      id: company.sourceKey,
      entityId: company.sourceKey,
      slug: String(company.sourceKey).replace(/^a16z-speedrun-006-/, ""),
      name: company.name,
      ycProfileUrl: company.profileUrl,
      websiteUrl: company.websiteUrl,
      tagline: company.tagline,
      description: company.description,
      industries: [],
      tags: [],
      githubAccounts: company.accounts.filter((account) => account.platform === "github"),
      socialLinks: firstLinksByPlatform(company.accounts),
      founders: company.founders.map((founder) => ({
        id: founder.sourceKey,
        entityId: founder.sourceKey,
        name: founder.name,
        ycProfileUrl: founder.profileUrl,
        websiteUrl: founder.websiteUrl,
        githubAccounts: founder.accounts.filter((account) => account.platform === "github"),
        socialLinks: firstLinksByPlatform(founder.accounts)
      })),
      sourceUrls: [company.profileUrl, company.websiteUrl].filter(Boolean)
    }))
  };
}

function firstLinksByPlatform(accounts) {
  const links = {};
  for (const account of accounts ?? []) {
    if (account?.platform && account?.url && !links[account.platform]) {
      links[account.platform] = account.url;
    }
  }
  return links;
}

async function extractTypescriptConstArray(source, fileName, variableName) {
  const tsModule = await import("typescript");
  const ts = tsModule.default ?? tsModule;
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let initializer = null;

  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(sourceFile) === variableName) {
      initializer = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  if (!initializer) {
    throw new Error(`Could not find ${variableName} in ${fileName}.`);
  }
  if (!ts.isArrayLiteralExpression(initializer)) {
    throw new Error(`${variableName} in ${fileName} must be an array literal.`);
  }

  return evaluateTypescriptLiteral(initializer, ts, sourceFile);
}

function evaluateTypescriptLiteral(node, ts, sourceFile) {
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map((element) => evaluateTypescriptLiteral(element, ts, sourceFile));
  }

  if (ts.isObjectLiteralExpression(node)) {
    const object = {};
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) {
        throw new Error(`Unsupported object literal property in ${sourceFile.fileName}: ${property.getText(sourceFile)}`);
      }
      object[propertyName(property.name, ts, sourceFile)] = evaluateTypescriptLiteral(property.initializer, ts, sourceFile);
    }
    return object;
  }

  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }

  if (ts.isNumericLiteral(node)) {
    return Number(node.text);
  }

  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;

  if (ts.isPrefixUnaryExpression(node)) {
    const value = evaluateTypescriptLiteral(node.operand, ts, sourceFile);
    if (node.operator === ts.SyntaxKind.MinusToken) return -value;
    if (node.operator === ts.SyntaxKind.PlusToken) return value;
  }

  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isParenthesizedExpression(node)) {
    return evaluateTypescriptLiteral(node.expression, ts, sourceFile);
  }

  throw new Error(`Unsupported TypeScript literal in ${sourceFile.fileName}: ${node.getText(sourceFile)}`);
}

function propertyName(name, ts, sourceFile) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  throw new Error(`Unsupported object literal key in ${sourceFile.fileName}: ${name.getText(sourceFile)}`);
}

function slugifyA16z(value) {
  return String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
