import { describe, expect, it } from "vitest";
import { loadYcPartnerFavorites } from "@/lib/yc-partners/server";

describe("YC partner favorite materialization", () => {
  it("aggregates the published partner snapshots across all supported batches", async () => {
    const response = await loadYcPartnerFavorites({ partnerId: "brad-flora" });

    expect(response.modelVersion).toBe("conviction-v1");
    expect(response.batchCount).toBeGreaterThanOrEqual(2);
    expect(response.companyCount).toBeGreaterThan(0);
    expect(response.partners).toHaveLength(1);
    expect(response.partners[0]?.partnerId).toBe("brad-flora");
    expect(response.partners[0]?.rankings.length).toBeGreaterThan(0);
    expect(response.partners[0]?.rankings[0]?.score).toBeGreaterThan(0);
    expect(response.partners[0]?.rankings[0]?.citations[0]?.sourceUrl).toMatch(/^https?:\/\//);
  }, 60_000);
});
