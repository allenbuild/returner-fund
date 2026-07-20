import type { EdgeType } from "./types";

export interface EdgePresentation {
  label: string;
  color: string;
  lineStyle: "solid" | "dashed" | "dotted";
  description: string;
}

export const EDGE_PRESENTATION = {
  industry_similarity: {
    label: "Industry similarity",
    color: "#835a08",
    lineStyle: "solid",
    description:
      "Shared industry tags and description terms. The similarity formula is 75% industry-tag Jaccard similarity and 25% description-term Jaccard similarity."
  },
  same_group_partner: {
    label: "Same group partner",
    color: "#146b58",
    lineStyle: "dashed",
    description: "Both company records list the same YC group partner."
  },
  top_voice_attention: {
    label: "Top Voice attention",
    color: "#0369a1",
    lineStyle: "dotted",
    description: "Verified evidence from the selected Top Voice audience matches attention to this company."
  },
  founder_of: {
    label: "Founder of",
    color: "#334155",
    lineStyle: "solid",
    description: "An explicit founder/company relationship in the source data."
  }
} as const satisfies Record<EdgeType, EdgePresentation>;

export function edgePresentation(type: EdgeType): EdgePresentation {
  return EDGE_PRESENTATION[type];
}
