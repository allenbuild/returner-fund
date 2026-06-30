import type { SourceEvidence, YcBatchResult, YcCompanyRecord } from "./types";
import { batchSlugToLabel, normalizeBatchSlug } from "./yc-parser";

const DEMO_SOURCE_URL = "demo://yc-batch";

export function getDemoYcBatch(inputBatchSlug: string, maxCompanies?: number): YcBatchResult {
  const batchSlug = normalizeBatchSlug(inputBatchSlug);
  const source = demoSource(`${DEMO_SOURCE_URL}/${batchSlug}`, "Deterministic demo YC-like batch");
  const companies = demoCompanies(batchSlug, source);
  return {
    batchSlug,
    label: batchSlugToLabel(batchSlug),
    mode: "demo",
    companies: typeof maxCompanies === "number" ? companies.slice(0, maxCompanies) : companies,
    expectedCompanyCount: null,
    observedCompanyCount: typeof maxCompanies === "number" ? companies.slice(0, maxCompanies).length : companies.length,
    sources: [source],
    warnings: ["Demo records are fake and must never be presented as real YC companies."]
  };
}

function demoCompanies(batchSlug: string, source: SourceEvidence): YcCompanyRecord[] {
  return [
    {
      name: "Vector Loom",
      batchSlug,
      ycProfileUrl: "demo://yc/company/vector-loom",
      websiteUrl: "https://example.com/vector-loom",
      tagline: "AI planning tools for robotics teams.",
      description: "Vector Loom helps robotics teams turn field logs into deployment plans.",
      industries: ["Robotics", "Developer Tools", "AI"],
      founders: [
        demoFounder("Maya Chen", "demo://yc/founder/maya-chen", source),
        demoFounder("Luis Romero", "demo://yc/founder/luis-romero", source)
      ],
      groupPartner: null,
      sourceReliability: "high",
      sources: [source],
      review_state: "verified",
      warnings: ["Group partner intentionally null because demo evidence does not include a public source."]
    },
    {
      name: "Northstar Ledger",
      batchSlug,
      ycProfileUrl: "demo://yc/company/northstar-ledger",
      websiteUrl: "https://example.com/northstar-ledger",
      tagline: "Treasury observability for climate finance.",
      description: "Northstar Ledger tracks project finance updates and investor reporting workflows.",
      industries: ["Fintech", "Climate", "B2B"],
      founders: [
        demoFounder("Ari Patel", "demo://yc/founder/ari-patel", source),
        demoFounder("Sam Okafor", "demo://yc/founder/sam-okafor", source)
      ],
      groupPartner: null,
      sourceReliability: "high",
      sources: [source],
      review_state: "verified",
      warnings: ["Group partner intentionally null because demo evidence does not include a public source."]
    },
    {
      name: "Signal Orchard",
      batchSlug,
      ycProfileUrl: "demo://yc/company/signal-orchard",
      websiteUrl: "https://example.com/signal-orchard",
      tagline: "Customer signal routing for product teams.",
      description: "Signal Orchard deduplicates feedback across sales calls, tickets, and community posts.",
      industries: ["SaaS", "Productivity", "AI"],
      founders: [demoFounder("Nora Kim", "demo://yc/founder/nora-kim", source)],
      groupPartner: null,
      sourceReliability: "high",
      sources: [source],
      review_state: "verified",
      warnings: ["Group partner intentionally null because demo evidence does not include a public source."]
    }
  ];
}

function demoFounder(name: string, ycProfileUrl: string, source: SourceEvidence) {
  return {
    name,
    ycProfileUrl,
    personalWebsiteUrl: null,
    sourceReliability: "high" as const,
    sources: [source],
    review_state: "verified" as const
  };
}

function demoSource(url: string, title: string): SourceEvidence {
  return {
    url,
    title,
    snippet: null,
    sourceReliability: "high",
    extractedAt: new Date(0).toISOString()
  };
}
