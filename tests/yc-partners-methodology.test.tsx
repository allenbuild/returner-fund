import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ScoringMethodology } from "@/components/ScoringMethodology";

describe("YC Partner Favorite methodology", () => {
  it("explains conviction weighting, duplicate handling, confidence, and absence of evidence", () => {
    render(<ScoringMethodology />);

    expect(screen.getByText(/Favorite score is a separate 1–100 signal/i)).toBeInTheDocument();
    expect(screen.getByText(/Explicit superlatives, strong endorsements, and specific reasoning/i))
      .toBeInTheDocument();
    expect(screen.getByText(/duplicate or cross-posted copies count once/i)).toBeInTheDocument();
    expect(screen.getByText(/Confidence is separate from Favorite score/i)).toBeInTheDocument();
    expect(screen.getByText(/not treated as evidence of dislike/i)).toBeInTheDocument();
  });
});
