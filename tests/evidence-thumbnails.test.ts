import { describe, expect, it } from "vitest";
import {
  githubThumbnailFromUrl,
  resolveEvidenceThumbnail,
  thumbnailCandidatesFromRaw,
  youtubeThumbnailFromUrl
} from "@/lib/graph/evidence-thumbnails";

describe("evidence thumbnail resolution", () => {
  it("derives official YouTube thumbnails from watch and shorts URLs", () => {
    expect(youtubeThumbnailFromUrl("https://www.youtube.com/watch?v=abcDEF12345")).toBe(
      "https://i.ytimg.com/vi/abcDEF12345/hqdefault.jpg"
    );
    expect(youtubeThumbnailFromUrl("https://www.youtube.com/shorts/shorts12345")).toBe(
      "https://i.ytimg.com/vi/shorts12345/hqdefault.jpg"
    );
  });

  it("filters X avatars and keeps real post media", () => {
    const resolved = resolveEvidenceThumbnail({
      id: "x-evidence",
      platform: "x",
      sourceUrl: "https://x.com/farzatv/status/123",
      rawVisibleText: JSON.stringify({
        media_urls: [
          "https://pbs.twimg.com/profile_images/123/avatar_normal.jpg",
          "https://pbs.twimg.com/media/HIGTbVJbkAAxEpE.jpg"
        ]
      })
    });

    expect(resolved.thumbnailUrl).toBe("https://pbs.twimg.com/media/HIGTbVJbkAAxEpE.jpg");
    expect(resolved.thumbnailSource).toBe("x-media");
  });

  it("extracts Instagram post media but rejects profile pictures", () => {
    const resolved = resolveEvidenceThumbnail({
      id: "ig-evidence",
      platform: "instagram",
      sourceUrl: "https://www.instagram.com/reel/ABC/",
      rawVisibleText: JSON.stringify({
        images: [
          "https://scontent.cdninstagram.com/v/t51.2885-19/profile_pic.jpg?stp=dst-jpg_s150x150",
          "https://scontent.cdninstagram.com/v/t51.71878-15/post_cover.jpg?format=jpg"
        ]
      })
    });

    expect(resolved.thumbnailUrl).toContain("t51.71878-15");
  });

  it("uses LinkedIn public media images", () => {
    const resolved = resolveEvidenceThumbnail({
      id: "li-evidence",
      platform: "linkedin",
      sourceUrl: "https://www.linkedin.com/posts/example",
      rawVisibleText: JSON.stringify({
        image: "https://media.licdn.com/dms/image/v2/D4D22AQHabc/feedshare-shrink_800.jpg"
      })
    });

    expect(resolved.thumbnailUrl).toContain("media.licdn.com");
  });

  it("derives GitHub repo and profile thumbnails", () => {
    expect(githubThumbnailFromUrl("https://github.com/superset-sh/superset", "ev-gh", null)).toBe(
      "https://opengraph.githubassets.com/ev-gh/superset-sh/superset"
    );
    expect(githubThumbnailFromUrl("https://github.com/superset-sh", "ev-gh", "superset-sh")).toBe(
      "https://github.com/superset-sh.png?size=240"
    );
  });

  it("extracts markdown and web image URLs", () => {
    expect(thumbnailCandidatesFromRaw("![preview](https://example.com/preview.webp)")).toContain(
      "https://example.com/preview.webp"
    );
  });
});
