import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/graph/route";

describe("GET /api/graph forward-compatible platforms", () => {
  it.each(["facebook", "threads"])("accepts the unscored native %s platform at the published route boundary", async (platform) => {
    const response = await GET(new Request(`http://localhost/api/graph?batch=F26&platforms=${platform}`));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.batch.slug).toBe("F26");
    expect(body.evidence.every((row: { platform: string }) => row.platform === platform)).toBe(true);
  });
  it("accepts TikTok and Bluesky filters without dropping them at the API boundary", async () => {
    const response = await GET(
      new Request("http://localhost/api/graph?batch=A16ZSR006&platforms=tiktok,bluesky")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.scoringContext).toMatchObject({
      scoreScope: "all_platforms",
      selectedPlatforms: []
    });
    expect(body.platformStatus).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ platform: "tiktok", status: expect.any(String) }),
        expect.objectContaining({ platform: "bluesky", status: expect.any(String) })
      ])
    );
  });
});
