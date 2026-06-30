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
const appendReport = booleanArg("--append");
const search = booleanArg("--search");
const webSearch = search || booleanArg("--web-search");
const promoteSearch = booleanArg("--promote-search");
const includeFounders = !booleanArg("--company-only");
const promoteFounderSearch = booleanArg("--promote-founder-search");
const skipOfficialDiscovery = booleanArg("--skip-official");
const forceDiscovery = booleanArg("--force-discovery");
const pruneWebOverrides = booleanArg("--prune-web-overrides");
const maxCompanies = numberArg("--max-companies") ?? Number.POSITIVE_INFINITY;
const offsetCompanies = Math.max(0, numberArg("--offset") ?? 0);
const workers = Math.max(1, Math.min(numberArg("--workers") ?? 4, 8));
const companyFilter = stringArg("--company")?.toLowerCase();
const now = new Date().toISOString();
const MAX_OFFICIAL_DISCOVERY_SOURCES = 12;
const MAX_LINK_BIO_PAGES_PER_SOURCE = 4;
const MAX_SECOND_HOP_DISCOVERY_PAGES = 5;
const LINK_IN_BIO_HOSTS = /(?:^|\.)?(?:linktr\.ee|bio\.link|bio\.site|beacons\.ai|bento\.me|lnk\.bio|solo\.to|taplink\.cc|carrd\.co|allmylinks\.com|linkin\.bio|msha\.ke|hoo\.be|campsite\.bio|withkoji\.com|koji\.to|stan\.store|flow\.page|about\.me)$/i;
const PUBLIC_PROFILE_DISCOVERY_HOSTS = /(?:^|\.)?(?:x\.com|twitter\.com|mobile\.twitter\.com|linkedin\.com)$/i;

const snapshot = JSON.parse(await readFile(ycSnapshotPath, "utf8"));
const overrides = await readJson(overridesPath, {});
const filteredCompanies = snapshot.companies.filter(
  (company) => !companyFilter || company.slug === companyFilter || company.name.toLowerCase().includes(companyFilter)
);
const companies = filteredCompanies.slice(offsetCompanies, offsetCompanies + maxCompanies);

const candidates = [];
const attempts = [];
let verifiedCount = 0;
let verifiedFounderCount = 0;

await runWorkerPool(companies, workers, async (company) => {
  const existing = overrides[company.slug]?.companySocialLinks?.instagram;
  const officialLinks = skipOfficialDiscovery ? [] : await discoverFromOfficialPages(company);
  const selectedOfficialLink = officialLinks[0] ?? null;
  if (!skipOfficialDiscovery) {
    attempts.push(
      discoveryAttempt({
        company,
        entityType: "company",
        entityName: company.name,
        query: company.websiteUrl ?? "official website unavailable",
        source: "official-website",
        resultCount: officialLinks.length,
        usefulResultCount: officialLinks.length,
        status: officialLinks.length ? "verified" : "no_results",
        selectedUrl: officialLinks[0]?.url ?? null,
        failureReason: officialLinks.length ? null : "No Instagram profile link found on official website or linked bio pages."
      })
    );
  }
  for (const link of officialLinks) {
    candidates.push(candidate(company, link.url, "verified", link.reason, link.sourceUrl));
  }

  if (selectedOfficialLink) {
    const existingCanonical = canonicalInstagramProfileUrl(existing);
    const selectedCanonical = canonicalInstagramProfileUrl(selectedOfficialLink.url);
    if (!existingCanonical || existingCanonical !== selectedCanonical || forceDiscovery) {
      setCompanyOverride(company, selectedOfficialLink.url, selectedOfficialLink.reason);
      verifiedCount += 1;
    }
    verifiedFounderCount += await discoverOfficialFounderOverrides(company);
    return;
  }

  if (!existing && officialLinks.length) {
    const selected = officialLinks[0];
    setCompanyOverride(company, selected.url, selected.reason);
    verifiedCount += 1;
    return;
  }

  if (search && (!existing || forceDiscovery) && !officialLinks.length) {
    const rows = await searchInstagram(company).catch((error) => {
      attempts.push(
        discoveryAttempt({
          company,
          entityType: "company",
          entityName: company.name,
          query: company.name,
          source: "opencli:instagram-search",
          resultCount: 0,
          usefulResultCount: 0,
          status: "failed",
          selectedUrl: null,
          failureReason: `OpenCLI Instagram search failed: ${errorMessage(error)}`
        })
      );
      return [
      {
        url: null,
        entityType: "company",
        entityName: company.name,
        review_state: "failed",
        matchReason: `OpenCLI Instagram search failed: ${errorMessage(error)}`
      }
      ];
    });
    attempts.push(
      discoveryAttempt({
        company,
        entityType: "company",
        entityName: company.name,
        query: company.name,
        source: "opencli:instagram-search",
        resultCount: rows.length,
        usefulResultCount: rows.filter((row) => row.url).length,
        status: rows.some((row) => row.review_state === "verified") ? "verified" : rows.length ? "needs_review" : "no_results",
        selectedUrl: rows.find((row) => row.url)?.url ?? null,
        failureReason: rows.length ? null : "OpenCLI Instagram search returned no candidates."
      })
    );
    for (const row of rows) {
      candidates.push(candidate(company, row.url, row.review_state, row.matchReason, "opencli:instagram-search", row));
      if (promoteSearch && row.review_state === "verified") {
        setCompanyOverride(company, row.url, row.matchReason);
        verifiedCount += 1;
        break;
      }
    }
  }

  if (webSearch && (!existing || forceDiscovery) && !officialLinks.length) {
    const result = await webSearchInstagram(company).catch((error) => ({
      rows: [],
      failures: [{ query: webQueriesForCompany(company).join(" | "), source: "duckduckgo:html", reason: errorMessage(error) }],
      completedQueries: 0
    }));
    const rows = result.rows;
    const webFailureReason = webSearchFailureReason(
      result.failures,
      "Search returned no Instagram profile candidates.",
      result.completedQueries
    );
    attempts.push(
      discoveryAttempt({
        company,
        entityType: "company",
        entityName: company.name,
        query: webQueriesForCompany(company).join(" | "),
        source: "duckduckgo:html",
        resultCount: rows.length,
        usefulResultCount: rows.filter((row) => row.url).length,
        status: rows.some((row) => row.review_state === "verified")
          ? "verified"
          : rows.some((row) => row.review_state === "rejected")
            ? rows.some((row) => row.review_state === "needs_review")
              ? "needs_review"
              : "rejected"
          : rows.length
            ? "needs_review"
            : !result.completedQueries && result.failures.length
              ? "failed"
              : "no_results",
        selectedUrl: selectedCandidateUrl(rows),
        failureReason: rows.length ? null : webFailureReason
      })
    );
    for (const row of rows) {
      candidates.push(candidate(company, row.url, row.review_state, row.matchReason, row.sourceUrl ?? row.source ?? "duckduckgo:html", row));
      if (promoteSearch && row.review_state === "verified") {
        setCompanyOverride(company, row.url, row.matchReason);
        verifiedCount += 1;
        break;
      }
    }
  }

  verifiedFounderCount += await discoverOfficialFounderOverrides(company);

  if (search && includeFounders) {
    for (const founder of company.founders ?? []) {
      const existingFounderInstagram = existingFounderOverride(company, founder)?.socialLinks?.instagram ?? founder.socialLinks?.instagram;
      if (existingFounderInstagram && !forceDiscovery) continue;

      const rows = await searchFounderInstagram(company, founder).catch((error) => {
        attempts.push(
          discoveryAttempt({
            company,
            entityType: "founder",
            entityName: founder.name,
            query: `${founder.name} ${company.name}`,
            source: "opencli:instagram-founder-search",
            resultCount: 0,
            usefulResultCount: 0,
            status: "failed",
            selectedUrl: null,
            failureReason: `OpenCLI Instagram founder search failed: ${errorMessage(error)}`
          })
        );
        return [
        {
          url: null,
          entityType: "founder",
          entityName: founder.name,
          review_state: "failed",
          matchReason: `OpenCLI Instagram founder search failed: ${errorMessage(error)}`
        }
        ];
      });
      attempts.push(
        discoveryAttempt({
          company,
          entityType: "founder",
          entityName: founder.name,
          query: `${founder.name} ${company.name} | ${founder.name}`,
          source: "opencli:instagram-founder-search",
          resultCount: rows.length,
          usefulResultCount: rows.filter((row) => row.url).length,
          status: rows.some((row) => row.review_state === "verified") ? "verified" : rows.length ? "needs_review" : "no_results",
          selectedUrl: rows.find((row) => row.review_state === "verified")?.url ?? rows.find((row) => row.url)?.url ?? null,
          failureReason: rows.length ? null : "OpenCLI Instagram founder search returned no candidates."
        })
      );
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

  if (webSearch && includeFounders) {
    for (const founder of company.founders ?? []) {
      const existingFounderInstagram = existingFounderOverride(company, founder)?.socialLinks?.instagram ?? founder.socialLinks?.instagram;
      if (existingFounderInstagram && !forceDiscovery) continue;

      const result = await webSearchFounderInstagram(company, founder).catch((error) => ({
        rows: [],
        failures: [{ query: webQueriesForFounder(company, founder).join(" | "), source: "duckduckgo:html-founder", reason: errorMessage(error) }],
        completedQueries: 0
      }));
      const rows = result.rows;
      const webFailureReason = webSearchFailureReason(
        result.failures,
        "Search returned no founder Instagram profile candidates.",
        result.completedQueries
      );
      attempts.push(
        discoveryAttempt({
          company,
          entityType: "founder",
          entityName: founder.name,
          query: webQueriesForFounder(company, founder).join(" | "),
          source: "duckduckgo:html-founder",
          resultCount: rows.length,
          usefulResultCount: rows.filter((row) => row.url).length,
          status: rows.some((row) => row.review_state === "verified")
            ? "verified"
            : rows.length
              ? "needs_review"
              : !result.completedQueries && result.failures.length
                ? "failed"
                : "no_results",
          selectedUrl: rows.find((row) => row.review_state === "verified")?.url ?? rows.find((row) => row.url)?.url ?? null,
          failureReason: rows.length ? null : webFailureReason
        })
      );
      for (const row of rows) {
        candidates.push(candidate(company, row.url, row.review_state, row.matchReason, row.sourceUrl ?? row.source ?? "duckduckgo:html-founder", row));
        if (promoteFounderSearch && row.review_state === "verified") {
          setFounderOverride(company, founder, row.url, row.matchReason);
          verifiedFounderCount += 1;
          break;
        }
      }
    }
  }
});

const prunedWebOverrides = pruneWebOverrides ? pruneWebVerifiedCompanyOverrides() : [];

let report = {
  generated_at: now,
  write_enabled: write,
  append_enabled: appendReport,
  searched_with_opencli: search,
  searched_with_web: webSearch,
  skipped_official_discovery: skipOfficialDiscovery,
  forced_discovery_for_existing_profiles: forceDiscovery,
  pruned_web_verified_overrides: prunedWebOverrides,
  promote_search_enabled: promoteSearch,
  include_founders: includeFounders,
  promote_founder_search_enabled: promoteFounderSearch,
  company_offset: offsetCompanies,
  companies_available: filteredCompanies.length,
  companies_checked: companies.length,
  verified_company_instagram_profiles: Object.values(overrides).filter((item) => item?.companySocialLinks?.instagram).length,
  verified_founder_instagram_profiles: Object.values(overrides).flatMap((item) => item?.founders ?? []).filter((founder) => founder?.socialLinks?.instagram).length,
  newly_verified_in_this_run: verifiedCount,
  newly_verified_founders_in_this_run: verifiedFounderCount,
  attempts,
  candidates
};

if (appendReport) {
  report = mergeDiscoveryReports(await readJson(candidatesPath, null), report);
}

await writeJson(candidatesPath, report);
if (write) {
  await writeJson(overridesPath, sortObject(overrides));
}

console.log(
  JSON.stringify(
    {
      outputPath: candidatesPath,
      write,
      offset: offsetCompanies,
      companiesAvailable: filteredCompanies.length,
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
  const visited = new Set();
  const found = [];

  for (const source of companyOfficialInstagramSources(company).slice(0, MAX_OFFICIAL_DISCOVERY_SOURCES)) {
    await crawlInstagramDiscoverySource(company, source, found, visited);
  }

  return dedupeLinks(found);
}

async function discoverOfficialFounderOverrides(company) {
  if (skipOfficialDiscovery || !includeFounders) return 0;
  let promotedCount = 0;

  for (const founder of company.founders ?? []) {
    const existingFounderInstagram = existingFounderOverride(company, founder)?.socialLinks?.instagram ?? founder.socialLinks?.instagram;
    if (existingFounderInstagram && !forceDiscovery) continue;

    const links = await discoverFromFounderPublicPages(company, founder);
    const verifiedLinks = links.filter((link) => link.review_state === "verified");
    attempts.push(
      discoveryAttempt({
        company,
        entityType: "founder",
        entityName: founder.name,
        query: founderPublicSourceQuery(company, founder),
        source: "official-founder-public-sources",
        resultCount: links.length,
        usefulResultCount: verifiedLinks.length,
        status: verifiedLinks.length ? "verified" : links.length ? "needs_review" : "no_results",
        selectedUrl: verifiedLinks[0]?.url ?? links[0]?.url ?? null,
        failureReason: links.length
          ? null
          : "No Instagram profile link found on YC-linked founder pages, X/LinkedIn public bios, personal sites, or linked bio pages."
      })
    );

    for (const link of links) {
      candidates.push(
        candidate(company, link.url, link.review_state, link.reason, link.sourceUrl, {
          ...link,
          entityType: "founder",
          entityName: founder.name
        })
      );
    }

    const selected = verifiedLinks[0] ?? null;
    if (!selected) continue;

    const existingCanonical = canonicalInstagramProfileUrl(existingFounderInstagram);
    const selectedCanonical = canonicalInstagramProfileUrl(selected.url);
    if (!existingCanonical || existingCanonical !== selectedCanonical || forceDiscovery) {
      setFounderOverride(company, founder, selected.url, selected.reason);
      promotedCount += 1;
    }
  }

  return promotedCount;
}

async function discoverFromFounderPublicPages(company, founder) {
  const visited = new Set();
  const found = [];
  for (const source of founderOfficialInstagramSources(company, founder).slice(0, MAX_OFFICIAL_DISCOVERY_SOURCES)) {
    await crawlInstagramDiscoverySource(company, source, found, visited);
  }

  return dedupeLinks(found).map((link) => {
    const verification = founderOfficialVerification(company, founder, link);
    return {
      ...link,
      review_state: verification.review_state,
      reason: `${link.reason} ${verification.reason}`
    };
  });
}

async function crawlInstagramDiscoverySource(company, source, found, visited) {
  const rootUrl = source.rootUrl ?? source.url ?? source.sourceUrl ?? company.websiteUrl ?? "yc-snapshot";
  const baseUrl = source.sourceUrl ?? source.url ?? rootUrl;
  if (source.text) {
    collectInstagramLinks(found, company, baseUrl, source.text, source.reason, {
      rootUrl,
      sourceLabel: source.label
    });
    await crawlLinkInBioPages(company, source.text, baseUrl, rootUrl, source.label, found, visited);
    return;
  }

  const normalized = normalizeUrl(source.url);
  if (!normalized || visited.has(normalized)) return;
  visited.add(normalized);

  const page = await fetchDiscoveryPage(normalized, source).catch(() => null);
  if (!page?.text) return;

  collectInstagramLinks(found, company, page.url, page.text, source.reason, {
    rootUrl,
    sourceLabel: source.label
  });
  await crawlLinkInBioPages(company, page.text, page.url, rootUrl, source.label, found, visited);
}

async function crawlLinkInBioPages(company, text, baseUrl, rootUrl, sourceLabel, found, visited) {
  const linkPages = extractLinkPageUrls(text, baseUrl).slice(0, MAX_LINK_BIO_PAGES_PER_SOURCE);
  for (const linkPage of linkPages) {
    const normalized = normalizeUrl(linkPage);
    if (!normalized || visited.has(normalized)) continue;
    visited.add(normalized);
    const page = await fetchDiscoveryPage(normalized, {
      label: `${sourceLabel} link-in-bio`,
      preferReader: false,
      timeoutMs: 15_000
    }).catch(() => null);
    if (!page?.text) continue;
    collectInstagramLinks(
      found,
      company,
      page.url,
      page.text,
      `Found through a public link-in-bio page linked from ${sourceLabel}.`,
      { rootUrl, sourceLabel: `${sourceLabel} link-in-bio` }
    );
  }
}

function companyOfficialInstagramSources(company) {
  const sources = [];
  addLocalDiscoveryText(sources, {
    label: "YC company snapshot",
    sourceUrl: company.ycProfileUrl ?? company.websiteUrl ?? `yc-snapshot:${company.slug}`,
    rootUrl: company.ycProfileUrl ?? company.websiteUrl ?? `yc-snapshot:${company.slug}`,
    reason: "Found in YC company snapshot metadata.",
    text: discoveryText([
      company.name,
      company.slug,
      company.description,
      company.longDescription,
      company.oneLiner,
      company.websiteUrl,
      company.ycProfileUrl,
      socialUrls(company).join(" ")
    ])
  });
  addDiscoveryPage(sources, company.websiteUrl, {
    label: "official company website",
    reason: "Found as an outbound Instagram profile link on the official company website.",
    rootUrl: company.websiteUrl,
    preferReader: false
  });
  for (const url of socialUrls(company, "x")) {
    addDiscoveryPage(sources, url, {
      label: "YC-linked company X public profile",
      reason: "Found from a YC-linked company X/Twitter public profile or bio.",
      rootUrl: url,
      preferReader: true
    });
  }
  for (const url of socialUrls(company, "linkedin")) {
    addDiscoveryPage(sources, url, {
      label: "YC-linked public LinkedIn company page",
      reason: "Found from a YC-linked public LinkedIn company page.",
      rootUrl: url,
      preferReader: true
    });
  }
  return dedupeDiscoverySources(sources);
}

function founderOfficialInstagramSources(company, founder) {
  const sources = [];
  addLocalDiscoveryText(sources, {
    label: `YC founder snapshot for ${founder.name}`,
    sourceUrl: founder.ycProfileUrl ?? company.ycProfileUrl ?? company.websiteUrl ?? `yc-founder:${company.slug}:${slugify(founder.name)}`,
    rootUrl: founder.ycProfileUrl ?? company.ycProfileUrl ?? company.websiteUrl ?? `yc-founder:${company.slug}:${slugify(founder.name)}`,
    reason: `Found in YC founder snapshot metadata for ${founder.name}.`,
    text: discoveryText([
      founder.name,
      founder.title,
      founder.bio,
      founder.description,
      founder.ycProfileUrl,
      founder.websiteUrl,
      socialUrls(founder).join(" ")
    ])
  });
  addDiscoveryPage(sources, founder.ycProfileUrl, {
    label: `${founder.name} public YC profile`,
    reason: `Found from ${founder.name}'s public YC founder profile.`,
    rootUrl: founder.ycProfileUrl,
    preferReader: false
  });
  addDiscoveryPage(sources, founder.websiteUrl, {
    label: `${founder.name} personal website`,
    reason: `Found from ${founder.name}'s public personal website.`,
    rootUrl: founder.websiteUrl,
    preferReader: false
  });
  for (const url of socialUrls(founder, "x")) {
    addDiscoveryPage(sources, url, {
      label: `${founder.name} public X profile`,
      reason: `Found from ${founder.name}'s public X/Twitter profile or bio.`,
      rootUrl: url,
      preferReader: true
    });
  }
  for (const url of socialUrls(founder, "linkedin")) {
    addDiscoveryPage(sources, url, {
      label: `${founder.name} public LinkedIn profile`,
      reason: `Found from ${founder.name}'s public LinkedIn profile.`,
      rootUrl: url,
      preferReader: true
    });
  }
  return dedupeDiscoverySources(sources);
}

function addLocalDiscoveryText(sources, source) {
  if (!source.text?.trim()) return;
  sources.push({ ...source, type: "text" });
}

function addDiscoveryPage(sources, url, source) {
  const normalized = normalizeUrl(url);
  if (!normalized) return;
  sources.push({
    ...source,
    type: "page",
    url: normalized,
    sourceUrl: normalized,
    rootUrl: source.rootUrl ?? normalized,
    preferReader: source.preferReader ?? shouldPreferReader(normalized)
  });
}

function dedupeDiscoverySources(sources) {
  const byKey = new Map();
  for (const source of sources) {
    const key = source.url ?? source.sourceUrl ?? `${source.label}:${normalizeToken(source.text)}`;
    if (!byKey.has(key)) byKey.set(key, source);
  }
  return [...byKey.values()];
}

function discoveryText(values) {
  return values.filter(Boolean).map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join(" ");
}

function socialUrls(entity, platform = null) {
  const links = entity?.socialLinks ?? {};
  const rawValues = platform
    ? platform === "x"
      ? [links.x, links.twitter, entity?.xUrl, entity?.twitterUrl]
      : platform === "linkedin"
        ? [links.linkedin, entity?.linkedinUrl, entity?.linkedInUrl]
        : [links[platform], entity?.[`${platform}Url`]]
    : [
        links.instagram,
        links.x,
        links.twitter,
        links.linkedin,
        links.github,
        entity?.instagramUrl,
        entity?.xUrl,
        entity?.twitterUrl,
        entity?.linkedinUrl,
        entity?.linkedInUrl
      ];
  return [...new Set(rawValues.filter(Boolean).map(String))];
}

function founderPublicSourceQuery(company, founder) {
  return [
    founder.ycProfileUrl,
    founder.websiteUrl,
    ...socialUrls(founder, "x"),
    ...socialUrls(founder, "linkedin"),
    `"${founder.name}" "${company.name}" public profile`
  ]
    .filter(Boolean)
    .join(" | ");
}

function founderOfficialVerification(company, founder, link) {
  const handle = instagramHandleFromUrl(link.url);
  const normalizedHandle = normalizeToken(handle);
  const founderName = String(founder.name ?? "");
  const founderTokens = founderName.split(/\s+/).map(normalizeToken).filter((token) => token.length > 1);
  const founderMatch = founderTokens.length > 0 && (
    normalizedHandle === normalizeToken(founderName) ||
    founderTokens.every((token) => normalizedHandle.includes(token))
  );
  const companyLike = companyCorroborationTokens(company, founder).some((token) => token && normalizedHandle === token);

  if (founderMatch && !companyLike) {
    return {
      review_state: "verified",
      reason: `Auto-verified as founder Instagram because handle "${handle}" matches founder name tokens and does not look like a company handle.`
    };
  }

  return {
    review_state: "needs_review",
    reason: `Needs review before founder attribution; founderHandleMatch=${founderMatch}, companyLikeHandle=${companyLike}.`
  };
}

function collectInstagramLinks(found, company, sourceUrl, text, reason, options = {}) {
  for (const url of extractInstagramProfileUrls(text)) {
    found.push({
      url,
      sourceUrl,
      sourceLabel: options.sourceLabel ?? null,
      reason: `${reason} Source chain starts from ${options.rootUrl ?? company.websiteUrl ?? sourceUrl}.`
    });
  }
}

function extractInstagramProfileUrls(text) {
  const urls = new Set();
  const addUrl = (rawUrl) => {
    const url = canonicalInstagramProfileUrl(rawUrl);
    if (url) urls.add(url);
  };

  const redirectRegex = /[?&]uddg=([^&)\s]+)/gi;
  let redirectMatch;
  while ((redirectMatch = redirectRegex.exec(text))) {
    try {
      addUrl(decodeURIComponent(redirectMatch[1]));
    } catch {
      // Ignore malformed redirect parameters from search result pages.
    }
  }

  const regex = /(?:(?:https?:)?\\?\/\\?\/)?(?:www\\?\.)?instagram\.com\\?\/([A-Za-z0-9._]{2,40})(?:[/?#"')\s]|&quot;|&amp;|$)/gi;
  let match;
  while ((match = regex.exec(text))) {
    const handle = match[1]?.replace(/^@/, "").replace(/[.]+$/, "");
    if (!handle || isLowValueInstagramHandle(handle)) continue;
    addUrl(`https://www.instagram.com/${handle}/`);
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
    if (isLinkInBioUrl(url)) {
      urls.add(url);
    }
  }
  return [...urls];
}

function isLinkInBioUrl(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.replace(/^www\./, "");
    return LINK_IN_BIO_HOSTS.test(host);
  } catch {
    return false;
  }
}

function extractPublicDiscoveryPageUrls(text, baseUrl, company) {
  const urls = new Set();
  for (const raw of extractUrlsFromText(text)) {
    const url = absoluteUrl(raw, baseUrl);
    if (!url || !isAllowedSecondHopDiscoveryUrl(url, company)) continue;
    const normalized = normalizeUrl(url);
    if (normalized) urls.add(normalized);
  }
  return [...urls];
}

function extractUrlsFromText(text) {
  const urls = new Set();
  const redirectRegex = /[?&]uddg=([^&)\s]+)/gi;
  let redirectMatch;
  while ((redirectMatch = redirectRegex.exec(text))) {
    try {
      urls.add(decodeURIComponent(redirectMatch[1]));
    } catch {
      // Ignore malformed redirect parameters.
    }
  }

  const urlRegex = /https?:\\?\/\\?\/[^\s"'<>()[\]{}]+/gi;
  let match;
  while ((match = urlRegex.exec(text))) {
    urls.add(match[0].replace(/\\\//g, "/").replace(/[.,;:]+$/, ""));
  }
  return [...urls];
}

function isAllowedSecondHopDiscoveryUrl(rawUrl, company) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.replace(/^www\./, "");
    const path = url.pathname.toLowerCase();
    if (isLinkInBioUrl(url.toString())) return true;
    if (isSameHost(url.toString(), company.websiteUrl)) return true;
    if (!PUBLIC_PROFILE_DISCOVERY_HOSTS.test(host)) return false;
    if (/(?:^|\.)linkedin\.com$/i.test(host)) {
      return /^\/(?:company|in)\//i.test(path);
    }
    if (/(?:^|\.)twitter\.com$/i.test(host) || /(?:^|\.)x\.com$/i.test(host)) {
      const firstSegment = path.split("/").filter(Boolean)[0];
      return Boolean(firstSegment) && !/^(?:home|explore|search|i|intent|share|settings|privacy|tos)$/i.test(firstSegment);
    }
    return false;
  } catch {
    return false;
  }
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

async function webSearchInstagram(company) {
  const result = await runWebQueries(webQueriesForCompany(company), company);
  return {
    rows: evaluateWebRows(company, null, result.rows),
    failures: result.failures,
    completedQueries: result.completedQueries
  };
}

async function webSearchFounderInstagram(company, founder) {
  const result = await runWebQueries(webQueriesForFounder(company, founder), company);
  return {
    rows: evaluateWebRows(company, founder, result.rows),
    failures: result.failures,
    completedQueries: result.completedQueries
  };
}

async function runWebQueries(queries, company) {
  const rows = [];
  const failures = [];
  let completedQueries = 0;
  for (const query of queries) {
    const page = await fetchPublicSearchPage(query, failures);
    if (!page?.text) {
      await delay(750);
      continue;
    }
    completedQueries += 1;
    const links = extractInstagramProfileUrls(page.text).slice(0, 8);
    for (const link of links) {
      rows.push({ url: link, query, source: page.source, sourceUrl: page.sourceUrl });
    }

    const discoveryPages = extractPublicDiscoveryPageUrls(page.text, page.sourceUrl, company).slice(
      0,
      MAX_SECOND_HOP_DISCOVERY_PAGES
    );
    for (const discoveryUrl of discoveryPages) {
      const secondHop = await fetchDiscoveryPage(discoveryUrl, {
        label: "public search result profile",
        preferReader: shouldPreferReader(discoveryUrl),
        timeoutMs: 15_000
      }).catch((error) => {
        failures.push({ query, source: "public-search-second-hop", url: discoveryUrl, reason: errorMessage(error) });
        return null;
      });
      if (!secondHop?.text) continue;
      const secondHopLinks = extractInstagramProfileUrls(secondHop.text).slice(0, 4);
      for (const link of secondHopLinks) {
        rows.push({
          url: link,
          query,
          source: `${page.source}:second-hop`,
          sourceUrl: discoveryUrl
        });
      }
      await delay(250);
    }
    await delay(500);
  }
  return {
    rows: [...new Map(rows.map((row) => [row.url, row])).values()],
    failures,
    completedQueries
  };
}

async function fetchPublicSearchPage(query, failures) {
  const encodedQuery = encodeURIComponent(query);
  const providers = [
    {
      source: "jina-reader:duckduckgo-html",
      url: `https://r.jina.ai/http://duckduckgo.com/html/?q=${encodedQuery}`,
      retries: 0,
      timeoutMs: 20_000
    },
    {
      source: "duckduckgo:html",
      url: `https://duckduckgo.com/html/?q=${encodedQuery}`,
      retries: 1,
      timeoutMs: 20_000
    }
  ];

  for (const provider of providers) {
    const page = await fetchText(provider.url, { retries: provider.retries, timeoutMs: provider.timeoutMs }).catch((error) => {
      failures.push({ query, source: provider.source, url: provider.url, reason: errorMessage(error) });
      return null;
    });
    if (page?.text) {
      return { ...page, source: provider.source, sourceUrl: provider.url };
    }
  }

  return null;
}

function webSearchFailureReason(failures, fallback, completedQueries = 0) {
  if (!failures?.length) return fallback;
  const summary = failures
    .slice(0, 4)
    .map((failure) => `${failure.query} via ${failure.source}: ${failure.reason}`)
    .join("; ");
  const suffix = failures.length > 4 ? `; ${failures.length - 4} more query failures` : "";
  if (completedQueries > 0) {
    return `${fallback} Some search transports failed while at least one public result page was still evaluated. ${summary}${suffix}`;
  }
  return `Web search request failed before candidates could be evaluated. ${summary}${suffix}`;
}

function evaluateWebRows(company, founder, rows) {
  const evaluated = [];
  for (const row of rows) {
    const url = canonicalInstagramProfileUrl(row.url);
    if (!url) continue;
    const username = instagramHandleFromUrl(url);
    if (!username) continue;
    const normalizedUsername = normalizeToken(username);
    const verification = companyWebVerification(company, normalizedUsername);

    if (!founder) {
      const rejected = isRejectedInstagramCandidate(company, url);
      evaluated.push({
        ...row,
        url,
        entityType: "company",
        entityName: company.name,
        review_state: rejected ? "rejected" : "needs_review",
        matchReason:
          rejected
            ? `Previous Instagram identity guard rejected ${url} for ${company.name}; keeping search hit out of scoring.`
            : verification.verified
            ? `Web Instagram search candidate has ${verification.reason} for ${company.name}; query="${row.query}". Live profile/linkback validation is still required before scoring.`
            : `Web Instagram search candidate for ${company.name}; query="${row.query}", ${verification.reason}.`
      });
      continue;
    }

    const founderTokens = founder.name.split(/\s+/).map(normalizeToken).filter((token) => token.length > 1);
    const founderHandleMatch =
      normalizedUsername === normalizeToken(founder.name) ||
      founderTokens.every((token) => normalizedUsername.includes(token));
    evaluated.push({
      ...row,
      url,
      entityType: "founder",
      entityName: founder.name,
      review_state: "needs_review",
      matchReason: `Web Instagram founder candidate for ${founder.name} at ${company.name}; query="${row.query}", founderHandleMatch=${founderHandleMatch}.`
    });
  }
  return evaluated;
}

function companyWebVerification(company, normalizedUsername) {
  const normalizedCompany = normalizeToken(company.name);
  const normalizedSlug = normalizeToken(company.slug);
  const normalizedHost = normalizeToken(hostBase(company.websiteUrl));
  const normalizedFullHost = normalizeToken(hostFullToken(company.websiteUrl));
  const ambiguous = isAmbiguousCompanyName(company.name);
  const exactFullHost = Boolean(
    normalizedFullHost && normalizedFullHost.length >= 6 && normalizedUsername === normalizedFullHost
  );
  const exactHost = Boolean(normalizedHost && normalizedHost.length >= 5 && normalizedUsername === normalizedHost);
  const exactSlug = Boolean(normalizedSlug && normalizedSlug.length >= 7 && normalizedUsername === normalizedSlug);
  const exactCompanyName = Boolean(normalizedCompany && normalizedCompany.length >= 8 && normalizedUsername === normalizedCompany);

  if (exactFullHost && !ambiguous) {
    return { verified: true, reason: `a full official-domain Instagram handle match (${normalizedFullHost})` };
  }

  return {
    verified: false,
    reason: `auto-verify rejected; exactFullHost=${exactFullHost}, exactHost=${exactHost}, exactSlug=${exactSlug}, exactCompanyName=${exactCompanyName}, ambiguous=${ambiguous}`
  };
}

function webQueriesForCompany(company) {
  const queries = [
    `"${company.name}" Instagram`,
    `"${company.name}" "Y Combinator" Instagram`,
    `"${company.name}" site:instagram.com`,
    `"${company.name}" "YC Spring 2026" Instagram`,
    `"${company.name}" site:x.com Instagram`,
    `"${company.name}" site:twitter.com Instagram`,
    `"${company.name}" site:linkedin.com/company Instagram`,
    `"${company.name}" "linktr.ee" Instagram`,
    `"${company.name}" "bio.link" Instagram`
  ];
  const domain = hostBase(company.websiteUrl);
  if (domain) {
    queries.push(`"${domain}" Instagram`);
    queries.push(`"${domain}" site:instagram.com`);
    queries.push(`"${domain}" site:x.com Instagram`);
  }
  return dedupeQueries(queries);
}

function webQueriesForFounder(company, founder) {
  return dedupeQueries([
    `"${founder.name}" "${company.name}" Instagram`,
    `"${founder.name}" "${company.name}" site:instagram.com`,
    `"${founder.name}" "Y Combinator" Instagram`,
    `"${founder.name}" "${company.name}" site:x.com Instagram`,
    `"${founder.name}" "${company.name}" site:twitter.com Instagram`,
    `"${founder.name}" "${company.name}" site:linkedin.com/in Instagram`,
    `"${founder.name}" "${company.name}" "linktr.ee"`,
    `"${founder.name}" "${company.name}" "bio.link"`
  ]);
}

function dedupeQueries(queries) {
  return [...new Set(queries.filter(Boolean))];
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

  if (isRejectedInstagramCandidate(company, url)) {
    return {
      url,
      entityType: "company",
      entityName: company.name,
      review_state: "rejected",
      matchReason: `Previous Instagram identity guard rejected ${url} for ${company.name}; keeping OpenCLI search hit out of scoring.`
    };
  }

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
      review_state: "needs_review",
      matchReason: `OpenCLI Instagram search returned exact non-ambiguous handle/name match for ${company.name}; query="${query}". Live profile/linkback validation is still required before scoring.`
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

function pruneWebVerifiedCompanyOverrides() {
  const pruned = [];
  for (const company of snapshot.companies) {
    const current = overrides[company.slug];
    const instagramUrl = current?.companySocialLinks?.instagram;
    if (!instagramUrl || !/^Web Instagram search /i.test(current.matchReason || "")) continue;

    const username = instagramHandleFromUrl(instagramUrl);
    const verification = companyWebVerification(company, normalizeToken(username));
    if (verification.verified) continue;

    const nextCompanySocialLinks = { ...(current.companySocialLinks ?? {}) };
    delete nextCompanySocialLinks.instagram;
    overrides[company.slug] = {
      ...current,
      companySocialLinks: nextCompanySocialLinks,
      prunedInstagram: {
        url: instagramUrl,
        matchReason: current.matchReason,
        prunedAt: now,
        pruneReason: verification.reason
      }
    };
    pruned.push({
      companySlug: company.slug,
      companyName: company.name,
      instagramUrl,
      reason: verification.reason
    });
  }
  return pruned;
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

function discoveryAttempt({
  company,
  entityType,
  entityName,
  query,
  source,
  resultCount,
  usefulResultCount,
  status,
  selectedUrl,
  failureReason
}) {
  return {
    companySlug: company.slug,
    companyName: company.name,
    entityType,
    entityName,
    platform: "instagram",
    query,
    source,
    result_count: resultCount,
    useful_result_count: usefulResultCount,
    selected_url: selectedUrl,
    status,
    failure_reason: failureReason,
    created_at: now
  };
}

function mergeDiscoveryReports(previous, current) {
  if (!previous || typeof previous !== "object") {
    return current;
  }

  const attempts = dedupeByKey([...(previous.attempts ?? []), ...(current.attempts ?? [])], attemptKey);
  const candidates = dedupeByKey([...(previous.candidates ?? []), ...(current.candidates ?? [])], candidateKey);
  const checkedCompanies = new Set([
    ...attempts.map((attempt) => attempt.companySlug).filter(Boolean),
    ...candidates.map((candidate) => candidate.companySlug).filter(Boolean)
  ]);

  return {
    ...previous,
    ...current,
    generated_at: current.generated_at,
    previous_generated_at: previous.generated_at ?? null,
    companies_checked: checkedCompanies.size || current.companies_checked,
    attempts,
    candidates,
    newly_verified_in_this_run: current.newly_verified_in_this_run,
    newly_verified_founders_in_this_run: current.newly_verified_founders_in_this_run,
    cumulative_candidate_count: candidates.length,
    cumulative_attempt_count: attempts.length
  };
}

function dedupeByKey(rows, getKey) {
  const byKey = new Map();
  for (const row of rows) {
    const key = getKey(row);
    const existing = byKey.get(key);
    byKey.set(key, mergeDiscoveryRow(existing, row));
  }
  return [...byKey.values()];
}

function mergeDiscoveryRow(existing, incoming) {
  if (!existing) {
    return incoming;
  }

  const incomingState = incoming.review_state ?? incoming.status;
  const existingState = existing.review_state ?? existing.status;
  const incomingRank = reviewStateRank(incomingState);
  const existingRank = reviewStateRank(existingState);
  const preserveExistingState = incomingState !== "rejected" && existingRank >= 4 && existingRank > incomingRank;
  const previousStatus =
    existingState && existingState !== incomingState ? existingState : existing.previous_status ?? incoming.previous_status;
  const previousFailureReason =
    existing.failure_reason && existing.failure_reason !== incoming.failure_reason
      ? existing.failure_reason
      : existing.previous_failure_reason ?? incoming.previous_failure_reason;
  return {
    ...existing,
    ...incoming,
    ...(preserveExistingState ? { review_state: existing.review_state, status: existing.status } : {}),
    ...(previousStatus ? { previous_status: previousStatus } : {}),
    ...(previousFailureReason ? { previous_failure_reason: previousFailureReason } : {}),
    failure_reason: incoming.failure_reason ?? (incomingRank >= 4 ? null : existing.failure_reason ?? null),
    created_at: existing.created_at ?? incoming.created_at,
    last_seen_at: incoming.created_at ?? now
  };
}

function attemptKey(row) {
  return [
    row.companySlug,
    row.entityType,
    normalizeToken(row.entityName),
    row.source,
    normalizeToken(row.query)
  ].join("|");
}

function candidateKey(row) {
  return [
    row.companySlug,
    row.entityType,
    normalizeToken(row.entityName),
    row.sourceUrl ?? row.source,
    canonicalInstagramProfileUrl(row.candidateUrl) ?? row.candidateUrl ?? "none"
  ].join("|");
}

function reviewStateRank(value) {
  if (value === "rejected") return 6;
  if (value === "verified") return 5;
  if (value === "needs_review") return 4;
  if (value === "failed") return 3;
  if (value === "no_results") return 2;
  return 0;
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

function hostBase(rawUrl) {
  if (!rawUrl) return null;
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, "").split(".")[0];
  } catch {
    return null;
  }
}

function hostFullToken(rawUrl) {
  if (!rawUrl) return null;
  try {
    const host = new URL(rawUrl).hostname.replace(/^www\./, "");
    const parts = host.split(".").filter(Boolean);
    if (parts.length < 2) return parts[0] ?? null;
    return parts.slice(0, 2).join("");
  } catch {
    return null;
  }
}

function isSameHost(leftUrl, rightUrl) {
  if (!leftUrl || !rightUrl) return false;
  try {
    const left = new URL(leftUrl).hostname.replace(/^www\./, "");
    const right = new URL(rightUrl).hostname.replace(/^www\./, "");
    return left === right;
  } catch {
    return false;
  }
}

function selectedCandidateUrl(rows) {
  return (
    rows.find((row) => row.review_state === "verified")?.url ??
    rows.find((row) => row.review_state === "needs_review")?.url ??
    rows.find((row) => row.url && row.review_state !== "rejected")?.url ??
    null
  );
}

function isRejectedInstagramCandidate(company, url) {
  const rejected = overrides[company.slug]?.rejectedInstagram ?? [];
  const candidate = canonicalInstagramProfileUrl(url);
  if (!candidate) return false;
  return rejected.some((item) => canonicalInstagramProfileUrl(item.url) === candidate);
}

function namesMatch(left, right) {
  return normalizeToken(left) === normalizeToken(right);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchDiscoveryPage(url, source = {}) {
  const normalized = normalizeUrl(url);
  if (!normalized) return null;
  const readerUrl = readerUrlFor(normalized);
  const fetchUrls = source.preferReader && readerUrl ? [readerUrl, normalized] : [normalized, readerUrl].filter(Boolean);
  const uniqueFetchUrls = [...new Set(fetchUrls)];
  let lastError = null;

  for (const fetchUrl of uniqueFetchUrls) {
    const page = await fetchText(fetchUrl, {
      retries: source.retries ?? 0,
      timeoutMs: source.timeoutMs ?? 15_000
    }).catch((error) => {
      lastError = error;
      return null;
    });
    if (page?.text) {
      return {
        url: normalized,
        fetchUrl,
        text: page.text
      };
    }
  }

  if (lastError) throw lastError;
  return null;
}

function shouldPreferReader(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.replace(/^www\./, "");
    return PUBLIC_PROFILE_DISCOVERY_HOSTS.test(host);
  } catch {
    return false;
  }
}

function readerUrlFor(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.hash = "";
    const path = `${url.hostname}${url.pathname}${url.search}`;
    return `https://r.jina.ai/http://${path}`;
  } catch {
    return null;
  }
}

async function fetchText(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const retries = Math.max(0, options.retries ?? 0);
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 YCNetworkMap/0.1 read-only",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Cache-Control": "no-cache"
        }
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText || ""}`.trim());
      }
      const text = await response.text();
      return { url: response.url || url, text };
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await delay(900 * (attempt + 1));
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new Error("Fetch failed");
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
    if (!/(^|\.)instagram\.com$/i.test(url.hostname)) return null;
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
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? `; cause=${error.cause.message}` : "";
  return `${error.name}: ${error.message}${cause}`;
}
