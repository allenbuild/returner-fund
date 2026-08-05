import { describe, expect, it } from "vitest";
import {
  isTopicFacetSnapshot,
  TOPIC_FACET_SNAPSHOT_VERSION,
  topicFacetRowsForAudience,
  topicFacetSnapshotUrl,
  withTopicFacetRows
} from "@/lib/graph/topic-facets";
import type { GraphResponse, TopicFacetRow } from "@/lib/graph/types";

describe("topic facet snapshots", () => {
  it("validates the compact snapshot contract and selects one audience", () => {
    const rows: TopicFacetRow[] = [{
      topic: "product-launch",
      postKey: "x:1",
      platform: "x",
      companyId: "company-acme",
      contributionScore: 12,
      audienceId: "off"
    }, {
      topic: "traction-growth",
      postKey: "x:2",
      platform: "x",
      companyId: "company-acme",
      contributionScore: 20,
      audienceId: "yc_partners"
    }];
    const snapshot = {
      version: TOPIC_FACET_SNAPSHOT_VERSION,
      batchSlug: "S2026",
      rowCount: rows.length,
      rows
    };

    expect(isTopicFacetSnapshot(snapshot)).toBe(true);
    expect(topicFacetRowsForAudience(snapshot, "off")).toEqual([rows[0]]);
    expect(topicFacetRowsForAudience(snapshot, "yc_partners")).toEqual([rows[1]]);
    expect(isTopicFacetSnapshot({ ...snapshot, rows: [{ ...rows[0], topic: "not-a-topic" }] })).toBe(false);
  });

  it("builds stable public URLs and attaches selected rows without mutating the graph", () => {
    expect(topicFacetSnapshotUrl("S2026")).toBe(`/topic-facets/s2026.json?v=${TOPIC_FACET_SNAPSHOT_VERSION}`);
    expect(topicFacetSnapshotUrl("unknown")).toBeNull();

    const graph = { selectedTopVoiceAudience: { id: "off" } } as GraphResponse;
    const rows: TopicFacetRow[] = [{
      topic: "corporate-update",
      postKey: "x:3",
      platform: "x",
      companyId: "company-acme",
      contributionScore: 0,
      audienceId: "off"
    }];
    const attached = withTopicFacetRows(graph, rows);
    expect(attached).not.toBe(graph);
    expect(attached.topicFacetRows).toBe(rows);
    expect(graph.topicFacetRows).toBeUndefined();
  });
});
