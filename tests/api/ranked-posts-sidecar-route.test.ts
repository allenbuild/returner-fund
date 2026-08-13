import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/ranked-posts-sidecar/route";

describe("GET /api/ranked-posts-sidecar", () => {
  it("serves the current full-corpus sidecar without caching", async () => {
    const response = GET();
    const body = await response.json() as {
      version: string;
      generatedAt: string;
      batches: Record<string, Record<string, { previewGeneratedAt: string }>>;
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(response.headers.get("x-ranked-posts-sidecar-version")).toBe("ranked-posts-full-corpus-v1");
    expect(body.version).toBe("ranked-posts-full-corpus-v1");
    expect(new Date(body.generatedAt).toISOString()).toBe(body.generatedAt);
    expect(new Date(body.batches.S26.off.previewGeneratedAt).toISOString())
      .toBe(body.batches.S26.off.previewGeneratedAt);
  });
});
