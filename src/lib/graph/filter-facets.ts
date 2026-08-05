import { applyClientGraphFilters, type ClientGraphFilters } from "./client-filters";
import { topicPhysicalPostCounts } from "./graph-taxonomies";
import type { PostTopic } from "./post-topics";
import type { GraphResponse, TopicFacetRow } from "./types";

/**
 * Counts the physical posts that qualify for each Topic after every other
 * visibility filter has been applied. The Topic dimension itself is omitted so
 * that multi-select remains an OR facet: an unselected Topic's count describes
 * the posts that selecting it would add, rather than only Topic co-occurrences.
 *
 * The source graph must be the unfiltered graph for the active batch and Top
 * Voices audience. Passing an already Topic-filtered response cannot restore
 * evidence that the server removed.
 */
export function topicPostFacetCounts(
  graph: GraphResponse,
  filters: ClientGraphFilters
): Map<PostTopic, number> {
  const hasNonTopicFilters = Boolean(
    filters.platforms.length ||
    filters.verticals?.length ||
    filters.industries.length ||
    filters.groupPartners.length ||
    filters.minScore > 0
  );
  if (
    !hasNonTopicFilters &&
    graph.selectedTopVoiceAudience.id === "off" &&
    graph.evidenceStats?.byTopic
  ) {
    return new Map(
      Object.entries(graph.evidenceStats.byTopic) as Array<[PostTopic, number]>
    );
  }

  const topicAgnosticGraph = applyClientGraphFilters(graph, {
    ...filters,
    topics: []
  });

  const facetRows = graph.topicFacetRows?.filter(
    (row) => row.audienceId === graph.selectedTopVoiceAudience.id
  ) ?? [];
  if (facetRows.length > 0) {
    const visibleCompanyIds = new Set(
      topicAgnosticGraph.nodes
        .filter((node) => node.entityType === "company")
        .map((node) => node.entityId)
    );
    return topicFacetPhysicalPostCounts(
      facetRows.filter((row) =>
        visibleCompanyIds.has(row.companyId) &&
        (filters.platforms.length === 0 || filters.platforms.includes(row.platform)) &&
        (graph.selectedTopVoiceAudience.id === "off" || row.contributionScore > 0)
      )
    );
  }

  return topicPhysicalPostCounts(topicAgnosticGraph.evidence);
}

function topicFacetPhysicalPostCounts(rows: TopicFacetRow[]): Map<PostTopic, number> {
  const postKeysByTopic = new Map<PostTopic, Set<string>>();
  for (const row of rows) {
    const keys = postKeysByTopic.get(row.topic) ?? new Set<string>();
    keys.add(row.postKey);
    postKeysByTopic.set(row.topic, keys);
  }
  return new Map([...postKeysByTopic].map(([topic, keys]) => [topic, keys.size]));
}
