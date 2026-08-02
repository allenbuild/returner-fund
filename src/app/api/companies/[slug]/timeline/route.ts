import type { ListPublishedTimelineEventsResult } from "@/lib/timeline/contracts";
import {
  companyTimelineHttpCacheKey,
  parseCompanyTimelineQuery,
  parseTimelineCompanySlug,
  TimelineHttpInputError,
  timelineJsonResponse,
  timelinePublicErrorResponse,
} from "@/lib/timeline/http";
import { getOrBuildTimelineHttpResult } from "@/lib/timeline/http-cache";
import { projectPublicTimelineList } from "@/lib/timeline/public-projection";
import {
  listPublishedTimelineEvents,
  resolveTimelineCompanyBySlug,
} from "@/lib/timeline/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

interface TimelineRouteContext {
  params: Promise<{ slug: string }>;
}

export async function GET(request: Request, context: TimelineRouteContext): Promise<Response> {
  let slug: string;
  let query;
  try {
    slug = parseTimelineCompanySlug((await context.params).slug);
    query = parseCompanyTimelineQuery(new URL(request.url).searchParams);
  } catch (error) {
    if (error instanceof TimelineHttpInputError) {
      return timelinePublicErrorResponse({
        status: 400,
        code: "invalid_timeline_request",
        message: error.message,
        issues: error.issues,
      });
    }
    return timelinePublicErrorResponse({
      status: 400,
      code: "invalid_timeline_request",
      message: "The timeline request was invalid.",
    });
  }

  try {
    const company = await resolveTimelineCompanyBySlug(slug);
    if (!company) {
      return timelinePublicErrorResponse({
        status: 404,
        code: "timeline_company_not_found",
        message: "No company exists for the requested timeline slug.",
      });
    }

    const cached = await getOrBuildTimelineHttpResult<ListPublishedTimelineEventsResult>({
      key: companyTimelineHttpCacheKey(slug, query),
      scope: { companyId: company.id },
      build: () => listPublishedTimelineEvents({
        companyId: company.id,
        from: query.from,
        to: query.to,
        categories: query.categories,
        cursor: query.cursor,
        limit: query.limit,
      }),
    });
    const result = cached.value;
    const payload = {
      ...projectPublicTimelineList(result),
      filters: {
        from: query.from ?? null,
        to: query.to ?? null,
        categories: query.categories,
      },
    };
    return timelineJsonResponse(request, payload, {
      generatedAt: result.cache.generatedAt,
      lastModifiedAt: result.cache.lastModifiedAt,
      responseHeaders: { "X-Timeline-Cache": cached.status },
    });
  } catch (error) {
    console.error("Company timeline request failed", {
      slug,
      error: error instanceof Error ? error.message : "Unknown timeline error",
    });
    return timelinePublicErrorResponse({
      status: 503,
      code: "timeline_unavailable",
      message: "The company timeline is temporarily unavailable.",
    });
  }
}
