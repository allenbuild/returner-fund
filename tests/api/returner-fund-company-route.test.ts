import { describe, expect, it, vi } from "vitest";
import {
  handleReturnerFundCompanyRequest,
} from "@/app/api/v1/companies/[slug]/returner-fund/route";
import type {
  ReturnerFundCompanyLookupResult,
  ReturnerFundCompanyResponse,
} from "@/lib/integrations/returner-fund-company";

describe("GET /api/v1/companies/[slug]/returner-fund", () => {
  it("validates the required batch and bounded limit before loading a graph", async () => {
    const lookup = vi.fn();
    const response = await request("https://returner.fund/api/v1/companies/atlia/returner-fund?limit=50", {
      authorize: async () => true,
      keyIsConfigured: () => false,
      lookup,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_request" } });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("rejects a request when the optional pre-shared key check fails", async () => {
    const response = await request(
      "https://returner.fund/api/v1/companies/atlia/returner-fund?batch=S26",
      {
        authorize: async () => false,
        keyIsConfigured: () => true,
        lookup: vi.fn(),
      }
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "unauthorized" } });
  });

  it("returns the stable contract with public caching when no key is configured", async () => {
    const lookup = vi.fn(async (): Promise<ReturnerFundCompanyLookupResult> => ({
      status: "found",
      response: fixtureResponse(),
    }));
    const response = await request(
      "https://returner.fund/api/v1/companies/atlia/returner-fund?batch=S26&limit=4",
      { authorize: async () => true, keyIsConfigured: () => false, lookup }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=60, s-maxage=60, stale-while-revalidate=300"
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-returner-fund-model")).toBe("4.2.0");
    await expect(response.json()).resolves.toEqual(fixtureResponse());
    expect(lookup).toHaveBeenCalledWith({ companyReference: "atlia", batchSlug: "S26", limit: 4 });
  });

  it.each([
    [{ status: "not_found" } as const, 404, "company_not_found"],
    [{ status: "unavailable", reason: "ranked_posts_out_of_sync" } as const, 503, "insights_out_of_sync"],
  ])("maps %s to a structured error", async (result, status, code) => {
    const response = await request(
      "https://returner.fund/api/v1/companies/missing/returner-fund?batch=S26",
      {
        authorize: async () => true,
        keyIsConfigured: () => false,
        lookup: async () => result,
      }
    );

    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
  });
});

function request(
  url: string,
  dependencies: Parameters<typeof handleReturnerFundCompanyRequest>[2]
) {
  const slug = new URL(url).pathname.split("/").at(-2) ?? "";
  return handleReturnerFundCompanyRequest(
    new Request(url),
    { params: Promise.resolve({ slug }) },
    dependencies
  );
}

function fixtureResponse(): ReturnerFundCompanyResponse {
  return {
    schemaVersion: "returner-fund-company-v1",
    company: {
      id: "company-atlia",
      slug: "atlia",
      name: "Atlia",
      batchSlug: "S26",
      batchLabel: "YC Summer 2026",
      ycProfileUrl: "https://www.ycombinator.com/companies/atlia",
      websiteUrl: "https://www.atlia.com",
      returnerFundUrl: "https://www.returner.fund/companies/atlia",
    },
    returnerFund: {
      score: 17,
      scale: { min: 0, max: 100 },
      absoluteScore: 9,
      topPlatform: "x",
      platformScores: { x: 35, youtube: 18 },
      cohort: {
        rank: 170,
        size: 218,
        derivedPercentile: 20.18,
        percentileMethod: "tie_aware_midrank_all_published_companies",
      },
      model: { id: "returner-traction", version: "4.2.0", name: "returner-traction-v4" },
      confidence: { level: "high", value: 0.773, scoredEvidenceCount: 10 },
      explanation: "Current score explanation.",
      evidenceAsOf: "2026-08-13T23:47:23.885Z",
      generatedAt: "2026-08-14T12:40:27.238Z",
    },
    postsReturned: 0,
    totalEligiblePosts: 0,
    postsTruncated: false,
    postsComplete: true,
    bestPosts: [],
  };
}
