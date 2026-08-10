import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ScoringMethodology } from "@/components/ScoringMethodology";

describe("ScoringMethodology", () => {
  it("describes the production score as recency-free and omits decay controls", () => {
    const { container } = render(<ScoringMethodology />);

    expect(screen.getByText(/Publication date and post age do not raise or lower an evidence score/i))
      .toBeInTheDocument();
    expect(screen.getByText(/an older post is not discounted and a newer post receives no freshness bonus/i))
      .toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Half-life" })).not.toBeInTheDocument();
    expect(screen.queryByText(/recency momentum/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/missing publication date uses/i)).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent(/\bmultipli\w*\b/i);
  });
});
