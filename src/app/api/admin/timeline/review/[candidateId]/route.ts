import { adminJsonResponse } from "@/lib/admin/request-auth";
import {
  authorizeTimelineAdminRequest,
  parseTimelineAdminResourceId,
  timelineAdminErrorResponse,
} from "@/lib/timeline/admin-http";
import { getTimelineCandidateDetail } from "@/lib/timeline/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

interface CandidateRouteContext {
  params: Promise<{ candidateId: string }>;
}

export async function GET(request: Request, context: CandidateRouteContext): Promise<Response> {
  const authFailure = authorizeTimelineAdminRequest(request);
  if (authFailure) return authFailure;
  try {
    const candidateId = parseTimelineAdminResourceId((await context.params).candidateId, "candidateId");
    const candidate = await getTimelineCandidateDetail(candidateId);
    if (!candidate) {
      return adminJsonResponse({
        error: { code: "timeline_candidate_not_found", message: "Timeline candidate was not found." },
      }, 404);
    }
    return adminJsonResponse({ generatedAt: new Date().toISOString(), candidate }, 200);
  } catch (error) {
    console.error("Timeline candidate detail request failed", {
      error: error instanceof Error ? error.message : "Unknown candidate detail error",
    });
    return timelineAdminErrorResponse(error);
  }
}
