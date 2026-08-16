import { readFileSync } from "node:fs";
import type { RemotePattern } from "next/dist/shared/lib/image-config";
import { matchRemotePattern } from "next/dist/shared/lib/match-remote-pattern";
import { describe, expect, it } from "vitest";
import { safeDashboardThumbnailUrl } from "@/lib/dashboard/thumbnail-policy";

function readNextRemotePatterns(config: string): RemotePattern[] {
  return [...config.matchAll(
    /\{\s*protocol:\s*"([^"]+)",\s*hostname:\s*"([^"]+)",\s*pathname:\s*"([^"]+)"\s*\}/g
  )].reduce<RemotePattern[]>((patterns, [, protocol, hostname, pathname]) => {
    if ((protocol !== "http" && protocol !== "https") || !hostname || !pathname) return patterns;
    patterns.push({ protocol, hostname, pathname });
    return patterns;
  }, []);
}

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
    const remotePatterns = readNextRemotePatterns(readFileSync("next.config.mjs", "utf8"));
    const publishedThumbnails = feed.stories
      .map((story) => story.thumbnailUrl)
      .filter((thumbnailUrl): thumbnailUrl is string => Boolean(thumbnailUrl));

    expect(publishedThumbnails.length).toBeGreaterThan(0);
    expect(remotePatterns.length).toBeGreaterThan(0);
    expect(
      remotePatterns.some((pattern) =>
        matchRemotePattern(pattern, new URL("https://cdninstagram.com/media/cover.jpg"))
      )
    ).toBe(false);
    for (const thumbnailUrl of publishedThumbnails) {
      expect(safeDashboardThumbnailUrl(thumbnailUrl)).toBe(thumbnailUrl);
      expect(remotePatterns.some((pattern) => matchRemotePattern(pattern, new URL(thumbnailUrl)))).toBe(true);
    }
  });
});
