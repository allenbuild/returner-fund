import { describe, expect, it } from "vitest";
import { extractLinkPreview } from "../scripts/link-preview-utils.mjs";

describe("link preview thumbnail extraction", () => {
  it("prefers Open Graph images and resolves relative URLs", () => {
    const preview = extractLinkPreview(
      `
        <html>
          <head>
            <meta property="og:image" content="/assets/cover.webp">
            <link rel="icon" href="/favicon.ico">
          </head>
        </html>
      `,
      "https://example.com/articles/launch"
    );

    expect(preview.thumbnailUrl).toBe("https://example.com/assets/cover.webp");
    expect(preview.thumbnailSource).toBe("link-preview-og-image");
  });

  it("uses JSON-LD image data before generic page images", () => {
    const preview = extractLinkPreview(
      `
        <script type="application/ld+json">
          {"@type":"NewsArticle","image":{"@type":"ImageObject","url":"https://cdn.example.com/story.jpg"}}
        </script>
        <main><img src="/inline-small.jpg" width="120" height="80"></main>
      `,
      "https://example.com/post"
    );

    expect(preview.thumbnailUrl).toBe("https://cdn.example.com/story.jpg");
    expect(preview.thumbnailSource).toBe("link-preview-jsonld-image");
  });

  it("rejects logos for primary preview and falls back to article imagery", () => {
    const preview = extractLinkPreview(
      `
        <meta property="og:image" content="https://example.com/logo.png">
        <article><img src="https://example.com/product-demo.png" width="1200" height="630"></article>
      `,
      "https://example.com"
    );

    expect(preview.thumbnailUrl).toBe("https://example.com/product-demo.png");
    expect(preview.thumbnailSource).toBe("link-preview-article-image");
  });

  it("uses favicon only as a source-owned last resort", () => {
    const preview = extractLinkPreview(
      `<html><head><link rel="icon" sizes="192x192" href="/favicon-192.png"></head><body>No images</body></html>`,
      "https://example.com"
    );

    expect(preview.thumbnailUrl).toBe("https://example.com/favicon-192.png");
    expect(preview.thumbnailSource).toBe("link-preview-favicon");
  });
});
