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
  });

  it("rejects arbitrary, insecure, credentialed, ported, and oversized URLs", () => {
    expect(safeDashboardThumbnailUrl("https://images.example.test/cover.jpg")).toBeNull();
    expect(safeDashboardThumbnailUrl("https://avatars.githubusercontent.com.evil.test/u/123")).toBeNull();
    expect(safeDashboardThumbnailUrl("http://avatars.githubusercontent.com/u/123")).toBeNull();
    expect(safeDashboardThumbnailUrl("https://user:secret@avatars.githubusercontent.com/u/123")).toBeNull();
    expect(safeDashboardThumbnailUrl("https://avatars.githubusercontent.com:8443/u/123")).toBeNull();
    expect(safeDashboardThumbnailUrl(`https://avatars.githubusercontent.com/u/${"a".repeat(2_100)}`)).toBeNull();
  });
});
