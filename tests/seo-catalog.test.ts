import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getCatalog, graphUrl } from "@/lib/seo/catalog";
import { siteUrl, slugify } from "@/lib/seo/site";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { HomeStructuredData } from "@/components/seo/HomeDiscovery";
import { DirectoryCompanyList } from "@/components/seo/DirectoryCompanyList";
import YcNetworkMapPage, { metadata as ycNetworkMapMetadata } from "@/app/yc-network-map/page";
import A16zNetworkMapPage, { metadata as a16zNetworkMapMetadata } from "@/app/a16z-network-map/page";
import YcSocialTractionPage, { metadata as ycSocialTractionMetadata } from "@/app/yc-social-traction/page";
import A16zSocialTractionPage, { metadata as a16zSocialTractionMetadata } from "@/app/a16z-social-traction/page";
import { generateMetadata as generateHomeMetadata } from "@/app/page";

const CANONICAL_ORIGIN = "https://www.returner.fund";
const INTENT_PATHS = [
  "/yc-network-map",
  "/a16z-network-map",
  "/yc-social-traction",
  "/a16z-social-traction"
] as const;

function withSiteUrl<T>(configured: string | undefined, run: () => T): T {
  const original = process.env.NEXT_PUBLIC_SITE_URL;

  try {
    if (configured === undefined) {
      delete process.env.NEXT_PUBLIC_SITE_URL;
    } else {
      process.env.NEXT_PUBLIC_SITE_URL = configured;
    }
    return run();
  } finally {
    if (original === undefined) {
      delete process.env.NEXT_PUBLIC_SITE_URL;
    } else {
      process.env.NEXT_PUBLIC_SITE_URL = original;
    }
  }
}

describe("public SEO catalog", () => {
  it("builds stable, unique routes from the three canonical graph snapshots", () => {
    const catalog = getCatalog();
    const expectedCompanies = catalog.graphs.reduce(
      (total, graph) => total + graph.nodes.filter((node) => node.entityType === "company").length,
      0
    );
    const expectedFounders = catalog.graphs.reduce(
      (total, graph) => total + graph.nodes
        .filter((node) => node.entityType === "company")
        .reduce((graphTotal, company) => graphTotal + company.founders.length, 0),
      0
    );

    expect(catalog.companies).toHaveLength(expectedCompanies);
    expect(catalog.founders).toHaveLength(expectedFounders);
    expect(catalog.cohorts).toHaveLength(catalog.graphs.length);
    expect(new Set(catalog.companies.map((company) => company.slug)).size).toBe(catalog.companies.length);
    expect(new Set(catalog.founders.map((founder) => founder.slug)).size).toBe(catalog.founders.length);
    expect(catalog.companies
      .filter((company) => company.node.entityId === "company-textsidekick")
      .map((company) => [company.node.batchSlug, company.slug]))
      .toEqual([["S2026", "sidekick"], ["S26", "sidekick-2"]]);
    expect(catalog.founders
      .filter((founder) => founder.id === "founder-textsidekick-justin-so-3332767")
      .map((founder) => [founder.company.node.batchSlug, founder.slug]))
      .toEqual([["S2026", "justin-so"], ["S26", "justin-so-2"]]);
  });

  it("uses crawl-safe slugs and keeps graph links URL-backed", () => {
    expect(slugify("Manufacturing & Robotics")).toBe("manufacturing-and-robotics");
    expect(slugify("Clair Health / AI")).toBe("clair-health-ai");

    const company = getCatalog().companies.find((candidate) => candidate.node.batchSlug === "A16ZSR006");
    expect(company).toBeDefined();
    expect(graphUrl(company!)).toContain("batch=A16ZSR006");
    expect(graphUrl(company!)).toContain(`node=${encodeURIComponent(company!.node.id)}`);
  });

  it("limits indexable taxonomy pages to useful, evidence-backed aggregates", () => {
    const catalog = getCatalog();

    expect(catalog.industries.filter((industry) => industry.indexable).every((industry) => industry.companies.length >= 3)).toBe(true);
    expect(catalog.platforms.filter((platform) => platform.indexable).every((platform) => platform.evidence.length > 0)).toBe(true);
    expect(catalog.partners.find((partner) => partner.name.toLowerCase() === "a16z speedrun")?.indexable).toBe(false);
  });
});

describe("crawl metadata routes", () => {
  it("normalizes the default and stale apex configuration to the final www host", () => {
    expect(withSiteUrl(undefined, () => siteUrl("/"))).toBe(`${CANONICAL_ORIGIN}/`);
    expect(withSiteUrl("https://returner.fund", () => siteUrl("/companies")))
      .toBe(`${CANONICAL_ORIGIN}/companies`);
  });

  it("blocks operational surfaces while allowing the public site", () => {
    const result = withSiteUrl("https://returner.fund", robots);
    const rules = Array.isArray(result.rules) ? result.rules : [result.rules];
    const wildcard = rules.find((rule) => rule.userAgent === "*");

    expect(wildcard?.allow).toBe("/");
    expect(wildcard?.disallow).toEqual(expect.arrayContaining(["/admin/", "/debug/", "/api/"]));
    expect(result.sitemap).toBe(`${CANONICAL_ORIGIN}/sitemap.xml`);
    expect(result.host).toBe(`${CANONICAL_ORIGIN}/`);
  });

  it("publishes only unique canonical public URLs", () => {
    const entries = withSiteUrl("https://returner.fund", sitemap);
    const urls = entries.map((entry) => entry.url);

    expect(urls).toContain(`${CANONICAL_ORIGIN}/`);
    expect(urls.every((url) => url.startsWith(`${CANONICAL_ORIGIN}/`))).toBe(true);
    expect(INTENT_PATHS.every((path) => urls.includes(`${CANONICAL_ORIGIN}${path}`))).toBe(true);
    expect(urls.some((url) => url.includes("/admin/") || url.includes("/debug/") || url.includes("?"))).toBe(false);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("server-renders visible discovery links for every search-intent route", () => {
    const markup = renderToStaticMarkup(createElement(HomeStructuredData));

    expect(markup).toContain("Startup network maps and social traction rankings");
    for (const path of INTENT_PATHS) {
      expect(markup).toContain(`href="${path}"`);
    }
  });

  it("links company rows only to generated primary-industry routes", () => {
    const catalog = getCatalog();
    const markup = renderToStaticMarkup(createElement(DirectoryCompanyList, {
      companies: catalog.companies,
      ranked: true
    }));
    const generatedIndustryPaths = new Set(catalog.industries.map((industry) => `/industries/${industry.slug}`));
    const linkedIndustryPaths = [...markup.matchAll(/href="(\/industries\/[^"]+)"/g)].map((match) => match[1]);

    expect(linkedIndustryPaths.length).toBeGreaterThan(0);
    expect(linkedIndustryPaths.every((path) => generatedIndustryPaths.has(path))).toBe(true);
  });

  it("renders four distinct, self-canonical intent pages with valid structured data", () => {
    const pages = [
      { path: "/yc-network-map", Page: YcNetworkMapPage, metadata: ycNetworkMapMetadata },
      { path: "/a16z-network-map", Page: A16zNetworkMapPage, metadata: a16zNetworkMapMetadata },
      { path: "/yc-social-traction", Page: YcSocialTractionPage, metadata: ycSocialTractionMetadata },
      { path: "/a16z-social-traction", Page: A16zSocialTractionPage, metadata: a16zSocialTractionMetadata }
    ];
    const titles = new Set<string>();

    for (const page of pages) {
      const title = String(page.metadata.title);
      const markup = renderToStaticMarkup(createElement(page.Page));
      const jsonLdBlocks = [...markup.matchAll(/<script type="application\/ld\+json">([^<]+)<\/script>/g)];

      titles.add(title);
      expect(page.metadata.alternates?.canonical).toBe(`${CANONICAL_ORIGIN}${page.path}`);
      expect(markup).toContain("<h1>");
      expect(markup).toContain("independent public-data project");
      expect(jsonLdBlocks.length).toBeGreaterThanOrEqual(2);
      expect(jsonLdBlocks.every((match) => {
        try {
          JSON.parse(match[1]);
          return true;
        } catch {
          return false;
        }
      })).toBe(true);
    }

    expect(titles.size).toBe(pages.length);
  });

  it("consolidates graph state to stable canonicals without indexing query URLs", async () => {
    const a16zView = await generateHomeMetadata({
      searchParams: Promise.resolve({ batch: "A16ZSR006" })
    });
    const trackingView = await generateHomeMetadata({
      searchParams: Promise.resolve({ utm_source: "seo-test" })
    });

    expect(a16zView.robots).toMatchObject({ index: false, follow: true });
    expect(a16zView.alternates?.canonical).toBe(`${CANONICAL_ORIGIN}/cohorts/a16z-speedrun-006`);
    expect(trackingView.robots).toMatchObject({ index: false, follow: true });
    expect(trackingView.alternates?.canonical).toBe(`${CANONICAL_ORIGIN}/`);
  });
});
