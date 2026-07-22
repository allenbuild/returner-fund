import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/graph/route";

describe("GET /api/graph query validation", () => {
  it.each([
    ["platforms", "platforms=github,myspace", "platforms.1"],
    ["empty platforms", "platforms=", "platforms.0"],
    ["businessModels", "businessModels=b2b,subscription", "businessModels.1"],
    ["empty businessModels", "businessModels=", "businessModels.0"],
    ["topics", "topics=traction-growth,viral-magic", "topics.1"],
    ["empty topics", "topics=", "topics.0"],
    ["verticals", "verticals=ai-agents,moon-mining", "verticals.1"],
    ["empty verticals", "verticals=", "verticals.0"],
    ["unknown query parameter", "madeUpFilter=value", "query"],
    ["edgeTypes", "edgeTypes=founder_of,follows", "edgeTypes.1"],
    ["empty edgeTypes", "edgeTypes=", "edgeTypes.0"],
    ["topVoices", "topVoices=everyone", "topVoices"],
    ["empty topVoices", "topVoices=", "topVoices"],
    ["batch", "batch=unknown", "batch"],
    ["empty batch", "batch=", "batch"],
    ["non-numeric minScore", "minScore=high", "minScore"],
    ["empty minScore", "minScore=", "minScore"],
    ["out-of-range minScore", "minScore=101", "minScore"],
    ["includeRaw", "includeRaw=yes", "includeRaw"],
    ["includeNonScoring", "includeNonScoring=2", "includeNonScoring"],
    ["includeWhy", "includeWhy=on", "includeWhy"],
    ["empty industry list member", "industries=fintech,,consumer", "industries.1"],
    ["empty group-partner list member", "groupPartners=Partner%20A,", "groupPartners.1"],
    ["blank search query", "q=%20%20", "q"],
    ["repeated typed parameter", "platforms=github&platforms=x", "platforms"],
    ["repeated topic parameter", "topics=traction-growth&topics=hiring-team", "topics"],
    ["repeated vertical parameter", "verticals=fintech&verticals=payments", "verticals"]
  ])("returns a structured 400 for invalid %s values", async (_name, search, errorPath) => {
    const response = await GET(new Request(`http://localhost/api/graph?${search}`));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body).toMatchObject({
      status: "failed",
      logs: [],
      error: { code: "invalid_query" }
    });
    expect(body.errors.join(" ")).toContain(errorPath);
    expect(body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: errorPath })])
    );
  });

  it("accepts canonical Topic and Vertical slugs", async () => {
    const topicResponse = await GET(
      new Request("http://localhost/api/graph?batch=S2026&topics=traction-growth")
    );
    expect(topicResponse.status).toBe(200);
    const topicBody = await topicResponse.json();
    expect(topicBody.evidence.length).toBeGreaterThan(0);
    expect(topicBody.evidence.every((item: { topics?: string[] }) => item.topics?.includes("traction-growth"))).toBe(true);

    const verticalResponse = await GET(
      new Request("http://localhost/api/graph?batch=S2026&verticals=ai-agents")
    );
    expect(verticalResponse.status).toBe(200);
    const verticalBody = await verticalResponse.json();
    const companyNodes = verticalBody.nodes.filter((node: { entityType: string }) => node.entityType === "company");
    expect(companyNodes.length).toBeGreaterThan(0);
    expect(companyNodes.every(
      (node: { verticals?: string[] }) => node.verticals?.includes("ai-agents")
    )).toBe(true);
  });

  it("normalizes legacy Topic aliases before filtering instead of returning an empty 200", async () => {
    const response = await GET(new Request("http://localhost/api/graph?batch=S2026&topics=traction"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.evidence.length).toBeGreaterThan(0);
    expect(body.evidence.every((item: { topics?: string[] }) => item.topics?.includes("traction-growth"))).toBe(true);
  });

  it("preserves absent parameters and accepts explicit false boolean values", async () => {
    const absentResponse = await GET(new Request("http://localhost/api/graph"));
    const absentBody = await absentResponse.json();

    expect(absentResponse.status).toBe(200);
    expect(absentBody.batch.slug).toBe("S2026");
    expect(absentBody.selectedTopVoiceAudience.id).toBe("off");
    expect(absentBody.scoringContext.selectedPlatforms).toEqual([]);

    const explicitFalseResponse = await GET(
      new Request(
        "http://localhost/api/graph?batch=S2026&minScore=0&topVoices=off&includeRaw=0&includeNonScoring=false&includeWhy=0"
      )
    );
    expect(explicitFalseResponse.status).toBe(200);
  });
});
