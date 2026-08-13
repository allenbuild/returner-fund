import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/topic-facets/[batchSlug]/route";
import { TOPIC_FACET_SNAPSHOT_VERSION } from "@/lib/graph/topic-facets";

describe("GET /api/topic-facets/[batchSlug]", () => {
  it("serves the current batch snapshot with explicit no-store headers", async () => {
    const response = await GET(new Request("http://localhost/api/topic-facets/S26"), {
      params: Promise.resolve({ batchSlug: "S26" })
    });
    const body = await response.json() as { version: string; batchSlug: string; rowCount: number; rows: unknown[] };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0, must-revalidate");
    expect(response.headers.get("cdn-cache-control")).toBe("no-store");
    expect(response.headers.get("x-topic-facets-batch")).toBe("S26");
    expect(response.headers.get("x-topic-facets-version")).toBe(TOPIC_FACET_SNAPSHOT_VERSION);
    expect(body).toMatchObject({
      version: TOPIC_FACET_SNAPSHOT_VERSION,
      batchSlug: "S26"
    });
    expect(body.rowCount).toBe(body.rows.length);
  });

  it("does not cache or expose an unknown batch", async () => {
    const response = await GET(new Request("http://localhost/api/topic-facets/nope"), {
      params: Promise.resolve({ batchSlug: "nope" })
    });
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
});
