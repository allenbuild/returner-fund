import { describe, expect, it, vi } from "vitest";
import { discoverExternalDashboardCandidates } from "@/lib/dashboard/external-discovery";

const NOW = new Date("2026-08-15T12:00:00.000Z");

describe("public dashboard discovery", () => {
  it("collects bounded public HN, Reddit, and research sources while retaining a safe partial failure", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input));
      if (url.hostname === "hn.algolia.com") {
        return json({
          hits: [{
            objectID: "hn-1",
            title: "Show HN: a technology launch",
            url: "https://example.com/launch?utm_source=hn",
            created_at: "2026-08-15T11:00:00.000Z",
            points: 320,
            num_comments: 44
          }]
        });
      }
      if (url.hostname === "api.github.com" && url.pathname === "/search/repositories") {
        return new Response("unavailable", { status: 503 });
      }
      if (url.hostname === "api.github.com" && url.pathname === "/events") return json([]);
      if (url.hostname === "rss.arxiv.org") {
        return new Response(`<?xml version="1.0"?><rss><channel><item>
          <title>Research result</title>
          <link>https://arxiv.org/abs/2608.12345</link>
          <guid>arxiv-2608.12345</guid>
          <pubDate>Fri, 15 Aug 2026 11:30:00 GMT</pubDate>
          <description>Verified abstract text.</description>
        </item></channel></rss>`, { headers: { "content-type": "application/rss+xml" } });
      }
      if (url.hostname === "www.reddit.com") {
        return json({
          data: {
            children: [{
              data: {
                id: "reddit-1",
                title: "Community discussion about a new release",
                permalink: "/r/MachineLearning/comments/reddit1/discussion/",
                url: "https://example.com/launch",
                author: "researcher",
                created_utc: NOW.getTime() / 1_000 - 1_800,
                score: 250,
                num_comments: 31
              }
            }]
          }
        });
      }
      throw new Error(`Unexpected request ${url}`);
    });

    const result = await discoverExternalDashboardCandidates({
      now: NOW,
      fetchImpl: fetchImpl as typeof fetch,
      rssFeeds: [],
      researchFeeds: [{
        name: "arXiv Test",
        url: "https://rss.arxiv.org/rss/cs.AI",
        platform: "research",
        sourceKind: "paper",
        independentlyReported: false
      }],
      redditSubreddits: ["MachineLearning"]
    });

    expect(result.failures).toEqual(["github_http_503"]);
    expect(result.sources).toEqual(["github_events", "hacker_news", "reddit:machinelearning", "rss:arxiv-test"]);
    expect(result.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ platform: "hacker_news", independentlyReported: true }),
      expect.objectContaining({ platform: "reddit", independentlyReported: false }),
      expect.objectContaining({ platform: "research", sourceKind: "paper", independentlyReported: false })
    ]));
    expect(result.candidates.find((candidate) => candidate.platform === "hacker_news")?.destinationUrl)
      .toBe("https://example.com/launch");
  });

  it("retains published GitHub releases when repository search is unavailable", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input));
      if (url.hostname === "hn.algolia.com") return json({ hits: [] });
      if (url.hostname !== "api.github.com") throw new Error(`Unexpected request ${url}`);
      if (url.pathname === "/search/repositories") return new Response("unavailable", { status: 503 });
      if (url.pathname === "/events") {
        expect(url.searchParams.get("per_page")).toBe("100");
        return json([
          {
            id: "event-77",
            type: "ReleaseEvent",
            created_at: "2026-08-15T11:35:00.000Z",
            actor: { login: "release-bot" },
            repo: { id: 42, name: "acme/ship" },
            payload: {
              action: "published",
              release: {
                id: 77,
                name: "Ship v2",
                tag_name: "v2.0.0",
                html_url: "https://github.com/acme/ship/releases/tag/v2.0.0",
                body: "Adds release notes for the safer deployment workflow.",
                published_at: "2026-08-15T11:30:00.000Z",
                updated_at: "2026-08-15T11:31:00.000Z",
                assets: [{ download_count: 120 }, { download_count: 8 }],
                reactions: { total_count: 17 }
              }
            }
          },
          {
            id: "event-non-release",
            type: "PushEvent",
            created_at: "2026-08-15T11:35:00.000Z",
            repo: { id: 42, name: "acme/ship" },
            payload: {}
          }
        ]);
      }
      throw new Error(`Unexpected GitHub request ${url}`);
    });

    const result = await discoverExternalDashboardCandidates({
      now: NOW,
      fetchImpl: fetchImpl as typeof fetch,
      rssFeeds: [],
      researchFeeds: [],
      redditSubreddits: []
    });

    expect(result.failures).toEqual(["github_http_503"]);
    expect(result.sources).toEqual(["github_events", "hacker_news"]);
    expect(result.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "github:release:77",
        canonicalKey: "github:release:77",
        platform: "github",
        sourceKind: "release",
        title: "acme/ship releases Ship v2",
        destinationUrl: "https://github.com/acme/ship/releases/tag/v2.0.0",
        metrics: { downloads: 128, reactions: 17 },
        entityKeys: ["repository:42", "destination:https://github.com/acme/ship/releases/tag/v2.0.0"],
        independentlyReported: false
      })
    ]));
  });

  it("only fetches configured RSS feeds on the fixed trusted publication hosts", async () => {
    vi.stubEnv("DASHBOARD_RSS_FEEDS", [
      "https://feeds.arstechnica.com/arstechnica/index",
      "https://www.technologyreview.com/feed/",
      "https://reader:secret@feeds.example.test/private.xml",
      "https://localhost/feed.xml",
      "https://127.0.0.1/feed.xml",
      "https://192.168.1.20/feed.xml",
      "https://[::1]/feed.xml",
      "https://[fc00::1]/feed.xml",
      "https://[::ffff:127.0.0.1]/feed.xml",
      // This public HTTPS URL is deliberately rejected too: dashboard
      // configuration is not a general-purpose outbound request mechanism.
      "https://news.example.test/feed.xml",
      "https://feeds.arstechnica.com:8443/nonstandard-port.xml"
    ].join(","));
    const seenHosts: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input));
      seenHosts.push(url.hostname);
      if (url.hostname === "hn.algolia.com") return json({ hits: [] });
      if (url.hostname === "api.github.com" && url.pathname === "/search/repositories") return json({ items: [] });
      if (url.hostname === "api.github.com" && url.pathname === "/events") return json([]);
      if (url.hostname === "feeds.arstechnica.com" || url.hostname === "www.technologyreview.com") {
        return new Response("<?xml version=\"1.0\"?><rss><channel /></rss>", {
          headers: { "content-type": "application/rss+xml" }
        });
      }
      throw new Error(`Unsafe feed was requested: ${url.hostname}`);
    });

    try {
      const result = await discoverExternalDashboardCandidates({
        now: NOW,
        fetchImpl: fetchImpl as typeof fetch,
        researchFeeds: [],
        redditSubreddits: []
      });

      expect(result.failures).toEqual([]);
      expect(result.sources).toEqual([
        "github",
        "github_events",
        "hacker_news",
        "rss:configured-feed-1",
        "rss:configured-feed-2"
      ]);
      expect([...new Set(seenHosts)].sort()).toEqual([
        "api.github.com",
        "feeds.arstechnica.com",
        "hn.algolia.com",
        "www.technologyreview.com"
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" }
  });
}
