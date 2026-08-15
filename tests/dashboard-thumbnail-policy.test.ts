import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { safeDashboardThumbnailUrl } from "@/lib/dashboard/thumbnail-policy";

describe("dashboard thumbnail policy", () => {
  it("permits only reviewed HTTPS media hosts", () => {
    expect(safeDashboardThumbnailUrl("https://avatars.githubusercontent.com/u/123?v=4#ignored"))
      .toBe("https://avatars.githubusercontent.com/u/123?v=4");
    expect(safeDashboardThumbnailUrl("https://scontent-ord5-2.cdninstagram.com/media/cover.jpg?token=example"))
      .toBe("https://scontent-ord5-2.cdninstagram.com/media/cover.jpg?token=example");
    expect(safeDashboardThumbnailUrl("https://i.ytimg.com/vi/demo/hqdefault.jpg"))
      .toBe("https://i.ytimg.com/vi/demo/hqdefault.jpg");
    expect(safeDashboardThumbnailUrl("https://i.guim.co.uk/img/media/example.jpg?width=640"))
      .toBe("https://i.guim.co.uk/img/media/example.jpg?width=640");
    expect(safeDashboardThumbnailUrl("https://static01.nyt.com/images/example.jpg"))
      .toBe("https://static01.nyt.com/images/example.jpg");
    expect(safeDashboardThumbnailUrl("https://media.wired.com/photos/example.jpg"))
      .toBe("https://media.wired.com/photos/example.jpg");
    expect(safeDashboardThumbnailUrl("https://helios-i.mashable.com/imagery/example.jpg"))
      .toBe("https://helios-i.mashable.com/imagery/example.jpg");
  });

  it("rejects arbitrary, insecure, credentialed, ported, and oversized URLs", () => {
    expect(safeDashboardThumbnailUrl("https://images.example.test/cover.jpg")).toBeNull();
    expect(safeDashboardThumbnailUrl("https://avatars.githubusercontent.com.evil.test/u/123")).toBeNull();
    expect(safeDashboardThumbnailUrl("http://avatars.githubusercontent.com/u/123")).toBeNull();
    expect(safeDashboardThumbnailUrl("https://user:secret@avatars.githubusercontent.com/u/123")).toBeNull();
    expect(safeDashboardThumbnailUrl("https://avatars.githubusercontent.com:8443/u/123")).toBeNull();
    expect(safeDashboardThumbnailUrl(`https://avatars.githubusercontent.com/u/${"a".repeat(2_100)}`)).toBeNull();
  });

  it("keeps the published dashboard's reviewed image hosts in sync with Next's optimizer configuration", () => {
    const feed = JSON.parse(readFileSync("public/dashboard/feed.json", "utf8")) as {
      stories: Array<{ thumbnailUrl: string | null }>;
    };
    const nextConfig = readFileSync("next.config.mjs", "utf8");
    const publishedThumbnails = feed.stories
      .map((story) => story.thumbnailUrl)
      .filter((thumbnailUrl): thumbnailUrl is string => Boolean(thumbnailUrl));

    expect(publishedThumbnails.length).toBeGreaterThan(0);
    for (const thumbnailUrl of publishedThumbnails) {
      expect(safeDashboardThumbnailUrl(thumbnailUrl)).toBe(thumbnailUrl);
      expect(nextConfig).toContain(`hostname: "${new URL(thumbnailUrl).hostname}"`);
    }
  });
});
