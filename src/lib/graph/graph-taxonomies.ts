import {
  COMPANY_VERTICAL_TAXONOMY_VERSION,
  inferCompanyVerticals,
  type CompanyVertical
} from "./company-verticals";
import { canonicalPostKey } from "./dedupe";
import {
  POST_TOPIC_CLASSIFIER_VERSION,
  POST_TOPIC_TAXONOMY_VERSION,
  classifyPostTopics,
  normalizePostTopics,
  type PostTopic
} from "./post-topics";
import type { CompanyRecord, EvidenceItem, GraphNode, GraphResponse } from "./types";

export function enrichGraphTaxonomies(graph: GraphResponse): GraphResponse {
  const evidence = graph.evidence.map(enrichEvidenceTopics);
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  return {
    ...graph,
    nodes: graph.nodes.map(enrichGraphNodeVerticals),
    evidence,
    leaderboard: graph.leaderboard.map((row) => ({
      ...row,
      biggestContribution: row.biggestContribution
        ? evidenceById.get(row.biggestContribution.id) ?? enrichEvidenceTopics(row.biggestContribution)
        : null
    }))
  };
}

export function enrichEvidenceTopics(item: EvidenceItem): EvidenceItem {
  const existingTopics = normalizePostTopics(item.topics ?? []);
  if (
    item.topicClassification?.classifierVersion === POST_TOPIC_CLASSIFIER_VERSION &&
    item.topicClassification.taxonomyVersion === POST_TOPIC_TAXONOMY_VERSION &&
    existingTopics.length > 0 &&
    sameMembers(existingTopics, item.topicClassification.topics)
  ) {
    return existingTopics.length === item.topics?.length
      ? item
      : { ...item, topics: existingTopics };
  }

  const explicitTopics = !item.topicClassification || item.topicClassification.method === "curated"
    ? existingTopics
    : [];
  const classification = classifyPostTopics({
    explicitTopics,
    title: item.title,
    text: item.text,
    rawVisibleText: item.rawVisibleText,
    mediaType: item.mediaType
  });
  return {
    ...item,
    topics: [...classification.topics],
    topicClassification: classification
  };
}

export function enrichCompanyRecordVerticals(company: CompanyRecord): CompanyRecord {
  const existing = company.verticals ?? [];
  if (
    company.verticalClassification?.taxonomyVersion === COMPANY_VERTICAL_TAXONOMY_VERSION &&
    sameMembers(existing, company.verticalClassification.verticals)
  ) {
    return company;
  }
  const classification = inferCompanyVerticals({
    companyId: company.id,
    batchSlug: company.batchSlug,
    primaryIndustry: company.primaryIndustry,
    industries: company.industries,
    tagline: company.tagline,
    description: company.description,
    businessModel: company.businessModel,
    curatedVerticals: existing.length ? existing : undefined
  });
  return {
    ...company,
    verticals: classification.verticals,
    verticalClassification: classification
  };
}

export function enrichGraphNodeVerticals(node: GraphNode): GraphNode {
  if (node.entityType !== "company") return node;
  const existing = node.verticals ?? [];
  if (
    node.verticalClassification?.taxonomyVersion === COMPANY_VERTICAL_TAXONOMY_VERSION &&
    sameMembers(existing, node.verticalClassification.verticals)
  ) {
    return node;
  }
  const classification = inferCompanyVerticals({
    companyId: node.entityId,
    batchSlug: node.batchSlug,
    primaryIndustry: node.primaryIndustry,
    industries: node.industries,
    tagline: node.tagline,
    description: node.description,
    businessModel: node.businessModel,
    curatedVerticals: existing.length ? existing : undefined
  });
  return {
    ...node,
    verticals: classification.verticals,
    verticalClassification: classification
  };
}

export function topicPhysicalPostCounts(evidence: EvidenceItem[]): Map<PostTopic, number> {
  const postKeysByTopic = new Map<PostTopic, Set<string>>();
  for (const item of evidence) {
    const key = canonicalPostKey(item);
    for (const topic of normalizePostTopics(item.topics ?? [])) {
      const keys = postKeysByTopic.get(topic) ?? new Set<string>();
      keys.add(key);
      postKeysByTopic.set(topic, keys);
    }
  }
  return new Map([...postKeysByTopic].map(([topic, keys]) => [topic, keys.size]));
}

export function companyVerticalCounts(nodes: GraphNode[]): Map<CompanyVertical, number> {
  const counts = new Map<CompanyVertical, number>();
  for (const node of nodes) {
    if (node.entityType !== "company") continue;
    for (const vertical of new Set(node.verticals ?? [])) {
      counts.set(vertical, (counts.get(vertical) ?? 0) + 1);
    }
  }
  return counts;
}

function sameMembers<T extends string>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}
