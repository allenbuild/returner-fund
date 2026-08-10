import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildGraphResponse } from "@/lib/graph/graph-builder";
import {
  canonicalPostKey,
  dedupePublishedContextEvidence
} from "@/lib/graph/dedupe";
import { enrichEvidenceTopics } from "@/lib/graph/graph-taxonomies";
import { normalizePostTopics } from "@/lib/graph/post-topics";
import {
  isTopicFacetSnapshot,
  type TopicFacetSnapshot
} from "@/lib/graph/topic-facets";
import type { DemoGraphDataset, EvidenceItem, GraphResponse, TopicFacetRow } from "@/lib/graph/types";
import { ycSpring2026GraphDataset } from "@/lib/graph/yc-spring-2026-dataset";

const COHORTS = [
  { batchSlug: "S2026", filename: "s2026" },
  { batchSlug: "S26", filename: "s26" },
  { batchSlug: "A16ZSR006", filename: "a16zsr006" }
] as const;

describe("topic facet full-source parity", () => {
  it("covers every published cohort post and company from the uncapped graph corpus", () => {
    for (const cohort of COHORTS) {
      const snapshot = readSnapshot(cohort.filename);
      const graph = buildGraphResponse(
        { batchSlug: cohort.batchSlug, topVoices: "off" },
        ycSpring2026GraphDataset
      );
      expect(isTopicFacetSnapshot(snapshot)).toBe(true);

      const actualRows = snapshot.rows.filter((row) => row.audienceId === "off");
      const ownership = cohortOwnership(ycSpring2026GraphDataset, cohort.batchSlug);
      const ownedEvidence = ycSpring2026GraphDataset.evidence.filter((item) =>
        evidenceBelongsToCohort(item, cohort.batchSlug, ownership)
      );
      const publishedEvidence = dedupePublishedContextEvidence(
        ownedEvidence,
        cohort.batchSlug
      );
      const expectedRows = rowsForEvidence(publishedEvidence, ownership.companyByEntity);
      const actualByIdentity = rowsByIdentity(actualRows);
      const expectedByIdentity = rowsByIdentity(expectedRows);
      const graphByIdentity = rowsByIdentity(rowsForGraph(graph));

      expect(publishedEvidence.length).toBeLessThanOrEqual(ownedEvidence.length);
      expect(graph.evidence).toHaveLength(publishedEvidence.length);
      expect(actualByIdentity.size).toBe(graph.evidence.length);
      expect(parityFailures(actualByIdentity, expectedByIdentity)).toEqual([]);
      expect(parityFailures(actualByIdentity, graphByIdentity)).toEqual([]);

      const ownedPostKeys = new Set(expectedRows.map((row) => row.postKey));
      const foreignUnscopedPostKeys = new Set(
        ycSpring2026GraphDataset.evidence
          .filter((item) => !item.batchSlug && !evidenceBelongsToCohort(item, cohort.batchSlug, ownership))
          .map(canonicalPostKey)
          .filter((postKey) => !ownedPostKeys.has(postKey))
      );
      expect(foreignUnscopedPostKeys.size).toBeGreaterThan(0);
      expect(actualRows.some((row) => foreignUnscopedPostKeys.has(row.postKey))).toBe(false);
    }
  }, 300_000);
});

function readSnapshot(filename: string): TopicFacetSnapshot {
  return JSON.parse(
    readFileSync(join(process.cwd(), "public", "topic-facets", `${filename}.json`), "utf8")
  ) as TopicFacetSnapshot;
}

function cohortOwnership(dataset: DemoGraphDataset, batchSlug: string): {
  companyIds: Set<string>;
  companyByEntity: Map<string, string>;
} {
  const companyIds = new Set<string>();
  const companyByEntity = new Map<string, string>();
  for (const company of dataset.companies) {
    if (company.batchSlug !== batchSlug) continue;
    companyIds.add(company.id);
    companyByEntity.set(company.id, company.id);
  }
  for (const founder of dataset.founders) {
    if (founder.batchSlug !== batchSlug) continue;
    const companyId = founder.companyIds.find((candidate) => companyIds.has(candidate));
    if (companyId) companyByEntity.set(founder.id, companyId);
  }
  return { companyIds, companyByEntity };
}

function evidenceBelongsToCohort(
  item: EvidenceItem,
  batchSlug: string,
  ownership: ReturnType<typeof cohortOwnership>
): boolean {
  if (item.batchSlug && item.batchSlug.toUpperCase() !== batchSlug) return false;
  return item.attachedCompanyId
    ? ownership.companyIds.has(item.attachedCompanyId)
    : ownership.companyByEntity.has(item.entityId);
}

function rowsForEvidence(
  evidence: EvidenceItem[],
  companyByEntity: Map<string, string>
): TopicFacetRow[] {
  return evidence
    .map(enrichEvidenceTopics)
    .flatMap((item) => {
      const companyId = item.attachedCompanyId ?? companyByEntity.get(item.entityId);
      if (!companyId) return [];
      return normalizePostTopics(item.topics ?? []).map((topic) => ({
        topic,
        postKey: canonicalPostKey(item),
        platform: item.platform,
        companyId,
        contributionScore: item.contributionScore,
        audienceId: "off" as const
      }));
    });
}

function rowsForGraph(graph: GraphResponse): TopicFacetRow[] {
  const companyByEntity = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.entityType !== "company") continue;
    companyByEntity.set(node.entityId, node.entityId);
    for (const founder of node.founders) companyByEntity.set(founder.id, node.entityId);
  }
  return rowsForEvidence(graph.evidence, companyByEntity);
}

function rowsByIdentity(rows: TopicFacetRow[]): Map<string, TopicFacetRow> {
  return new Map(
    rows.map((row) => [
      `${row.topic}\u0000${row.postKey}`,
      row
    ])
  );
}

function parityFailures(
  actual: Map<string, TopicFacetRow>,
  expected: Map<string, TopicFacetRow>
): string[] {
  const failures: string[] = [];
  for (const [identity, expectedRow] of expected) {
    const actualRow = actual.get(identity);
    if (!actualRow) failures.push(`missing:${identity}`);
    else if (JSON.stringify(actualRow) !== JSON.stringify(expectedRow)) {
      failures.push(`mismatch:${identity}`);
    }
  }
  for (const identity of actual.keys()) {
    if (!expected.has(identity)) failures.push(`extra:${identity}`);
  }
  return failures.slice(0, 20);
}
