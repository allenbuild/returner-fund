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
    render(
      <TopStoriesDashboard
        snapshot={snapshotWithThumbnail(
          "https://images.example.test/cover.jpg",
          "Unapproved dashboard thumbnail",
          { injectIntoPublicFixture: true }
        )}
      />
    );

    expect(screen.queryByRole("img", { name: "Unapproved dashboard thumbnail" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Unapproved dashboard thumbnail").tagName).toBe("SPAN");
  });
});

function snapshotWithThumbnail(
  thumbnailUrl: string,
  thumbnailAlt: string,
  options?: { injectIntoPublicFixture?: boolean }
): DashboardPublicFeedSnapshot {
  const candidates = developmentDashboardFixtures(NOW);
  const qualifiedFixture = candidates[0];
  if (!qualifiedFixture) throw new Error("Expected dashboard candidate fixtures.");
  qualifiedFixture.sourceVerified = true;
  qualifiedFixture.sourceLinkStatus = "verified";
  qualifiedFixture.publicationPrecision = "exact";
  qualifiedFixture.socialBackfillEligible = true;
  qualifiedFixture.metrics = { ...qualifiedFixture.metrics, views: 1_000_000 };

  const { snapshot } = buildDashboardSnapshot(candidates, { now: NOW });
  const next = structuredClone(snapshot);
  const story = next.stories[0];
  if (!story) throw new Error("Expected dashboard fixtures to produce a story.");
  story.thumbnailUrl = thumbnailUrl;
  story.thumbnailAlt = thumbnailAlt;
  const feed = toDashboardPublicFeedSnapshot(next);
  // The store removes unapproved URLs before publishing. Inject one into the
  // compact fixture here so the renderer's independent safety fallback stays
  // covered for stale or tampered public artifacts.
  if (options?.injectIntoPublicFixture) feed.stories[0]!.thumbnailUrl = thumbnailUrl;
  return feed;
}
