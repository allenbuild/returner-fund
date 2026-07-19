import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildGraphResponse,
  clearTopVoiceRollupCache
} from "../src/lib/graph/graph-builder.ts";
import { yc2026GraphDataset } from "../src/lib/graph/yc-spring-2026-dataset.ts";
import {
  GRAPH_ARTIFACTS,
  collectCanonicalGraphSetViolations,
  collectGraphArtifactViolations
} from "../scripts/validate-public-artifacts.mjs";

const RESPONSE_BUILT_AT = new Date().toISOString();

describe("public artifact validator against canonical v4 responses", () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(RESPONSE_BUILT_AT);
    clearTopVoiceRollupCache();
  });

  afterAll(() => {
    clearTopVoiceRollupCache();
    vi.useRealTimers();
  });

  it.each(GRAPH_ARTIFACTS)("accepts $path", (descriptor) => {
    const graph = buildGraphResponse(
      {
        batchSlug: descriptor.batch,
        ...(descriptor.audience === "off" ? {} : { topVoices: descriptor.audience })
      },
      yc2026GraphDataset
    );

    const violations = collectGraphArtifactViolations(graph, descriptor);

    expect(violations, violations.slice(0, 20).join("\n")).toEqual([]);
  });

  it("preserves canonical scores, ranks, radii, and momentum across audience snapshots", () => {
    const entries = GRAPH_ARTIFACTS.map((descriptor) => ({
      descriptor,
      graph: buildGraphResponse(
        {
          batchSlug: descriptor.batch,
          ...(descriptor.audience === "off" ? {} : { topVoices: descriptor.audience })
        },
        yc2026GraphDataset
      )
    }));

    const violations = collectCanonicalGraphSetViolations(entries);

    expect(violations, violations.slice(0, 20).join("\n")).toEqual([]);
  });
});
