import { edgePresentation } from "@/lib/graph/edge-presentation";
import type { EdgeType, GraphEdge } from "@/lib/graph/types";

const EDGE_ORDER: EdgeType[] = [
  "industry_similarity",
  "same_group_partner",
  "top_voice_attention",
  "founder_of"
];

export function GraphEdgeLegend({ edges }: { edges: GraphEdge[] }) {
  const presentTypes = new Set(edges.map((edge) => edge.edgeType));
  const visibleTypes = EDGE_ORDER.filter((type) => presentTypes.has(type));

  if (!visibleTypes.length) return null;

  return (
    <section className="edge-legend" aria-labelledby="edge-legend-title">
      <div className="edge-legend-heading">
        <strong id="edge-legend-title">Map connections</strong>
        <span>Relationships only · never score points</span>
      </div>
      <div className="edge-legend-items">
        {visibleTypes.map((type) => {
          const presentation = edgePresentation(type);
          const explanations = uniqueExplanations(edges, type);
          return (
            <details className="edge-legend-item" key={type}>
              <summary>
                <span
                  className={`edge-legend-line edge-legend-line-${presentation.lineStyle}`}
                  style={{ color: presentation.color }}
                  aria-hidden="true"
                />
                <span>{presentation.label}</span>
              </summary>
              <div className="edge-legend-tooltip">
                <p>{presentation.description}</p>
                {explanations.length > 0 && (
                  <ul aria-label={`${presentation.label} explanations in this map`}>
                    {explanations.map((explanation) => <li key={explanation}>{explanation}</li>)}
                  </ul>
                )}
              </div>
            </details>
          );
        })}
      </div>
      <p>
        A connection does not mean one company interacted with another, and line thickness or opacity is map emphasis,
        not traction strength or score contribution.
      </p>
    </section>
  );
}

function uniqueExplanations(edges: GraphEdge[], type: EdgeType): string[] {
  return [...new Set(
    [...edges]
      .filter((edge) => edge.edgeType === type)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((edge) => edge.explanation.trim())
      .filter(Boolean)
  )].slice(0, 3);
}
