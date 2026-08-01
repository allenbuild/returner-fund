import { NextResponse } from "next/server";
import { z } from "zod";
import {
  applyBenchmarkMomentumRows,
  benchmarkStoreVersion,
  ensureBenchmarkMomentum,
  inheritCanonicalCompanyScoring
} from "@/lib/graph/benchmarks";
import { applyClientGraphFilters } from "@/lib/graph/client-filters";
import {
  COMPANY_VERTICALS,
  isCompanyVertical,
  type CompanyVertical
} from "@/lib/graph/company-verticals";
import { buildGraphResponse } from "@/lib/graph/graph-builder";
import { enrichGraphTaxonomies } from "@/lib/graph/graph-taxonomies";
import {
  getOrBuildCachedGraphResponse,
  type GraphResponseCacheScope
} from "@/lib/graph/graph-response-cache";
import { datasetWithLiveEvidence, liveEvidenceCacheVersion } from "@/lib/graph/live-evidence-dataset";
import { overlayLiveEvidenceOnGraph } from "@/lib/graph/live-evidence-overlay";
import { personalizeInsiderGraphSnapshot } from "@/lib/graph/personalized-insider-snapshot";
import { POST_TOPIC_SLUGS, normalizePostTopic, type PostTopic } from "@/lib/graph/post-topics";
import { sanitizeGraphResponse } from "@/lib/graph/response-sanitizer";
import { enrichSummerPlatformStatus } from "@/lib/graph/summer-platform-status";
import { loadLiveEvidenceRecords } from "@/lib/ingestion/live-source-refresh";
import { centralDayKey, millisecondsUntilNextCentralMidnight } from "@/lib/time/central-day";
import { YC_SPRING_2026_BATCH_SLUG, yc2026GraphDataset } from "@/lib/graph/yc-spring-2026-dataset";
import type { BusinessModel, EdgeType, Platform, TopVoiceAudienceId } from "@/lib/graph/types";
import {
  effectiveInsiderMembers,
  emptyInsiderConfiguration,
  type UserInsiderConfiguration
} from "@/lib/social/user-insiders";
import {
  authenticateInsiderRequest,
  loadUserInsiderConfiguration
} from "@/lib/social/user-insiders-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const platforms = [
  "github",
  "x",
  "linkedin",
  "instagram",
  "product_hunt",
  "youtube",
  "rss",
  "web",
  "reddit",
  "hacker_news",
  "bilibili",
  "tiktok",
  "bluesky"
] as const satisfies readonly Platform[];

const edgeTypes = [
  "founder_of",
  "industry_similarity",
  "same_group_partner",
  "top_voice_attention"
] as const satisfies readonly EdgeType[];
const businessModels = [
  "b2b",
  "consumer",
  "fintech",
  "healthcare",
  "industrial",
  "developer_tools",
  "api",
  "hardware",
  "open_source",
  "services",
  "marketplace"
] as const satisfies readonly BusinessModel[];
const topVoiceAudiences = ["off", "yc_partners", "insiders"] as const satisfies readonly TopVoiceAudienceId[];

const GRAPH_RESPONSE_CACHE_TTL_MS = 60_000;
const DEFAULT_BATCH_SLUG = YC_SPRING_2026_BATCH_SLUG;
const MAX_FILTER_VALUES = 64;
const batchSlugs = new Set(yc2026GraphDataset.batches.map((batch) => batch.slug));
const commaSeparatedValuesSchema = z.string().transform((value) =>
  value.split(",").map((item) => item.trim())
);
const platformListSchema = commaSeparatedValuesSchema.pipe(
  z
    .array(z.enum(platforms))
    .min(1)
    .max(platforms.length)
    .refine((values) => new Set(values).size === values.length, { message: "Values must be unique." })
);
const edgeTypeListSchema = commaSeparatedValuesSchema.pipe(
  z
    .array(z.enum(edgeTypes))
    .min(1)
    .max(edgeTypes.length)
    .refine((values) => new Set(values).size === values.length, { message: "Values must be unique." })
);
const businessModelListSchema = commaSeparatedValuesSchema.pipe(
  z
    .array(z.enum(businessModels))
    .min(1)
    .max(businessModels.length)
    .refine((values) => new Set(values).size === values.length, { message: "Values must be unique." })
);
const postTopicSchema = z.string().transform((value, context): PostTopic => {
  const normalized = normalizePostTopic(value);
  if (!normalized) {
    context.addIssue({
      code: "custom",
      message: `Must be one of: ${POST_TOPIC_SLUGS.join(", ")}.`
    });
    return z.NEVER;
  }
  return normalized;
});
const companyVerticalSchema = z.custom<CompanyVertical>(
  (value) => typeof value === "string" && isCompanyVertical(value),
  { message: `Must be one of: ${COMPANY_VERTICALS.map(({ slug }) => slug).join(", ")}.` }
);
const topicListSchema = commaSeparatedValuesSchema.pipe(
  z
    .array(postTopicSchema)
    .min(1)
    .max(POST_TOPIC_SLUGS.length)
    .refine((values) => new Set(values).size === values.length, { message: "Values must be unique." })
);
const verticalListSchema = commaSeparatedValuesSchema.pipe(
  z
    .array(companyVerticalSchema)
    .min(1)
    .max(COMPANY_VERTICALS.length)
    .refine((values) => new Set(values).size === values.length, { message: "Values must be unique." })
);
const looseListSchema = commaSeparatedValuesSchema.pipe(
  z
    .array(z.string().min(1).max(120))
    .min(1)
    .max(MAX_FILTER_VALUES)
    .refine((values) => new Set(values).size === values.length, { message: "Values must be unique." })
);
const booleanQuerySchema = z.enum(["0", "1", "false", "true"]).transform((value) =>
  value === "1" || value === "true"
);
const minScoreSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value) => Number(value))
  .pipe(z.number().finite().min(0).max(100));
const graphQuerySchema = z.object({
  batch: z
    .string()
    .trim()
    .min(1)
    .refine((value) => batchSlugs.has(value), {
      message: `Must be one of: ${[...batchSlugs].join(", ")}.`
    })
    .default(DEFAULT_BATCH_SLUG),
  platforms: platformListSchema.optional(),
  edgeTypes: edgeTypeListSchema.optional(),
  minScore: minScoreSchema.optional(),
  industries: looseListSchema.optional(),
  groupPartners: looseListSchema.optional(),
  topics: topicListSchema.optional(),
  verticals: verticalListSchema.optional(),
  businessModels: businessModelListSchema.optional(),
  q: z.string().trim().min(1).max(200).optional(),
  topVoices: z.enum(topVoiceAudiences).default("off"),
  insiderIds: looseListSchema.optional(),
  includeRaw: booleanQuerySchema.default(false),
  includeNonScoring: booleanQuerySchema.default(false),
  includeWhy: booleanQuerySchema.default(false)
}).strict().superRefine((query, context) => {
  if (query.insiderIds?.length && query.topVoices !== "insiders") {
    context.addIssue({
      code: "custom",
      path: ["insiderIds"],
      message: "Individual insiders can only be selected when Top Voices is set to insiders."
    });
  }
});

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const parsedQuery = graphQuerySchema.safeParse(graphQueryInput(params));
  if (!parsedQuery.success) {
    return invalidQueryResponse(parsedQuery.error);
  }

  const query = parsedQuery.data;
  const batchSlug = query.batch;
  const dataset = yc2026GraphDataset;
  const includeRaw = query.includeRaw;
  const includeNonScoring = query.includeNonScoring;
  const includeWhy = query.includeWhy;
  const filters = {
    batchSlug,
    platforms: query.platforms,
    edgeTypes: query.edgeTypes,
    minScore: query.minScore,
    industries: query.industries,
    groupPartners: query.groupPartners,
    topics: query.topics,
    verticals: query.verticals,
    businessModels: query.businessModels,
    query: query.q,
    topVoices: query.topVoices,
    insiderIds: query.insiderIds
  };
  let insiderMembers: ReturnType<typeof effectiveInsiderMembers> | undefined;
  let insiderConfigurationCacheKey = "built-in";
  let hasPersonalizedInsiderConfiguration = false;
  let insiderConfiguration: UserInsiderConfiguration = emptyInsiderConfiguration();
  if (query.topVoices === "insiders") {
    const authenticated = await authenticateInsiderRequest(request);
    if (authenticated) {
      try {
        insiderConfiguration = await loadUserInsiderConfiguration(authenticated.client, authenticated.userId);
        insiderMembers = effectiveInsiderMembers(insiderConfiguration);
        insiderConfigurationCacheKey = `${authenticated.userId}:${insiderConfiguration.version}`;
        hasPersonalizedInsiderConfiguration = true;
      } catch (error) {
        console.error("Personalized Insiders configuration load failed", error);
        return NextResponse.json(
          { error: { code: "insider_configuration_load_failed", message: "Your private Insiders list could not be loaded." } },
          { status: 500, headers: { "Cache-Control": "private, no-store, max-age=0" } }
        );
      }
    }
    insiderMembers ??= effectiveInsiderMembers({
      excludedDefaultIds: [],
      weightOverrides: {},
      addedInsiders: []
    });
    const enabledIds = new Set(insiderMembers.map((member) => member.personId));
    const unknownSelection = (query.insiderIds ?? []).find((personId) => !enabledIds.has(personId));
    if (unknownSelection) {
      return NextResponse.json(
        {
          error: {
            code: "invalid_insider_selection",
            message: `${unknownSelection} is not an enabled insider.`
          }
        },
        { status: 400, headers: { "Cache-Control": "private, no-store, max-age=0" } }
      );
    }
  }
  let liveEvidence: Awaited<ReturnType<typeof loadLiveEvidenceRecords>>;
  try {
    liveEvidence = await loadLiveEvidenceRecords();
  } catch (error) {
    if (isMissingLiveEvidenceSnapshotError(error)) {
      liveEvidence = [];
    } else {
      console.error("Graph live evidence overlay load failed", error);
      return liveEvidenceReloadFailureResponse();
    }
  }
  const now = new Date();
  const cacheKey = JSON.stringify({
    filters,
    includeRaw,
    includeNonScoring,
    includeWhy,
    dataset: "yc-2026-official",
    benchmarkCentralDay: centralDayKey(now),
    benchmarkStore: benchmarkStoreVersion(batchSlug),
    liveEvidence: liveEvidenceCacheVersion(liveEvidence),
    insiderConfiguration: insiderConfigurationCacheKey
  });
  const cacheTtlMs = Math.min(
    GRAPH_RESPONSE_CACHE_TTL_MS,
    millisecondsUntilNextCentralMidnight(now)
  );
  const cacheScope = {
    batchSlug,
    topVoices: filters.topVoices
  } satisfies GraphResponseCacheScope;
  const graph = await getOrBuildCachedGraphResponse({
    cacheKey,
    ttlMs: cacheTtlMs,
    scope: cacheScope,
    build: () => {
      const baseGraph = buildGraphResponse({ batchSlug, topVoices: "off" }, dataset);
      const liveBaseGraph = overlayLiveEvidenceOnGraph(baseGraph, liveEvidence, {
        topVoices: "off",
        calibrationCohort: dataset.companies.filter((company) => company.batchSlug === batchSlug)
      }).graph;
      let canonicalGraph = liveBaseGraph;
      try {
        const benchmarkRows = ensureBenchmarkMomentum(liveBaseGraph).graph.fastestGaining;
        canonicalGraph = applyBenchmarkMomentumRows(liveBaseGraph, benchmarkRows);
      } catch (error) {
        console.error("Graph benchmark momentum failed; returning graph without persisted benchmark deltas", error);
      }
      const graphForAudience = filters.topVoices === "off"
        ? canonicalGraph
        : (() => {
            const selectedInsiderIds = query.insiderIds ?? [];
            const inherited = inheritCanonicalCompanyScoring(
              buildGraphResponse(
                {
                  batchSlug,
                  topVoices: filters.topVoices
                },
                datasetWithLiveEvidence(dataset, liveEvidence)
              ),
              canonicalGraph
            );
            if (filters.topVoices !== "insiders") return inherited;
            // The unauthenticated, unfiltered Insiders graph is a canonical
            // audience slice used by the static daily benchmark publisher. It
            // must keep the all-platform company scores it inherited above.
            // Personalized configurations and explicit member selections are
            // scenarios, so those are dynamically rescored.
            if (!hasPersonalizedInsiderConfiguration && selectedInsiderIds.length === 0) {
              return inherited;
            }
            return personalizeInsiderGraphSnapshot({
              insiderGraph: inherited,
              baseGraph: canonicalGraph,
              configuration: insiderConfiguration,
              selectedInsiderIds
            });
          })();
      const filteredGraph = applyClientGraphFilters(enrichGraphTaxonomies(graphForAudience), {
        platforms: filters.platforms ?? [],
        industries: filters.industries ?? [],
        groupPartners: filters.groupPartners ?? [],
        topics: filters.topics ?? [],
        verticals: filters.verticals ?? [],
        minScore: filters.minScore ?? 0,
        businessModels: filters.businessModels ?? [],
        edgeTypes: filters.edgeTypes ?? [],
        query: filters.query
      });
      return enrichSummerPlatformStatus(
        sanitizeGraphResponse(filteredGraph, {
          includeRaw,
          includeNonScoring,
          includeWhy
        })
      );
    }
  });

  return noStoreJson(graph);
}

function noStoreJson(body: unknown) {
  return NextResponse.json(body, {
    headers: {
      "Cache-Control": "no-store, max-age=0"
    }
  });
}

function liveEvidenceReloadFailureResponse() {
  return NextResponse.json(
    {
      status: "failed",
      logs: [],
      errors: [
        "Persisted live evidence could not be reloaded, so the graph was not generated without it."
      ],
      error: { code: "live_evidence_reload_failed" }
    },
    {
      status: 500,
      headers: {
        "Cache-Control": "no-store, max-age=0"
      }
    }
  );
}

function isMissingLiveEvidenceSnapshotError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function graphQueryInput(params: URLSearchParams): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const name of new Set(params.keys())) {
    const values = params.getAll(name);
    if (values.length === 1) {
      input[name] = values[0];
    } else if (values.length > 1) {
      input[name] = values;
    }
  }
  return input;
}

function invalidQueryResponse(error: z.ZodError) {
  const details = error.issues.map((issue) => ({
    path: issue.path.map(String).join(".") || "query",
    message: issue.message
  }));

  return NextResponse.json(
    {
      status: "failed",
      logs: [],
      errors: details.map((detail) => `${detail.path}: ${detail.message}`),
      error: {
        code: "invalid_query",
        details
      }
    },
    {
      status: 400,
      headers: {
        "Cache-Control": "no-store, max-age=0"
      }
    }
  );
}
