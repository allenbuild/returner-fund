import { describe, expect, it } from "vitest";
import { originalEvidenceText, splitVerbatimSentences } from "@/lib/graph/verbatim-evidence-text";

describe("verbatim partner evidence text", () => {
  it("hydrates X article bodies without traversing quoted content", () => {
    const text = originalEvidenceText({
      platform: "x",
      text: "short display text",
      rawVisibleText: JSON.stringify({
        post: {
          text: "I am very impressed by Kara.",
          articleBody: "The full article body explains why the team can win.",
          quote: { text: "Quoted founder text must not be scored." }
        }
      })
    });

    expect(text).toBe("I am very impressed by Kara.\n\nThe full article body explains why the team can win.");
    expect(text).not.toContain("Quoted founder text");
  });

  it("uses the structurally bounded LinkedIn primary body", () => {
    const text = originalEvidenceText({
      platform: "linkedin",
      text: "display text",
      rawVisibleText: JSON.stringify({
        post: {
          articleBody: "First authored paragraph.\n\nSecond authored paragraph.",
          rawText: "Feed post number 1 Partner Name 2h First authored paragraph."
        },
        relatedPost: { text: "Unrelated post must not be scored." }
      })
    });

    expect(text).toBe("First authored paragraph.\n\nSecond authored paragraph.");
    expect(text).not.toContain("Feed post number");
    expect(text).not.toContain("Unrelated post");
  });

  it("does not treat a search-result attribution summary as authored text", () => {
    expect(originalEvidenceText({
      platform: "linkedin",
      title: "Partner praises Kara",
      text: "Partner praises Kara",
      originalText: "Partner praises Kara",
      attributionProvenance: "strict_native_search_snippet_v3"
    })).toBe("");
  });

  it("preserves exact sentence spans around URLs, decimals, and initials", () => {
    const text = "Read https://x.com/partner/a.b. Kara has a 3.14x edge. U.S. teams are rare!";
    expect(splitVerbatimSentences(text)).toEqual([
      "Read https://x.com/partner/a.b.",
      "Kara has a 3.14x edge.",
      "U.S. teams are rare!"
    ]);
  });
});
