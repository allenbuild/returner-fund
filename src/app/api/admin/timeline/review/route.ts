import { adminJsonResponse } from "@/lib/admin/request-auth";
import {
  authorizeTimelineAdminRequest,
  parseTimelineAdminReviewQuery,
  timelineAdminErrorResponse,
} from "@/lib/timeline/admin-http";
import { listTimelineCandidates } from "@/lib/timeline/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

export async function GET(request: Request): Promise<Response> {
  const authFailure = authorizeTimelineAdminRequest(request);
  if (authFailure) return authFailure;

  try {
    const query = parseTimelineAdminReviewQuery(new URL(request.url).searchParams);
    const result = await listTimelineCandidates({
      q: query.query,
      companyId: query.companyId,
      status: query.status,
      cursor: query.cursor,
      limit: query.limit,
    });
    return adminJsonResponse({
      generatedAt: new Date().toISOString(),
      items: result.items,
      nextCursor: result.nextCursor,
    }, 200);
  } catch (error) {
    console.error("Timeline candidate review request failed", {
      error: error instanceof Error ? error.message : "Unknown candidate review error",
    });
    return timelineAdminErrorResponse(error);
  }
}
