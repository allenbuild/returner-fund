import { describe, expect, it } from "vitest";
import { canonicalPostKey } from "@/lib/graph/dedupe";
import { buildGraphResponse } from "@/lib/graph/graph-builder";
import { handleFromUrl, ycSpring2026GraphDataset } from "@/lib/graph/yc-spring-2026-dataset";
import type { SocialAccountSummary } from "@/lib/graph/types";

describe("YC Summer 2026 official snapshot", () => {
  it("defaults to YC Spring 2026 while exposing every supported batch in graph metadata", () => {
    const graph = buildGraphResponse({}, ycSpring2026GraphDataset);

    expect(graph.batch).toEqual({
      slug: "S2026",
      label: "YC Spring 2026 (P26)",
      companyCountExpected: 197,
      companyCountObserved: 197
    });
    expect(graph.batches).toEqual([
      graph.batch,
      {
        slug: "S26",
        label: "YC Summer 2026 (S26)",
        companyCountExpected: 83,
        companyCountObserved: 83
      },
      {
        slug: "A16ZSR006",
        label: "a16z speedrun 006",
        companyCountExpected: 59,
        companyCountObserved: 59
      }
    ]);
    expect(new Set(graph.nodes.map((node) => node.batchSlug))).toEqual(new Set(["S2026"]));
  });

  it("can switch back to the Spring 2026 official snapshot", () => {
    const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
    const companyNodes = graph.nodes.filter((node) => node.entityType === "company");

    expect(graph.batch).toEqual({
      slug: "S2026",
      label: "YC Spring 2026 (P26)",
      companyCountExpected: 197,
      companyCountObserved: 197
    });
    expect(companyNodes).toHaveLength(197);
    expect(graph.leaderboard).toHaveLength(197);
    expect(graph.nodes.some((node) => node.label === "HeyClicky")).toBe(true);
    expect(graph.nodes.some((node) => node.label === "Conifer")).toBe(false);
    expect(graph.evidence.some((item) => item.title === "FarzaTV X post")).toBe(false);
    expect(
      graph.evidence.find((item) => item.sourceUrl === "https://x.com/FarzaTV/status/2077130366230639022")?.title
    ).toContain("Today we're shipping screen-aware dictation.");
  });

  it("loads the complete public YC batch instead of the demo seed", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const companyNodes = graph.nodes.filter((node) => node.entityType === "company");
    const founderNodes = graph.nodes.filter((node) => node.entityType === "founder");

    expect(graph.mode).toBe("official_snapshot");
    expect(graph.batch.companyCountExpected).toBe(83);
    expect(graph.batch.companyCountObserved).toBe(83);
    expect(companyNodes).toHaveLength(83);
    expect(founderNodes).toHaveLength(0);
    expect(graph.leaderboard).toHaveLength(83);
    expect(graph.evidence.length).toBeGreaterThan(39);
    expect(new Set(graph.evidence.map((item) => item.platform))).toEqual(
      new Set(["github", "youtube", "x", "linkedin", "hacker_news", "product_hunt", "web", "rss"])
    );
    expect(graph.evidence.some((item) => item.platform === "github" && item.thumbnailUrl)).toBe(true);
    expect(graph.evidence.some((item) => item.platform === "youtube" && item.attachedCompanyName === "Archal")).toBe(true);
    expect(graph.evidence.some((item) => item.platform === "x" && item.contributionScore > 0)).toBe(true);
    expect(graph.evidence.some((item) => item.platform === "linkedin" && item.contributionScore > 0)).toBe(true);
    expect(graph.evidence.some((item) => item.platform === "instagram")).toBe(false);
    expect(graph.leaderboard[0]?.topPlatform).toBeTruthy();
    expect(companyNodes.filter((node) => node.score > 0).length).toBeGreaterThan(6);
    expect(companyNodes.some((node) => node.founders.length > 0)).toBe(true);
    expect(graph.evidence.some((item) => item.entityType === "founder")).toBe(true);
    expect(graph.needsReview.some((item) => item.candidateUrl === "https://www.producthunt.com/products/screen-studio")).toBe(false);
    expect(JSON.stringify(graph.evidence)).not.toContain("yc-public-directory");
  }, 30_000);

  it("provides a thumbnail URL for every evidence item in YC and a16z batches", () => {
    for (const batchSlug of ["S2026", "S26", "A16ZSR006"]) {
      const graph = buildGraphResponse({ batchSlug }, ycSpring2026GraphDataset);
      const missing = graph.evidence.filter((item) => !item.thumbnailUrl);

      expect(
        missing.map((item) => `${item.platform}:${item.id}`).slice(0, 20),
        `${batchSlug} is missing thumbnails for ${missing.length} evidence items`
      ).toEqual([]);
    }
  }, 30_000);

  it("canonicalizes physical evidence while retaining founder and company references", () => {
    const spring = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
    const allowance = spring.nodes.find((node) => node.entityId === "company-allowance");
    const allowancePost = spring.evidence.filter(
      (item) => canonicalPostKey(item) === "x:post:2057828506399281568"
    );

    expect(allowancePost).toHaveLength(1);
    expect(allowancePost[0]).toEqual(
      expect.objectContaining({
        entityType: "founder",
        entityId: "founder-allowance-dasmer-singh-330737",
        attachedCompanyId: "company-allowance"
      })
    );
    expect(allowance?.evidenceIds).toContain(allowancePost[0]?.id);
    expect(
      allowance?.founders.find((founder) => founder.id === allowancePost[0]?.entityId)?.evidenceIds
    ).toContain(allowancePost[0]?.id);

    const profileRows = spring.evidence.filter((item) => item.id.startsWith("evidence-github-profile-"));
    expect(new Set(spring.evidence.map((item) => item.id)).size).toBe(spring.evidence.length);
    expect(profileRows.every((item) => item.contributionScore === 0)).toBe(true);
    expect(
      profileRows
        .filter((item) => item.entityId === "company-smol-machines")
        .map((item) => item.id)
        .sort()
    ).toEqual([
      "evidence-github-profile-company-smol-machines-containers",
      "evidence-github-profile-company-smol-machines-smol-machines"
    ]);

    const summer = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const pangoPost = summer.evidence.filter(
      (item) => canonicalPostKey(item) === "linkedin:post:7473269455783948288"
    );
    const pangoContext = summer.evidence.filter(
      (item) => item.platformPostId === "7473616064967266304"
    );

    expect(pangoPost).toHaveLength(1);
    expect(pangoPost[0]).toEqual(
      expect.objectContaining({
        entityType: "founder",
        entityId: "founder-pango-lukasz-reszczynski-3331619",
        attachedCompanyId: "company-pango",
        metrics: expect.objectContaining({ reactions: 319, comments: 43 })
      })
    );
    expect(pangoContext).toEqual([
      expect.objectContaining({
        id: "linkedin-topvoices_people_only_third_sol_ultra-s26-topvoice-pango-petekoomen-7473616064967266304",
        contributionScore: 0,
        sourceUrl: "https://www.linkedin.com/in/petekoomen/recent-activity/comments/#post-7473616064967266304",
        metrics: expect.objectContaining({ reactions: 3 })
      })
    ]);
    expect(canonicalPostKey(pangoContext[0]!)).toBe("linkedin:post:7473616064967266304");
    expect(pangoContext[0]?.why).toContain("Direct comment locator:");

    const linkedInCommentContexts = [...spring.evidence, ...summer.evidence].filter((item) =>
      item.sourceUrl.includes("/recent-activity/comments/#post-")
    );
    expect(linkedInCommentContexts).toHaveLength(5);
    for (const item of linkedInCommentContexts) {
      expect(item.contributionScore).toBe(0);
      expect(item.review_state).toBe("verified");
      expect(canonicalPostKey(item)).toBe(`linkedin:post:${item.platformPostId}`);
      expect(Object.values(item.metrics).some((value) => Number(value) > 0)).toBe(true);
      expect(item.why).toContain("Direct comment locator:");
      expect(item.why).toContain("never contribute to regular company or founder traction scores");
    }

    const unlocatedComment = ycSpring2026GraphDataset.evidence.find(
      (item) => item.id === "linkedin-topvoice-company-rise-reforming-alexisohanian-activity-7345937006784356353-comment-george-rose"
    );
    const mislabelledParentComment = ycSpring2026GraphDataset.evidence.find(
      (item) => item.id === "linkedin-topvoice-seventh-pass-s2026-company-insforge-andrew-miklas-7462200339899846656"
    );

    expect(unlocatedComment).toEqual(
      expect.objectContaining({
        contributionScore: 0,
        platformPostId: null,
        review_state: "needs_review"
      })
    );
    expect(unlocatedComment?.why).toContain("no separate stable native comment identity");
    expect(mislabelledParentComment).toEqual(
      expect.objectContaining({
        contributionScore: 0,
        platformPostId: null,
        review_state: "rejected"
      })
    );
    expect(mislabelledParentComment?.why).toContain("owned by y-combinator");
    expect(mislabelledParentComment?.why).toContain("Parent-post IDs and metrics are never attributed");
  }, 30_000);

  it("extracts LinkedIn account identities before nested admin, about, and posts routes", () => {
    const nestedRoutes = new Map([
      ["https://www.linkedin.com/company/acme/admin/dashboard/", "acme"],
      ["https://www.linkedin.com/company/acme/about/", "acme"],
      ["https://www.linkedin.com/company/acme/posts/?feedView=all", "acme"],
      ["https://www.linkedin.com/in/person/recent-activity/all/", "person"]
    ]);
    for (const [url, expectedHandle] of nestedRoutes) {
      expect(handleFromUrl(url)).toBe(expectedHandle);
    }

    for (const malformedUrl of [
      "https://www.linkedin.com/company/admin/dashboard/",
      "https://www.linkedin.com/company/about/",
      "https://www.linkedin.com/company/posts/",
      "https://www.linkedin.com/company/",
      "https://www.linkedin.com/in/posts/",
      "https://www.linkedin.com/posts/acme_activity-123-test",
      "not a url"
    ]) {
      expect(handleFromUrl(malformedUrl)).toBeNull();
    }

    const expectedSnapshotAccounts = new Map([
      ["https://www.linkedin.com/company/109776165/admin/dashboard/", "109776165"],
      ["https://www.linkedin.com/company/huscarl/about/", "huscarl"],
      ["https://www.linkedin.com/company/lamina-labs/about/", "lamina-labs"],
      ["https://www.linkedin.com/company/108252929/admin/dashboard/", "108252929"],
      ["https://www.linkedin.com/company/mountyc26/posts/?feedView=all", "mountyc26"],
      ["https://www.linkedin.com/company/111953568/admin/dashboard/", "111953568"],
      ["https://www.linkedin.com/company/coniferbuild/posts/?feedView=all", "coniferbuild"],
      ["https://www.linkedin.com/company/131464079/admin/dashboard/", "131464079"],
      ["https://www.linkedin.com/company/130274179/admin/dashboard/", "130274179"]
    ]);
    const socialAccounts = [
      ...ycSpring2026GraphDataset.companies.flatMap((company) => company.socialAccounts),
      ...ycSpring2026GraphDataset.founders.flatMap((founder) => founder.socialAccounts)
    ];

    for (const [url, expectedHandle] of expectedSnapshotAccounts) {
      expect(socialAccounts.find((account) => account.url === url)).toEqual(
        expect.objectContaining({ handle: expectedHandle, review_state: "verified" })
      );
    }
    expect(
      socialAccounts
        .filter((account) => account.review_state === "verified")
        .filter((account) => !account.handle || ["admin", "dashboard", "about", "posts"].includes(account.handle))
    ).toEqual([]);
  });

  it("keeps evidence account lineage materialized, owner-scoped, and score-neutral", () => {
    const owners = materializedAccountOwners(ycSpring2026GraphDataset);
    const ownersById = new Map<string, typeof owners>();
    for (const owner of owners) {
      ownersById.set(owner.account.id, [...(ownersById.get(owner.account.id) ?? []), owner]);
    }

    const linkedEvidence = ycSpring2026GraphDataset.evidence.filter(
      (item) => item.socialAccountId !== null && item.socialAccountId !== undefined
    );
    const unresolvedEvidence = linkedEvidence.filter((item) => !ownersById.has(item.socialAccountId!));
    const wrongOwnerEvidence = linkedEvidence.filter(
      (item) =>
        !ownersById
          .get(item.socialAccountId!)
          ?.some(
            (owner) =>
              owner.entityType === item.entityType &&
              owner.entityId === item.entityId &&
              owner.account.platform === item.platform
          )
    );
    const collidingAccountIds = [...ownersById.entries()].filter(([, accountOwners]) =>
      new Set(
        accountOwners.map(
          (owner) => `${owner.entityType}:${owner.entityId}:${owner.account.platform}:${owner.account.url}`
        )
      ).size > 1
    );
    const scoredLinkedEvidence = linkedEvidence.filter((item) => item.contributionScore > 0);
    const screenpipeRepository = ycSpring2026GraphDataset.evidence.find(
      (item) => item.sourceUrl === "https://github.com/screenpipe/screenpipe"
    );

    expect(linkedEvidence.length).toBeGreaterThan(0);
    expect(scoredLinkedEvidence.length).toBeGreaterThan(0);
    expect(unresolvedEvidence).toHaveLength(0);
    expect(wrongOwnerEvidence).toHaveLength(0);
    expect(collidingAccountIds).toHaveLength(0);
    expect(screenpipeRepository).toEqual(
      expect.objectContaining({
        entityType: "company",
        entityId: "company-screenpipe",
        platform: "github",
        contributionScore: expect.any(Number)
      })
    );
    expect(screenpipeRepository?.contributionScore).toBeGreaterThan(0);
    expect(ownersById.get(screenpipeRepository?.socialAccountId ?? "")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityType: "company",
          entityId: "company-screenpipe",
          account: expect.objectContaining({ platform: "github" })
        })
      ])
    );
  });
});

function materializedAccountOwners(dataset: Pick<typeof ycSpring2026GraphDataset, "companies" | "founders">): Array<{
  entityType: "company" | "founder";
  entityId: string;
  account: SocialAccountSummary;
}> {
  return [
    ...dataset.companies.flatMap((company) =>
      company.socialAccounts.map((account) => ({ entityType: "company" as const, entityId: company.id, account }))
    ),
    ...dataset.founders.flatMap((founder) =>
      founder.socialAccounts.map((account) => ({ entityType: "founder" as const, entityId: founder.id, account }))
    )
  ];
}
