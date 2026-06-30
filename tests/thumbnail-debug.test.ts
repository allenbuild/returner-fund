import { describe, expect, it } from "vitest";
import { buildGraphResponse } from "@/lib/graph/graph-builder";
import { ycSpring2026GraphDataset } from "@/lib/graph/yc-spring-2026-dataset";
import { buildThumbnailCoverageReport, isFallbackThumbnail } from "@/lib/ingestion/thumbnail-debug";

describe("thumbnail debug coverage", () => {
  it("treats cached PNG screenshots as real thumbnails and generated SVGs as fallback", () => {
    expect(isFallbackThumbnail("/evidence-thumbnails/instagram/heyclicky-cover.png")).toBe(false);
    expect(isFallbackThumbnail("/evidence-thumbnails/x/generated-preview.svg")).toBe(true);
    expect(isFallbackThumbnail("https://pbs.twimg.com/media/example.jpg")).toBe(false);
    expect(isFallbackThumbnail("https://example.com/favicon.svg")).toBe(false);
  });

  it("summarizes thumbnail coverage without counting local screenshots as fallback", () => {
    const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
    const report = buildThumbnailCoverageReport({
      ...graph,
      evidence: [
        {
          ...graph.evidence[0],
          id: "real-local-png",
          thumbnailUrl: "/evidence-thumbnails/instagram/real-local.png",
          thumbnailSource: "instagram-media-cache"
        },
        {
          ...graph.evidence[0],
          id: "generated-svg",
          thumbnailUrl: "/evidence-thumbnails/x/generated.svg",
          thumbnailSource: "x-generated-fallback"
        },
        {
          ...graph.evidence[0],
          id: "missing-thumbnail",
          thumbnailUrl: null,
          thumbnailSource: null
        }
      ]
    });

    expect(report.rowsWithRealThumbnail).toBe(1);
    expect(report.rowsWithFallbackThumbnail).toBe(1);
    expect(report.rowsMissingThumbnail).toBe(1);
  });
});
