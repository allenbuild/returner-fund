import { describe, expect, it } from "vitest";
import { getCatalog, graphUrl } from "@/lib/seo/catalog";
import { siteUrl, slugify } from "@/lib/seo/site";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";

describe("public SEO catalog", () => {
  it("builds stable, unique routes from the three canonical graph snapshots", () => {
    const catalog = getCatalog();

    expect(catalog.companies).toHaveLength(371);
    expect(catalog.founders).toHaveLength(755);
    expect(catalog.cohorts).toHaveLength(3);
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
  it("blocks operational surfaces while allowing the public site", () => {
    const result = robots();
    const rules = Array.isArray(result.rules) ? result.rules : [result.rules];
    const wildcard = rules.find((rule) => rule.userAgent === "*");

    expect(wildcard?.allow).toBe("/");
    expect(wildcard?.disallow).toEqual(expect.arrayContaining(["/admin/", "/debug/", "/api/"]));
    expect(result.sitemap).toBe(siteUrl("/sitemap.xml"));
  });

  it("publishes only unique canonical public URLs", () => {
    const entries = sitemap();
    const urls = entries.map((entry) => entry.url);

    expect(urls).toContain(siteUrl("/"));
    expect(urls.some((url) => url.includes("/admin/") || url.includes("/debug/") || url.includes("?"))).toBe(false);
    expect(new Set(urls).size).toBe(urls.length);
  });
});
