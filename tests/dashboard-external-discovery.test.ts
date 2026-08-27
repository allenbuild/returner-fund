import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DASHBOARD_INSTAGRAM_ACCOUNTS,
  DEFAULT_DASHBOARD_RESEARCH_FEEDS,
  DEFAULT_DASHBOARD_RSS_FEEDS,
  DEFAULT_DASHBOARD_YOUTUBE_CHANNELS,
  DEFAULT_DASHBOARD_YOUTUBE_SEARCH_QUERIES,
  MAX_DASHBOARD_INSTAGRAM_ACCOUNTS,
  MAX_DASHBOARD_YOUTUBE_CHANNELS,
  discoverExternalDashboardCandidates,
  fetchInstagramAccountCandidates,
  fetchYoutubeChannelCandidates,
  fetchYoutubeSearchCandidates
} from "@/lib/dashboard/external-discovery";
import { buildDashboardSnapshot, dashboardTop100Eligibility } from "@/lib/dashboard/pipeline";

const NOW = new Date("2026-08-15T12:00:00.000Z");
const YOUTUBE_INNERTUBE_API_KEY = "AIzaUnitTestPublicKey_123456789012345";
const YOUTUBE_INNERTUBE_CLIENT_VERSION = "2.20260815.00.00";

describe("public dashboard discovery", () => {
  it("accepts exact primary-author Instagram reels with native million-play counters", async () => {
    const now = new Date("2026-08-26T10:23:46.764Z");
    const requests: Array<{ url: URL; init: RequestInit }> = [];
    const payloads = new Map<string, unknown>([
      ["apple", instagramNativeFeedPayload("apple", [{
        shortcode: "DcbalRNsXiS",
        nativeMediaId: "3700000000000000001",
        postedAt: "2026-08-24T16:00:18.000Z",
        plays: 21_545_529,
        likes: 387_079,
        comments: 1_142,
        caption: "Wait for the drop. #ShotoniPhone by Phineas P. Additional software used."
      }])],
      ["techburner", instagramNativeFeedPayload("techburner", [{
        shortcode: "Dcd_FfvP96F",
        nativeMediaId: "3700000000000000002",
        postedAt: "2026-08-25T15:44:22.000Z",
        plays: 2_887_229,
        likes: 114_709,
        comments: 503,
        caption: "Robot Phone 🤯 #robot #ai #smartphone #reels"
      }])]
    ]);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const username = url.pathname.split("/")[5] ?? "";
      requests.push({ url, init: init ?? {} });
      return json(payloads.get(username));
    });

    const [apple, techBurner] = await Promise.all([
      fetchInstagramAccountCandidates(fetchImpl as typeof fetch, now, { name: "Apple", username: "apple" }),
      fetchInstagramAccountCandidates(fetchImpl as typeof fetch, now, { name: "Tech Burner", username: "techburner" })
    ]);

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.url.hostname).toBe("www.instagram.com");
      expect(request.url.pathname).toMatch(/^\/api\/v1\/feed\/user\/(?:apple|techburner)\/username\/$/);
      expect(request.url.searchParams.get("count")).toBe("50");
      expect(request.init.credentials).toBe("omit");
      expect(request.init.redirect).toBe("error");
      const headers = new Headers(request.init.headers);
      expect(headers.get("x-ig-app-id")).toBe("936619743392459");
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("cookie")).toBeNull();
    }
    expect(apple.candidates).toEqual([expect.objectContaining({
      canonicalKey: "instagram:post:DcbalRNsXiS",
      url: "https://www.instagram.com/reel/DcbalRNsXiS",
      platform: "instagram",
      sourceKind: "video",
      authorHandle: "apple",
      title: expect.stringContaining("#ShotoniPhone"),
      publishedAt: "2026-08-24T16:00:18.000Z",
      metrics: { views: 21_545_529, likes: 387_079, comments: 1_142 },
      socialBackfillEligible: true,
      sourceVerified: true,
      sourceLinkStatus: "verified",
      publicationPrecision: "exact"
    })]);
    expect(techBurner.candidates).toEqual([expect.objectContaining({
      canonicalKey: "instagram:post:Dcd_FfvP96F",
      authorHandle: "techburner",
      publishedAt: "2026-08-25T15:44:22.000Z",
      metrics: { views: 2_887_229, likes: 114_709, comments: 503 }
    })]);
    const candidates = [...apple.candidates, ...techBurner.candidates];
    expect(candidates.map((candidate) => dashboardTop100Eligibility(candidate, now).reason)).toEqual([
      "eligible",
      "eligible"
    ]);
    expect(buildDashboardSnapshot(candidates, { now }).snapshot.stories).toHaveLength(2);
  });

  it("rejects vague high-view Instagram content and preserves the million-view gate", async () => {
    const now = new Date("2026-08-26T10:23:46.764Z");
    const fetchImpl = vi.fn(async (): Promise<Response> => json(instagramNativeFeedPayload("mkbhd", [{
      shortcode: "DcezzvJQRen",
      nativeMediaId: "3700000000000000011",
      postedAt: "2026-08-25T23:25:08.000Z",
      plays: 1_757_687,
      likes: 101_168,
      comments: 854,
      caption: "Do a flip"
    }, {
      shortcode: "DceTechBelow",
      nativeMediaId: "3700000000000000012",
      postedAt: "2026-08-25T22:00:00.000Z",
      plays: 999_999,
      likes: 90_000,
      comments: 400,
      caption: "New AI smartphone and robot hardware"
    }])));

    const result = await fetchInstagramAccountCandidates(fetchImpl as typeof fetch, now, {
      name: "MKBHD",
      username: "mkbhd"
    });

    expect(result.candidates).toHaveLength(2);
    expect(dashboardTop100Eligibility(result.candidates[0]!, now)).toMatchObject({
      eligible: false,
      reason: "unverified_source"
    });
    expect(dashboardTop100Eligibility(result.candidates[1]!, now)).toMatchObject({
      eligible: false,
      reason: "below_one_million_views"
    });
    expect(buildDashboardSnapshot(result.candidates, { now }).snapshot.stories).toHaveLength(0);
  });

  it("fails closed on an Instagram envelope mismatch and drops a surface-only author", async () => {
    const now = new Date("2026-08-26T10:23:46.764Z");
    const mismatchedEnvelope = vi.fn(async (): Promise<Response> => json(
      instagramNativeFeedPayload("techburner", [])
    ));
    await expect(fetchInstagramAccountCandidates(mismatchedEnvelope as typeof fetch, now, {
      name: "Apple",
      username: "apple"
    })).rejects.toThrow("instagram_native_feed_username_mismatch");

    const surfaceOnly = vi.fn(async (): Promise<Response> => json(instagramNativeFeedPayload("apple", [{
      shortcode: "DcbSurfaceOnly",
      nativeMediaId: "3700000000000000021",
      postedAt: "2026-08-25T16:00:18.000Z",
      plays: 9_000_000,
      likes: 100_000,
      comments: 1_000,
      caption: "AI smartphone software",
      authorUsername: "unrelatedcreator"
    }])));
    const result = await fetchInstagramAccountCandidates(surfaceOnly as typeof fetch, now, {
      name: "Apple",
      username: "apple"
    });
    expect(result.source).toBe("instagram:apple");
    expect(result.candidates).toEqual([]);
  });

  it("requires exact native timestamps and an actual native view counter", async () => {
    const now = new Date("2026-08-26T10:23:46.764Z");
    const missingTimestamp = instagramNativeFeedPayload("apple", [{
      shortcode: "DcbNoTimestamp",
      nativeMediaId: "3700000000000000031",
      postedAt: "2026-08-25T16:00:18.000Z",
      plays: 9_000_000,
      likes: 100_000,
      comments: 1_000,
      caption: "AI smartphone software"
    }]) as { items: Array<Record<string, unknown>> };
    delete missingTimestamp.items[0]!.taken_at;
    await expect(fetchInstagramAccountCandidates(
      vi.fn(async (): Promise<Response> => json(missingTimestamp)) as typeof fetch,
      now,
      { name: "Apple", username: "apple" }
    )).rejects.toThrow("instagram_native_feed_item_malformed");

    const missingViews = instagramNativeFeedPayload("apple", [{
      shortcode: "DcbNoViews",
      nativeMediaId: "3700000000000000032",
      postedAt: "2026-08-25T16:00:18.000Z",
      plays: null,
      likes: 100_000,
      comments: 1_000,
      caption: "AI smartphone software"
    }]);
    const result = await fetchInstagramAccountCandidates(
      vi.fn(async (): Promise<Response> => json(missingViews)) as typeof fetch,
      now,
      { name: "Apple", username: "apple" }
    );
    expect(result.candidates).toEqual([]);
  });

  it("ships a unique, bounded fixed Instagram roster", () => {
    expect(DEFAULT_DASHBOARD_INSTAGRAM_ACCOUNTS).toHaveLength(30);
    expect(DEFAULT_DASHBOARD_INSTAGRAM_ACCOUNTS.length).toBeLessThanOrEqual(MAX_DASHBOARD_INSTAGRAM_ACCOUNTS);
    expect(DEFAULT_DASHBOARD_INSTAGRAM_ACCOUNTS.map(({ username }) => username)).toEqual(expect.arrayContaining([
      "apple",
      "mkbhd",
      "techburner",
      "openai",
      "nvidia",
      "samsungmobile",
      "xiaomi.global",
      "beebomco",
      "teslamotors",
      "techwiser",
      "haylsworld",
      "supersaf",
      "googlepixel",
      "oneplus",
      "qualcomm"
    ]));
    expect(new Set(DEFAULT_DASHBOARD_INSTAGRAM_ACCOUNTS.map(({ username }) => username)).size).toBe(
      DEFAULT_DASHBOARD_INSTAGRAM_ACCOUNTS.length
    );
  });

  it("caps and concurrency-bounds an explicit Instagram roster", async () => {
    const configured = Array.from({ length: MAX_DASHBOARD_INSTAGRAM_ACCOUNTS + 5 }, (_, index) => ({
      name: `Account ${index}`,
      username: `account${index}`
    }));
    const requestedUsernames: string[] = [];
    let activeInstagramRequests = 0;
    let maxActiveInstagramRequests = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input));
      if (url.hostname === "hn.algolia.com") return json({ hits: [] });
      if (url.hostname === "api.github.com" && url.pathname === "/search/repositories") return json({ items: [] });
      if (url.hostname === "api.github.com" && url.pathname === "/events") return json([]);
      if (url.hostname === "www.instagram.com") {
        const username = url.pathname.split("/")[5] ?? "";
        requestedUsernames.push(username);
        activeInstagramRequests += 1;
        maxActiveInstagramRequests = Math.max(maxActiveInstagramRequests, activeInstagramRequests);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeInstagramRequests -= 1;
        return json(instagramNativeFeedPayload(username, []));
      }
      throw new Error(`Unexpected request ${url}`);
    });

    const result = await discoverExternalDashboardCandidates({
      now: NOW,
      fetchImpl: fetchImpl as typeof fetch,
      instagramAccounts: configured,
      rssFeeds: [],
      researchFeeds: [],
      redditSubreddits: []
    });

    expect(requestedUsernames).toEqual(configured
      .slice(0, MAX_DASHBOARD_INSTAGRAM_ACCOUNTS)
      .map(({ username }) => username));
    expect(maxActiveInstagramRequests).toBe(3);
    expect(result.failures).toEqual([]);
    expect(result.sources.filter((source) => source.startsWith("instagram:"))).toHaveLength(
      MAX_DASHBOARD_INSTAGRAM_ACCOUNTS
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3 + MAX_DASHBOARD_INSTAGRAM_ACCOUNTS);
  });

  it("uses fixed channel identity with no-key official browse and player requests", async () => {
    const channelId = "UCE_M8A5yxnLfW0KghEeajjw";
    const requests: Array<{ url: URL; method: string; headers: Headers; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body });
      if (url.pathname === "/youtubei/v1/browse") {
        return json(youtubeUploadsBrowseResponse(["3WpzNmY35S4", "lowviews001", "thirdvid001"]));
      }
      if (url.pathname === "/youtubei/v1/player") {
        const videoId = String(body.videoId);
        return json(youtubePlayerResponse({
          videoId,
          channelId,
          author: "Apple",
          title: "Apple AI hardware launch",
          description: "New AI hardware and developer software.",
          publishedAt: "2026-08-15T03:00:00-07:00",
          views: videoId === "3WpzNmY35S4" ? 2_000_000 : 999_999
        }));
      }
      throw new Error(`Unexpected request ${url}`);
    });

    const result = await fetchYoutubeChannelCandidates(fetchImpl as typeof fetch, NOW, {
      name: "Apple",
      handle: "Apple",
      channelId
    });

    expect(requests).toHaveLength(3);
    expect(requests[0]).toMatchObject({ method: "POST" });
    expect(requests[0]?.url.pathname).toBe("/youtubei/v1/browse");
    expect(requests[0]?.url.searchParams.get("key")).toBeNull();
    expect(requests[0]?.body).toMatchObject({ browseId: `VLUU${channelId.slice(2)}` });
    expect(requests.slice(1).map(({ body }) => body.videoId)).toEqual(["3WpzNmY35S4", "lowviews001"]);
    for (const request of requests) {
      expect(request.url.searchParams.get("key")).toBeNull();
      expect(request.headers.get("x-youtube-client-name")).toBe("1");
      expect(request.headers.get("x-youtube-client-version")).toBeTruthy();
      expect(JSON.stringify(request.body)).not.toContain("AIza");
    }
    expect(result.candidates).toEqual([
      expect.objectContaining({ id: "youtube:3WpzNmY35S4", metrics: { views: 2_000_000, likes: null } }),
      expect.objectContaining({ id: "youtube:lowviews001", metrics: { views: 999_999, likes: null } })
    ]);
    expect(buildDashboardSnapshot(result.candidates, { now: NOW }).snapshot.stories).toHaveLength(1);
  });

  it("uses exact official player JSON when the watch HTML exposes only date-level metadata", async () => {
    const channelId = "UC1234567890123456789012";
    const channelPage = youtubeChannelPage(channelId, [{
      videoId: "3WpzNmY35S4",
      title: "The new Mac mini with M6",
      views: "842K views",
      relativeTime: "14 hours ago"
    }, {
      videoId: "lowviews001",
      title: "A smaller Mac update",
      views: "2.5M views",
      relativeTime: "2 hours ago"
    }, {
      videoId: "thirdvid001",
      title: "A third recent upload",
      views: "9M views",
      relativeTime: "20 minutes ago"
    }], true);
    const playerRequests: Array<{ url: URL; method: string; headers: Headers; body: Record<string, unknown> }> = [];
    const watchRequests: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname === "/@Apple/videos") {
        expect(url.searchParams.get("hl")).toBe("en");
        expect(url.searchParams.get("gl")).toBe("US");
        return new Response(channelPage);
      }
      if (url.pathname === "/youtubei/v1/player") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        playerRequests.push({ url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body });
        const videoId = String(body.videoId);
        if (!new Set(["3WpzNmY35S4", "lowviews001"]).has(videoId)) {
          throw new Error(`Unexpected player video ${videoId}`);
        }
        return json(youtubePlayerResponse({
          videoId,
          channelId,
          author: "Apple",
          title: videoId === "3WpzNmY35S4" ? "The new Mac mini with M6" : "A smaller Mac update",
          description: videoId === "3WpzNmY35S4"
            ? "The M6 chip adds faster graphics, neural accelerators, and AI performance."
            : "A software and AI update for Mac developers.",
          publishedAt: videoId === "3WpzNmY35S4"
            ? "2026-08-15T01:33:48-07:00"
            : "2026-08-15T03:00:00-07:00",
          views: videoId === "3WpzNmY35S4" ? 2_547_274 : 999_999
        }));
      }
      if (url.pathname === "/watch") {
        watchRequests.push(url.toString());
        const videoId = url.searchParams.get("v") ?? "";
        return new Response(youtubeWatchPage({
          videoId,
          channelId,
          author: "Apple",
          title: "Date-only watch metadata must not attest this upload",
          description: "Software and AI.",
          publishedAt: "2026-08-15",
          publishDate: "2026-08-15",
          uploadDate: "2026-08-15",
          views: 2_547_274,
          likes: 21_798
        }));
      }
      throw new Error(`Unexpected request ${url}`);
    });

    const result = await fetchYoutubeChannelCandidates(fetchImpl as typeof fetch, NOW, {
      name: "Apple",
      handle: "Apple"
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(watchRequests).toEqual([]);
    expect(playerRequests.map(({ body }) => body.videoId)).toEqual(["3WpzNmY35S4", "lowviews001"]);
    for (const request of playerRequests) {
      expect(request.method).toBe("POST");
      expect(request.url.searchParams.get("key")).toBe(YOUTUBE_INNERTUBE_API_KEY);
      expect(request.url.searchParams.get("prettyPrint")).toBe("false");
      expect(request.headers.get("content-type")).toBe("application/json");
      expect(request.headers.get("x-youtube-client-name")).toBe("1");
      expect(request.headers.get("x-youtube-client-version")).toBe(YOUTUBE_INNERTUBE_CLIENT_VERSION);
      expect(request.body).toMatchObject({
        context: { client: { clientName: "WEB", clientVersion: YOUTUBE_INNERTUBE_CLIENT_VERSION, hl: "en", gl: "US" } },
        contentCheckOk: true,
        racyCheckOk: true
      });
      expect(JSON.stringify(request.body)).not.toContain(YOUTUBE_INNERTUBE_API_KEY);
    }
    expect(result.source).toBe("youtube:apple");
    expect(result.candidates).toEqual([
      expect.objectContaining({
        canonicalKey: "youtube:video:3WpzNmY35S4",
        url: "https://www.youtube.com/watch?v=3WpzNmY35S4",
        platform: "youtube",
        sourceKind: "video",
        authorName: "Apple",
        publishedAt: "2026-08-15T08:33:48.000Z",
        metrics: { views: 2_547_274, likes: null },
        socialBackfillEligible: true,
        sourceVerified: true,
        sourceLinkStatus: "verified",
        publicationPrecision: "exact"
      }),
      expect.objectContaining({
        canonicalKey: "youtube:video:lowviews001",
        metrics: { views: 999_999, likes: null }
      })
    ]);
    expect(buildDashboardSnapshot(result.candidates, { now: NOW }).snapshot.stories).toHaveLength(1);
  });

  it("discovers legacy video, grid, and rich-item renderers in display order", async () => {
    const channelId = "UC1234567890123456789012";
    const channelPage = youtubeChannelPageFromContents(channelId, [
      {
        richItemRenderer: {
          content: {
            videoRenderer: {
              videoId: "ngPkbaZliaU",
              title: { runs: [{ text: "A concept phone" }] },
              viewCountText: { simpleText: "No public counter here" }
            }
          }
        }
      },
      {
        gridVideoRenderer: {
          videoId: "legacygr001",
          title: { simpleText: "An AI developer update" },
          viewCountText: { simpleText: "743K views" }
        }
      },
      {
        richItemRenderer: {
          content: {
            lockupViewModel: {
              contentId: "thirdvid001",
              contentType: "LOCKUP_CONTENT_TYPE_VIDEO"
            }
          }
        }
      }
    ]);
    const requestedIds: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname === "/@mkbhd/videos") return new Response(channelPage);
      const videoId = url.searchParams.get("v");
      if (url.pathname === "/watch" && videoId) {
        requestedIds.push(videoId);
        return new Response(youtubeWatchPage({
          videoId,
          channelId,
          author: "Marques Brownlee",
          title: videoId === "ngPkbaZliaU" ? "A concept phone" : "An AI developer update",
          description: "Technology, software, hardware, and AI research.",
          publishedAt: "2026-08-15T03:00:00-07:00",
          views: 1_500_000,
          likes: 10_000
        }));
      }
      throw new Error(`Unexpected request ${url}`);
    });

    const result = await fetchYoutubeChannelCandidates(fetchImpl as typeof fetch, NOW, {
      name: "MKBHD",
      handle: "mkbhd"
    });

    expect(requestedIds).toEqual(["ngPkbaZliaU", "legacygr001"]);
    expect(result.candidates.map((candidate) => candidate.id)).toEqual([
      "youtube:ngPkbaZliaU",
      "youtube:legacygr001"
    ]);
  });

  it("reports an actionable failure when a configured channel page has no preview IDs", async () => {
    const channelId = "UC1234567890123456789012";
    const fetchImpl = vi.fn(async (): Promise<Response> =>
      new Response(youtubeChannelPage(channelId, []))
    );

    await expect(fetchYoutubeChannelCandidates(fetchImpl as typeof fetch, NOW, {
      name: "MKBHD",
      handle: "mkbhd"
    })).rejects.toThrow("youtube_mkbhd_no_video_preview_ids");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports detail-unavailable when player identity is wrong and fallback timestamps are date-only", async () => {
    const channelId = "UC1234567890123456789012";
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname === "/@Apple/videos") return new Response(youtubeChannelPage(channelId, [{
        videoId: "3WpzNmY35S4",
        title: "The new Mac mini with M6",
        views: "2.5M views",
        relativeTime: "14 hours ago"
      }, {
        videoId: "lowviews001",
        title: "A smaller Mac update",
        views: "900K views",
        relativeTime: "2 hours ago"
      }], true));
      if (url.pathname === "/youtubei/v1/player") {
        const body = JSON.parse(String(init?.body)) as { videoId?: string };
        return json(youtubePlayerResponse({
          videoId: body.videoId ?? "",
          channelId: "UCwrongchannel123456789012",
          author: "Wrong channel",
          title: "Mismatched video",
          description: "Software and AI.",
          publishedAt: "2026-08-15T03:00:00-07:00",
          views: 2_000_000
        }));
      }
      const videoId = url.searchParams.get("v");
      if (url.pathname === "/watch" && videoId) {
        return new Response(youtubeWatchPage({
          videoId,
          channelId,
          author: "Apple",
          title: "Date-only fallback",
          description: "Software and AI.",
          publishedAt: "2026-08-15",
          views: 2_000_000,
          likes: 10_000
        }));
      }
      throw new Error(`Unexpected request ${url}`);
    });

    await expect(fetchYoutubeChannelCandidates(fetchImpl as typeof fetch, NOW, {
      name: "Apple",
      handle: "Apple"
    })).rejects.toThrow("youtube_apple_detail_unavailable");
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it("bounds fixed view-sorted search and rereads every nominated video from the official player", async () => {
    const channelId = "UC1234567890123456789012";
    const searchRequests: URL[] = [];
    const playerRequests: Array<{ videoId: string; signal: AbortSignal | null }> = [];
    const idsByQuery = DEFAULT_DASHBOARD_YOUTUBE_SEARCH_QUERIES.map((_, queryIndex) =>
      Array.from({ length: 8 }, (_, resultIndex) => `q${queryIndex + 1}video${String(resultIndex).padStart(4, "0")}`)
    );
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname === "/results") {
        searchRequests.push(url);
        const queryIndex = DEFAULT_DASHBOARD_YOUTUBE_SEARCH_QUERIES.indexOf(
          url.searchParams.get("search_query") as typeof DEFAULT_DASHBOARD_YOUTUBE_SEARCH_QUERIES[number]
        );
        return new Response(youtubeSearchPage(idsByQuery[queryIndex] ?? []));
      }
      if (url.pathname === "/youtubei/v1/player") {
        const body = JSON.parse(String(init?.body)) as { videoId?: string };
        const videoId = body.videoId ?? "";
        playerRequests.push({ videoId, signal: init?.signal ?? null });
        return json(youtubePlayerResponse({
          videoId,
          channelId,
          author: "Verified technology creator",
          title: `AI hardware launch ${videoId}`,
          description: "Artificial intelligence chips and developer software.",
          publishedAt: "2026-08-15T10:00:00.000Z",
          views: 1_500_000
        }));
      }
      throw new Error(`Unexpected request ${url}`);
    });

    const result = await fetchYoutubeSearchCandidates(fetchImpl as typeof fetch, NOW);

    expect(searchRequests).toHaveLength(4);
    expect(searchRequests.map((url) => url.searchParams.get("search_query"))).toEqual(
      DEFAULT_DASHBOARD_YOUTUBE_SEARCH_QUERIES
    );
    for (const request of searchRequests) {
      expect(request.searchParams.get("sp")).toBe("CAMSAggDEAE");
      expect(request.searchParams.get("hl")).toBe("en");
      expect(request.searchParams.get("gl")).toBe("US");
    }
    expect(playerRequests).toHaveLength(24);
    expect(new Set(playerRequests.map(({ videoId }) => videoId)).size).toBe(24);
    expect(playerRequests.every(({ signal }) => signal instanceof AbortSignal)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(28);
    expect(result.source).toBe("youtube:search");
    expect(result.candidates).toHaveLength(24);
    expect(result.candidates[0]).toMatchObject({
      platform: "youtube",
      sourceVerified: true,
      sourceLinkStatus: "verified",
      publicationPrecision: "exact",
      publishedAt: "2026-08-15T10:00:00.000Z",
      metrics: { views: 1_500_000, likes: null },
      entityKeys: [`youtube:channel:${channelId}`]
    });
    expect(buildDashboardSnapshot(result.candidates, { now: NOW }).snapshot.status.eligibleCandidateCount).toBe(24);
  });

  it("keeps a million-view rabbit-trap entertainment result out of the strict technology Top 100", async () => {
    const videoId = "rabbit00001";
    const channelId = "UC1234567890123456789012";
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname === "/results") return new Response(youtubeSearchPage([videoId]));
      if (url.pathname === "/youtubei/v1/player") {
        const body = JSON.parse(String(init?.body)) as { videoId?: string };
        return json(youtubePlayerResponse({
          videoId: body.videoId ?? "",
          channelId,
          author: "CHANNA SKILL",
          title: "Beautiful Creative DIY Rabbit Trap #outdoors #camping #bushcraft #survival #technology #soap #shorts",
          description: "A rabbit trap made outdoors while camping.",
          publishedAt: "2026-08-15T09:00:00.000Z",
          views: 17_704_162
        }));
      }
      throw new Error(`Unexpected request ${url}`);
    });

    const result = await fetchYoutubeSearchCandidates(fetchImpl as typeof fetch, NOW);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ metrics: { views: 17_704_162, likes: null }, topics: [] });
    expect(dashboardTop100Eligibility(result.candidates[0]!, NOW)).toMatchObject({
      eligible: false,
      reason: "unverified_source"
    });
    expect(buildDashboardSnapshot(result.candidates, { now: NOW }).snapshot.stories).toHaveLength(0);
  });

  it("falls back to bounded official search and keeps player metadata behind every hard gate", async () => {
    const videoIds = ["fallback001", "oldvideo001", "belowone001", "nontech0001"];
    const channelId = "UC1234567890123456789012";
    const pageRequests: RequestInit[] = [];
    const fallbackRequests: Array<{ query: string; params: string; init: RequestInit }> = [];
    const playerRequests: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname === "/results") {
        pageRequests.push(init ?? {});
        return new Response(null, {
          status: 302,
          headers: { Location: "https://www.google.com/sorry/index" }
        });
      }
      if (url.pathname === "/youtubei/v1/search") {
        const body = JSON.parse(String(init?.body)) as { query?: string; params?: string };
        fallbackRequests.push({
          query: body.query ?? "",
          params: body.params ?? "",
          init: init ?? {}
        });
        return json(youtubeSearchResponse(videoIds));
      }
      if (url.pathname === "/youtubei/v1/player") {
        const body = JSON.parse(String(init?.body)) as { videoId?: string };
        const videoId = body.videoId ?? "";
        playerRequests.push(videoId);
        if (videoId === "oldvideo001") {
          return json(youtubePlayerResponse({
            videoId,
            channelId,
            author: "Old technology creator",
            title: "AI hardware from last week",
            description: "Artificial intelligence chips and developer software.",
            publishedAt: "2026-08-11T10:00:00.000Z",
            views: 4_000_000
          }));
        }
        if (videoId === "belowone001") {
          return json(youtubePlayerResponse({
            videoId,
            channelId,
            author: "Robotics creator",
            title: "New robotics hardware launch",
            description: "An autonomous robot and its control software.",
            publishedAt: "2026-08-15T09:00:00.000Z",
            views: 999_999
          }));
        }
        if (videoId === "nontech0001") {
          return json(youtubePlayerResponse({
            videoId,
            channelId,
            author: "Outdoor creator",
            title: "Beautiful creative rabbit trap",
            description: "A rabbit trap made outdoors while camping.",
            publishedAt: "2026-08-15T08:00:00.000Z",
            views: 8_000_000
          }));
        }
        return json(youtubePlayerResponse({
          videoId,
          channelId,
          author: "Verified technology creator",
          title: "AI hardware launch",
          description: "Artificial intelligence chips and developer software.",
          publishedAt: "2026-08-15T10:00:00.000Z",
          views: 1_500_000
        }));
      }
      throw new Error(`Unexpected request ${url}`);
    });

    const result = await fetchYoutubeSearchCandidates(fetchImpl as typeof fetch, NOW);

    expect(pageRequests).toHaveLength(DEFAULT_DASHBOARD_YOUTUBE_SEARCH_QUERIES.length);
    expect(pageRequests.every(({ redirect }) => redirect === "manual")).toBe(true);
    expect(fallbackRequests.map(({ query }) => query)).toEqual(DEFAULT_DASHBOARD_YOUTUBE_SEARCH_QUERIES);
    expect(fallbackRequests.every(({ params }) => params === "CAMSAggDEAE")).toBe(true);
    for (const { init } of fallbackRequests) {
      expect(init.method).toBe("POST");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(init.headers);
      expect(headers.get("x-youtube-client-name")).toBe("1");
      expect(headers.get("x-youtube-client-version")).toMatch(/^2\.\d{8}\.\d{2}\.\d{2}$/);
    }
    expect(playerRequests).toEqual(videoIds);
    expect(fetchImpl).toHaveBeenCalledTimes(12);
    expect(result.candidates.map((candidate) => candidate.id)).toEqual([
      "youtube:fallback001",
      "youtube:belowone001",
      "youtube:nontech0001"
    ]);
    expect(result.candidates[0]).toMatchObject({
      sourceVerified: true,
      sourceLinkStatus: "verified",
      publicationPrecision: "exact",
      publishedAt: "2026-08-15T10:00:00.000Z",
      metrics: { views: 1_500_000, likes: null }
    });
    expect(result.candidates.map((candidate) => dashboardTop100Eligibility(candidate, NOW).reason)).toEqual([
      "eligible",
      "below_one_million_views",
      "unverified_source"
    ]);
    expect(buildDashboardSnapshot(result.candidates, { now: NOW }).snapshot.stories).toHaveLength(1);
  });

  it("reports one deterministic label when every fixed search page is unavailable", async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => new Response("unavailable", { status: 503 }));

    await expect(fetchYoutubeSearchCandidates(fetchImpl as typeof fetch, NOW))
      .rejects.toThrow("youtube_search_pages_unavailable");
    expect(fetchImpl).toHaveBeenCalledTimes(DEFAULT_DASHBOARD_YOUTUBE_SEARCH_QUERIES.length * 2);
  });

  it("ships an expanded verified tech roster under the hard channel bound", () => {
    expect(DEFAULT_DASHBOARD_YOUTUBE_CHANNELS).toEqual([
      { name: "Apple", handle: "Apple", channelId: "UCE_M8A5yxnLfW0KghEeajjw" },
      { name: "MKBHD", handle: "mkbhd", channelId: "UCBJycsmduvYEL83R_U4JriQ" },
      { name: "OpenAI", handle: "OpenAI", channelId: "UCXZCJLdBC09xxGZ6gcdrc6A" },
      { name: "Google", handle: "Google", channelId: "UCK8sQmJBp8GCxrOtXWBpyEA" },
      { name: "NVIDIA", handle: "NVIDIA", channelId: "UCHuiy8bXnmK5nisYHUd1J5g" },
      { name: "Tesla", handle: "Tesla", channelId: "UC5WjFrtBdufl6CZojX3D8dQ" },
      { name: "Linus Tech Tips", handle: "LinusTechTips", channelId: "UCXuqSBlHAE6Xw-yeJA0Tunw" },
      { name: "Mrwhosetheboss", handle: "Mrwhosetheboss", channelId: "UCMiJRAwDNSNzuYeN2uWa0pA" },
      { name: "Fireship", handle: "Fireship", channelId: "UCsBjURrPoezykLs9EqgamOA" },
      { name: "Samsung", handle: "Samsung", channelId: "UCWwgaK7x0_FR1goeSRazfsQ" },
      { name: "Microsoft", handle: "Microsoft", channelId: "UCFtEEv80fQVKkD4h1PF-Xqw" },
      { name: "Android", handle: "Android", channelId: "UC9M7-jzdU8CVrQo1JwmIdWA" },
      { name: "Unbox Therapy", handle: "unboxtherapy", channelId: "UCsTcErHg8oDvUnTzoqsYeNw" },
      { name: "JerryRigEverything", handle: "JerryRigEverything", channelId: "UCWFKCr40YwOZQx8FHU_ZqqQ" },
      { name: "Dave2D", handle: "Dave2D", channelId: "UCVYamHliCI9rw1tHR1xbkfw" },
      { name: "The Verge", handle: "TheVerge", channelId: "UCddiUEpeqJcYeBxX1IVBKvQ" },
      { name: "SpaceX", handle: "SpaceX", channelId: "UCtI0Hodo5o5dUb67FeUjDeA" },
      { name: "Boston Dynamics", handle: "BostonDynamics", channelId: "UC7vVhkEfw4nOGp8TyDk7RcQ" },
      { name: "DJI", handle: "DJI", channelId: "UCsNGtpqGsyw0U6qEG-WHadA" },
      { name: "Nothing", handle: "NothingTechnology", channelId: "UCuVQmkiETvqmLviDcBtQw4A" },
      { name: "Google DeepMind", handle: "GoogleDeepMind", channelId: "UCP7jMXSY2xbc3KCAE0MHQ-A" },
      { name: "Made by Google", handle: "MadeByGoogle", channelId: "UCIG1k8umaCIIrujZPzZPIMA" },
      { name: "Meta", handle: "Meta", channelId: "UC04FyDIvYXNecpbG8gyOw4A" },
      { name: "AMD", handle: "AMD", channelId: "UCHQDjDDW8w2RieO-IuqYlyg" },
      { name: "Intel", handle: "Intel", channelId: "UCk7SjrXVXAj8m8BLgzh6dGA" },
      { name: "WIRED", handle: "WIRED", channelId: "UCftwRNsjfRo08xYE31tkiyw" },
      { name: "CNET", handle: "CNET", channelId: "UCOmcA3f_RrH6b9NmcNa4tdg" },
      { name: "Austin Evans", handle: "AustinEvans", channelId: "UCXGgrKt94gR6lmN4aN3mYTg" },
      { name: "iJustine", handle: "iJustine", channelId: "UCey_c7U86mJGz1VJWH5CYPA" },
      { name: "Techquickie", handle: "techquickie", channelId: "UC0vBXGSyV14uvJ4hECDOl0Q" },
      { name: "ShortCircuit", handle: "ShortCircuit", channelId: "UCdBK94H6oZT2Q7l0-b0xmMg" },
      { name: "NetworkChuck", handle: "NetworkChuck", channelId: "UC9x0AN7BWHpCDHSm9NiJFJQ" },
      { name: "Cleo Abram", handle: "CleoAbram", channelId: "UC415bOPUcGSamy543abLmRA" },
      { name: "Mark Rober", handle: "MarkRober", channelId: "UCY1kMZp36IQSyNx_9h4mpCg" },
      { name: "Hacksmith Industries", handle: "Hacksmith", channelId: "UCjgpFI5dU-D1-kh9H1muoxQ" },
      { name: "Beebom", handle: "BeebomCo", channelId: "UCvpfclapgcuJo0M_x65pfRw" },
      { name: "Two Minute Papers", handle: "TwoMinutePapers", channelId: "UCbfYPyITQ-7l4upoX8nvctg" },
      { name: "Jeff Geerling", handle: "JeffGeerling", channelId: "UCR-DXc1voovS8nhAvccRZhg" },
      { name: "ColdFusion", handle: "ColdFusion", channelId: "UC4QZ_LsYcvcq7qOsOhpAX4A" },
      { name: "Veritasium", handle: "veritasium", channelId: "UCHnyfMqiRRG1u-2MsSQLbXA" },
      { name: "SmarterEveryDay", handle: "smartereveryday", channelId: "UC6107grRI4m0o2-emgoDnAA" },
      { name: "Stuff Made Here", handle: "StuffMadeHere", channelId: "UCj1VqrHhDte54oLgPG4xpuQ" },
      { name: "Practical Engineering", handle: "PracticalEngineeringChannel", channelId: "UCMOqf8ab-42UUQIdVoKwjlQ" },
      { name: "Real Engineering", handle: "RealEngineering", channelId: "UCR1IuLEqb6UEA_zQ81kwXfg" },
      { name: "Engineering Explained", handle: "EngineeringExplained", channelId: "UClqhvGmHcvWL9w3R48t9QXQ" },
      { name: "Tech Burner", handle: "TechBurner", channelId: "UCXUJJNoP1QupwsYIWFXmsZg" },
      { name: "Technical Guruji", handle: "TechnicalGuruji", channelId: "UCOhHO2ICt0ti9KAh-QHvttQ" },
      { name: "Trakin Tech", handle: "TrakinTech", channelId: "UCEPL07qzVsOcHd3sMUws65g" },
      { name: "Hayls World", handle: "HaylsWorld", channelId: "UCIxLxlan8q9WA7sjuq6LdTQ" },
      { name: "SuperSaf", handle: "SuperSaf", channelId: "UCIrrRLyFMVmmL9NDAU2obJA" },
      { name: "TechWiser", handle: "techwiser", channelId: "UCdp6GUwjKscp5ST4M4WgIpw" },
      { name: "GadgetIn", handle: "GadgetIn", channelId: "UC1dI4tO13ApuSX0QeX8pHng" },
      { name: "Technology Gyan", handle: "TechnologyGyan", channelId: "UC1tVU8H153ZFO9eRsxdJlhA" },
      { name: "UrAvgConsumer", handle: "UrAvgConsumer", channelId: "UC9fSZHEh6XsRpX-xJc6lT3A" }
    ]);
    expect(DEFAULT_DASHBOARD_YOUTUBE_CHANNELS.length).toBeLessThanOrEqual(MAX_DASHBOARD_YOUTUBE_CHANNELS);
    expect(DEFAULT_DASHBOARD_YOUTUBE_CHANNELS).toHaveLength(54);
    expect(MAX_DASHBOARD_YOUTUBE_CHANNELS).toBe(54);
    const channelIds = DEFAULT_DASHBOARD_YOUTUBE_CHANNELS.map(({ channelId }) => channelId);
    const handles = DEFAULT_DASHBOARD_YOUTUBE_CHANNELS.map(({ handle }) => handle.toLowerCase());
    expect(channelIds.every((channelId) => /^UC[A-Za-z0-9_-]{22}$/.test(channelId ?? ""))).toBe(true);
    expect(new Set(channelIds).size).toBe(DEFAULT_DASHBOARD_YOUTUBE_CHANNELS.length);
    expect(new Set(handles).size).toBe(DEFAULT_DASHBOARD_YOUTUBE_CHANNELS.length);
  });

  it("caps an explicit YouTube roster before issuing channel or detail requests", async () => {
    const channelId = "UC1234567890123456789012";
    const configured = Array.from({ length: MAX_DASHBOARD_YOUTUBE_CHANNELS + 1 }, (_, index) => ({
      name: `Channel ${index}`,
      handle: `channel${index}`
    }));
    const requestedHandles: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input));
      if (url.hostname === "hn.algolia.com") return json({ hits: [] });
      if (url.hostname === "api.github.com" && url.pathname === "/search/repositories") return json({ items: [] });
      if (url.hostname === "api.github.com" && url.pathname === "/events") return json([]);
      if (url.hostname === "www.youtube.com" && url.pathname.endsWith("/videos")) {
        requestedHandles.push(url.pathname.split("/")[1] ?? "");
        return new Response(youtubeChannelPage(channelId, []));
      }
      throw new Error(`Unexpected request ${url}`);
    });

    const result = await discoverExternalDashboardCandidates({
      now: NOW,
      fetchImpl: fetchImpl as typeof fetch,
      youtubeChannels: configured,
      rssFeeds: [],
      researchFeeds: [],
      redditSubreddits: []
    });

    expect(requestedHandles).toEqual(configured
      .slice(0, MAX_DASHBOARD_YOUTUBE_CHANNELS)
      .map((channel) => `@${channel.handle}`));
    expect(result.failures).toHaveLength(MAX_DASHBOARD_YOUTUBE_CHANNELS);
    expect(fetchImpl).toHaveBeenCalledTimes(3 + MAX_DASHBOARD_YOUTUBE_CHANNELS);
  });

  it("bounds concurrent YouTube channel discovery on shared runner IPs", async () => {
    const configured = Array.from({ length: 9 }, (_, index) => ({
      name: `Channel ${index}`,
      handle: `channel${index}`,
      channelId: `UC${String(index).padStart(22, "0")}`
    }));
    let activeBrowseRequests = 0;
    let maxActiveBrowseRequests = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input));
      if (url.hostname === "hn.algolia.com") return json({ hits: [] });
      if (url.hostname === "api.github.com" && url.pathname === "/search/repositories") return json({ items: [] });
      if (url.hostname === "api.github.com" && url.pathname === "/events") return json([]);
      if (url.pathname === "/youtubei/v1/browse") {
        activeBrowseRequests += 1;
        maxActiveBrowseRequests = Math.max(maxActiveBrowseRequests, activeBrowseRequests);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeBrowseRequests -= 1;
        return json(youtubeUploadsBrowseResponse([]));
      }
      if (url.pathname.endsWith("/videos")) {
        return new Response(youtubeChannelPage("UC1234567890123456789012", []));
      }
      throw new Error(`Unexpected request ${url}`);
    });

    const result = await discoverExternalDashboardCandidates({
      now: NOW,
      fetchImpl: fetchImpl as typeof fetch,
      youtubeChannels: configured,
      rssFeeds: [],
      researchFeeds: [],
      redditSubreddits: []
    });

    expect(maxActiveBrowseRequests).toBe(4);
    expect(result.sources).toEqual(["github", "github_events", "hacker_news"]);
    expect(result.failures).toHaveLength(configured.length);
  });

  it("isolates one YouTube channel failure from another channel's verified candidates", async () => {
    const channelId = "UC1234567890123456789012";
    const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input));
      if (url.hostname === "hn.algolia.com") return json({ hits: [] });
      if (url.hostname === "api.github.com" && url.pathname === "/search/repositories") return json({ items: [] });
      if (url.hostname === "api.github.com" && url.pathname === "/events") return json([]);
      if (url.pathname === "/@Apple/videos") return new Response("blocked", { status: 503 });
      if (url.pathname === "/@mkbhd/videos") return new Response(youtubeChannelPage(channelId, [{
        videoId: "ngPkbaZliaU",
        title: "A concept phone",
        views: "2M views",
        relativeTime: "1 day ago"
      }]));
      if (url.pathname === "/watch" && url.searchParams.get("v") === "ngPkbaZliaU") {
        return new Response(youtubeWatchPage({
          videoId: "ngPkbaZliaU",
          channelId,
          author: "Marques Brownlee",
          title: "A concept phone",
          description: "A new smartphone hardware and software concept.",
          publishedAt: "2026-08-15T03:00:00-07:00",
          views: 2_000_000,
          likes: 10_000
        }));
      }
      throw new Error(`Unexpected request ${url}`);
    });

    const result = await discoverExternalDashboardCandidates({
      now: NOW,
      fetchImpl: fetchImpl as typeof fetch,
      youtubeChannels: [{ name: "Apple", handle: "Apple" }, { name: "MKBHD", handle: "mkbhd" }],
      rssFeeds: [],
      researchFeeds: [],
      redditSubreddits: []
    });

    expect(result.failures).toEqual(["youtube_apple_http_503"]);
    expect(result.sources).toEqual(["github", "github_events", "hacker_news", "youtube:mkbhd"]);
    expect(result.candidates).toEqual([expect.objectContaining({ id: "youtube:ngPkbaZliaU" })]);
  });

  it("maps exact official X fields and lets the strict million-view gate reject lower-reach posts", async () => {
    const requests: Array<{ url: URL; authorization: string | null }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      if (url.hostname === "api.x.com") {
        const headers = new Headers(init?.headers);
        requests.push({ url, authorization: headers.get("authorization") });
        return json({
          data: [
            {
              id: "2100000000000000001",
              author_id: "author-1",
              text: "We launched an open-source AI robotics model for developers today.",
              created_at: "2026-08-15T11:15:00.000Z",
              public_metrics: {
                impression_count: 1_500_000,
                like_count: 42_000,
                reply_count: 800,
                retweet_count: 6_000,
                quote_count: 350
              },
              attachments: { media_keys: ["media-1"] }
            },
            {
              id: "2100000000000000002",
              author_id: "author-2",
              text: "A quantum software research release for developer teams.",
              created_at: "2026-08-15T11:30:00.000Z",
              public_metrics: {
                impression_count: 999_999,
                like_count: 12_000,
                reply_count: 200,
                retweet_count: 1_000,
                quote_count: 50
              }
            }
          ],
          includes: {
            users: [
              { id: "author-1", username: "VerifiedBuilder", name: "Verified Builder" },
              { id: "author-2", username: "QuantumLab", name: "Quantum Lab" }
            ],
            media: [{ media_key: "media-1", type: "video", preview_image_url: "https://pbs.twimg.com/media/preview.jpg" }]
          }
        });
      }
      if (url.hostname === "hn.algolia.com") return json({ hits: [] });
      if (url.hostname === "api.github.com" && url.pathname === "/search/repositories") return json({ items: [] });
      if (url.hostname === "api.github.com" && url.pathname === "/events") return json([]);
      throw new Error(`Unexpected request ${url}`);
    });

    const result = await discoverExternalDashboardCandidates({
      now: NOW,
      fetchImpl: fetchImpl as typeof fetch,
      xBearerToken: "official-x-token",
      rssFeeds: [],
      researchFeeds: [],
      redditSubreddits: []
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.authorization).toBe("Bearer official-x-token");
    expect(requests[0]?.url.searchParams.get("max_results")).toBe("100");
    expect(requests[0]?.url.searchParams.get("sort_order")).toBe("relevancy");
    expect(requests[0]?.url.searchParams.has("next_token")).toBe(false);
    expect(result.sources).toEqual(["github", "github_events", "hacker_news", "x:recent-search"]);
    expect(result.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        canonicalKey: "x:post:2100000000000000001",
        url: "https://x.com/VerifiedBuilder/status/2100000000000000001",
        authorName: "Verified Builder",
        authorHandle: "VerifiedBuilder",
        sourceKind: "video",
        publishedAt: "2026-08-15T11:15:00.000Z",
        metrics: {
          views: 1_500_000,
          likes: 42_000,
          replies: 800,
          reposts: 6_000,
          quotes: 350
        },
        socialBackfillEligible: true,
        sourceVerified: true,
        sourceLinkStatus: "verified",
        publicationPrecision: "exact"
      }),
      expect.objectContaining({
        canonicalKey: "x:post:2100000000000000002",
        metrics: expect.objectContaining({ views: 999_999 })
      })
    ]));

    const snapshot = buildDashboardSnapshot(result.candidates, { now: NOW }).snapshot;
    expect(snapshot.stories).toHaveLength(1);
    expect(snapshot.stories[0]?.sources[0]).toMatchObject({
      canonicalKey: "x:post:2100000000000000001",
      metrics: { views: 1_500_000 }
    });
  });

  it("isolates an official X outage and skips the lane entirely without a bearer token", async () => {
    const requestedHosts: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input));
      requestedHosts.push(url.hostname);
      if (url.hostname === "api.x.com") return new Response("unavailable", { status: 503 });
      if (url.hostname === "hn.algolia.com") return json({ hits: [] });
      if (url.hostname === "api.github.com" && url.pathname === "/search/repositories") return json({ items: [] });
      if (url.hostname === "api.github.com" && url.pathname === "/events") return json([]);
      throw new Error(`Unexpected request ${url}`);
    });
    const options = {
      now: NOW,
      fetchImpl: fetchImpl as typeof fetch,
      rssFeeds: [],
      researchFeeds: [],
      redditSubreddits: []
    };

    const failed = await discoverExternalDashboardCandidates({ ...options, xBearerToken: "official-x-token" });
    expect(failed.failures).toEqual(["x_recent_search_http_503"]);
    expect(failed.sources).toEqual(["github", "github_events", "hacker_news"]);

    requestedHosts.length = 0;
    const absent = await discoverExternalDashboardCandidates(options);
    expect(absent.failures).toEqual([]);
    expect(absent.sources).toEqual(["github", "github_events", "hacker_news"]);
    expect(requestedHosts).not.toContain("api.x.com");
  });

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

interface InstagramNativeFeedFixturePost {
  shortcode: string;
  nativeMediaId: string;
  postedAt: string;
  plays: number | null;
  likes: number;
  comments: number;
  caption: string;
  authorUsername?: string;
}

function instagramNativeFeedPayload(
  requestedUsername: string,
  posts: InstagramNativeFeedFixturePost[]
): { user: { username: string }; items: Array<Record<string, unknown>>; num_results: number; more_available: false; next_max_id: null } {
  return {
    user: { username: requestedUsername },
    items: posts.map((post) => ({
      code: post.shortcode,
      pk: post.nativeMediaId,
      taken_at: Math.trunc(new Date(post.postedAt).getTime() / 1_000),
      user: { username: post.authorUsername ?? requestedUsername },
      media_type: 2,
      product_type: "clips",
      play_count: post.plays,
      like_count: post.likes,
      comment_count: post.comments,
      caption: { text: post.caption }
    })),
    num_results: posts.length,
    more_available: false,
    next_max_id: null
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" }
  });
}

function youtubeChannelPage(
  channelId: string,
  videos: Array<{ videoId: string; title: string; views: string; relativeTime: string }>,
  includeInnertubeConfig = false
): string {
  return youtubeChannelPageFromContents(channelId, videos.map((video) => ({
      lockupViewModel: {
        contentId: video.videoId,
        contentType: "LOCKUP_CONTENT_TYPE_VIDEO",
        metadata: {
          lockupMetadataViewModel: {
            title: { content: video.title },
            metadata: {
              contentMetadataViewModel: {
                metadataRows: [{
                  metadataParts: [
                    { text: { content: video.views } },
                    { text: { content: video.relativeTime } }
                  ]
                }]
              }
            }
          }
        }
      }
    })), includeInnertubeConfig);
}

function youtubeChannelPageFromContents(
  channelId: string,
  contents: unknown[],
  includeInnertubeConfig = false
): string {
  const innertubeConfig = includeInnertubeConfig
    ? `<script>ytcfg.set(${JSON.stringify({
      INNERTUBE_API_KEY: YOUTUBE_INNERTUBE_API_KEY,
      INNERTUBE_CLIENT_VERSION: YOUTUBE_INNERTUBE_CLIENT_VERSION
    })});</script>`
    : "";
  return `${innertubeConfig}<script>var ytInitialData = ${JSON.stringify({
    metadata: { channelMetadataRenderer: { externalId: channelId } },
    // A renderer outside the selected tab must never consume one of the two
    // bounded detail slots.
    header: { videoRenderer: { videoId: "outside0001" } },
    contents: {
      twoColumnBrowseResultsRenderer: {
        tabs: [{
          tabRenderer: {
            title: "Home",
            selected: false,
            content: { richGridRenderer: { contents: [] } }
          }
        }, {
          tabRenderer: {
            title: "Videos",
            selected: true,
            endpoint: {
              commandMetadata: { webCommandMetadata: { url: "/@channel/videos" } }
            },
            content: { richGridRenderer: { contents } }
          }
        }]
      }
    }
  })};</script>`;
}

function youtubePlayerResponse(input: {
  videoId: string;
  channelId: string;
  author: string;
  title: string;
  description: string;
  publishedAt: string;
  publishDate?: string;
  uploadDate?: string;
  views: number;
}): unknown {
  return {
    videoDetails: {
      videoId: input.videoId,
      channelId: input.channelId,
      author: input.author,
      title: input.title,
      shortDescription: input.description,
      viewCount: String(input.views)
    },
    microformat: {
      playerMicroformatRenderer: {
        publishDate: input.publishDate ?? input.publishedAt,
        uploadDate: input.uploadDate ?? input.publishedAt
      }
    }
  };
}

function youtubeUploadsBrowseResponse(videoIds: string[]): unknown {
  return {
    contents: {
      twoColumnBrowseResultsRenderer: {
        tabs: [{
          tabRenderer: {
            selected: true,
            content: {
              sectionListRenderer: {
                contents: videoIds.map((videoId) => ({
                  playlistVideoRenderer: { videoId }
                }))
              }
            }
          }
        }]
      }
    }
  };
}

function youtubeSearchPage(videoIds: string[]): string {
  return `<script>var ytInitialData = ${JSON.stringify(youtubeSearchResponse(videoIds))};</script>`;
}

function youtubeSearchResponse(videoIds: string[]): unknown {
  return {
    contents: {
      twoColumnSearchResultsRenderer: {
        primaryContents: {
          sectionListRenderer: {
            contents: [{
              itemSectionRenderer: {
                contents: videoIds.map((videoId) => ({ videoRenderer: { videoId } }))
              }
            }]
          }
        }
      }
    }
  };
}

function youtubeWatchPage(input: {
  videoId: string;
  channelId: string;
  author: string;
  title: string;
  description: string;
  publishedAt: string;
  publishDate?: string;
  uploadDate?: string;
  views: number;
  likes: number;
}): string {
  return `<script>var ytInitialPlayerResponse = ${JSON.stringify({
    videoDetails: {
      videoId: input.videoId,
      channelId: input.channelId,
      author: input.author,
      title: input.title,
      shortDescription: input.description,
      viewCount: String(input.views)
    },
    microformat: {
      playerMicroformatRenderer: {
        publishDate: input.publishDate ?? input.publishedAt,
        uploadDate: input.uploadDate ?? input.publishedAt
      }
    },
    likeCount: String(input.likes)
  })};</script>`;
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
