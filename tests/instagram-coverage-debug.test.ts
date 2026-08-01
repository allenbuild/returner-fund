import { describe, expect, it } from "vitest";
import { buildGraphResponse } from "@/lib/graph/graph-builder";
import { ycSpring2026GraphDataset } from "@/lib/graph/yc-spring-2026-dataset";
import { buildInstagramCoverageReport } from "@/lib/ingestion/instagram-debug";
import companiesSnapshot from "@/lib/yc/summer-2026-companies.json";
import overridesSnapshot from "@/lib/social/verified-social-overrides.json";
import publicEvidenceSnapshot from "@/lib/social/public-evidence-current.json";
import loggedInEvidenceSnapshot from "@/lib/social/logged-in-evidence-current.json";
import targetedEvidenceSnapshot from "@/lib/social/targeted-evidence-current.json";

describe("instagram coverage debug report", () => {
  it("explains the current Summer 2026 Instagram coverage without counting old Spring overrides", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const report = buildInstagramCoverageReport({
      graph,
      companies: companiesSnapshot.companies,
      overrides: overridesSnapshot,
      snapshots: [publicEvidenceSnapshot, loggedInEvidenceSnapshot, targetedEvidenceSnapshot],
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
    expect(report.profiles.verifiedCompanyOverrides).toBe(2);
    expect(report.evidence.rows).toBe(9);
    expect(report.evidence.scoredRows).toBe(9);
    expect(report.evidence.companiesWithScoredEvidence).toBe(2);
    expect(report.feedCompanies.map((item) => item.companyName).sort()).toEqual([
      "Control Seat",
      "Pluto"
    ]);
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

    expect(graph.nodes.filter((node) => node.entityType === "company")).toHaveLength(
      companiesSnapshot.companies.length
    );
    expect(graph.nodes.some((node) => ["HeyClicky", "Synphony", "ANORIA"].includes(node.label))).toBe(false);
    expect(instagramRows).toHaveLength(9);
    expect(new Set(instagramRows.map((item) => item.attachedCompanyName))).toEqual(
      new Set(["Control Seat", "Pluto"])
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
      new Set(["github", "youtube", "x", "linkedin", "instagram", "hacker_news", "product_hunt"])
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
