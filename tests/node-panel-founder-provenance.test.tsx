import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NodePanel } from "@/components/NodePanel";
import type { GraphNode } from "@/lib/graph/types";

afterEach(cleanup);
function company(batchSlug: string): GraphNode {
  return {
    id: "company-ploid", entityType: "company", entityId: "company-ploid", label: "Ploid", batchSlug,
    score: 0, previousScore: 0, scoreDelta: 0, radius: 1, topPlatform: null, platformScores: {}, socialAccounts: [], evidenceIds: [],
    ycProfileUrl: "https://www.ycombinator.com/companies/ploid", websiteUrl: null, tagline: null, description: null, groupPartner: null,
    primaryIndustry: "b2b", businessModel: "b2b", review_state: "verified", sourceUrl: "https://www.ycombinator.com/companies/ploid", visual: { color: "#000", borderColor: "#000", opacity: 1 }, industries: [], relatedEntityIds: [],
    founders: [{ id: "founder-ploid-ada-123", name: "Ada Founder", ycProfileUrl: "https://www.ycombinator.com/people/ada-founder", socialAccounts: [], evidenceIds: [], platformScores: {} }],
    review_state_counts: { verified: 0, needs_review: 0, rejected: 0, unknown: 0 }
  } as unknown as GraphNode;
}
describe("founder provenance link in the dashboard", () => {
  it("renders F26 founder chip with the supplied official company destination", () => {
    const node = company("F26"), before = JSON.stringify(node);
    render(<NodePanel node={node} relatedNodes={[]} evidence={[]} />);
    expect(document.querySelector(".founder-chip-list a")).toHaveAttribute("href", "https://www.ycombinator.com/companies/ploid");
    expect(document.querySelector(".founder-chip-list a")).toHaveTextContent("Ada Founder");
    expect(JSON.stringify(node)).toBe(before);
  });
  it("retains the prior founder destination for earlier cohorts", () => {
    render(<NodePanel node={company("S26")} relatedNodes={[]} evidence={[]} />);
    expect(document.querySelector(".founder-chip-list a")).toHaveAttribute("href", "https://www.ycombinator.com/people/ada-founder");
  });
});
