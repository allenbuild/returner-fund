import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { EvidenceItem } from "@/lib/graph/types";
import { discoverTimelineHistoricalArchiveSources } from "@/lib/timeline/archive";
import { classificationSourceFromFetchedPage } from "@/lib/timeline/discovery";
import type { TimelineCandidateProposal } from "@/lib/timeline/domain";
import { linkVerifiedTimelineEventPosts } from "@/lib/timeline/ingestion-runner";
import { extractTimelinePageMetadata } from "@/lib/timeline/page-metadata";
import { canonicalizeSourceUrl } from "@/lib/timeline/source-document";

const COMPANY = {
  id: "company-acme",
  slug: "acme",
  name: "Acme",
  aliases: ["Acme"],
  websiteUrl: "https://acme.example",
  founderNames: ["Alice Founder"],
};

describe("Timeline archive and page provenance", () => {
  it("extracts ordinary HTML title and publication metadata without JSON-LD", () => {
    const source = classificationSourceFromFetchedPage(COMPANY, {
      originalUrl: "https://acme.example/blog/launch",
      finalUrl: "https://acme.example/blog/launch",
      status: 200,
      contentType: "text/html",
      fetchedAt: "2026-08-02T13:00:00.000Z",
      redirects: [],
      body: "<html><head><title>Acme launched publicly</title><meta property='article:published_time' content='2026-08-02T12:00:00Z'></head><body><main>Acme launched its public product for development teams today.</main></body></html>",
    });
    expect(source).toMatchObject({
      title: "Acme launched publicly",
      publicationTimestamp: "2026-08-02T12:00:00.000Z",
      sourceType: "company_page",
    });
  });

  it("retrieves bounded Internet Archive captures and classifies fetched pages as archived evidence", async () => {
    const fetchedCaptures: string[] = [];
    const result = await discoverTimelineHistoricalArchiveSources(COMPANY, {
      fromYear: 2019,
      toYear: 2021,
      maxCaptures: 2,
      fetchIndex: async (url) => ({
        originalUrl: url,
        finalUrl: url,
        status: 200,
        contentType: "application/json",
        fetchedAt: "2026-08-02T12:00:00.000Z",
        redirects: [],
        body: JSON.stringify([
          ["timestamp", "original", "statuscode", "mimetype", "digest"],
          ["20200102030405", "https://acme.example/launch", "200", "text/html", "AAA"],
          ["20200602030405", "https://attacker.example/acme", "200", "text/html", "BAD"],
          ["20210102030405", "https://acme.example/about", "200", "text/html", "BBB"],
        ]),
      }),
      fetchPage: async (url) => {
        fetchedCaptures.push(url);
        return {
          originalUrl: url,
          finalUrl: url,
          status: 200,
          contentType: "text/html",
          fetchedAt: "2026-08-02T12:00:00.000Z",
          redirects: [],
          body: `<!doctype html><html><head>
            <title>Acme launched its first product</title>
            <link rel="canonical" href="https://acme.example/launch">
            <script type="application/ld+json">${JSON.stringify({
              "@type": "NewsArticle",
              headline: "Acme launched its first product",
              author: { "@type": "Person", name: "Alice Founder" },
              publisher: { "@type": "Organization", name: "Acme" },
              datePublished: "2020-01-02T03:04:05Z",
              dateModified: "2020-01-03T04:05:06Z",
            })}</script>
          </head><body><main>Acme launched its first public product for software teams and announced general availability.</main></body></html>`,
        };
      },
    });

    expect(fetchedCaptures).toHaveLength(2);
    expect(fetchedCaptures[0]).toContain("/web/20200102030405id_/https://acme.example/launch");
    expect(fetchedCaptures.every((url) => !url.includes("attacker.example"))).toBe(true);
    expect(result).toMatchObject({ status: "completed", discoveredUrls: 2, fetchedUrls: 2 });
    expect(result.sources[0]).toMatchObject({
      sourceType: "archived_page",
      author: "Alice Founder",
      publisher: "Acme",
      publicationTimestamp: "2020-01-02T03:04:05.000Z",
      updatedTimestamp: "2020-01-03T04:05:06.000Z",
      authorRelationship: "company",
      attributionStatus: "verified",
      metadata: expect.objectContaining({
        archiveProvider: "internet_archive",
        archiveOriginalUrl: "https://acme.example/launch",
        archiveCapturedAt: "2020-01-02T03:04:05.000Z",
        archiveIndexUsedAsEvidence: false,
        searchSnippetUsedAsEvidence: false,
        jsonLdTypes: ["NewsArticle"],
        pageCanonicalUrl: "https://acme.example/launch",
      }),
    });
  });

  it("rejects cross-site canonical tags and preserves valid archive replay URLs", () => {
    const metadata = extractTimelinePageMetadata(
      `<html><head><title>Acme launch</title><link rel="canonical" href="http://127.0.0.1/admin"></head></html>`,
      "https://news.example/acme",
    );
    expect(metadata.title).toBe("Acme launch");
    expect(metadata.canonicalUrl).toBeNull();
    expect(metadata.metadata).toMatchObject({
      canonicalCandidatePresent: true,
      canonicalCandidateAccepted: false,
    });
    expect(canonicalizeSourceUrl("https://web.archive.org/web/20200102030405id_/https://acme.example/launch"))
      .toBe("https://web.archive.org/web/20200102030405id_/https://acme.example/launch");
  });

  it("rejects a capture response redirected away from its selected immutable replay", async () => {
    const result = await discoverTimelineHistoricalArchiveSources(COMPANY, {
      fromYear: 2020,
      toYear: 2020,
      maxCaptures: 1,
      fetchIndex: async (url) => ({
        originalUrl: url,
        finalUrl: url,
        status: 200,
        contentType: "application/json",
        fetchedAt: "2026-08-02T12:00:00.000Z",
        redirects: [],
        body: JSON.stringify([
          ["timestamp", "original", "statuscode", "mimetype", "digest"],
          ["20200102030405", "https://acme.example/launch", "200", "text/html", "AAA"],
        ]),
      }),
      fetchPage: async (url) => ({
        originalUrl: url,
        finalUrl: "https://acme.example/launch",
        status: 200,
        contentType: "text/html",
        fetchedAt: "2026-08-02T12:00:00.000Z",
        redirects: ["https://acme.example/launch"],
        body: "<html><head><title>Acme launch</title></head><body><main>Acme launched a public product for software teams.</main></body></html>",
      }),
    });

    expect(result.sources).toEqual([]);
    expect(result.failures).toEqual([expect.objectContaining({
      provider: "internet_archive",
      kind: "archive_capture_fetch_failed",
      message: expect.stringMatching(/redirected away/i),
    })]);
  });
});

describe("Timeline canonical post links", () => {
  it("links only evidence with a verified attribution to the event's exact company", async () => {
    const database = memoryClient({
      evidence_attributions: [
        { evidence_id: "evidence-good", company_id: "db-acme", review_state: "verified" },
        { evidence_id: "evidence-other-company", company_id: "db-other", review_state: "verified" },
        { evidence_id: "evidence-unreviewed", company_id: "db-acme", review_state: "needs_review" },
      ],
      evidence_items: [
        { id: "evidence-good", platform: "linkedin", platform_object_id: null, canonical_url: "https://www.linkedin.com/posts/acme-launch" },
        { id: "evidence-other-company", platform: "linkedin", platform_object_id: null, canonical_url: "https://www.linkedin.com/posts/acme-launch" },
        { id: "evidence-unreviewed", platform: "linkedin", platform_object_id: null, canonical_url: "https://www.linkedin.com/posts/acme-launch" },
      ],
    });
    const linked = await linkVerifiedTimelineEventPosts({
      client: database.client,
      eventId: "event-acme",
      companyId: "db-acme",
      classification: proposal(),
      graphEvidence: [graphEvidence()],
    });

    expect(linked).toBe(1);
    expect(database.upserts.timeline_event_posts).toEqual([{
      event_id: "event-acme",
      evidence_id: "evidence-good",
      evidence_role: "primary",
      relevance_reason: "Verified canonical linkedin evidence attributed to the same company.",
    }]);
  });

  it("does not link a canonical URL when its only attribution belongs to another company", async () => {
    const database = memoryClient({
      evidence_attributions: [
        { evidence_id: "evidence-other", company_id: "db-other", review_state: "verified" },
      ],
      evidence_items: [
        { id: "evidence-other", platform: "linkedin", platform_object_id: null, canonical_url: "https://www.linkedin.com/posts/acme-launch" },
      ],
    });
    await expect(linkVerifiedTimelineEventPosts({
      client: database.client,
      eventId: "event-acme",
      companyId: "db-acme",
      classification: proposal(),
      graphEvidence: [graphEvidence()],
    })).resolves.toBe(0);
    expect(database.upserts.timeline_event_posts).toBeUndefined();
  });

  it("adds a database guard and service-only published post projection", () => {
    const migration = readFileSync("supabase/migrations/019_timeline_verified_post_links.sql", "utf8");
    expect(migration).toMatch(/assert_timeline_event_post_company_attribution/);
    expect(migration).toMatch(/attribution\.company_id = event\.primary_company_id/);
    expect(migration).toMatch(/attribution\.review_state = 'verified'/);
    expect(migration).toMatch(/create or replace view public\.published_timeline_post_metadata/);
    expect(migration).toMatch(/revoke all privileges on table public\.published_timeline_post_metadata from public, anon, authenticated/);
  });
});

function proposal(): TimelineCandidateProposal {
  return {
    isMeaningfulEvent: true,
    companyId: "company-acme",
    category: "product_launch",
    title: "Acme released its public product",
    summary: "Acme released its public product for software teams.",
    eventDate: "2026-08-02",
    eventDateType: "publication_date",
    isMajor: false,
    importanceScore: 75,
    entityIds: ["company-acme"],
    sourceIds: ["graph-acme-launch"],
    mergeKey: "acme:product_launch:public_product:2026-08-02",
    evidence: [{
      sourceId: "graph-acme-launch",
      supports: ["title", "summary", "eventDate"],
      excerpt: "Acme released its public product for software teams.",
    }],
    conflicts: [],
    classifierVersion: "test",
    extractionVersion: "test",
  };
}

function graphEvidence(): EvidenceItem {
  return {
    id: "graph-acme-launch",
    entityType: "company",
    entityId: "company-acme",
    platform: "linkedin",
    authorName: "Acme",
    authorHandle: "acme",
    postedAt: "2026-08-02T12:00:00.000Z",
    mediaType: "text",
    text: "Acme released its public product for software teams.",
    metrics: { likes: 10 },
    contributionScore: 10,
    sourceUrl: "https://www.linkedin.com/posts/acme-launch?utm_source=test",
    why: "Verified company post.",
    review_state: "verified",
    linkStatus: "verified",
  };
}

function memoryClient(tables: Record<string, Array<Record<string, unknown>>>) {
  const upserts: Record<string, Array<Record<string, unknown>>> = {};
  const client = {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      const query = {
        select() { return query; },
        eq(column: string, value: unknown) {
          rows = rows.filter((row) => row[column] === value);
          return query;
        },
        in(column: string, values: readonly unknown[]) {
          rows = rows.filter((row) => values.includes(row[column]));
          return query;
        },
        limit(value: number) {
          rows = rows.slice(0, value);
          return query;
        },
        upsert(values: unknown) {
          upserts[table] = (Array.isArray(values) ? values : [values]) as Array<Record<string, unknown>>;
          return query;
        },
        then<TResult1 = { data: Array<Record<string, unknown>>; error: null }, TResult2 = never>(
          onfulfilled?: ((value: { data: Array<Record<string, unknown>>; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ) {
          return Promise.resolve({ data: rows, error: null }).then(onfulfilled, onrejected);
        },
      };
      return query;
    },
  };
  return { client: client as never, upserts };
}
