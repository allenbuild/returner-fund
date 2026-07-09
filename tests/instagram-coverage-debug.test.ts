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
        companies_checked: 83,
        searched_with_opencli: false,
        searched_with_web: false,
        candidates: [],
        attempts: []
      }
    });

    expect(report.companyCount).toBe(83);
    expect(report.profiles.snapshotCompanyProfiles).toBe(0);
    expect(report.profiles.snapshotFounderProfiles).toBe(0);
    expect(report.profiles.verifiedCompanyOverrides).toBe(0);
    expect(report.evidence.rows).toBe(0);
    expect(report.evidence.companiesWithScoredEvidence).toBe(0);
    expect(report.feedCompanies).toEqual([]);
    expect(report.missingCompanies).toHaveLength(83);
    expect(report.rootCause).toEqual(
      expect.arrayContaining([
        "The current YC snapshot has zero company-level Instagram profile URLs.",
        "The current YC snapshot has zero founder-level Instagram profile URLs.",
        "No verified company Instagram overrides exist for the current YC snapshot.",
        "No current Instagram evidence rows are attached to the graph."
      ])
    );
  });

  it("does not leak old Spring Instagram companies into the Summer graph", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);

    expect(graph.nodes.filter((node) => node.entityType === "company")).toHaveLength(83);
    expect(graph.nodes.some((node) => ["HeyClicky", "Synphony", "ANORIA"].includes(node.label))).toBe(false);
    expect(graph.evidence.some((item) => item.platform === "instagram")).toBe(false);
    expect(graph.evidence.some((item) => item.attachedCompanyName === "HeyClicky")).toBe(false);
  });

  it("keeps Summer social scoring limited to official YC-linked GitHub evidence until new public evidence is collected", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const platforms = new Set(graph.evidence.map((item) => item.platform));
    const githubRows = graph.evidence.filter((item) => item.platform === "github");
    const githubCompanySlugs = new Set(githubRows.map((item) => item.attachedCompanyId?.replace(/^company-/, "")));
    const officialGithubSlugs = new Set(
      companiesSnapshot.companies.filter((company) => company.socialLinks.github).map((company) => company.slug)
    );

    expect(platforms).toEqual(new Set(["github"]));
    expect(officialGithubSlugs.size).toBe(15);
    expect(githubRows.length).toBeGreaterThan(15);
    expect([...githubCompanySlugs].every((slug) => slug && officialGithubSlugs.has(slug))).toBe(true);
  });
});
