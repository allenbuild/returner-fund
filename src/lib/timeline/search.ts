import { canonicalizeSourceUrl } from "./source-document";

export interface TimelineSearchQuery {
  query: string;
  companyId: string;
  limit?: number;
  recencyDays?: number;
}

export interface TimelineSearchResult {
  title: string;
  url: string;
  snippet: string | null;
  publishedAt: string | null;
  provider: string;
  /** Search output is discovery-only until the page itself is safely fetched. */
  evidenceRole: "discovery_only";
}

export interface TimelineSearchProvider {
  readonly id: string;
  search(query: TimelineSearchQuery, signal?: AbortSignal): Promise<TimelineSearchResult[]>;
}

abstract class HttpSearchProvider implements TimelineSearchProvider {
  abstract readonly id: string;
  protected readonly apiKey: string;
  protected readonly fetchImpl: typeof fetch;
  constructor(apiKey: string, fetchImpl: typeof fetch = fetch) {
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }
  abstract search(query: TimelineSearchQuery, signal?: AbortSignal): Promise<TimelineSearchResult[]>;

  protected safeLimit(value: number | undefined): number {
    return Math.min(Math.max(value ?? 10, 1), 20);
  }

  protected result(title: unknown, url: unknown, snippet: unknown, publishedAt: unknown): TimelineSearchResult | null {
    if (typeof title !== "string" || typeof url !== "string") return null;
    try {
      return {
        title: title.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300),
        url: canonicalizeSourceUrl(url),
        snippet: typeof snippet === "string" ? snippet.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 600) : null,
        publishedAt: typeof publishedAt === "string" ? publishedAt : null,
        provider: this.id,
        evidenceRole: "discovery_only",
      };
    } catch {
      return null;
    }
  }
}

export class BraveTimelineSearchProvider extends HttpSearchProvider {
  readonly id = "brave";

  async search(query: TimelineSearchQuery, signal?: AbortSignal): Promise<TimelineSearchResult[]> {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query.query);
    url.searchParams.set("count", String(this.safeLimit(query.limit)));
    if (query.recencyDays && query.recencyDays <= 31) url.searchParams.set("freshness", `pd${Math.max(1, query.recencyDays)}`);
    const response = await this.fetchImpl(url, {
      signal,
      headers: { Accept: "application/json", "X-Subscription-Token": this.apiKey },
    });
    if (!response.ok) throw new Error(`Brave timeline search failed (${response.status}).`);
    const json = await response.json() as { web?: { results?: Array<Record<string, unknown>> } };
    return (json.web?.results ?? []).map((item) =>
      this.result(item.title, item.url, item.description, item.page_age)
    ).filter((item): item is TimelineSearchResult => item !== null);
  }
}

export class SerperTimelineSearchProvider extends HttpSearchProvider {
  readonly id = "serper";

  async search(query: TimelineSearchQuery, signal?: AbortSignal): Promise<TimelineSearchResult[]> {
    const response = await this.fetchImpl("https://google.serper.dev/search", {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json", "X-API-KEY": this.apiKey },
      body: JSON.stringify({ q: query.query, num: this.safeLimit(query.limit) }),
    });
    if (!response.ok) throw new Error(`Serper timeline search failed (${response.status}).`);
    const json = await response.json() as { organic?: Array<Record<string, unknown>> };
    return (json.organic ?? []).map((item) =>
      this.result(item.title, item.link, item.snippet, item.date)
    ).filter((item): item is TimelineSearchResult => item !== null);
  }
}

export class TavilyTimelineSearchProvider extends HttpSearchProvider {
  readonly id = "tavily";

  async search(query: TimelineSearchQuery, signal?: AbortSignal): Promise<TimelineSearchResult[]> {
    const response = await this.fetchImpl("https://api.tavily.com/search", {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: this.apiKey,
        query: query.query,
        max_results: this.safeLimit(query.limit),
        search_depth: "basic",
        include_raw_content: false,
      }),
    });
    if (!response.ok) throw new Error(`Tavily timeline search failed (${response.status}).`);
    const json = await response.json() as { results?: Array<Record<string, unknown>> };
    return (json.results ?? []).map((item) =>
      this.result(item.title, item.url, item.content, item.published_date)
    ).filter((item): item is TimelineSearchResult => item !== null);
  }
}

export class ExaTimelineSearchProvider extends HttpSearchProvider {
  readonly id = "exa";

  async search(query: TimelineSearchQuery, signal?: AbortSignal): Promise<TimelineSearchResult[]> {
    const response = await this.fetchImpl("https://api.exa.ai/search", {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json", "x-api-key": this.apiKey },
      body: JSON.stringify({
        query: query.query,
        numResults: this.safeLimit(query.limit),
        type: "auto",
        contents: { text: { maxCharacters: 600 } },
        ...(query.recencyDays ? {
          startPublishedDate: new Date(Date.now() - Math.max(1, query.recencyDays) * 86_400_000).toISOString(),
        } : {}),
      }),
    });
    if (!response.ok) throw new Error(`Exa timeline search failed (${response.status}).`);
    const json = await response.json() as { results?: Array<Record<string, unknown>> };
    return (json.results ?? []).map((item) =>
      this.result(item.title, item.url, item.text, item.publishedDate)
    ).filter((item): item is TimelineSearchResult => item !== null);
  }
}

export function createConfiguredTimelineSearchProviders(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): TimelineSearchProvider[] {
  const providers: TimelineSearchProvider[] = [];
  const brave = clean(env.BRAVE_SEARCH_API_KEY);
  const serper = clean(env.SERPER_API_KEY);
  const tavily = clean(env.TAVILY_API_KEY);
  const exa = clean(env.EXA_API_KEY);
  // Prefer the already deployed Exa credential, then append any explicitly
  // configured alternatives. Callers own per-provider budgets and failover.
  if (exa) providers.push(new ExaTimelineSearchProvider(exa, fetchImpl));
  if (brave) providers.push(new BraveTimelineSearchProvider(brave, fetchImpl));
  if (serper) providers.push(new SerperTimelineSearchProvider(serper, fetchImpl));
  if (tavily) providers.push(new TavilyTimelineSearchProvider(tavily, fetchImpl));
  return providers;
}

function clean(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized || null;
}
