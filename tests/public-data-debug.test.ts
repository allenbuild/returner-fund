import { describe, expect, it } from "vitest";
import { buildGraphResponse } from "@/lib/graph/graph-builder";
import { ycSpring2026GraphDataset } from "@/lib/graph/yc-spring-2026-dataset";
import { buildDuplicateReport, buildWorkerTasks, PUBLIC_CONNECTOR_PLATFORMS } from "@/lib/ingestion/public-data-debug";
import companiesSnapshot from "@/lib/yc/summer-2026-companies.json";

describe("public data debug instrumentation", () => {
  it("creates one checkpointed public connector task per company and platform", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const tasks = buildWorkerTasks(graph);

    expect(graph.nodes).toHaveLength(companiesSnapshot.companies.length);
    expect(graph.nodes.every((node) => node.entityType === "company")).toBe(true);
    expect(tasks).toHaveLength(graph.nodes.length * PUBLIC_CONNECTOR_PLATFORMS.length);
    expect(tasks.every((task) => task.checkpointKey.includes(task.companyId))).toBe(true);
  });

  it("marks LinkedIn working and reports its measured S26 source mix", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const linkedin = graph.platformStatus.find((item) => item.platform === "linkedin");
    const x = graph.platformStatus.find((item) => item.platform === "x");

    expect(linkedin?.status).toBe("working");
    const authenticatedCountMatch = linkedin?.notes.match(
      /; (\d+) came from the opt-in authenticated browser snapshot/i
    );
    expect(authenticatedCountMatch).toBeTruthy();
    const authenticatedCount = Number(authenticatedCountMatch![1]);
    expect(Number.isInteger(authenticatedCount)).toBe(true);
    if (authenticatedCount > 0) {
      expect(linkedin?.authMethod.toLowerCase()).toContain("authenticated browser session");
      expect(linkedin?.authMethod.toLowerCase()).toContain("verified public evidence");
    } else {
      expect(linkedin?.authMethod.toLowerCase()).toContain("public unauthenticated");
      expect(linkedin?.authMethod.toLowerCase()).not.toContain("authenticated browser session");
    }
    expect(x?.status).toBe("public_only");
    expect(x?.authMethod.toLowerCase()).toContain("official yc profile links");
  });

  it("dedupes company-level social accounts that duplicate founder accounts in the graph", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const report = buildDuplicateReport(graph);

    expect(report.duplicateAccountGroupCount).toBe(0);
    expect(graph.nodes.some((node) => node.founders.some((founder) => founder.socialAccounts.length > 0))).toBe(true);
  });

  it("reports duplicate evidence by canonical platform post ID and latest snapshot timestamp", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const base = {
      ...graph.evidence[0],
      id: "duplicate-base",
      platform: "instagram" as const,
      sourceUrl: "https://www.instagram.com/reel/ABC123/?utm_source=one",
      platformPostId: "ABC123",
      last_checked_at: "2026-06-20T00:00:00Z"
    };
    const duplicate = {
      ...base,
      id: "duplicate-fresh",
      sourceUrl: "https://instagram.com/reel/ABC123/?utm_source=two",
      platformPostId: "ABC123",
      last_checked_at: "2026-06-28T00:00:00Z"
    };
    const report = buildDuplicateReport({
      ...graph,
      evidence: [base, duplicate]
    });

    expect(report.duplicateGroupCount).toBe(1);
    expect(report.groups[0]).toMatchObject({
      key: `${base.entityId}:instagram:post:ABC123`,
      platformPostIds: ["ABC123"],
      latestCheckedAt: "2026-06-28T00:00:00Z"
    });
  });

  it("reports duplicate social account attachments under a company", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const node = graph.nodes.find((candidate) => candidate.founders.length > 0);

    expect(node).toBeDefined();
    node!.socialAccounts.push({
      id: "company-duplicate-x",
      platform: "x",
      handle: "duplicate",
      url: "https://twitter.com/duplicate",
      review_state: "verified",
      discoveredFromUrl: node!.ycProfileUrl,
      matchReason: "test"
    });
    node!.founders[0].socialAccounts.push({
      id: "founder-duplicate-x",
      platform: "x",
      handle: "duplicate",
      url: "https://x.com/duplicate/",
      review_state: "verified",
      discoveredFromUrl: node!.founders[0].ycProfileUrl,
      matchReason: "test"
    });

    const report = buildDuplicateReport(graph);

    expect(report.duplicateAccountGroupCount).toBeGreaterThan(0);
    expect(report.duplicateAccountGroups).toContainEqual(
      expect.objectContaining({
        platform: "x",
        accountIds: ["company-duplicate-x", "founder-duplicate-x"]
      })
    );
  });
});
