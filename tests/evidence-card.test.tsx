import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EvidenceMediaCard } from "@/components/EvidenceMediaCard";
import type { EvidenceItem } from "@/lib/graph/types";

describe("EvidenceMediaCard", () => {
  it("renders the compact public evidence surface without debug metadata", () => {
    const item: EvidenceItem = {
      id: "ev-card",
      entityType: "founder",
      entityId: "founder-1",
      platform: "x",
      authorName: "Farza",
      authorHandle: "FarzaTV",
      postedAt: "2026-05-30T00:00:00.000Z",
      title: "Watch me control my computer with just my voice.",
      text: "Watch me control my computer with just my voice. This is the future of operating systems.",
      mediaType: "video",
      thumbnailUrl: "https://pbs.twimg.com/media/HIGTbVJbkAAxEpE.jpg",
      thumbnailSource: "x-media",
      metrics: { views: 3_700_000, likes: 14_000, comments: 935, reposts: 1_500 },
      contributionScore: 100,
      rawEngagement: 338_000,
      normalizedScore: 100,
      sourceUrl: "https://x.com/FarzaTV/status/123",
      first_seen_at: "2026-06-28T00:00:00.000Z",
      last_checked_at: "2026-06-29T00:00:00.000Z",
      why: "Attached to HeyClicky after attribution guard.",
      attachedCompanyName: "HeyClicky"
    };

    const { container } = render(<EvidenceMediaCard item={item} />);

    expect(screen.getByText("Watch me control my computer with just my voice.")).toBeInTheDocument();
    expect(screen.queryByText("Farza / FarzaTV")).not.toBeInTheDocument();
    expect(screen.getByText("100")).toBeInTheDocument();
    expect(container.querySelector(".evidence-card-stats")).toHaveTextContent(
      "3.7M views / 14K likes / 935 comments / 1,500 reposts"
    );
    expect(container.querySelector(".evidence-media-card")).toHaveAttribute("href", item.sourceUrl);
    const imageSrc = container.querySelector("img")?.getAttribute("src");
    expect(imageSrc).toBe(item.thumbnailUrl);
    expect(screen.queryByText(/raw/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/normalized/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/first seen/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/checked/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/attached/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^open$/i)).not.toBeInTheDocument();
  });

  it("generates a post thumbnail when no native thumbnail exists", () => {
    const item: EvidenceItem = {
      id: "ev-fallback",
      entityType: "company",
      entityId: "company-1",
      platform: "github",
      authorName: "acme/widgets",
      authorHandle: "acme",
      postedAt: "2026-06-20T00:00:00.000Z",
      text: "acme/widgets: GitHub repository.",
      mediaType: "repo",
      metrics: { stars: 1200, forks: 88 },
      contributionScore: 82,
      sourceUrl: "https://github.com/acme/widgets",
      why: "Repository traction."
    };

    const { container } = render(<EvidenceMediaCard item={item} />);

    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
    expect(decodeDataImage(img?.getAttribute("src"))).toContain("GitHub");
    expect(screen.queryByRole("img", { name: "GitHub logo" })).not.toBeInTheDocument();
    expect(screen.getAllByText(/1,200 stars/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("acme/widgets: GitHub repository.").length).toBeGreaterThan(0);
    expect(screen.queryByText(/preview pending/i)).not.toBeInTheDocument();
  });

  it("falls through to a generated thumbnail if native media fails", () => {
    const item: EvidenceItem = {
      id: "ev-broken-native",
      entityType: "company",
      entityId: "company-1",
      platform: "instagram",
      authorName: "Acme",
      authorHandle: "acme",
      postedAt: "2026-06-20T00:00:00.000Z",
      text: "We shipped a new demo.",
      mediaType: "video",
      thumbnailUrl: "https://scontent.cdninstagram.com/v/t51.71878-15/expired-cover.jpg",
      thumbnailSource: "instagram-media",
      metrics: { likes: 1200, comments: 88 },
      contributionScore: 82,
      sourceUrl: "https://www.instagram.com/reel/ABC123/",
      why: "Visible Instagram traction."
    };

    const { container } = render(<EvidenceMediaCard item={item} />);
    const nativeImg = container.querySelector("img");

    expect(nativeImg).toHaveAttribute("src", item.thumbnailUrl);
    fireEvent.error(nativeImg!);

    const generatedImg = container.querySelector("img");
    expect(generatedImg?.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
    expect(decodeDataImage(generatedImg?.getAttribute("src"))).toContain("Instagram");
    expect(container.querySelector(".evidence-thumbnail-fallback")).not.toBeInTheDocument();
  });

  it("uses native Instagram CDN covers before generated fallback", () => {
    const item: EvidenceItem = {
      id: "ev-instagram-cover",
      entityType: "founder",
      entityId: "founder-ig",
      platform: "instagram",
      authorName: "Farza",
      authorHandle: "farza954",
      postedAt: "2026-04-25T00:00:00.000Z",
      title: "im building a buddy for your computer cursor",
      text: "im building a buddy for your computer cursor",
      mediaType: "video",
      thumbnailUrl: "https://scontent.cdninstagram.com/v/t51.71878-15/cover.jpg",
      thumbnailSource: "instagram-media",
      metrics: { likes: 123_500, comments: 30_300 },
      contributionScore: 100,
      sourceUrl: "https://www.instagram.com/reel/ABC123/",
      why: "Visible Instagram reel metrics."
    };

    const { container } = render(<EvidenceMediaCard item={item} />);

    const imageSrc = container.querySelector("img")?.getAttribute("src");
    expect(imageSrc).toBe(item.thumbnailUrl);
    expect(screen.queryByText(/cover blocked/i)).not.toBeInTheDocument();
  });
});

function decodeDataImage(value: string | null | undefined): string {
  const payload = value?.split(",")[1] ?? "";
  return decodeURIComponent(payload);
}
