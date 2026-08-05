import type { Platform } from "@/lib/graph/types";
import {
  companyRankingEvidenceCount,
  graphEvidenceCount,
  graphPlatformEvidenceCount,
  getCatalog,
  platformLabel,
  type PublicCohort,
  type PublicCompany
} from "@/lib/seo/catalog";
import { slugify } from "@/lib/seo/site";

export type EcosystemKey = "yc" | "a16z";

export interface EcosystemSnapshot {
  key: EcosystemKey;
  name: string;
  shortName: string;
  cohortSlugs: string[];
  cohorts: PublicCohort[];
  companies: PublicCompany[];
  companyCount: number;
  founderCount: number;
  evidenceCount: number;
  partnerCount: number;
  generatedAt: string;
  snapshotLabel: string;
  industries: Array<{ name: string; slug: string; count: number }>;
  platforms: Array<{ platform: Platform; label: string; slug: string; count: number }>;
}

const BATCHES: Record<EcosystemKey, string[]> = {
  yc: ["S2026", "S26"],
  a16z: ["A16ZSR006"]
};

export function getEcosystemSnapshot(key: EcosystemKey): EcosystemSnapshot {
  const catalog = getCatalog();
  const batchSlugs = new Set(BATCHES[key]);
  const cohorts = catalog.cohorts.filter((cohort) => batchSlugs.has(cohort.batchSlug));
  const companies = cohorts
    .flatMap((cohort) => cohort.companies)
    .sort(
      (left, right) =>
        right.node.score - left.node.score ||
        companyRankingEvidenceCount(right) - companyRankingEvidenceCount(left) ||
        left.node.label.localeCompare(right.node.label)
    );
  const graphs = [...new Map(companies.map((company) => [company.graph.batch.slug, company.graph])).values()];
  const generatedAt = cohorts
    .map((cohort) => cohort.companies[0]?.graph.generatedAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? new Date(0).toISOString();

  return {
    key,
    name: key === "yc" ? "Y Combinator" : "Andreessen Horowitz (a16z) Speedrun",
    shortName: key === "yc" ? "YC" : "a16z Speedrun",
    cohortSlugs: cohorts.map((cohort) => cohort.slug),
    cohorts,
    companies,
    companyCount: companies.length,
    founderCount: companies.reduce((total, company) => total + company.node.founders.length, 0),
    evidenceCount: graphs.reduce((total, graph) => total + graphEvidenceCount(graph), 0),
    partnerCount: new Set(companies.map((company) => company.node.groupPartner).filter(Boolean)).size,
    generatedAt,
    snapshotLabel: formatSnapshotDate(generatedAt),
    industries: countIndustries(companies),
    platforms: countPlatforms(graphs)
  };
}

function countIndustries(companies: PublicCompany[]) {
  const counts = new Map<string, number>();
  for (const company of companies) {
    const industry = company.node.primaryIndustry.trim();
    if (!industry) continue;
    counts.set(industry, (counts.get(industry) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, slug: slugify(name), count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

function countPlatforms(graphs: PublicCompany["graph"][]) {
  const counts = new Map<Platform, number>();
  for (const graph of graphs) {
    const platforms = graph.evidenceStats
      ? Object.keys(graph.evidenceStats.byPlatform) as Platform[]
      : [...new Set(graph.evidence.map((item) => item.platform))];
    for (const platform of platforms) {
      counts.set(platform, (counts.get(platform) ?? 0) + graphPlatformEvidenceCount(graph, platform));
    }
  }
  return [...counts.entries()]
    .map(([platform, count]) => ({
      platform,
      label: platformLabel(platform),
      slug: slugify(platform),
      count
    }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

function formatSnapshotDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() === 0) return "Current snapshot";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeZone: "UTC"
  }).format(date);
}
