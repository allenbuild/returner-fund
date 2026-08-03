import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  fetchSafeTimelineSource,
  isPrivateOrReservedAddress,
} from "@/lib/timeline/safe-fetch";
import {
  canonicalizeSourceUrl,
  normalizeSourceDocument,
} from "@/lib/timeline/source-document";
import { discoverTimelineDirectSources, discoverTimelineWebSources } from "@/lib/timeline/discovery";

describe("timeline source normalization", () => {
  it("canonicalizes tracking URLs deterministically", () => {
    expect(canonicalizeSourceUrl("HTTPS://Example.COM:443/news/?utm_source=x&b=2&a=1#section"))
      .toBe("https://example.com/news?a=1&b=2");
  });

  it.each([
    "http://localhost/source",
    "https://127.0.0.1/source",
    "https://10.0.0.1/source",
    "https://[::1]/source",
    "https://metadata.google.internal/latest/meta-data",
  ])("rejects local or reserved source URLs: %s", (url) => {
    expect(() => canonicalizeSourceUrl(url)).toThrow(/Blocked|private|reserved/i);
  });

  it("recursively removes secret-bearing metadata keys", () => {
    const normalized = normalizeSourceDocument({
      originalUrl: "https://example.com/announcement",
      title: "Announcement",
      sourceType: "company_page",
      fetchedAt: "2026-08-02T00:00:00.000Z",
      discoveryMethod: "official_site",
      sourceQualityTier: 1,
      metadata: {
        safe: "kept",
        nested: {
          authorization: "Bearer secret",
          child: [{ api_key: "secret" }, { publicValue: "kept" }],
        },
      },
    });
    expect(normalized.metadata).toEqual({
      safe: "kept",
      nested: { child: [{}, { publicValue: "kept" }] },
    });
  });
});

describe("timeline safe fetch", () => {
  it.each([
    "fe90::1",
    "fec0::1",
    "ff02::1",
    "::ffff:7f00:1",
    "2001:db8::1",
    "3fff::1",
    "198.51.100.1",
    "203.0.113.1",
  ])("rejects private or reserved address range %s", (address) => {
    expect(isPrivateOrReservedAddress(address)).toBe(true);
  });

  it.each(["93.184.216.34", "2606:4700:4700::1111"])("allows globally routable address %s", (address) => {
    expect(isPrivateOrReservedAddress(address)).toBe(false);
  });

  it("fails closed when DNS changes between validation and connection", async () => {
    const resolveAddresses = vi.fn()
      .mockResolvedValueOnce(["93.184.216.34"])
      .mockResolvedValueOnce(["127.0.0.1"]);
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(fetchSafeTimelineSource("https://example.com/source", {
      resolveAddresses,
      fetchImpl,
    })).rejects.toThrow(/DNS changed/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("passes only validated public addresses to a pin-capable transport", async () => {
    const pinnedFetchImpl = vi.fn(async (url: URL, addresses: readonly string[]) => {
      expect(url.hostname).toBe("example.com");
      expect(addresses).toEqual(["93.184.216.34"]);
      return new Response("source", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    });
    const result = await fetchSafeTimelineSource("https://example.com/source", {
      resolveAddresses: async () => ["93.184.216.34"],
      pinnedFetchImpl,
    });
    expect(result.body).toBe("source");
    expect(pinnedFetchImpl).toHaveBeenCalledOnce();
  });

  it.each([404, 429, 500])("rejects HTTP %i error pages before they can become evidence", async (status) => {
    await expect(fetchSafeTimelineSource("https://example.com/source", {
      resolveAddresses: async () => ["93.184.216.34"],
      pinnedFetchImpl: async () => new Response("<title>Acme launch</title>", {
        status,
        headers: { "content-type": "text/html" },
      }),
    })).rejects.toThrow(new RegExp(`HTTP ${status}`));
  });

  it("keeps the timeout active until the complete response body is consumed", async () => {
    vi.useFakeTimers();
    try {
      const request = fetchSafeTimelineSource("https://example.com/source", {
        timeoutMs: 1_000,
        resolveAddresses: async () => ["93.184.216.34"],
        pinnedFetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
          pull() {
            return new Promise(() => undefined);
          },
        }), {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      });
      const rejection = expect(request).rejects.toThrow(/abort/i);
      await vi.advanceTimersByTimeAsync(1_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("shares one hard deadline across redirects instead of resetting the budget", async () => {
    const startedAt = Date.now();
    await expect(fetchSafeTimelineSource("https://example.com/source", {
      timeoutMs: 1_000,
      deadlineAt: startedAt + 80,
      resolveAddresses: async () => ["93.184.216.34"],
      pinnedFetchImpl: async (_url, _addresses, init) => new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response(null, {
          status: 302,
          headers: { location: "/next" },
        })), 50);
        const signal = init.signal;
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason ?? new DOMException("aborted", "AbortError"));
        }, { once: true });
      }),
    })).rejects.toThrow(/abort|deadline/i);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it("cancels an unread redirect body before following Location", async () => {
    let cancelled = false;
    let calls = 0;
    const result = await fetchSafeTimelineSource("https://example.com/source", {
      resolveAddresses: async () => ["93.184.216.34"],
      pinnedFetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(new ReadableStream<Uint8Array>({
            cancel() { cancelled = true; },
          }), {
            status: 302,
            headers: { location: "/final" },
          });
        }
        return new Response("source", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      },
    });
    expect(result.finalUrl).toBe("https://example.com/final");
    expect(cancelled).toBe(true);
  });
});

describe("timeline web discovery identity", () => {
  it("follows only bounded same-domain announcement links from an official seed page", async () => {
    const fetched: string[] = [];
    const result = await discoverTimelineDirectSources({
      id: "company-acme", slug: "acme", name: "Acme", aliases: ["Acme"],
      websiteUrl: "https://acme.example", founderNames: [],
    }, ["https://acme.example"], {
      discoveryMethod: "official_site",
      maxUrls: 1,
      followInternalLinks: 2,
      fetchPage: async (url) => {
        fetched.push(url);
        if (url === "https://acme.example/") {
          return {
            originalUrl: url, finalUrl: url, status: 200, contentType: "text/html",
            body: "<html><head><title>Acme</title></head><body><a href='/blog/launch'>Launch news</a><a href='https://attacker.example/blog/acme'>Press</a><a href='/privacy'>Privacy</a></body></html>",
            fetchedAt: NOW, redirects: [],
          };
        }
        return {
          originalUrl: url, finalUrl: url, status: 200, contentType: "text/html",
          body: "<html><head><title>Acme launched publicly</title><meta property='article:published_time' content='2026-08-02T12:00:00Z'></head><body><main>Acme launched its public product for development teams today.</main></body></html>",
          fetchedAt: NOW, redirects: [],
        };
      },
    });

    expect(fetched).toEqual(["https://acme.example/", "https://acme.example/blog/launch"]);
    expect(result.sources).toHaveLength(1);
    expect(result.discoveredUrls).toBe(2);
  });

  it("retains accelerator profiles as tier-one institutional evidence", async () => {
    const result = await discoverTimelineDirectSources({
      id: "company-acme", slug: "acme", name: "Acme", aliases: ["Acme"],
      websiteUrl: "https://acme.example", founderNames: [],
    }, ["https://www.ycombinator.com/companies/acme"], {
      discoveryMethod: "institutional_profile",
      sourceType: "accelerator_profile",
      sourceQualityTier: 1,
      fetchPage: async (url) => ({
        originalUrl: url, finalUrl: url, status: 200, contentType: "text/html",
        body: "<html><head><title>Acme: Y Combinator</title><time datetime='2026-08-02'></time></head><body><main>Acme joined Y Combinator S26 to launch its product.</main></body></html>",
        fetchedAt: "2026-08-02T13:00:00Z", redirects: [],
      }),
    });

    expect(result.sources[0]).toMatchObject({
      sourceType: "accelerator_profile",
      sourceQualityTier: 1,
      publicationTimestamp: "2026-08-02T00:00:00.000Z",
    });
  });

  it("does not retain a result where a short company name is only a claimant substring", async () => {
    const result = await discoverTimelineWebSources({
      id: "company-ara",
      slug: "ara",
      name: "Ara",
      aliases: ["Ara"],
      websiteUrl: "https://ara.example",
      founderNames: [],
    }, {
      providers: [{
        id: "test-search",
        async search() {
          return [{
            title: "Paragon funding",
            url: "https://news.example/paragon-funding",
            snippet: "Paragon raised a seed round.",
            publishedAt: "2026-08-02",
            provider: "test-search",
            evidenceRole: "discovery_only" as const,
          }];
        },
      }],
      maxQueries: 1,
      maxResultsPerQuery: 1,
      maxFetchedPages: 1,
      fetchPage: async (url) => ({
        originalUrl: url,
        finalUrl: url,
        status: 200,
        contentType: "text/html",
        body: "<html><head><title>Paragon raised a $12M seed round</title><meta property='article:published_time' content='2026-08-02T12:00:00Z'></head><body><main>Paragon raised a $12M seed round to expand its product.</main></body></html>",
        fetchedAt: "2026-08-02T13:00:00Z",
        redirects: [],
      }),
    });

    expect(result.sources).toEqual([]);
    expect(result.status).toBe("no_results");
  });
});

const NOW = "2026-08-02T13:00:00.000Z";
