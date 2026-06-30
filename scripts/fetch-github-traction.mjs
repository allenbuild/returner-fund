import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const root = process.cwd();
const ycSnapshotPath = join(root, "src", "lib", "yc", "spring-2026-companies.json");
const outputPath = join(root, "src", "lib", "social", "github-traction.json");
const apiBase = "https://api.github.com";
const workers = Math.max(1, Math.min(numberArg("--workers") ?? 6, 16));
const companyLimit = numberArg("--max-companies") ?? Number.POSITIVE_INFINITY;
const maxSearches = numberArg("--max-searches") ?? 80;
const enableWebsiteDiscovery = !process.argv.includes("--no-website");
const enableSearchDiscovery = process.argv.includes("--search");

const ycSnapshot = JSON.parse(await readFile(ycSnapshotPath, "utf8"));
const companies = ycSnapshot.companies.slice(0, companyLimit);
const explicitTargets = collectExplicitGithubTargets(companies);
const discovery = await discoverGithubTargets(companies, explicitTargets);
const githubTargets = dedupeTargets([...explicitTargets, ...discovery.targets]);
console.log(
  `GitHub targets: ${githubTargets.length} (${explicitTargets.length} explicit, ${discovery.targets.length} discovered, ${discovery.searchesUsed} searches).`
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
    label: "GitHub public API with website/search discovery",
    fetchedAt: new Date().toISOString(),
    targetCount: githubTargets.length,
    fetchedCount: results.filter((result) => result.fetched).length,
    discovery: {
      explicitTargetCount: explicitTargets.length,
      discoveredTargetCount: discovery.targets.length,
      websiteTargets: discovery.websiteTargets,
      searchTargets: discovery.searchTargets,
      searchesUsed: discovery.searchesUsed,
      searchFailures: discovery.searchFailures
    },
    notes: [
      "Read-only public GitHub API data.",
      "GITHUB_TOKEN is optional and only increases API rate limits; gh auth token can be exported before running.",
      "No stars, follows, forks, issues, pull requests, comments, or account mutations are performed.",
      "Discovery trusts YC-linked GitHub URLs and GitHub links from official company websites.",
      "GitHub search discovery is available with --search, but is disabled by default because same-name repositories need review before scoring."
    ]
  },
  accounts: results.sort((a, b) => (b.aggregate?.profileScore ?? 0) - (a.aggregate?.profileScore ?? 0))
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`Wrote ${outputPath}`);

function collectExplicitGithubTargets(companies) {
  const targets = [];

  for (const company of companies) {
    const companyGithubUrl = company.socialLinks?.github;
    if (companyGithubUrl) {
      targets.push({
        entityType: "company",
        entityId: companyId(company),
        companySlug: company.slug,
        companyName: company.name,
        name: company.name,
        sourceUrl: company.ycProfileUrl,
        githubUrl: companyGithubUrl,
        discoverySource: "yc_profile",
        matchReason: "GitHub URL explicitly listed on YC public company profile.",
        ...parseGithubUrl(companyGithubUrl)
      });
    }

    for (const founder of company.founders ?? []) {
      const founderGithubUrl = founder.socialLinks?.github;
      if (!founderGithubUrl) continue;
      targets.push({
        entityType: "founder",
        entityId: founderId(company, founder),
        companySlug: company.slug,
        companyName: company.name,
        name: founder.name,
        sourceUrl: founder.ycProfileUrl,
        githubUrl: founderGithubUrl,
        discoverySource: "yc_profile",
        matchReason: "GitHub URL explicitly listed on YC public founder profile.",
        ...parseGithubUrl(founderGithubUrl)
      });
    }
  }

  return targets.filter((target) => target.login);
}

async function discoverGithubTargets(companies, explicitTargets) {
  const targets = [];
  const explicitCompanySlugs = new Set(explicitTargets.filter((target) => target.entityType === "company").map((target) => target.companySlug));
  const stats = {
    targets,
    websiteTargets: 0,
    searchTargets: 0,
    searchesUsed: 0,
    searchFailures: []
  };

  await runWorkerPool(companies, workers, async (company) => {
    if (enableWebsiteDiscovery) {
      const websiteLinks = await discoverGithubLinksFromWebsite(company).catch(() => []);
      for (const url of websiteLinks) {
        const parsed = parseGithubUrl(url);
        if (!parsed.login) continue;
        targets.push({
          entityType: "company",
          entityId: companyId(company),
          companySlug: company.slug,
          companyName: company.name,
          name: company.name,
          sourceUrl: company.websiteUrl,
          githubUrl: githubUrlFromParsed(parsed),
          discoverySource: "official_website",
          matchReason: "GitHub URL linked from the official company website.",
          ...parsed
        });
        stats.websiteTargets += 1;
      }
    }

    if (!enableSearchDiscovery || stats.searchesUsed >= maxSearches) return;
    if (explicitCompanySlugs.has(company.slug)) return;
    const searchTargets = await searchGithubForCompany(company, stats);
    for (const target of searchTargets) {
      targets.push(target);
      stats.searchTargets += 1;
    }
  });

  return stats;
}

async function discoverGithubLinksFromWebsite(company) {
  if (!company.websiteUrl) return [];
  const response = await fetch(company.websiteUrl, {
    signal: AbortSignal.timeout(15_000),
    headers: {
      "user-agent": "yc-network-intelligence-readonly-github-discovery",
      accept: "text/html,text/plain,*/*"
    }
  });
  if (!response.ok) return [];
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
          entityId: companyId(company),
          companySlug: company.slug,
          companyName: company.name,
          name: company.name,
          sourceUrl: company.ycProfileUrl,
          githubUrl: repo.html_url,
          discoverySource: "github_search",
          matchReason: "Conservative GitHub repository search match on company name, domain root, or homepage.",
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
    const [login, repo] = parsed.pathname.split("/").filter(Boolean);
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
  return source === "yc_profile" ? 0 : source === "official_website" ? 1 : 2;
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

function companyId(company) {
  return `company-${company.slug}`;
}

function founderId(company, founder) {
  return `founder-${company.slug}-${slugify(founder.name)}-${founder.id}`;
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
