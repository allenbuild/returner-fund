import { describe, expect, it } from "vitest";
import { ProductHuntConnector } from "@/lib/connectors/product-hunt";

describe("ProductHuntConnector", () => {
  it("discovers public Product Hunt candidates as review-gated URLs", async () => {
    const connector = new ProductHuntConnector(mockFetch({
      "duckduckgo.com/html": `
        <a href="https://www.producthunt.com/products/heyclicky">HeyClicky</a>
        <a href="https://www.producthunt.com/products/screen-studio">Screen Studio</a>
      `
    }));

    const candidates = await connector.discoverProfiles({
      type: "company",
      id: "company-heyclicky",
      name: "HeyClicky"
    });

    expect(candidates.map((candidate) => candidate.url)).toEqual(["https://www.producthunt.com/products/heyclicky"]);
    expect(candidates[0]?.review_state).toBe("needs_review");
  });

  it("normalizes public product pages and parses visible metrics", async () => {
    const connector = new ProductHuntConnector(mockFetch({
      "producthunt.com/products/heyclicky": `
        <title>HeyClicky | Product Hunt</title>
        <meta name="description" content="Your friendly cursor companion">
        <a href="https://www.producthunt.com/posts/heyclicky">Launch</a>
        1.2K upvotes
        34 comments
      `
    }));

    const posts = await connector.fetchRecentPosts(
      { platform: "product_hunt", handle: "heyclicky", url: "https://producthunt.com/products/heyclicky" },
      { limit: 3 }
    );
    const metrics = await connector.fetchMetrics(posts[0]!);

    expect(posts[0]).toMatchObject({
      platform: "product_hunt",
      platformPostId: "heyclicky",
      mediaType: "launch",
      text: "Your friendly cursor companion"
    });
    expect(metrics.upvotes).toBe(1200);
    expect(metrics.comments).toBe(34);
  });
});

function mockFetch(routes: Record<string, string>): typeof fetch {
  return (async (url: RequestInfo | URL) => {
    const href = String(url);
    const route = Object.entries(routes).find(([needle]) => href.includes(needle));
    if (!route) {
      return new Response("not found", { status: 404 });
    }
    return new Response(route[1], { status: 200, headers: { "content-type": "text/html" } });
  }) as typeof fetch;
}
