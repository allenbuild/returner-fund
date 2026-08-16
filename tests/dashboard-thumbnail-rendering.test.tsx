import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TopStoriesDashboard } from "@/components/dashboard/TopStoriesDashboard";
import type { DashboardPublicFeedSnapshot } from "@/lib/dashboard/contracts";
import { developmentDashboardFixtures } from "@/lib/dashboard/fixtures";
import { buildDashboardSnapshot } from "@/lib/dashboard/pipeline";
import { toDashboardPublicFeedSnapshot } from "@/lib/dashboard/store";

const NOW = new Date("2026-08-15T12:00:00.000Z");

describe("dashboard thumbnail rendering", () => {
  it("uses Next's constrained optimizer for an approved thumbnail host", () => {
    const thumbnailUrl = "https://avatars.githubusercontent.com/u/123?v=4";
    render(<TopStoriesDashboard snapshot={snapshotWithThumbnail(thumbnailUrl, "Approved dashboard thumbnail")} />);

    const image = screen.getByRole("img", { name: "Approved dashboard thumbnail" });
    expect(image).toHaveAttribute("src", expect.stringContaining("/_next/image?"));
    expect(image.getAttribute("src")).toContain(encodeURIComponent(thumbnailUrl));
  });

  it("uses the local platform fallback instead of loading an unapproved thumbnail URL", () => {
    render(<TopStoriesDashboard snapshot={snapshotWithThumbnail("https://images.example.test/cover.jpg", "Unapproved dashboard thumbnail")} />);

    expect(screen.queryByRole("img", { name: "Unapproved dashboard thumbnail" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Unapproved dashboard thumbnail").tagName).toBe("SPAN");
  });
});

function snapshotWithThumbnail(thumbnailUrl: string, thumbnailAlt: string): DashboardPublicFeedSnapshot {
  const { snapshot } = buildDashboardSnapshot(developmentDashboardFixtures(NOW), { now: NOW });
  const next = structuredClone(snapshot);
  const story = next.stories[0];
  if (!story) throw new Error("Expected dashboard fixtures to produce a story.");
  story.thumbnailUrl = thumbnailUrl;
  story.thumbnailAlt = thumbnailAlt;
  return toDashboardPublicFeedSnapshot(next);
}
