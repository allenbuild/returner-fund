import type { MetadataRoute } from "next";
import { getCatalog } from "@/lib/seo/catalog";
import { siteUrl } from "@/lib/seo/site";

export default function sitemap(): MetadataRoute.Sitemap {
  const catalog = getCatalog();
  const lastModified = new Date(
    Math.max(...catalog.graphs.map((graph) => new Date(graph.generatedAt).getTime()))
  );

  const entries: MetadataRoute.Sitemap = [
    entry("/", "daily", 1, lastModified),
    entry("/dashboard", "hourly", 1, lastModified),
    entry("/cohorts", "weekly", 0.9, lastModified),
    entry("/companies", "weekly", 0.9, lastModified),
    entry("/founders", "weekly", 0.8, lastModified),
    entry("/industries", "weekly", 0.8, lastModified),
    entry("/platforms", "weekly", 0.8, lastModified),
    entry("/partners", "weekly", 0.7, lastModified),
    entry("/rankings", "daily", 0.9, lastModified),
    entry("/about", "monthly", 0.6),
    entry("/methodology", "monthly", 0.7),
    entry("/data-sources", "monthly", 0.7),
    entry("/faq", "monthly", 0.6),
    entry("/corrections", "monthly", 0.6),
    ...catalog.cohorts.map((cohort) => entry(`/cohorts/${cohort.slug}`, "daily", 0.9, new Date(cohort.companies[0]?.graph.generatedAt ?? lastModified))),
    ...catalog.companies
      .filter((company) => company.indexable)
      .map((company) => entry(`/companies/${company.slug}`, "weekly", 0.8, new Date(company.graph.generatedAt))),
    ...catalog.founders
      .filter((founder) => founder.indexable)
      .map((founder) => entry(`/founders/${founder.slug}`, "weekly", 0.7, new Date(founder.company.graph.generatedAt))),
    ...catalog.industries
      .filter((industry) => industry.indexable)
      .map((industry) => entry(`/industries/${industry.slug}`, "weekly", 0.7, lastModified)),
    ...catalog.platforms
      .filter((platform) => platform.indexable)
      .map((platform) => entry(`/platforms/${platform.slug}`, "daily", 0.7, lastModified)),
    ...catalog.partners
      .filter((partner) => partner.indexable)
      .map((partner) => entry(`/partners/${partner.slug}`, "weekly", 0.6, lastModified))
  ];

  const seenUrls = new Set<string>();
  return entries.filter((item) => {
    if (seenUrls.has(item.url)) return false;
    seenUrls.add(item.url);
    return true;
  });
}

function entry(
  path: string,
  changeFrequency: NonNullable<MetadataRoute.Sitemap[number]["changeFrequency"]>,
  priority: number,
  lastModified?: Date
): MetadataRoute.Sitemap[number] {
  return { url: siteUrl(path), changeFrequency, priority, lastModified };
}
