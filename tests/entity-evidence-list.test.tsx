import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EntityEvidenceList } from "@/components/seo/EntityEvidenceList";
import type { EvidenceItem } from "@/lib/graph/types";

describe("EntityEvidenceList", () => {
  it("fails closed instead of crashing when legacy evidence omits display fields", () => {
    const legacyEvidence = {
      id: "legacy-evidence",
      platform: "x",
      postedAt: undefined,
      authorName: undefined,
      authorHandle: undefined,
      text: undefined,
      title: undefined,
      metrics: undefined,
      contributionScore: undefined,
      sourceUrl: "https://x.com/example/status/1"
    } as unknown as EvidenceItem;

    render(<EntityEvidenceList evidence={[legacyEvidence]} />);

    expect(screen.getByText("Date unavailable")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Public traction signal" })).toBeInTheDocument();
    expect(screen.getByText("Signal score").nextElementSibling).toHaveTextContent("0");
  });
});
