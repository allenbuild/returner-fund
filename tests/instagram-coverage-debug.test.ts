import { describe, expect, it } from "vitest";
import { buildGraphResponse } from "@/lib/graph/graph-builder";
import { ycSpring2026GraphDataset } from "@/lib/graph/yc-spring-2026-dataset";
import { buildInstagramCoverageReport } from "@/lib/ingestion/instagram-debug";
import companiesSnapshot from "@/lib/yc/summer-2026-companies.json";
import overridesSnapshot from "@/lib/social/verified-social-overrides.json";

describe("instagram coverage debug report", () => {
  it("accepts multi-account override values without treating invalid Instagram arrays as verified", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const company = companiesSnapshot.companies[0];
    const baseInput = {
      graph,
      companies: [company],
      discovery: null
    };
    const validInstagramArray = {
      [company.slug]: {
        companySocialLinks: {
          instagram: ["https://www.instagram.com/verified.one/", "https://instagram.com/verified_two"],
          reddit: ["https://www.reddit.com/r/example/", "https://www.reddit.com/user/example/"]
        }
      }
    };
    const invalidInstagramArray = {
      [company.slug]: {
        companySocialLinks: {
          instagram: ["https://www.instagram.com/verified.one/", "https://instagram.com.evil.test/imposter"]
        }
      }
    };

    expect(
      buildInstagramCoverageReport({ ...baseInput, overrides: validInstagramArray }).profiles.verifiedCompanyOverrides
    ).toBe(1);
    expect(
      buildInstagramCoverageReport({ ...baseInput, overrides: invalidInstagramArray }).profiles.verifiedCompanyOverrides
    ).toBe(0);
  });

  it("explains the current Summer 2026 Instagram coverage without counting old Spring overrides", () => {
    const currentCompanySlugs = new Set(companiesSnapshot.companies.map((company) => company.slug));
    const allVerifiedCompanyOverrides = Object.entries(overridesSnapshot).filter(([, override]) =>
      "companySocialLinks" in override &&
      override.companySocialLinks &&
      "instagram" in override.companySocialLinks &&
      Boolean(override.companySocialLinks.instagram)
    );
    const currentVerifiedCompanyOverrides = allVerifiedCompanyOverrides.filter(([slug]) =>
      currentCompanySlugs.has(slug)
    );
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const instagramRows = graph.evidence.filter((item) => item.platform === "instagram");
    const scoredInstagramRows = instagramRows.filter((item) => item.contributionScore > 0);
    const instagramEvidenceIds = new Set(instagramRows.map((item) => item.id));
    const scoredInstagramEvidenceIds = new Set(scoredInstagramRows.map((item) => item.id));
    const companiesWithInstagramEvidence = graph.nodes.filter(
      (node) =>
        node.entityType === "company" && node.evidenceIds.some((evidenceId) => instagramEvidenceIds.has(evidenceId))
    );
    const companiesWithScoredInstagramEvidence = graph.nodes.filter(
      (node) =>
        node.entityType === "company" &&
        node.evidenceIds.some((evidenceId) => scoredInstagramEvidenceIds.has(evidenceId))
    );
    const report = buildInstagramCoverageReport({
      graph,
      companies: companiesSnapshot.companies,
      overrides: overridesSnapshot,
      discovery: {
        companies_checked: companiesSnapshot.companies.length,
        searched_with_opencli: false,
        searched_with_web: false,
        candidates: [],
        attempts: []
      }
    });

    expect(report.companyCount).toBe(companiesSnapshot.companies.length);
    expect(report.profiles.snapshotCompanyProfiles).toBe(0);
    expect(report.profiles.snapshotFounderProfiles).toBe(0);
    expect(currentVerifiedCompanyOverrides.length).toBeGreaterThan(0);
    expect(allVerifiedCompanyOverrides.length).toBeGreaterThan(currentVerifiedCompanyOverrides.length);
    expect(report.profiles.verifiedCompanyOverrides).toBe(currentVerifiedCompanyOverrides.length);
    expect(report.evidence.rows).toBe(instagramRows.length);
    expect(report.evidence.scoredRows).toBe(scoredInstagramRows.length);
    expect(report.evidence.companiesWithEvidence).toBe(companiesWithInstagramEvidence.length);
    expect(report.evidence.companiesWithScoredEvidence).toBe(companiesWithScoredInstagramEvidence.length);
    expect(report.feedCompanies.map((item) => item.companyId).sort()).toEqual(
      companiesWithInstagramEvidence.map((company) => company.entityId).sort()
    );
    expect(report.feedCompanies.map((item) => item.companyName)).toEqual(
      expect.arrayContaining(["Control Seat", "Pluto", "tash"])
    );
    expect(report.missingCompanies).toHaveLength(
      companiesSnapshot.companies.length - report.evidence.companiesWithScoredEvidence
    );
    expect(report.rootCause).toEqual(
      expect.arrayContaining([
        "The current YC snapshot has zero company-level Instagram profile URLs.",
        "The current YC snapshot has zero founder-level Instagram profile URLs.",
        "The last Instagram discovery report did not run a broad Instagram search; it only crawled official websites."
      ])
    );
    expect(report.rootCause).not.toContain("No current Instagram evidence rows are attached to the graph.");
  });

  it("does not leak old Spring Instagram companies while retaining verified Summer rows", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const instagramRows = graph.evidence.filter((item) => item.platform === "instagram");
    const currentCompanyIds = new Set(companiesSnapshot.companies.map((company) => `company-${company.slug}`));

    expect(graph.nodes.filter((node) => node.entityType === "company")).toHaveLength(
      companiesSnapshot.companies.length
    );
    expect(graph.nodes.some((node) => ["HeyClicky", "Synphony", "ANORIA"].includes(node.label))).toBe(false);
    expect(instagramRows.length).toBeGreaterThan(0);
    expect(instagramRows.every((item) => currentCompanyIds.has(item.attachedCompanyId ?? ""))).toBe(true);
    expect(instagramRows.map((item) => item.attachedCompanyName)).toEqual(
      expect.arrayContaining(["Control Seat", "Pluto", "tash"])
    );
    expect(graph.evidence.some((item) => item.attachedCompanyName === "HeyClicky")).toBe(false);
  });

  it("keeps only verified Instagram rows in Summer scoring with other public social rows", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const platforms = new Set(graph.evidence.map((item) => item.platform));
    const githubRows = graph.evidence.filter((item) => item.platform === "github");
    const youtubeRows = graph.evidence.filter((item) => item.platform === "youtube");
    const githubCompanySlugs = new Set(githubRows.map((item) => item.attachedCompanyId?.replace(/^company-/, "")));
    const officialGithubSlugs = new Set(
      companiesSnapshot.companies.filter((company) => company.socialLinks.github).map((company) => company.slug)
    );

    expect(platforms).toEqual(
      new Set(["github", "youtube", "x", "linkedin", "instagram", "hacker_news", "product_hunt", "rss", "web"])
    );
    expect(platforms.has("x")).toBe(true);
    expect(platforms.has("linkedin")).toBe(true);
    expect(platforms.has("instagram")).toBe(true);
    expect(youtubeRows.length).toBeGreaterThan(0);
    expect(officialGithubSlugs.size).toBeGreaterThan(0);
    expect(githubRows.length).toBeGreaterThan(officialGithubSlugs.size);
    expect([...githubCompanySlugs].every(Boolean)).toBe(true);
  });
});
