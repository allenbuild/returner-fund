import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DASHBOARD_RESEARCH_FEEDS,
  DEFAULT_DASHBOARD_RSS_FEEDS,
  discoverExternalDashboardCandidates
} from "@/lib/dashboard/external-discovery";

const NOW = new Date("2026-08-15T12:00:00.000Z");

describe("public dashboard discovery", () => {
  it("ships a diversified roster of direct editorial and research feeds", () => {
    expect(DEFAULT_DASHBOARD_RSS_FEEDS.map((feed) => feed.name)).toEqual(expect.arrayContaining([
      "MIT Technology Review",
      "IEEE Spectrum",
      "The New York Times Technology",
      "BBC News Technology",
      "The Guardian Technology",
      "WIRED",
      "TechCrunch",
      "CNET",
      "Financial Times Technology",
      "The Decoder",
      "BleepingComputer",
      "Bloomberg Technology",
      "The Record",
      "Dark Reading",
      "HPCwire",
      "Phys.org Technology",
      "Data Center Dynamics",
      "The Markup",
      "Rest of World",
      "Krebs on Security",
      "SecurityWeek",
      "LWN.net",
      "Google Online Security",
      "Google DeepMind",
      "Microsoft Security",
      "Cloudflare Blog"
    ]));
    expect(DEFAULT_DASHBOARD_RSS_FEEDS.map((feed) => feed.name)).not.toEqual(expect.arrayContaining([
      "NASA News",
      "Phys.org Physics",
      "Phys.org Space",
      "Space.com",
      "ScienceAlert",
      "Forbes Innovation"
    ]));
    expect(new Set(DEFAULT_DASHBOARD_RSS_FEEDS.map((feed) => new URL(feed.url).hostname)).size).toBeGreaterThanOrEqual(35);
    expect(DEFAULT_DASHBOARD_RESEARCH_FEEDS.map((feed) => feed.name)).toEqual(expect.arrayContaining([
      "arXiv cs.AI",
      "arXiv cs.LG",
      "arXiv stat.ML",
      "arXiv cs.CL",
      "arXiv cs.CV",
      "arXiv cs.RO",
      "arXiv cs.CR",
      "Apple Machine Learning Research"
    ]));
  });

  it("keeps HN as a bounded corroboration lane while retaining a safe partial failure", async () => {
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
                title: "Community discussion about a new AI model release",
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
      expect.objectContaining({ platform: "reddit", independentlyReported: false }),
      expect.objectContaining({
        platform: "research",
        sourceKind: "paper",
        independentlyReported: false,
        sourceVerified: true,
        sourceLinkStatus: "verified",
        publicationPrecision: "exact"
      })
    ]));
    expect(result.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        platform: "hacker_news",
        destinationUrl: "https://example.com/launch"
      })
    ]));
  });

  it("keeps a bounded slate of technology-relevant HN corroboration without allowing lifestyle stories", async () => {
    const editorialFeeds = ["Editorial One", "Editorial Two", "Editorial Three"].map((name, index) => ({
      name,
      url: `https://publication-${index + 1}.example.test/feed.xml`,
      quality: 80
    }));
    const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input));
      if (url.hostname === "hn.algolia.com") {
        return json({
          hits: [
            { objectID: "lower", title: "Open-source compiler adds GPU support", created_at: "2026-08-15T11:00:00.000Z", points: 50, num_comments: 1 },
            { objectID: "top", title: "AI security research identifies a prompt injection flaw", created_at: "2026-08-15T11:05:00.000Z", points: 500, num_comments: 80 },
            { objectID: "health", title: "Semaglutide may protect against dementia", created_at: "2026-08-15T11:10:00.000Z", points: 900, num_comments: 250 },
            { objectID: "satire", title: "Prompt injection legal filing is AI satire", created_at: "2026-08-15T11:15:00.000Z", points: 800, num_comments: 200 },
            { objectID: "low-attention", title: "Open-source browser engine experiment", created_at: "2026-08-15T11:20:00.000Z", points: 1, num_comments: 0 }
          ]
        });
      }
      if (url.hostname === "api.github.com" && url.pathname === "/search/repositories") return json({ items: [] });
      if (url.hostname === "api.github.com" && url.pathname === "/events") return json([]);
      if (url.hostname.endsWith(".example.test")) {
        const source = url.hostname.split(".")[0] ?? "publication";
        return new Response(rssItems(source, 33), { headers: { "content-type": "application/rss+xml" } });
      }
      throw new Error(`Unexpected request ${url}`);
    });

    const result = await discoverExternalDashboardCandidates({
      now: NOW,
      fetchImpl: fetchImpl as typeof fetch,
      rssFeeds: editorialFeeds,
      researchFeeds: [],
      redditSubreddits: []
    });

    const hackerNews = result.candidates.filter((candidate) => candidate.platform === "hacker_news");
    const editorial = result.candidates.filter((candidate) => candidate.platform === "rss");
    expect(editorial).toHaveLength(99);
    expect(hackerNews).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "hn:lower", destinationUrl: null }),
      expect.objectContaining({ id: "hn:top", destinationUrl: null })
    ]));
    expect(hackerNews).toHaveLength(2);
    expect(hackerNews).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "hn:health" })]));
    expect(hackerNews).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "hn:satire" })]));
    expect(hackerNews).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "hn:low-attention" })]));
    expect(hackerNews.length).toBeLessThanOrEqual(12);
  });

  it("extracts a safe card thumbnail from entry HTML when a publisher omits media tags", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input));
      if (url.hostname === "hn.algolia.com") return json({ hits: [] });
      if (url.hostname === "api.github.com" && url.pathname === "/search/repositories") return json({ items: [] });
      if (url.hostname === "api.github.com" && url.pathname === "/events") return json([]);
      if (url.hostname === "publisher.example.test") {
        return new Response(`<?xml version="1.0"?><rss><channel>
          <item>
            <title>AI article with a publisher image</title>
            <link>https://publisher.example.test/articles/with-image</link>
            <guid>with-image</guid>
            <pubDate>Fri, 15 Aug 2026 11:00:00 GMT</pubDate>
            <description><![CDATA[<p>Reporting explains how AI infrastructure is expanding safely. <img data-src="https://cdn.publisher.example.test/cards/story.jpg?width=1200&amp;utm_source=rss" /></p>]]></description>
          </item>
          <item>
            <title>Cybersecurity article with only unsafe image candidates</title>
            <link>https://publisher.example.test/articles/without-image</link>
            <guid>without-image</guid>
            <pubDate>Fri, 15 Aug 2026 11:00:00 GMT</pubDate>
            <description><![CDATA[<img src="javascript:alert(1)" /><img data-src="https://127.0.0.1/private.png" />]]></description>
          </item>
          <item>
            <title>Cloud infrastructure report</title>
            <link>https://publisher.example.test/articles/context-free</link>
            <guid>context-free</guid>
            <pubDate>Fri, 15 Aug 2026 11:00:00 GMT</pubDate>
            <description><![CDATA[Flamingo missiles were used.]]></description>
          </item>
        </channel></rss>`, { headers: { "content-type": "application/rss+xml" } });
      }
      throw new Error(`Unexpected request ${url}`);
    });

    const result = await discoverExternalDashboardCandidates({
      now: NOW,
      fetchImpl: fetchImpl as typeof fetch,
      rssFeeds: [{ name: "Publisher", url: "https://publisher.example.test/feed.xml", quality: 80 }],
      researchFeeds: [],
      redditSubreddits: []
    });

    expect(result.candidates.find((candidate) => candidate.title === "AI article with a publisher image")?.thumbnailUrl)
      .toBe("https://cdn.publisher.example.test/cards/story.jpg?width=1200");
    expect(result.candidates.find((candidate) => candidate.title === "AI article with a publisher image")?.summary)
      .toBe("Reporting explains how AI infrastructure is expanding safely.");
    expect(result.candidates.find((candidate) => candidate.title === "Cybersecurity article with only unsafe image candidates")?.thumbnailUrl)
      .toBeNull();
    expect(result.candidates.find((candidate) => candidate.title === "Cloud infrastructure report")?.summary)
      .toBeNull();
  });

  it("caps a narrowly focused feed before repeated product-update cards can dominate", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input));
      if (url.hostname === "hn.algolia.com") return json({ hits: [] });
      if (url.hostname === "api.github.com" && url.pathname === "/search/repositories") return json({ items: [] });
      if (url.hostname === "api.github.com" && url.pathname === "/events") return json([]);
      if (url.hostname === "focused-publisher.example.test") {
        return new Response(rssItems("focused-publisher", 4), { headers: { "content-type": "application/rss+xml" } });
      }
      throw new Error(`Unexpected request ${url}`);
    });

    const result = await discoverExternalDashboardCandidates({
      now: NOW,
      fetchImpl: fetchImpl as typeof fetch,
      rssFeeds: [{ name: "Focused Publisher", url: "https://focused-publisher.example.test/feed.xml", quality: 80, maxItems: 2 }],
      researchFeeds: [],
      redditSubreddits: []
    });

    expect(result.candidates.filter((candidate) => candidate.platform === "rss")).toHaveLength(2);
  });

  it("permits a broader but still bounded primary-research window", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input));
      if (url.hostname === "hn.algolia.com") return json({ hits: [] });
      if (url.hostname === "api.github.com" && url.pathname === "/search/repositories") return json({ items: [] });
      if (url.hostname === "api.github.com" && url.pathname === "/events") return json([]);
      if (url.hostname === "research-publisher.example.test") {
        return new Response(rssItems("research-publisher", 70), { headers: { "content-type": "application/rss+xml" } });
      }
      throw new Error(`Unexpected request ${url}`);
    });

    const result = await discoverExternalDashboardCandidates({
      now: NOW,
      fetchImpl: fetchImpl as typeof fetch,
      rssFeeds: [],
      researchFeeds: [{
        name: "Research Publisher",
        url: "https://research-publisher.example.test/feed.xml",
        platform: "research",
        sourceKind: "paper",
        independentlyReported: false
      }],
      redditSubreddits: []
    });

    expect(result.candidates.filter((candidate) => candidate.platform === "research")).toHaveLength(60);
  });

  it("keeps technology reporting while rejecting entertainment, consumer commerce, and generic culture from broad feeds", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input));
      if (url.hostname === "hn.algolia.com") return json({ hits: [] });
      if (url.hostname === "api.github.com" && url.pathname === "/search/repositories") return json({ items: [] });
      if (url.hostname === "api.github.com" && url.pathname === "/events") return json([]);
      if (url.hostname === "broad-publisher.example.test") {
        return new Response(`<?xml version="1.0"?><rss><channel>
          ${rssEntry("Open-source AI infrastructure expands data-center research", "ai-infrastructure")}
          ${rssEntry("New Windows laptop review benchmarks edge AI models", "windows-review")}
          ${rssEntry("The Best All-in-One Printers for 2026", "printers")}
          ${rssEntry("Star Wars season trailer revealed at fan event", "star-wars")}
          ${rssEntry("Upgrade Your PC With Windows 11 Pro Today", "windows-upgrade")}
          ${rssEntry("Celebrity social media post asks what AI means for culture", "culture")}
          ${rssEntry("I Vibe Coded an App With Opus 5 to Get Better at The Finals", "vibe-coded")}
          ${rssEntry("What's the USB trident symbol for?", "usb-trident")}
          ${rssEntry("T-Mobile is giving away the Apple iPhone 17 for free this weekend", "tmobile-giveaway")}
          ${rssEntry("Semaglutide research explores dementia treatment", "semaglutide")}
          ${rssEntry("Prompt injection legal filing is a satire of AI law", "prompt-injection-satire")}
          ${rssEntry("Why Can't Go Viral?", "cant-go-viral")}
          ${rssEntry("Secondhand book sales are booming", "secondhand-books")}
          ${rssEntry("Hybrid car battery guide: what to know", "hybrid-battery-guide")}
          ${rssEntry("Futuristic mosquito-zapping laser now available to buy", "available-to-buy")}
          ${rssEntry("Per-developer environments were the goal. Agents moved the goalposts.", "vague-goalposts")}
          ${rssEntry("APOD: Bright Perseids from Sweden", "apod")}
          ${rssEntry("Sponsored: Power on the critical path for AI data centers", "sponsored")}
          ${rssEntry("NASA announces a new aerospace expo", "expo")}
          ${rssEntry("This Week in Science: AI agents come to an agreement", "science-roundup")}
          ${rssEntry("GLP-1s may be working in an entirely different way", "glp1")}
          ${rssEntry("Mysterious mushroom fairy rings grow in circles", "mushrooms")}
          ${rssEntry("iPhone 18 Pro price: Apple protects its profit margins", "iphone-price")}
          ${rssEntry("Apple Loop: iPhone 18 Pro stock warning", "apple-loop")}
          ${rssEntry("Apple Watch battery replacement: How much does it cost and is it worth it", "battery-replacement")}
        </channel></rss>`, { headers: { "content-type": "application/rss+xml" } });
      }
      throw new Error(`Unexpected request ${url}`);
    });

    const result = await discoverExternalDashboardCandidates({
      now: NOW,
      fetchImpl: fetchImpl as typeof fetch,
      rssFeeds: [{ name: "Broad Publisher", url: "https://broad-publisher.example.test/feed.xml", quality: 80 }],
      researchFeeds: [],
      redditSubreddits: []
    });

    expect(result.candidates.map((candidate) => candidate.title)).toEqual([
      "Open-source AI infrastructure expands data-center research"
    ]);
    expect(result.candidates[0]).toEqual(expect.objectContaining({ independentlyReported: true, sourceQuality: 80 }));
  });

  it("requires title-led technology coverage and strips publisher boilerplate before RSS admission", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input));
      if (url.hostname === "hn.algolia.com") return json({ hits: [] });
      if (url.hostname === "api.github.com" && url.pathname === "/search/repositories") return json({ items: [] });
      if (url.hostname === "api.github.com" && url.pathname === "/events") return json([]);
      if (url.hostname === "editorial.example.test") {
        return new Response(`<?xml version="1.0"?><rss><channel>
          ${rssEntry("AI benchmark measures agent reliability across coding tasks", "ai-benchmark", "Independent reporting on model evaluation and developer workflows.")}
          ${rssEntry("New semiconductor plant expands GPU compute capacity", "semiconductor", "The manufacturer is adding advanced chips for cloud infrastructure.")}
          ${rssEntry("Satellite network adds secure broadband for remote sites", "satellite-network", "The launch supports network security and cloud-connected devices.")}
          ${rssEntry("Ancient Egypt Will Soon Host The Century's Longest Total Solar Eclipse", "solar-eclipse", "Researchers describe where observers can view the astronomical event.")}
          ${rssEntry("Abolishing Atomic Arms Requires a New Nuclear Treaty", "atomic-arms", "Diplomats are discussing disarmament negotiations.")}
          ${rssEntry("Popular Aesthetic Treatments May Change How You Look", "aesthetic-treatment", "A health feature with general advice.ScienceAlert stories are written, fact-checked, and edited by humans, never generated by AI.")}
          ${rssEntry("Ancient Humans Survived an Ice Age Mystery", "ancient-humans", "Scientists study a historical population.")}
          ${rssEntry("AI Roleplaying Is the Internet's Latest Way to Have a Laugh", "ai-roleplaying", "A culture story about entertainment online.")}
          ${rssEntry("Navy Weekend Video Shows a New Military Carrier", "military-weekend", "The Navy released footage of the vessel.")}
          ${rssEntry("Ukraine Opens Rocket Factory During the War", "ukraine-rocket", "The factory is part of the country's military response.")}
        </channel></rss>`, { headers: { "content-type": "application/rss+xml" } });
      }
      throw new Error(`Unexpected request ${url}`);
    });

    const result = await discoverExternalDashboardCandidates({
      now: NOW,
      fetchImpl: fetchImpl as typeof fetch,
      rssFeeds: [{ name: "Editorial", url: "https://editorial.example.test/feed.xml", quality: 80 }],
      researchFeeds: [],
      redditSubreddits: []
    });

    expect(result.candidates.map((candidate) => candidate.title)).toEqual([
      "AI benchmark measures agent reliability across coding tasks",
      "New semiconductor plant expands GPU compute capacity",
      "Satellite network adds secure broadband for remote sites"
    ]);
    expect(result.candidates.map((candidate) => candidate.summary).join(" ")).not.toContain("never generated by AI");
  });

  it("excludes speculative-token repositories while retaining described technical projects", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input));
      if (url.hostname === "hn.algolia.com") return json({ hits: [] });
      if (url.hostname === "api.github.com" && url.pathname === "/search/repositories") {
        return json({
          items: [
            {
              id: 1,
              full_name: "acme/ai-evaluation",
              html_url: "https://github.com/acme/ai-evaluation",
              description: "Open-source software for AI model evaluation and reproducible research.",
              created_at: "2026-08-15T11:00:00.000Z",
              updated_at: "2026-08-15T11:20:00.000Z",
              stargazers_count: 120,
              forks_count: 8,
              watchers_count: 12,
              owner: { login: "acme" }
            },
            {
              id: 2,
              full_name: "morsyxbt/nft-public-mint",
              html_url: "https://github.com/morsyxbt/nft-public-mint",
              description: "Cryptocurrency token airdrop minting tools.",
              created_at: "2026-08-15T11:00:00.000Z",
              updated_at: "2026-08-15T11:20:00.000Z",
              stargazers_count: 900,
              forks_count: 80,
              watchers_count: 90,
              owner: { login: "morsyxbt" }
            },
            {
              id: 3,
              full_name: "liceses/dsh-gitbash-preset",
              html_url: "https://github.com/liceses/dsh-gitbash-preset",
              description: "Developer tools preset for programming workflows.",
              created_at: "2026-08-15T11:00:00.000Z",
              updated_at: "2026-08-15T11:20:00.000Z",
              stargazers_count: 180,
              forks_count: 8,
              watchers_count: 12,
              owner: { login: "liceses" }
            },
            {
              id: 4,
              full_name: "orbitpomponio/Exodus-Fake-Balance",
              html_url: "https://github.com/orbitpomponio/Exodus-Fake-Balance",
              description: "Open-source software for testing a mobile wallet interface.",
              created_at: "2026-08-15T11:00:00.000Z",
              updated_at: "2026-08-15T11:20:00.000Z",
              stargazers_count: 180,
              forks_count: 8,
              watchers_count: 12,
              owner: { login: "orbitpomponio" }
            },
            {
              id: 5,
              full_name: "Yousuf-developer/Viscose-carousel",
              html_url: "https://github.com/Yousuf-developer/Viscose-carousel",
              description: "A wheel of work that never quite sets. Cards fuse as they meet.",
              created_at: "2026-08-15T11:00:00.000Z",
              updated_at: "2026-08-15T11:20:00.000Z",
              stargazers_count: 180,
              forks_count: 8,
              watchers_count: 12,
              owner: { login: "Yousuf-developer" }
            }
          ]
        });
      }
      if (url.hostname === "api.github.com" && url.pathname === "/events") return json([]);
      throw new Error(`Unexpected request ${url}`);
    });

    const result = await discoverExternalDashboardCandidates({
      now: NOW,
      fetchImpl: fetchImpl as typeof fetch,
      rssFeeds: [],
      researchFeeds: [],
      redditSubreddits: []
    });

    expect(result.candidates).toEqual([
      expect.objectContaining({ id: "github:1", title: "acme/ai-evaluation" })
    ]);
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
      "https://www.cnet.com/rss/news/",
      // Broad general-interest science/innovation sources stay out of the
      // runtime-configurable roster as well as the default roster.
      "https://www.forbes.com/innovation/feed2/",
      "https://www.sciencealert.com/feed",
      "https://www.nasa.gov/news-release/feed/",
      "https://www.space.com/feeds/all",
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
      if (["feeds.arstechnica.com", "www.technologyreview.com", "www.cnet.com"].includes(url.hostname)) {
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
        "rss:configured-feed-2",
        "rss:configured-feed-3"
      ]);
      expect([...new Set(seenHosts)].sort()).toEqual([
        "api.github.com",
        "feeds.arstechnica.com",
        "hn.algolia.com",
        "www.cnet.com",
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

function rssItems(source: string, count: number): string {
  return `<?xml version="1.0"?><rss><channel>${Array.from({ length: count }, (_, index) => `
    <item>
      <title>${source} technology article ${index + 1}</title>
      <link>https://${source}.example.test/articles/${index + 1}</link>
      <guid>${source}-${index + 1}</guid>
      <pubDate>Fri, 15 Aug 2026 11:00:00 GMT</pubDate>
      <description>Independent editorial coverage.</description>
    </item>`).join("")}</channel></rss>`;
}

function rssEntry(title: string, id: string, description = "Independent reporting with detailed technology context."): string {
  return `<item>
    <title>${title}</title>
    <link>https://broad-publisher.example.test/articles/${id}</link>
    <guid>${id}</guid>
    <pubDate>Fri, 15 Aug 2026 11:00:00 GMT</pubDate>
    <description><![CDATA[${description}]]></description>
  </item>`;
}
