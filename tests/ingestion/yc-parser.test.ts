import { describe, expect, it } from "vitest";
import { YcBatchAdapter, getDemoYcBatch, normalizeBatchSlug, parseYcCompaniesFromHtml, parseYcFallbackResults } from "@/lib/ingestion";

describe("YC batch parser", () => {
  it("normalizes common batch names", () => {
    expect(normalizeBatchSlug("YC Spring 2026")).toBe("S2026");
    expect(normalizeBatchSlug("spring 2026")).toBe("S2026");
    expect(normalizeBatchSlug("W 2026")).toBe("W2026");
  });

  it("parses official structured payloads as verified records", () => {
    const html = `
      <html>
        <script id="__NEXT_DATA__" type="application/json">
          {
            "props": {
              "companies": [
                {
                  "name": "Acme AI",
                  "batch": "Spring 2026",
                  "slug": "acme-ai",
                  "websiteUrl": "https://acme.example",
                  "oneLiner": "AI tools for test fixtures.",
                  "description": "Acme AI builds deterministic test data.",
                  "tags": ["AI", "Developer Tools"],
                  "founders": [
                    { "name": "Jane Doe", "url": "https://www.ycombinator.com/people/jane-doe" }
                  ],
                  "groupPartner": "Public Partner"
                }
              ]
            }
          }
        </script>
      </html>
    `;

    const records = parseYcCompaniesFromHtml(html, "S2026", "https://www.ycombinator.com/companies?batch=S2026");

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      name: "Acme AI",
      batchSlug: "S2026",
      ycProfileUrl: "https://www.ycombinator.com/companies/acme-ai",
      websiteUrl: "https://acme.example/",
      sourceReliability: "high",
      review_state: "verified",
      groupPartner: "Public Partner"
    });
    expect(records[0].founders[0]).toMatchObject({
      name: "Jane Doe",
      sourceReliability: "high",
      review_state: "verified"
    });
  });

  it("parses YC HTML links as needs_review incomplete records", () => {
    const html = `
      <article>
        <a href="/companies/card-co">Card Co</a>
        <span>Spring 2026</span>
      </article>
    `;

    const records = parseYcCompaniesFromHtml(html, "Spring 2026", "https://www.ycombinator.com/companies?batch=S2026");

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      name: "Card Co",
      sourceReliability: "medium",
      review_state: "needs_review",
      groupPartner: null
    });
    expect(records[0].warnings.join(" ")).toContain("do not infer");
  });

  it("keeps fallback search reconstruction in needs_review", () => {
    const records = parseYcFallbackResults(
      [
        {
          title: "Searchable AI | Y Combinator",
          url: "https://www.ycombinator.com/companies/searchable-ai",
          snippet: "Searchable AI is a YC Spring 2026 company.",
          source: "test"
        },
        {
          title: "Random directory",
          url: "https://example.com/random",
          snippet: "No relevant context.",
          source: "test"
        }
      ],
      "S2026"
    );

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      name: "Searchable AI",
      sourceReliability: "medium",
      review_state: "needs_review",
      groupPartner: null
    });
    expect(records[0].founders).toEqual([]);
  });

  it("returns deterministic fake YC-like demo data", () => {
    const demo = getDemoYcBatch("YC Spring 2026", 2);

    expect(demo.mode).toBe("demo");
    expect(demo.batchSlug).toBe("S2026");
    expect(demo.companies).toHaveLength(2);
    expect(demo.warnings.join(" ")).toContain("fake");
  });

  it("falls back through the adapter when official YC parsing has no records", async () => {
    const adapter = new YcBatchAdapter({
      fetchImpl: async () => new Response("<html>No companies here</html>", { status: 200 }),
      searchProvider: {
        async search() {
          return [
            {
              title: "Fallback Co | Y Combinator",
              url: "https://www.ycombinator.com/companies/fallback-co",
              snippet: "Fallback Co is in YC Spring 2026.",
              source: "test"
            }
          ];
        }
      }
    });

    const result = await adapter.fetchBatch("S2026");

    expect(result.mode).toBe("fallback");
    expect(result.companies).toHaveLength(1);
    expect(result.companies[0].review_state).toBe("needs_review");
    expect(result.expectedCompanyCount).toBe(197);
    expect(result.observedCompanyCount).toBe(1);
    expect(result.warnings.join(" ")).toContain("Fallback search results require review");
    expect(result.warnings.join(" ")).toContain("Expected 197 companies for YC Spring 2026");
  });
});
