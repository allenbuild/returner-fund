import { applyClientGraphFilters, type ClientGraphFilters } from "./client-filters";
import { topicPhysicalPostCounts } from "./graph-taxonomies";
import type { PostTopic } from "./post-topics";
import type { GraphResponse } from "./types";

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
  const topicAgnosticGraph = applyClientGraphFilters(graph, {
    ...filters,
    topics: []
  });
  return topicPhysicalPostCounts(topicAgnosticGraph.evidence);
}
