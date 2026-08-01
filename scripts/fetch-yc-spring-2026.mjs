import * as cheerio from "cheerio";
import { resolve } from "node:path";
import {
  publishCatalogAndAliasLedger,
  readJson,
  reconcileMutableYcRoster
} from "./lib/yc-mutable-roster-refresh.mjs";

const DEFAULT_BATCH_NAME = "Summer 2026";
const DIRECTORY_URL_BASE = "https://www.ycombinator.com/companies";
const ALGOLIA_QUERIES_URL = "https://45BWZJ1SGC-dsn.algolia.net/1/indexes/*/queries";
const MINIMUM_COUNT = 167;
const ALGOLIA_PAGE_SIZE = 250;
const DEFAULT_OUT_PATH = "src/lib/yc/summer-2026-companies.json";
const DEFAULT_ALIAS_LEDGER_PATH = "src/lib/yc/summer-2026-company-aliases.json";
const CONCURRENCY = 6;
const REQUEST_TIMEOUT_MS = 30_000;
const REFRESH_TIMEOUT_MS = 5 * 60_000;

async function main() {
  const config = {
    ...parseArgs(process.argv.slice(2)),
    signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS)
  };
  const directoryHtml = await fetchText(config.directoryUrl, config.signal);
  const [previousCatalog, previousAliasLedger] = await Promise.all([
    readJson(config.outPath, "existing YC catalog"),
    readJson(config.aliasLedgerPath, "existing YC alias ledger")
  ]);
  const algolia = extractAlgoliaOptions(directoryHtml);
  const listing = await fetchCompanyListing(algolia, config);

  if (!Number.isInteger(listing.nbHits) || listing.nbHits < config.minimumCount) {
    throw new Error(
      `Expected at least ${config.minimumCount} ${config.batchName} companies from YC Algolia; got nbHits=${listing.nbHits}.`
    );
  }
  if (listing.hits.length !== listing.nbHits) {
    throw new Error(
      `YC Algolia returned an incomplete ${config.batchName} page: nbHits=${listing.nbHits}, hits=${listing.hits.length}.`
    );
  }
  if (config.expectedCount !== null && listing.nbHits !== config.expectedCount) {
    throw new Error(
      `Expected exactly ${config.expectedCount} ${config.batchName} companies from YC Algolia; got ${listing.nbHits}.`
    );
  }
  validateListing(listing, config);

  const companies = await mapLimit(listing.hits, CONCURRENCY, async (hit, index) => {
    const detail = await fetchCompanyDetail(hit.slug, config.signal);
    const hitId = String(hit.id ?? hit.objectID ?? "").trim();
    const detailId = String(detail.id ?? "").trim();
    if (hitId !== detailId || (detail.slug && detail.slug !== hit.slug)) {
      throw new Error(
        `YC detail identity mismatch for ${hit.slug}: ` +
        `listing=${hitId}/${hit.slug}, detail=${detailId}/${detail.slug ?? "missing"}.`
      );
    }
    return sanitizeCompany(hit, detail, index, config);
  });

  companies.sort((left, right) => left.name.localeCompare(right.name));
  validateCompanies(companies, listing, config);

  const payload = {
    source: {
      label: "YC public directory + public company detail pages",
      directoryUrl: config.directoryUrl,
      algoliaIndex: "YCCompany_production",
      algoliaFilter: `batch:"${config.batchName}"`,
      fetchedAt: new Date().toISOString(),
      expectedCompanyCount: listing.nbHits,
      observedCompanyCount: companies.length,
      minimumCompanyCount: config.minimumCount,
      notes: [
        "Generated from public, unauthenticated YC pages.",
        "Signed image URLs, CSRF tokens, cookies, emails, and session-specific fields are intentionally not stored."
      ]
    },
    companies
  };

  const reconciliation = reconcileMutableYcRoster({
    previousCatalog,
    nextCatalog: payload,
    aliasLedger: previousAliasLedger
  });
  await publishCatalogAndAliasLedger({
    catalogPath: config.outPath,
    aliasLedgerPath: config.aliasLedgerPath,
    catalog: payload,
    aliasLedger: reconciliation.aliasLedger
  });

  console.log(
    `Wrote ${companies.length} YC ${config.batchName} companies and ` +
      `${reconciliation.appended.length} immutable-ID company alias transition(s), ` +
      `${reconciliation.appendedFounderTransitions.length} founder roster transition(s) to ${config.outPath}`
  );
}

function parseArgs(args) {
  const options = {
    batchName: DEFAULT_BATCH_NAME,
    expectedCount: null,
    minimumCount: MINIMUM_COUNT,
    outPath: DEFAULT_OUT_PATH,
    aliasLedgerPath: DEFAULT_ALIAS_LEDGER_PATH,
    directoryUrl: null
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const [flag, inlineValue] = arg.split("=", 2);
    if (!flag.startsWith("--")) {
      throw new Error(`Unknown positional argument: ${arg}`);
    }
    const value = inlineValue ?? args[index + 1];
    if (inlineValue === undefined) {
      index += 1;
    }
    if (!value) {
      throw new Error(`Missing value for ${flag}`);
    }

    switch (flag) {
      case "--batch":
      case "--batch-name":
        options.batchName = value;
        break;
      case "--expected-count":
        options.expectedCount = Number.parseInt(value, 10);
        if (!Number.isInteger(options.expectedCount) || options.expectedCount < 1) {
          throw new Error(`Invalid --expected-count value: ${value}`);
        }
        break;
      case "--minimum-count":
        options.minimumCount = Number.parseInt(value, 10);
        if (!Number.isInteger(options.minimumCount) || options.minimumCount < 1) {
          throw new Error(`Invalid --minimum-count value: ${value}`);
        }
        break;
      case "--out":
        options.outPath = value;
        break;
      case "--alias-ledger":
        options.aliasLedgerPath = value;
        break;
      case "--directory-url":
        options.directoryUrl = value;
        break;
      default:
        throw new Error(`Unknown option: ${flag}`);
    }
  }

  return {
    ...options,
    outPath: resolve(options.outPath),
    aliasLedgerPath: resolve(options.aliasLedgerPath),
    directoryUrl:
      options.directoryUrl ??
      `${DIRECTORY_URL_BASE}?batch=${encodeURIComponent(options.batchName)}`
  };
}

async function fetchText(url, signal) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "yc-network-intelligence-readonly"
    },
    signal: requestSignal(signal)
  });
  if (!response.ok) {
    throw new Error(`GET ${url} failed with HTTP ${response.status}`);
  }
  return response.text();
}

function extractAlgoliaOptions(html) {
  const match = html.match(/window\.AlgoliaOpts\s*=\s*(\{.*?\});/s);
  if (!match) {
    throw new Error("Could not find window.AlgoliaOpts in YC directory HTML.");
  }
  return JSON.parse(match[1]);
}

async function fetchCompanyListing(algolia, config) {
  const first = await fetchCompanyListingPage(algolia, config, 0, ALGOLIA_PAGE_SIZE);
  if (first.exhaustiveNbHits === false) {
    throw new Error(`YC Algolia returned a non-exhaustive ${config.batchName} result set.`);
  }
  const hits = [...first.hits];
  for (let page = 1; page < first.nbPages; page += 1) {
    const result = await fetchCompanyListingPage(algolia, config, page, ALGOLIA_PAGE_SIZE);
    if (result.nbHits !== first.nbHits || result.nbPages !== first.nbPages) {
      throw new Error(
        `YC Algolia ${config.batchName} census changed during pagination: ` +
        `initial nbHits=${first.nbHits}, page ${page} nbHits=${result.nbHits}.`
      );
    }
    if (result.exhaustiveNbHits === false) {
      throw new Error(`YC Algolia returned a non-exhaustive ${config.batchName} page ${page}.`);
    }
    hits.push(...result.hits);
  }
  const confirmation = await fetchCompanyListingPage(algolia, config, 0, 1);
  if (confirmation.nbHits !== first.nbHits) {
    throw new Error(
      `YC Algolia ${config.batchName} census changed after pagination: ` +
      `initial nbHits=${first.nbHits}, final nbHits=${confirmation.nbHits}.`
    );
  }
  return { ...first, hits };
}

async function fetchCompanyListingPage(algolia, config, page, hitsPerPage) {
  const params = new URLSearchParams({
    query: "",
    hitsPerPage: String(hitsPerPage),
    page: String(page),
    filters: `batch:"${config.batchName}"`
  });
  const body = {
    requests: [
      {
        indexName: "YCCompany_production",
        params: params.toString()
      }
    ]
  };
  const response = await fetch(ALGOLIA_QUERIES_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-algolia-application-id": algolia.app,
      "x-algolia-api-key": algolia.key
    },
    body: JSON.stringify(body),
    signal: requestSignal(config.signal)
  });
  if (!response.ok) {
    throw new Error(`Algolia query failed with HTTP ${response.status}`);
  }
  const json = await response.json();
  return json.results[0];
}

function validateListing(listing, config) {
  const seenObjectIds = new Set();
  const seenSlugs = new Set();
  for (const hit of listing.hits) {
    const objectId = String(hit?.objectID ?? hit?.id ?? "").trim();
    const slug = String(hit?.slug ?? "").trim();
    if (!objectId || !slug) {
      throw new Error(`YC Algolia returned a ${config.batchName} hit without an immutable ID or slug.`);
    }
    if (seenObjectIds.has(objectId) || seenSlugs.has(slug)) {
      throw new Error(`YC Algolia returned duplicate ${config.batchName} identity: ${objectId}/${slug}.`);
    }
    seenObjectIds.add(objectId);
    seenSlugs.add(slug);
  }
}

function validateCompanies(companies, listing, config) {
  const ids = new Set();
  const slugs = new Set();
  for (const company of companies) {
    if (company.batch !== config.batchName) {
      throw new Error(
        `YC detail page ${company.slug} belongs to ${company.batch ?? "an unknown batch"}; ` +
        `expected ${config.batchName}.`
      );
    }
    if (ids.has(company.id) || slugs.has(company.slug)) {
      throw new Error(`YC detail pages returned duplicate identity: ${company.id}/${company.slug}.`);
    }
    ids.add(company.id);
    slugs.add(company.slug);
  }
  if (companies.length !== listing.nbHits) {
    throw new Error(
      `YC detail crawl is incomplete: nbHits=${listing.nbHits}, companies=${companies.length}.`
    );
  }
}

async function fetchCompanyDetail(slug, signal) {
  const html = await fetchText(`https://www.ycombinator.com/companies/${slug}`, signal);
  const $ = cheerio.load(html);
  const dataPage = $("[data-page]").attr("data-page");
  if (!dataPage) {
    throw new Error(`Could not find data-page payload for ${slug}`);
  }
  const page = JSON.parse(dataPage);
  return page.props.company;
}

function requestSignal(overallSignal) {
  return AbortSignal.any([overallSignal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
}

function sanitizeCompany(hit, detail, index, config) {
  const ycUrl = `https://www.ycombinator.com/companies/${hit.slug}`;
  const groupPartner = detail.primary_group_partner?.full_name ?? null;
  const launch = Array.isArray(detail.launches) ? detail.launches[0] : null;
  const founders = Array.isArray(detail.founders)
    ? detail.founders.map((founder) => sanitizeFounder(founder, hit.slug))
    : [];

  return {
    id: String(detail.id ?? hit.id ?? hit.objectID ?? hit.slug),
    objectID: String(hit.objectID ?? ""),
    slug: hit.slug,
    name: detail.name ?? hit.name,
    batch: detail.batch_name ?? hit.batch,
    ycProfileUrl: detail.ycdc_url ?? ycUrl,
    websiteUrl: detail.website || hit.website || null,
    tagline: detail.one_liner ?? hit.one_liner ?? "",
    description: detail.long_description ?? hit.long_description ?? "",
    industry: hit.industry ?? detail.industry ?? null,
    subindustry: hit.subindustry ?? null,
    industries: normalizeStrings(hit.industries ?? [hit.industry, hit.subindustry]),
    tags: normalizeStrings([...(hit.tags ?? []), ...(detail.tags ?? [])]),
    location: detail.location ?? hit.all_locations ?? null,
    teamSize: numberOrNull(detail.team_size ?? hit.team_size),
    status: detail.ycdc_status ?? hit.status ?? null,
    groupPartner,
    groupPartnerUrl: detail.primary_group_partner?.url ?? null,
    socialLinks: sanitizeSocialLinks({
      github: detail.github_url,
      linkedin: detail.linkedin_url,
      x: detail.twitter_url
    }),
    founders,
    launch: launch
      ? {
          title: launch.title ?? null,
          url: launch.ycdc_launch_url ?? launch.url ?? null,
          tagline: launch.tagline ?? null,
          totalVoteCount: numberOrNull(launch.total_vote_count),
          approvedAt: launch.approved_at ?? null
        }
      : null,
    sourceUrls: [ycUrl, config.directoryUrl]
  };
}

function sanitizeFounder(founder, companySlug) {
  return {
    id: String(founder.user_id ?? `${companySlug}-${slugify(founder.full_name ?? "founder")}`),
    name: founder.full_name ?? "Unknown founder",
    title: founder.title ?? null,
    bio: founder.founder_bio ?? "",
    ycProfileUrl: founder.user_id ? `https://www.ycombinator.com/people/${slugify(founder.full_name ?? String(founder.user_id))}` : null,
    socialLinks: sanitizeSocialLinks({
      linkedin: founder.linkedin_url,
      x: founder.twitter_url
    })
  };
}

function sanitizeSocialLinks(links) {
  return Object.fromEntries(
    Object.entries(links)
      .map(([platform, url]) => [platform, cleanUrl(url)])
      .filter(([, url]) => Boolean(url))
  );
}

function cleanUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  try {
    return new URL(value.trim()).toString();
  } catch {
    return null;
  }
}

function normalizeStrings(values) {
  return [
    ...new Set(
      values
        .filter((value) => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
    )
  ];
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
      if ((index + 1) % 25 === 0 || index + 1 === items.length) {
        console.log(`Fetched ${index + 1}/${items.length}`);
      }
    }
  });
  await Promise.all(workers);
  return results;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
