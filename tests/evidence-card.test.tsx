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
    expect(screen.getByText("May 30th, 2026")).toBeInTheDocument();
    expect(screen.queryByText("Founder account")).not.toBeInTheDocument();
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

  it.each([
    {
      platform: "x" as const,
      metrics: { comments: 7, replies: 5 },
      expected: "7 comments"
    },
    {
      platform: "linkedin" as const,
      metrics: { reactions: 6, likes: 8, comments: 5, replies: 7, reposts: 3, shares: 4 },
      expected: "8 reactions / 7 comments / 4 reposts"
    }
  ])(
    "collapses $platform metric aliases into canonical displayed counts",
    ({ platform, metrics, expected }) => {
      const item: EvidenceItem = {
        id: `ev-${platform}-aliases`,
        entityType: "company",
        entityId: "company-aliases",
        platform,
        authorName: "Alias Co",
        authorHandle: "aliasco",
        postedAt: "2026-07-15T00:00:00.000Z",
        text: "Alias Co shipped an update.",
        mediaType: "text",
        metrics,
        contributionScore: 42,
        sourceUrl:
          platform === "x" ? "https://x.com/aliasco/status/1" : "https://www.linkedin.com/posts/aliasco_1",
        why: "Canonical metric display regression."
      };

      const { container } = render(<EvidenceMediaCard item={item} />);

      expect(container.querySelector(".evidence-card-stats")?.textContent).toBe(expected);
    }
  );

  it("uses singular labels for metric values of one", () => {
    const item: EvidenceItem = {
      id: "ev-singular-metrics",
      entityType: "company",
      entityId: "company-singular",
      platform: "x",
      authorName: "Singular Co",
      authorHandle: "singularco",
      postedAt: "2026-07-15T00:00:00.000Z",
      text: "Singular Co shipped an update.",
      mediaType: "text",
      metrics: { views: 1, likes: 1, replies: 1, reposts: 1 },
      contributionScore: 42,
      sourceUrl: "https://x.com/singularco/status/1",
      why: "Singular metric label regression."
    };

    const { container } = render(<EvidenceMediaCard item={item} />);

    expect(container.querySelector(".evidence-card-stats")?.textContent).toBe(
      "1 view / 1 like / 1 comment / 1 repost"
    );
  });

  it("replaces a generic source title with descriptive post text and its publication date", () => {
    const item: EvidenceItem = {
      id: "ev-farza-screen-aware-dictation",
      entityType: "founder",
      entityId: "founder-heyclicky-farza",
      platform: "x",
      authorName: "Farza",
      authorHandle: "FarzaTV",
      postedAt: "2026-07-14T20:37:25.000Z",
      title: "FarzaTV X post",
      text: "Today we're shipping screen-aware dictation. First, we built a speedy speech-to-text.",
      mediaType: "video",
      metrics: { views: 2_687_075, likes: 10_602, comments: 544, reposts: 465 },
      contributionScore: 100,
      sourceUrl: "https://x.com/FarzaTV/status/2077130366230639022",
      why: "Visible first-party X traction."
    };

    const { container } = render(<EvidenceMediaCard item={item} />);

    expect(screen.getAllByText("Today we're shipping screen-aware dictation.").length).toBeGreaterThan(0);
    expect(screen.queryByText("FarzaTV X post")).not.toBeInTheDocument();
    expect(screen.getByText("July 14th, 2026")).toBeInTheDocument();
    const generatedThumbnail = decodeDataImage(container.querySelector("img")?.getAttribute("src"));
    expect(generatedThumbnail).toContain("Today we're shipping");
    expect(generatedThumbnail).toContain("screen-aware dictation.");
    expect(generatedThumbnail).not.toContain("FarzaTV X post");
  });

  it("never renders a generic platform title when post text is unavailable", () => {
    const item: EvidenceItem = {
      id: "ev-generic-title-only",
      entityType: "founder",
      entityId: "founder-heyclicky-farza",
      platform: "x",
      authorName: "Farza",
      authorHandle: "FarzaTV",
      postedAt: "2026-07-14T20:37:25.000Z",
      title: "FarzaTV X post",
      text: "",
      mediaType: "text",
      metrics: { views: 100 },
      contributionScore: 10,
      sourceUrl: "https://x.com/FarzaTV/status/2077130366230639022",
      why: "Visible first-party X traction."
    };

    render(<EvidenceMediaCard item={item} />);

    expect(screen.queryByText("FarzaTV X post")).not.toBeInTheDocument();
    expect(screen.getByText(item.sourceUrl)).toBeInTheDocument();
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

  it("falls through to a generated thumbnail and resets failures for a new item", () => {
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

    const { container, rerender } = render(<EvidenceMediaCard item={item} />);
    const nativeImg = container.querySelector("img");

    expect(nativeImg).toHaveAttribute("src", item.thumbnailUrl);
    fireEvent.error(nativeImg!);

    const generatedImg = container.querySelector("img");
    expect(generatedImg?.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
    expect(decodeDataImage(generatedImg?.getAttribute("src"))).toContain("Instagram");
    expect(container.querySelector(".evidence-thumbnail-fallback")).not.toBeInTheDocument();

    rerender(<EvidenceMediaCard item={{ ...item, id: "ev-next-item" }} />);

    expect(container.querySelector("img")).toHaveAttribute("src", item.thumbnailUrl);
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

  it.each([
    ["tiktok", "TikTok", "https://www.tiktok.com/@acme/video/7512345678901234567"],
    ["bluesky", "Bluesky", "https://bsky.app/profile/acme.example/post/3ltforwardcompat"]
  ] as const)("renders unscored %s evidence without presenting zero traction", (platform, label, sourceUrl) => {
    const item: EvidenceItem = {
      id: `ev-${platform}`,
      entityType: "company",
      entityId: "company-acme",
      platform,
      authorName: "Acme",
      authorHandle: "acme",
      postedAt: "2026-07-15T00:00:00.000Z",
      text: "A verified product update.",
      mediaType: platform === "tiktok" ? "video" : "link",
      metrics: { views: 10_000, likes: 250 },
      contributionScore: 0,
      tractionStatus: "unscored",
      tractionLimitations: ["No calibrated model."],
      sourceUrl,
      review_state: "verified",
      why: "Verified native post evidence."
    };

    const { container } = render(<EvidenceMediaCard item={item} />);

    expect(screen.getByText("Unscored")).toBeInTheDocument();
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(container.querySelector(".contribution-pill")).not.toHaveTextContent(/^0$/);
    expect(decodeDataImage(container.querySelector("img")?.getAttribute("src"))).not.toMatch(/>0<\/text>/);
  });
});

function decodeDataImage(value: string | null | undefined): string {
  const payload = value?.split(",")[1] ?? "";
  return decodeURIComponent(payload);
}
