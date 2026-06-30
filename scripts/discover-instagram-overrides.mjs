import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const ycSnapshotPath = join(root, "src", "lib", "yc", "spring-2026-companies.json");
const overridesPath = join(root, "src", "lib", "social", "verified-social-overrides.json");
const candidatesPath = join(root, "outputs", "instagram-discovery-candidates.json");
const openCliMain = join(process.env.APPDATA ?? "", "npm", "node_modules", "@jackwener", "opencli", "dist", "src", "main.js");

const write = booleanArg("--write");
const search = booleanArg("--search");
const promoteSearch = booleanArg("--promote-search");
const includeFounders = !booleanArg("--company-only");
const promoteFounderSearch = booleanArg("--promote-founder-search");
const maxCompanies = numberArg("--max-companies") ?? Number.POSITIVE_INFINITY;
const workers = Math.max(1, Math.min(numberArg("--workers") ?? 4, 8));
const companyFilter = stringArg("--company")?.toLowerCase();
const now = new Date().toISOString();

const snapshot = JSON.parse(await readFile(ycSnapshotPath, "utf8"));
const overrides = await readJson(overridesPath, {});
const companies = snapshot.companies
  .filter((company) => !companyFilter || company.slug === companyFilter || company.name.toLowerCase().includes(companyFilter))
  .slice(0, maxCompanies);

const candidates = [];
let verifiedCount = 0;
let verifiedFounderCount = 0;

await runWorkerPool(companies, workers, async (company) => {
  const existing = overrides[company.slug]?.companySocialLinks?.instagram;
  const officialLinks = await discoverFromOfficialPages(company);
  for (const link of officialLinks) {
    candidates.push(candidate(company, link.url, "verified", link.reason, link.sourceUrl));
  }

  if (!existing && officialLinks.length) {
    const selected = officialLinks[0];
    setCompanyOverride(company, selected.url, selected.reason);
    verifiedCount += 1;
    return;
  }

  if (search && !existing && !officialLinks.length) {
    const rows = await searchInstagram(company).catch((error) => [
      {
        url: null,
        entityType: "company",
        entityName: company.name,
        review_state: "failed",
        matchReason: `OpenCLI Instagram search failed: ${errorMessage(error)}`
      }
    ]);
    for (const row of rows) {
      candidates.push(candidate(company, row.url, row.review_state, row.matchReason, "opencli:instagram-search", row));
      if (promoteSearch && row.review_state === "verified") {
        setCompanyOverride(company, row.url, row.matchReason);
        verifiedCount += 1;
        break;
      }
    }
  }

  if (search && includeFounders) {
    for (const founder of company.founders ?? []) {
      const existingFounderInstagram = existingFounderOverride(company, founder)?.socialLinks?.instagram ?? founder.socialLinks?.instagram;
      if (existingFounderInstagram) continue;

      const rows = await searchFounderInstagram(company, founder).catch((error) => [
        {
          url: null,
          entityType: "founder",
          entityName: founder.name,
          review_state: "failed",
          matchReason: `OpenCLI Instagram founder search failed: ${errorMessage(error)}`
        }
      ]);
      for (const row of rows) {
        candidates.push(candidate(company, row.url, row.review_state, row.matchReason, "opencli:instagram-founder-search", row));
        if (promoteFounderSearch && row.review_state === "verified") {
          setFounderOverride(company, founder, row.url, row.matchReason);
          verifiedFounderCount += 1;
          break;
        }
      }
    }
  }
});

const report = {
  generated_at: now,
  write_enabled: write,
  searched_with_opencli: search,
  promote_search_enabled: promoteSearch,
  include_founders: includeFounders,
  promote_founder_search_enabled: promoteFounderSearch,
  companies_checked: companies.length,
  verified_company_instagram_profiles: Object.values(overrides).filter((item) => item?.companySocialLinks?.instagram).length,
  verified_founder_instagram_profiles: Object.values(overrides).flatMap((item) => item?.founders ?? []).filter((founder) => founder?.socialLinks?.instagram).length,
  newly_verified_in_this_run: verifiedCount,
  newly_verified_founders_in_this_run: verifiedFounderCount,
  candidates
};

await writeJson(candidatesPath, report);
if (write) {
  await writeJson(overridesPath, sortObject(overrides));
}

console.log(
  JSON.stringify(
    {
      outputPath: candidatesPath,
      write,
      companies: companies.length,
      candidates: candidates.length,
      newlyVerified: verifiedCount,
      newlyVerifiedFounders: verifiedFounderCount,
      totalVerifiedCompanyInstagramProfiles: report.verified_company_instagram_profiles
    },
    null,
    2
  )
);
process.exit(0);

async function discoverFromOfficialPages(company) {
  if (!company.websiteUrl) return [];
  const visited = new Set();
  const found = [];
  const homepage = await fetchText(company.websiteUrl).catch(() => null);
  if (!homepage) return [];
  visited.add(normalizeUrl(company.websiteUrl));
  collectInstagramLinks(found, company, homepage.url, homepage.text, "Found as an outbound Instagram profile link on the official company website.");

  if (found.length) return dedupeLinks(found);

  const linkPages = extractLinkPageUrls(homepage.text, homepage.url).slice(0, 3);
  for (const linkPage of linkPages) {
    const normalized = normalizeUrl(linkPage);
    if (!normalized || visited.has(normalized)) continue;
    visited.add(normalized);
    const page = await fetchText(linkPage).catch(() => null);
    if (!page) continue;
    collectInstagramLinks(
      found,
      company,
      page.url,
      page.text,
      "Found through an official website outbound link-in-bio page."
    );
    if (found.length) break;
  }

  return dedupeLinks(found);
}

function collectInstagramLinks(found, company, sourceUrl, text, reason) {
  for (const url of extractInstagramProfileUrls(text)) {
    found.push({
      url,
      sourceUrl,
      reason: `${reason} Source chain starts from ${company.websiteUrl}.`
    });
  }
}

function extractInstagramProfileUrls(text) {
  const urls = new Set();
  const regex = /https?:\\?\/\\?\/(?:www\\?\.)?instagram\\.com\\?\/([A-Za-z0-9._]{2,40})(?:[/?#"']|&quot;|&amp;|$)/gi;
  let match;
  while ((match = regex.exec(text))) {
    const handle = match[1]?.replace(/^@/, "").replace(/[.]+$/, "");
    if (!handle || isLowValueInstagramHandle(handle)) continue;
    urls.add(`https://www.instagram.com/${handle}/`);
  }
  return [...urls];
}

function extractLinkPageUrls(text, baseUrl) {
  const urls = new Set();
  const regex = /href=["']([^"']+)["']|https?:\/\/[^\s"'<>]+/gi;
  let match;
  while ((match = regex.exec(text))) {
    const raw = match[1] ?? match[0];
    const url = absoluteUrl(raw, baseUrl);
    if (!url) continue;
    if (/(?:linktr\.ee|bio\.link|beacons\.ai|bento\.me|lnk\.bio|solo\.to|taplink\.cc|carrd\.co|allmylinks\.com)\//i.test(url)) {
      urls.add(url);
    }
  }
  return [...urls];
}

async function searchInstagram(company) {
  const rows = await runInstagramSearch(company.name);
  return rows
    .map((row) => evaluateSearchCandidate(company, row, company.name))
    .filter(Boolean);
}

async function searchFounderInstagram(company, founder) {
  const queries = [`${founder.name} ${company.name}`, founder.name];
  const rows = [];
  for (const query of queries) {
    const results = await runInstagramSearch(query);
    for (const row of results) {
      rows.push({ ...row, query });
    }
  }

  const evaluated = [];
  const seen = new Set();
  for (const row of rows) {
    const item = await evaluateFounderSearchCandidate(company, founder, row);
    if (!item?.url || seen.has(item.url)) continue;
    seen.add(item.url);
    evaluated.push(item);
  }
  return evaluated;
}

async function runInstagramSearch(query) {
  const raw = await runOpenCli(["instagram", "search", query, "--limit", "5", "-f", "json", "--site-session", "persistent"], {
    timeoutMs: 45_000
  });
  return parseJsonOutput(raw);
}

function evaluateSearchCandidate(company, row, query) {
  const url = canonicalInstagramProfileUrl(row.url ?? row.username);
  if (!url) return null;
  const username = instagramHandleFromUrl(url);
  if (!username || isLowValueInstagramHandle(username)) return null;

  const normalizedCompany = normalizeToken(company.name);
  const normalizedSlug = normalizeToken(company.slug);
  const normalizedUsername = normalizeToken(username);
  const normalizedName = normalizeToken(row.name);
  const exactHandle = normalizedUsername === normalizedCompany || normalizedUsername === normalizedSlug;
  const exactName = normalizedName === normalizedCompany || normalizedName === normalizedSlug;

  if (exactHandle && exactName && !isAmbiguousCompanyName(company.name)) {
    return {
      url,
      entityType: "company",
      entityName: company.name,
      review_state: "verified",
      matchReason: `OpenCLI Instagram search returned exact non-ambiguous handle/name match for ${company.name}; query="${query}".`
    };
  }

  return {
    url,
    entityType: "company",
    entityName: company.name,
    review_state: "needs_review",
    matchReason: `OpenCLI Instagram search candidate for ${company.name}; query="${query}", exactHandle=${exactHandle}, exactName=${exactName}, rank=${row.rank ?? "unknown"}.`
  };
}

async function evaluateFounderSearchCandidate(company, founder, row) {
  const url = canonicalInstagramProfileUrl(row.url ?? row.username);
  if (!url) return null;
  const username = instagramHandleFromUrl(url);
  if (!username || isLowValueInstagramHandle(username)) return null;

  const profile = await fetchInstagramProfile(username).catch(() => null);
  const visibleText = [
    row.name,
    row.username,
    row.bio,
    row.text,
    row.description,
    profile?.name,
    profile?.username,
    profile?.bio,
    profile?.url,
    profile?.website
  ].join(" ");
  const normalizedVisibleText = normalizeToken(visibleText);
  const normalizedUsername = normalizeToken(username);
  const normalizedFounder = normalizeToken(founder.name);
  const founderNameTokens = founder.name.split(/\s+/).map(normalizeToken).filter((token) => token.length > 1);
  const founderNameMatch =
    normalizedUsername === normalizedFounder ||
    normalizeToken(row.name) === normalizedFounder ||
    normalizeToken(profile?.name) === normalizedFounder ||
    founderNameTokens.every((token) => normalizedVisibleText.includes(token));
  const companySignals = companyCorroborationTokens(company, founder);
  const matchedCompanySignal = companySignals.find((token) => token && normalizedVisibleText.includes(token));
  const isPrivate = /\bprivate\b/i.test(`${row.private ?? ""} ${row.is_private ?? ""} ${profile?.private ?? ""} ${profile?.is_private ?? ""}`);

  if (founderNameMatch && matchedCompanySignal && !isPrivate) {
    return {
      url,
      entityType: "founder",
      entityName: founder.name,
      review_state: "verified",
      matchReason: `OpenCLI Instagram founder search verified ${founder.name}: visible profile identity matched the founder and corroborated ${company.name} via "${matchedCompanySignal}". Query="${row.query ?? founder.name}".`
    };
  }

  return {
    url,
    entityType: "founder",
    entityName: founder.name,
    review_state: "needs_review",
    matchReason: `OpenCLI Instagram founder search candidate for ${founder.name} at ${company.name}; founderNameMatch=${founderNameMatch}, companySignal=${matchedCompanySignal ?? "none"}, private=${isPrivate}, query="${row.query ?? founder.name}".`
  };
}

async function fetchInstagramProfile(username) {
  const raw = await runOpenCli(["instagram", "profile", username, "-f", "json", "--site-session", "persistent"], {
    timeoutMs: 30_000
  });
  return parseJsonOutput(raw)[0] ?? null;
}

function setCompanyOverride(company, instagramUrl, matchReason) {
  if (!instagramUrl) return;
  const current = overrides[company.slug] ?? {};
  overrides[company.slug] = {
    ...current,
    companySocialLinks: {
      ...(current.companySocialLinks ?? {}),
      instagram: instagramUrl
    },
    matchReason
  };
}

function setFounderOverride(company, founder, instagramUrl, matchReason) {
  if (!instagramUrl) return;
  const current = overrides[company.slug] ?? {};
  const founders = current.founders ?? [];
  const existingIndex = founders.findIndex((item) => namesMatch(item.name, founder.name));
  const nextFounder = {
    ...(existingIndex >= 0 ? founders[existingIndex] : {}),
    id: founders[existingIndex]?.id ?? `discovered-${slugify(founder.name)}`,
    name: founder.name,
    ycProfileUrl: founder.ycProfileUrl ?? null,
    sourceUrl: instagramUrl,
    socialLinks: {
      ...(founders[existingIndex]?.socialLinks ?? {}),
      instagram: instagramUrl
    },
    matchReason
  };
  const nextFounders =
    existingIndex >= 0
      ? founders.map((item, index) => (index === existingIndex ? nextFounder : item))
      : [...founders, nextFounder];

  overrides[company.slug] = {
    ...current,
    founders: nextFounders
  };
}

function existingFounderOverride(company, founder) {
  return (overrides[company.slug]?.founders ?? []).find((item) => namesMatch(item.name, founder.name));
}

function candidate(company, url, reviewState, matchReason, sourceUrl, extra = {}) {
  return {
    companySlug: company.slug,
    companyName: company.name,
    entityType: extra.entityType ?? "company",
    entityName: extra.entityName ?? company.name,
    platform: "instagram",
    candidateUrl: url,
    sourceUrl,
    review_state: reviewState,
    matchReason,
    created_at: now
  };
}

function companyCorroborationTokens(company, founder) {
  const tokens = new Set([company.name, company.slug]);
  if (company.websiteUrl) {
    try {
      const host = new URL(company.websiteUrl).hostname.replace(/^www\./, "");
      tokens.add(host);
      tokens.add(host.split(".")[0]);
    } catch {
      // Ignore malformed historical website fields.
    }
  }
  for (const value of [company.socialLinks?.x, founder.socialLinks?.x, company.socialLinks?.github, founder.socialLinks?.github]) {
    const handle = socialHandleFromUrl(value);
    if (handle) tokens.add(handle);
  }
  return [...tokens].map(normalizeToken).filter((token) => token.length > 2);
}

function socialHandleFromUrl(rawUrl) {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? null;
  } catch {
    return null;
  }
}

function namesMatch(left, right) {
  return normalizeToken(left) === normalizeToken(right);
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "YCNetworkIntelligence/0.1 read-only Instagram discovery"
      }
    });
    const text = await response.text();
    return { url: response.url || url, text };
  } finally {
    clearTimeout(timer);
  }
}

async function runOpenCli(args, options = {}) {
  const result = await execFileAsync(process.execPath, [openCliMain, ...args], {
    cwd: root,
    timeout: options.timeoutMs ?? 45_000,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true
  });
  return result.stdout;
}

function parseJsonOutput(raw) {
  const value = String(raw ?? "").trim();
  const start = Math.min(...[value.indexOf("{"), value.indexOf("[")].filter((index) => index >= 0));
  if (!Number.isFinite(start)) return [];
  const parsed = JSON.parse(value.slice(start));
  return Array.isArray(parsed) ? parsed : [parsed];
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

function canonicalInstagramProfileUrl(value) {
  if (!value) return null;
  if (/^[A-Za-z0-9._]{2,40}$/.test(value)) return `https://www.instagram.com/${value}/`;
  try {
    const url = new URL(value);
    if (!/(^|\\.)instagram\\.com$/i.test(url.hostname)) return null;
    const handle = url.pathname.split("/").filter(Boolean)[0];
    if (!handle || isLowValueInstagramHandle(handle)) return null;
    return `https://www.instagram.com/${handle}/`;
  } catch {
    return null;
  }
}

function instagramHandleFromUrl(url) {
  try {
    return new URL(url).pathname.split("/").filter(Boolean)[0] ?? null;
  } catch {
    return null;
  }
}

function isLowValueInstagramHandle(handle) {
  return /^(?:p|reel|tv|stories|explore|accounts|about|developer|oauth|direct|graphql|instagram|privacy|legal|terms)$/i.test(handle);
}

function isAmbiguousCompanyName(name) {
  const normalized = normalizeToken(name);
  return normalized.length <= 5 || /^(?:stage|bloom|hub|hyper|result|drafted|pops|juno|memoir|dispatch|archer)$/i.test(normalized);
}

function normalizeToken(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function slugify(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function absoluteUrl(raw, baseUrl) {
  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return null;
  }
}

function dedupeLinks(links) {
  return [...new Map(links.map((link) => [link.url, link])).values()];
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sortObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function numberArg(name) {
  const raw = process.argv.find((arg) => arg.startsWith(`${name}=`))?.split("=")[1];
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringArg(name) {
  return process.argv.find((arg) => arg.startsWith(`${name}=`))?.split("=").slice(1).join("=");
}

function booleanArg(name) {
  return process.argv.includes(name);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
