import { getDemoYcBatch } from "./yc-demo";
import {
  batchSlugToLabel,
  normalizeBatchSlug,
  parseYcCompaniesFromHtml,
  parseYcFallbackResults,
  sourceEvidence
} from "./yc-parser";
import type {
  YcBatchFetchOptions,
  YcBatchResult,
  YcSearchProvider,
  YcSearchResult
} from "./types";

export const YC_SPRING_2026_EXPECTED_COMPANY_COUNT = 197;

interface YcBatchAdapterOptions {
  fetchImpl?: typeof fetch;
  searchProvider?: YcSearchProvider;
  officialDirectoryUrlBuilder?: (batchSlug: string) => string;
}

export class YcBatchAdapter {
  private readonly fetchImpl: typeof fetch;
  private readonly searchProvider?: YcSearchProvider;
  private readonly officialDirectoryUrlBuilder: (batchSlug: string) => string;

  constructor(options: YcBatchAdapterOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.searchProvider = options.searchProvider;
    this.officialDirectoryUrlBuilder = options.officialDirectoryUrlBuilder ?? buildOfficialYcDirectoryUrl;
  }

  async fetchBatch(batchSlugInput: string, options: YcBatchFetchOptions = {}): Promise<YcBatchResult> {
    const batchSlug = normalizeBatchSlug(batchSlugInput);
    if (options.demo) {
      return getDemoYcBatch(batchSlug, options.maxCompanies);
    }

    const warnings: string[] = [];
    const officialUrl = this.officialDirectoryUrlBuilder(batchSlug);
    try {
      const response = await this.fetchImpl(officialUrl, {
        headers: { "User-Agent": "yc-network-intelligence-readonly" },
        signal: options.signal
      });
      if (response.ok) {
        const html = await response.text();
        const companies = parseYcCompaniesFromHtml(html, batchSlug, officialUrl);
        if (companies.length > 0) {
          const selectedCompanies = applyMaxCompanies(companies, options.maxCompanies);
          const countValidation = validateExpectedCompanyCount(batchSlug, selectedCompanies.length, options.maxCompanies);
          return {
            batchSlug,
            label: batchSlugToLabel(batchSlug),
            mode: "official",
            companies: selectedCompanies,
            expectedCompanyCount: countValidation.expectedCompanyCount,
            observedCompanyCount: selectedCompanies.length,
            sources: [sourceEvidence({ url: officialUrl, title: "YC company directory", sourceReliability: "high" })],
            warnings: [...warnings, ...countValidation.warnings]
          };
        }
        warnings.push("Official YC directory loaded but no company records were parsed.");
      } else {
        warnings.push(`Official YC directory returned HTTP ${response.status}.`);
      }
    } catch (error) {
      warnings.push(`Official YC directory fetch failed: ${error instanceof Error ? error.message : "unknown error"}.`);
    }

    const fallbackResults = await this.fetchFallbackSearchResults(batchSlug, options);
    const fallbackCompanies = parseYcFallbackResults(fallbackResults, batchSlug);
    const selectedFallbackCompanies = applyMaxCompanies(fallbackCompanies, options.maxCompanies);
    const countValidation = validateExpectedCompanyCount(
      batchSlug,
      selectedFallbackCompanies.length,
      options.maxCompanies
    );
    return {
      batchSlug,
      label: batchSlugToLabel(batchSlug),
      mode: "fallback",
      companies: selectedFallbackCompanies,
      expectedCompanyCount: countValidation.expectedCompanyCount,
      observedCompanyCount: selectedFallbackCompanies.length,
      sources: fallbackResults.map((result) =>
        sourceEvidence({
          url: result.url,
          title: result.title,
          snippet: result.snippet,
          sourceReliability: result.url.includes("ycombinator.com/companies") ? "medium" : "low"
        })
      ),
      warnings: [
        ...warnings,
        fallbackResults.length === 0
          ? "No fallback search provider/results available; batch ingestion returned an empty fallback shape."
          : "Fallback search results require review before canonical use.",
        ...countValidation.warnings
      ]
    };
  }

  buildFallbackQueries(batchSlugInput: string): string[] {
    const batchSlug = normalizeBatchSlug(batchSlugInput);
    const label = batchSlugToLabel(batchSlug);
    return [
      `site:ycombinator.com/companies "${label}" "Y Combinator"`,
      `"YC ${batchSlug}" startup founder`,
      `"Y Combinator ${label}" company founder`
    ];
  }

  private async fetchFallbackSearchResults(
    batchSlug: string,
    options: YcBatchFetchOptions
  ): Promise<YcSearchResult[]> {
    if (!this.searchProvider) return [];
    const queries = this.buildFallbackQueries(batchSlug);
    const batches = await Promise.all(
      queries.map((query) => this.searchProvider?.search(query, { limit: 10, signal: options.signal }) ?? [])
    );
    const seen = new Set<string>();
    return batches.flat().filter((result) => {
      if (seen.has(result.url)) return false;
      seen.add(result.url);
      return true;
    });
  }
}

export function buildOfficialYcDirectoryUrl(batchSlugInput: string): string {
  const batchSlug = normalizeBatchSlug(batchSlugInput);
  return `https://www.ycombinator.com/companies?batch=${encodeURIComponent(batchSlug)}`;
}

function applyMaxCompanies<T>(companies: T[], maxCompanies?: number): T[] {
  return typeof maxCompanies === "number" ? companies.slice(0, Math.max(0, maxCompanies)) : companies;
}

export function expectedCompanyCountForBatch(batchSlugInput: string): number | null {
  return normalizeBatchSlug(batchSlugInput) === "S2026" ? YC_SPRING_2026_EXPECTED_COMPANY_COUNT : null;
}

function validateExpectedCompanyCount(
  batchSlugInput: string,
  observedCompanyCount: number,
  maxCompanies?: number
): { expectedCompanyCount: number | null; warnings: string[] } {
  const batchSlug = normalizeBatchSlug(batchSlugInput);
  const expectedCompanyCount = expectedCompanyCountForBatch(batchSlug);

  if (expectedCompanyCount === null || typeof maxCompanies === "number") {
    return { expectedCompanyCount, warnings: [] };
  }

  if (observedCompanyCount === expectedCompanyCount) {
    return { expectedCompanyCount, warnings: [] };
  }

  return {
    expectedCompanyCount,
    warnings: [
      `Expected ${expectedCompanyCount} companies for YC Spring 2026 (${batchSlug}); parsed ${observedCompanyCount}.`
    ]
  };
}
