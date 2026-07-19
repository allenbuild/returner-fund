import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EvidenceItem, GraphNode, GraphResponse, Platform } from "@/lib/graph/types";
import { slugify } from "./site";

const GRAPH_FILES = ["s2026.json", "s26.json", "a16zsr006.json"] as const;

export interface PublicCompany {
  slug: string;
  node: GraphNode;
  graph: GraphResponse;
  evidence: EvidenceItem[];
  indexable: boolean;
}

export interface PublicFounder {
  slug: string;
  id: string;
  name: string;
  company: PublicCompany;
  socialAccounts: GraphNode["founders"][number]["socialAccounts"];
  evidence: EvidenceItem[];
  indexable: boolean;
}

export interface PublicCohort {
  slug: string;
  batchSlug: string;
  label: string;
  companies: PublicCompany[];
  evidenceCount: number;
}

export interface PublicIndustry {
  slug: string;
  name: string;
  companies: PublicCompany[];
  indexable: boolean;
}

export interface PublicPlatform {
  slug: string;
  platform: Platform;
  label: string;
  companies: PublicCompany[];
  evidence: EvidenceItem[];
  indexable: boolean;
}

export interface PublicPartner {
  slug: string;
  name: string;
  companies: PublicCompany[];
  indexable: boolean;
}

interface Catalog {
  graphs: GraphResponse[];
  companies: PublicCompany[];
  founders: PublicFounder[];
  cohorts: PublicCohort[];
  industries: PublicIndustry[];
  platforms: PublicPlatform[];
  partners: PublicPartner[];
}

let catalogCache: Catalog | null = null;

export function getCatalog(): Catalog {
  if (catalogCache) return catalogCache;

  const graphs = GRAPH_FILES.map(readGraph);
  const companyCandidates = graphs.flatMap((graph) =>
    graph.nodes
      .filter((node) => node.entityType === "company")
      .map((node) => ({ graph, node }))
  );
  const companySlugs = uniqueSlugs(companyCandidates.map(({ node }) => ({ key: node.entityId, value: node.label })));
  const companies = companyCandidates.map(({ graph, node }) => {
    const evidenceIds = new Set(node.evidenceIds);
    const evidence = graph.evidence.filter((item) => evidenceIds.has(item.id));
    return {
      slug: companySlugs.get(node.entityId) ?? slugify(node.label),
      node,
      graph,
      evidence,
      indexable: node.review_state === "verified" && Boolean(node.tagline || node.description) &&
        Boolean(node.websiteUrl || node.socialAccounts.length || evidence.length)
    } satisfies PublicCompany;
  });

  const founderCandidates = companies.flatMap((company) =>
    company.node.founders.map((founder) => ({ company, founder }))
  );
  const founderSlugs = uniqueSlugs(founderCandidates.map(({ founder }) => ({ key: founder.id, value: founder.name })));
  const founders = founderCandidates.map(({ company, founder }) => {
    const evidenceIds = new Set(founder.evidenceIds);
    const evidence = company.graph.evidence.filter((item) => evidenceIds.has(item.id));
    return {
      slug: founderSlugs.get(founder.id) ?? slugify(founder.name),
      id: founder.id,
      name: founder.name,
      company,
      socialAccounts: founder.socialAccounts,
      evidence,
      indexable: Boolean(evidence.length || founder.socialAccounts.length >= 2)
    } satisfies PublicFounder;
  });

  const cohorts = graphs.map((graph) => {
    const cohortCompanies = companies.filter((company) => company.node.batchSlug === graph.batch.slug);
    return {
      slug: slugify(graph.batch.label),
      batchSlug: graph.batch.slug,
      label: graph.batch.label,
      companies: cohortCompanies,
      evidenceCount: cohortCompanies.reduce((sum, company) => sum + company.evidence.length, 0)
    } satisfies PublicCohort;
  });

  const industries = groupedCompanies(companies, (company) => [company.node.primaryIndustry])
    .map(([name, grouped]) => ({
      slug: slugify(name),
      name,
      companies: grouped,
      indexable: grouped.length >= 3
    }))
    .sort((left, right) => right.companies.length - left.companies.length || left.name.localeCompare(right.name));

  const platforms = platformValues()
    .map((platform) => {
      const platformEvidence = companies.flatMap((company) => company.evidence.filter((item) => item.platform === platform));
      const platformCompanies = companies.filter((company) =>
        company.evidence.some((item) => item.platform === platform) ||
        company.node.socialAccounts.some((account) => account.platform === platform) ||
        company.node.founders.some((founder) => founder.socialAccounts.some((account) => account.platform === platform))
      );
      return {
        slug: slugify(platform),
        platform,
        label: platformLabel(platform),
        companies: platformCompanies,
        evidence: platformEvidence,
        indexable: platformEvidence.length > 0
      } satisfies PublicPlatform;
    })
    .filter((platform) => platform.companies.length > 0)
    .sort((left, right) => right.evidence.length - left.evidence.length);

  const partners = groupedCompanies(companies, (company) => company.node.groupPartner ? [company.node.groupPartner] : [])
    .map(([name, grouped]) => ({
      slug: slugify(name),
      name,
      companies: grouped,
      indexable: grouped.length >= 2 && name.toLowerCase() !== "a16z speedrun"
    }))
    .sort((left, right) => right.companies.length - left.companies.length || left.name.localeCompare(right.name));

  catalogCache = { graphs, companies, founders, cohorts, industries, platforms, partners };
  return catalogCache;
}

export function findCompany(slug: string): PublicCompany | undefined {
  return getCatalog().companies.find((company) => company.slug === slug);
}

export function findFounder(slug: string): PublicFounder | undefined {
  return getCatalog().founders.find((founder) => founder.slug === slug);
}

export function findCohort(slug: string): PublicCohort | undefined {
  return getCatalog().cohorts.find((cohort) => cohort.slug === slug || cohort.batchSlug.toLowerCase() === slug.toLowerCase());
}

export function findIndustry(slug: string): PublicIndustry | undefined {
  return getCatalog().industries.find((industry) => industry.slug === slug);
}

export function findPlatform(slug: string): PublicPlatform | undefined {
  return getCatalog().platforms.find((platform) => platform.slug === slug);
}

export function findPartner(slug: string): PublicPartner | undefined {
  return getCatalog().partners.find((partner) => partner.slug === slug);
}

export function graphUrl(company: PublicCompany): string {
  const params = new URLSearchParams();
  if (company.node.batchSlug !== "S2026") params.set("batch", company.node.batchSlug);
  params.set("node", company.node.id);
  const query = params.toString();
  return query ? `/?${query}` : "/";
}

export function platformLabel(platform: Platform): string {
  const labels: Partial<Record<Platform, string>> = {
    github: "GitHub",
    x: "X",
    linkedin: "LinkedIn",
    instagram: "Instagram",
    product_hunt: "Product Hunt",
    youtube: "YouTube",
    rss: "RSS",
    web: "Web",
    reddit: "Reddit",
    hacker_news: "Hacker News",
    bilibili: "Bilibili",
    tiktok: "TikTok",
    bluesky: "Bluesky"
  };
  return labels[platform] ?? platform;
}

function readGraph(filename: string): GraphResponse {
  return JSON.parse(readFileSync(join(process.cwd(), "public", "graph", filename), "utf8")) as GraphResponse;
}

function uniqueSlugs(items: { key: string; value: string }[]): Map<string, string> {
  const grouped = new Map<string, { key: string; value: string }[]>();
  for (const item of items) {
    const base = slugify(item.value);
    grouped.set(base, [...(grouped.get(base) ?? []), item]);
  }
  const slugs = new Map<string, string>();
  for (const [base, matches] of grouped) {
    matches
      .sort((left, right) => left.key.localeCompare(right.key))
      .forEach((item, index) => slugs.set(item.key, index === 0 ? base : `${base}-${index + 1}`));
  }
  return slugs;
}

function groupedCompanies(
  companies: PublicCompany[],
  values: (company: PublicCompany) => string[]
): [string, PublicCompany[]][] {
  const groups = new Map<string, PublicCompany[]>();
  for (const company of companies) {
    for (const value of new Set(values(company).map((item) => item.trim()).filter(Boolean))) {
      groups.set(value, [...(groups.get(value) ?? []), company]);
    }
  }
  return [...groups.entries()];
}

function platformValues(): Platform[] {
  return ["github", "x", "linkedin", "instagram", "product_hunt", "youtube", "rss", "web", "reddit", "hacker_news", "bilibili", "tiktok", "bluesky"];
}
