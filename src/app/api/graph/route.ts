import { NextResponse } from "next/server";
import { z } from "zod";
import { applyStoredBenchmarkMomentum } from "@/lib/graph/benchmarks";
import { applyClientGraphFilters } from "@/lib/graph/client-filters";
import {
  COMPANY_VERTICALS,
  isCompanyVertical,
  type CompanyVertical
} from "@/lib/graph/company-verticals";
import { personalizeInsiderGraphSnapshot } from "@/lib/graph/personalized-insider-snapshot";
import { POST_TOPIC_SLUGS, normalizePostTopic, type PostTopic } from "@/lib/graph/post-topics";
import {
  isPublishedGraphBatchSlug,
  loadPublishedGraphSnapshot,
  PUBLISHED_GRAPH_BATCH_FILES,
  type PublishedGraphBatchSlug
} from "@/lib/graph/published-graph-snapshot";
import { enrichSummerPlatformStatus } from "@/lib/graph/summer-platform-status";
import type { BusinessModel, EdgeType, GraphResponse, Platform, TopVoiceAudienceId } from "@/lib/graph/types";
import {
  effectiveInsiderMembers,
  emptyInsiderConfiguration,
  type UserInsiderConfiguration
} from "@/lib/social/user-insiders";
import {
  authenticateInsiderRequest,
  loadUserInsiderConfiguration
} from "@/lib/social/user-insiders-server";
import { streamJsonResponse } from "@/lib/http/stream-json-response";

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

const DEFAULT_BATCH_SLUG: PublishedGraphBatchSlug = "S2026";
const MAX_FILTER_VALUES = 64;
const batchSlugs = Object.keys(PUBLISHED_GRAPH_BATCH_FILES) as PublishedGraphBatchSlug[];
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
    .refine(isPublishedGraphBatchSlug, {
      message: `Must be one of: ${batchSlugs.join(", ")}.`
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

type GraphQuery = z.infer<typeof graphQuerySchema> & { batch: PublishedGraphBatchSlug };

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const parsedQuery = graphQuerySchema.safeParse(graphQueryInput(params));
  if (!parsedQuery.success) {
    return invalidQueryResponse(parsedQuery.error);
  }
  const query = parsedQuery.data as GraphQuery;

  // Raw and diagnostic responses are intentionally kept behind a lazy import.
  // The normal dashboard path must never materialize the full multi-batch
  // evidence corpus in a serverless process.
  if (query.includeRaw || query.includeNonScoring || query.includeWhy) {
    const diagnosticUrl = new URL(request.url);
    diagnosticUrl.pathname = "/api/graph/full";
    return NextResponse.redirect(diagnosticUrl, 307);
  }

  let insiderConfiguration = emptyInsiderConfiguration();
  let hasPersonalizedInsiderConfiguration = false;
  if (query.topVoices === "insiders") {
    const personalized = await resolveInsiderConfiguration(request, query, insiderConfiguration);
    if (!personalized.ok) return personalized.response;
    insiderConfiguration = personalized.configuration;
    hasPersonalizedInsiderConfiguration = personalized.authenticated;
  }

  const now = new Date();
  const filters = {
    platforms: query.platforms ?? [],
    edgeTypes: query.edgeTypes ?? [],
    minScore: query.minScore ?? 0,
    industries: query.industries ?? [],
    groupPartners: query.groupPartners ?? [],
    topics: query.topics ?? [],
    verticals: query.verticals ?? [],
    businessModels: query.businessModels ?? [],
    query: query.q
  };
  try {
    const canonical = await buildPublishedGraph({
      query,
      now,
      insiderConfiguration,
      hasPersonalizedInsiderConfiguration
    });
    const graph = hasActiveGraphFilters(query)
      ? enrichSummerPlatformStatus(applyClientGraphFilters(canonical, filters))
      : canonical;
    return noStoreJson(graph, { source: "published_snapshot" });
  } catch (error) {
    console.error("Published graph response failed", error);
    return publishedGraphFailureResponse();
  }
}

async function buildPublishedGraph(input: {
  query: GraphQuery;
  now: Date;
  insiderConfiguration: UserInsiderConfiguration;
  hasPersonalizedInsiderConfiguration: boolean;
}): Promise<GraphResponse> {
  const { query, now } = input;
  if (query.topVoices !== "insiders") {
    const graph = await loadPublishedGraphSnapshot({
      batchSlug: query.batch,
      audienceId: query.topVoices
    });
    return applyStoredBenchmarkMomentum(graph, { now });
  }

  const insiderGraph = await loadPublishedGraphSnapshot({
    batchSlug: query.batch,
    audienceId: "insiders"
  });
  const selectedInsiderIds = query.insiderIds ?? [];
  if (!input.hasPersonalizedInsiderConfiguration && selectedInsiderIds.length === 0) {
    return applyStoredBenchmarkMomentum(insiderGraph, { now });
  }

  const baseGraph = applyStoredBenchmarkMomentum(
    await loadPublishedGraphSnapshot({ batchSlug: query.batch, audienceId: "off" }),
    { now }
  );
  return personalizeInsiderGraphSnapshot({
    insiderGraph,
    baseGraph,
    configuration: input.insiderConfiguration,
    selectedInsiderIds
  });
}

async function resolveInsiderConfiguration(
  request: Request,
  query: GraphQuery,
  fallback: UserInsiderConfiguration
): Promise<
  | { ok: true; configuration: UserInsiderConfiguration; authenticated: boolean }
  | { ok: false; response: Response }
> {
  let configuration = fallback;
  let authenticatedConfiguration = false;
  const authenticated = await authenticateInsiderRequest(request);
  if (authenticated) {
    try {
      configuration = await loadUserInsiderConfiguration(authenticated.client, authenticated.userId);
      authenticatedConfiguration = true;
    } catch (error) {
      console.error("Personalized Insiders configuration load failed", error);
      return {
        ok: false,
        response: NextResponse.json(
          { error: { code: "insider_configuration_load_failed", message: "Your private Insiders list could not be loaded." } },
          { status: 500, headers: { "Cache-Control": "private, no-store, max-age=0" } }
        )
      };
    }
  }

  const enabledIds = new Set(
    effectiveInsiderMembers(configuration).map((member) => member.personId)
  );
  const unknownSelection = (query.insiderIds ?? []).find((personId) => !enabledIds.has(personId));
  if (unknownSelection) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: {
            code: "invalid_insider_selection",
            message: `${unknownSelection} is not an enabled insider.`
          }
        },
        { status: 400, headers: { "Cache-Control": "private, no-store, max-age=0" } }
      )
    };
  }
  return {
    ok: true,
    configuration,
    authenticated: authenticatedConfiguration
  };
}

function noStoreJson(body: unknown, metadata?: { source: string }) {
  return streamJsonResponse(body, {
    headers: {
      "Cache-Control": "no-store, max-age=0",
      ...(metadata ? { "X-Graph-Source": metadata.source } : {})
    }
  });
}

function hasActiveGraphFilters(query: GraphQuery): boolean {
  return Boolean(
    query.platforms?.length ||
    query.edgeTypes?.length ||
    query.minScore !== undefined ||
    query.industries?.length ||
    query.groupPartners?.length ||
    query.topics?.length ||
    query.verticals?.length ||
    query.businessModels?.length ||
    query.q
  );
}

function publishedGraphFailureResponse() {
  return NextResponse.json(
    {
      status: "failed",
      logs: [],
      errors: ["The published graph snapshot could not be loaded."],
      error: { code: "published_graph_unavailable" }
    },
    {
      status: 503,
      headers: { "Cache-Control": "no-store, max-age=0" }
    }
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
      error: { code: "invalid_query", details }
    },
    {
      status: 400,
      headers: { "Cache-Control": "no-store, max-age=0" }
    }
  );
}
