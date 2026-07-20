import { describe, expect, it } from "vitest";

import {
  COMPANY_VERTICAL_OVERRIDES,
  COMPANY_VERTICAL_TAXONOMY_VERSION,
  COMPANY_VERTICALS,
  MAX_INFERRED_COMPANY_VERTICALS,
  companyVerticalOverrideKey,
  getCompanyVerticalDefinition,
  inferCompanyVerticals,
  isCompanyVertical,
  normalizeCompanyVerticals,
  type CompanyVertical,
  type CompanyVerticalMetadata
} from "@/lib/graph/company-verticals";

const EXPECTED_LABELS = [
  "AI Agents",
  "AI Infrastructure",
  "Developer Tools",
  "Cybersecurity",
  "Cloud Infrastructure",
  "Data Infrastructure",
  "Open Source",
  "Robotics",
  "Computer Vision",
  "Voice AI",
  "Fintech",
  "Payments",
  "Banking",
  "Lending",
  "Insurance",
  "Crypto",
  "Healthcare",
  "Clinical AI",
  "Medical Devices",
  "Biotech",
  "Drug Discovery",
  "Synthetic Biology",
  "Manufacturing",
  "Industrial Automation",
  "Supply Chain",
  "Logistics",
  "Construction",
  "Real Estate",
  "Climate",
  "Energy",
  "Agriculture",
  "Food Tech",
  "Defense",
  "Aerospace",
  "Space",
  "Government",
  "Education",
  "Legal",
  "HR",
  "Sales",
  "Marketing",
  "Customer Support",
  "Accounting",
  "E-commerce",
  "Marketplaces",
  "Consumer Social",
  "Gaming",
  "Creator Economy",
  "Travel",
  "Hardware"
] as const;

const EXPECTED_SLUGS = [
  "ai-agents",
  "ai-infrastructure",
  "developer-tools",
  "cybersecurity",
  "cloud-infrastructure",
  "data-infrastructure",
  "open-source",
  "robotics",
  "computer-vision",
  "voice-ai",
  "fintech",
  "payments",
  "banking",
  "lending",
  "insurance",
  "crypto",
  "healthcare",
  "clinical-ai",
  "medical-devices",
  "biotech",
  "drug-discovery",
  "synthetic-biology",
  "manufacturing",
  "industrial-automation",
  "supply-chain",
  "logistics",
  "construction",
  "real-estate",
  "climate",
  "energy",
  "agriculture",
  "food-tech",
  "defense",
  "aerospace",
  "space",
  "government",
  "education",
  "legal",
  "hr",
  "sales",
  "marketing",
  "customer-support",
  "accounting",
  "e-commerce",
  "marketplaces",
  "consumer-social",
  "gaming",
  "creator-economy",
  "travel",
  "hardware"
] as const satisfies readonly CompanyVertical[];

describe("company vertical taxonomy", () => {
  it("contains the exact 50 canonical labels, slugs, and ordering", () => {
    expect(COMPANY_VERTICALS).toHaveLength(50);
    expect(COMPANY_VERTICALS.map(({ label }) => label)).toEqual(EXPECTED_LABELS);
    expect(COMPANY_VERTICALS.map(({ slug }) => slug)).toEqual(EXPECTED_SLUGS);
    expect(COMPANY_VERTICALS.map(({ order }) => order)).toEqual(
      Array.from({ length: 50 }, (_, index) => index + 1)
    );
  });

  it("keeps labels and stable slugs unique and never exposes the unclassified sentinel", () => {
    const labels = COMPANY_VERTICALS.map(({ label }) => label);
    const slugs = COMPANY_VERTICALS.map(({ slug }) => slug);
    expect(new Set(labels).size).toBe(labels.length);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs).not.toContain("__unclassified__");
    expect(COMPANY_VERTICAL_TAXONOMY_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.v\d+$/);
  });

  it("defines descriptions, aliases, and keywords for every option", () => {
    for (const definition of COMPANY_VERTICALS) {
      expect(definition.description.length).toBeGreaterThan(20);
      expect(definition.aliases.length).toBeGreaterThan(0);
      expect(definition.keywords.length).toBeGreaterThan(0);
      expect(getCompanyVerticalDefinition(definition.slug)).toBe(definition);
      expect(isCompanyVertical(definition.slug)).toBe(true);
    }
    expect(isCompanyVertical("other")).toBe(false);
    expect(isCompanyVertical("__unclassified__")).toBe(false);
  });

  it("normalizes selections into canonical order with dedupe and a bound", () => {
    expect(normalizeCompanyVerticals(["hardware", "robotics", "hardware", "ai-agents"])).toEqual([
      "ai-agents",
      "robotics",
      "hardware"
    ]);
    expect(normalizeCompanyVerticals(EXPECTED_SLUGS, 2)).toEqual(["ai-agents", "ai-infrastructure"]);
  });
});

describe("company vertical inference", () => {
  it.each([
    {
      name: "Robotics",
      metadata: {
        companyId: "fixture-robotics",
        tagline: "Robots that work alongside people",
        description: "A humanoid robot fleet for production environments."
      },
      expected: "robotics"
    },
    {
      name: "Biotech",
      metadata: {
        companyId: "fixture-biotech",
        primaryIndustry: "Biotechnology",
        description: "Protein engineering for new biologics."
      },
      expected: "biotech"
    },
    {
      name: "Clinical AI",
      metadata: {
        companyId: "fixture-clinical-ai",
        tagline: "AI for clinicians that automates clinical documentation"
      },
      expected: "clinical-ai"
    },
    {
      name: "AI Agents",
      metadata: {
        companyId: "fixture-ai-agents",
        primaryIndustry: "Agentic AI",
        tagline: "Digital workers for finance teams"
      },
      expected: "ai-agents"
    },
    {
      name: "Developer Tools",
      metadata: {
        companyId: "fixture-developer-tools",
        businessModel: "developer_tools",
        description: "A developer platform for testing APIs."
      },
      expected: "developer-tools"
    },
    {
      name: "Fintech",
      metadata: {
        companyId: "fixture-fintech",
        primaryIndustry: "Fintech",
        tagline: "A financial platform for institutional investors"
      },
      expected: "fintech"
    },
    {
      name: "Defense",
      metadata: {
        companyId: "fixture-defense",
        industries: ["Industrials", "Defense"],
        tagline: "Counter-drone systems for national security"
      },
      expected: "defense"
    },
    {
      name: "Space",
      metadata: {
        companyId: "fixture-space",
        primaryIndustry: "Aviation and Space",
        description: "Reusable spacecraft and orbital infrastructure."
      },
      expected: "space"
    },
    {
      name: "Hardware",
      metadata: {
        companyId: "fixture-hardware",
        businessModel: "hardware",
        description: "Purpose-built electronic devices for field teams."
      },
      expected: "hardware"
    }
  ])("classifies a strong $name fixture", ({ metadata, expected }) => {
    const result = inferCompanyVerticals(metadata);
    expect(result.verticals).toContain(expected);
    expect(result.source).toBe("inferred");
    expect(result.unclassified).toBe(false);
    const explanation = result.explanations.find(({ vertical }) => vertical === expected);
    expect(explanation?.score).toBeGreaterThanOrEqual(30);
    expect(explanation?.matchedFields.length).toBeGreaterThan(0);
    expect(explanation?.matchedTerms.length).toBeGreaterThan(0);
    expect(explanation?.reason).toContain(explanation?.label);
  });

  it("keeps genuinely ambiguous metadata unclassified instead of guessing", () => {
    const result = inferCompanyVerticals({
      companyId: "ambiguous",
      primaryIndustry: "B2B",
      industries: ["Software"],
      tagline: "A better platform for modern teams",
      description: "We make work faster and easier."
    });
    expect(result).toEqual({
      taxonomyVersion: COMPANY_VERTICAL_TAXONOMY_VERSION,
      source: "unclassified",
      verticals: [],
      unclassified: true,
      explanations: []
    });
  });

  it("uses explicit reviewed values first and canonicalizes their ordering", () => {
    const result = inferCompanyVerticals({
      companyId: "explicit-wins",
      primaryIndustry: "Gaming",
      tagline: "A video game studio",
      curatedVerticals: ["hardware", "clinical-ai", "hardware"]
    });
    expect(result.source).toBe("curated");
    expect(result.verticals).toEqual(["clinical-ai", "hardware"]);
    expect(result.verticals).not.toContain("gaming");
    expect(result.explanations.every(({ score, reason }) => score === null && reason.includes("reviewed")))
      .toBe(true);
  });

  it("uses batch-scoped curated overrides before inference", () => {
    const overrideKey = companyVerticalOverrideKey("S2026", "company-eden-robotics");
    expect(overrideKey).toBe("S2026:company-eden-robotics");
    expect(COMPANY_VERTICAL_OVERRIDES["S2026:company-eden-robotics"]).toEqual([
      "robotics",
      "manufacturing",
      "logistics"
    ]);

    const result = inferCompanyVerticals({
      companyId: "company-eden-robotics",
      batchSlug: "S2026",
      primaryIndustry: "Education"
    });
    expect(result.source).toBe("override");
    expect(result.verticals).toEqual(["robotics", "manufacturing", "logistics"]);
    expect(result.verticals).not.toContain("education");
  });

  it("does not leak a batch-scoped override into another batch", () => {
    const result = inferCompanyVerticals({
      companyId: "company-eden-robotics",
      batchSlug: "W2027",
      primaryIndustry: "Education"
    });
    expect(result.source).toBe("inferred");
    expect(result.verticals).toContain("education");
    expect(result.verticals).not.toContain("robotics");
  });

  it("is deterministic under metadata input ordering and duplicates", () => {
    const first = inferCompanyVerticals({
      companyId: "ordered",
      industries: ["Defense", "Aviation", "Robotics", "Defense"],
      tags: ["Hardware", "Space Tech"],
      categories: ["Industrial Automation", "Computer Vision"]
    });
    const second = inferCompanyVerticals({
      companyId: "ordered",
      industries: ["Robotics", "Aviation", "Defense"],
      tags: ["Space Tech", "Hardware", "Space Tech"],
      categories: ["Computer Vision", "Industrial Automation"]
    });
    expect(second).toEqual(first);
  });

  it("bounds broad multi-label output at five with deterministic score and taxonomy tie-breaking", () => {
    const result = inferCompanyVerticals({
      companyId: "broad",
      industries: [
        "Hardware",
        "Space",
        "Defense",
        "Robotics",
        "Manufacturing",
        "Logistics",
        "Construction",
        "Energy"
      ]
    });
    expect(result.verticals).toHaveLength(MAX_INFERRED_COMPANY_VERTICALS);
    expect(result.verticals).toEqual(["robotics", "manufacturing", "logistics", "construction", "energy"]);
  });

  it("does not let traction-like properties influence inference", () => {
    const lowTraction = {
      companyId: "metrics-ignored",
      tagline: "Open source developer tools",
      totalScore: 0,
      rawEngagement: 0
    };
    const highTraction = {
      ...lowTraction,
      totalScore: 100,
      rawEngagement: 9_999_999
    };
    expect(inferCompanyVerticals(lowTraction)).toEqual(inferCompanyVerticals(highTraction));
  });

  it("uses phrase boundaries rather than matching substrings", () => {
    const metadata: CompanyVerticalMetadata = {
      companyId: "substring",
      tagline: "Hardware-free trips for well-traveled teams",
      description: "A companionship product for contractors."
    };
    const result = inferCompanyVerticals(metadata);
    expect(result.verticals).not.toContain("travel");
    expect(result.verticals).not.toContain("construction");
  });

  it("does not classify from one incidental or negated description phrase", () => {
    expect(inferCompanyVerticals({
      companyId: "no-hardware",
      description: "Works without additional hardware for modern teams."
    }).verticals).not.toContain("hardware");
    expect(inferCompanyVerticals({
      companyId: "sales-adjacent",
      description: "Integrates into existing sales workflows."
    }).verticals).not.toContain("sales");
  });
});
