import { adminJsonResponse } from "@/lib/admin/request-auth";
import {
  authorizeTimelineAdminRequest,
  parseTimelineAdminResourceId,
  timelineAdminErrorResponse,
} from "@/lib/timeline/admin-http";
import { getTimelineAdminEventDetail } from "@/lib/timeline/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

interface EventRouteContext {
  params: Promise<{ eventId: string }>;
}

export async function GET(request: Request, context: EventRouteContext): Promise<Response> {
  const authFailure = authorizeTimelineAdminRequest(request);
  if (authFailure) return authFailure;

  try {
    const eventId = parseTimelineAdminResourceId((await context.params).eventId, "eventId");
    const eventDetail = await getTimelineAdminEventDetail(eventId);
    if (!eventDetail) {
      return adminJsonResponse({
        error: { code: "timeline_event_not_found", message: "Timeline event was not found." },
      }, 404);
    }
    return adminJsonResponse({ generatedAt: new Date().toISOString(), eventDetail }, 200);
  } catch (error) {
    console.error("Timeline event detail request failed", {
      error: error instanceof Error ? error.message : "Unknown event detail error",
    });
    return timelineAdminErrorResponse(error);
  }
}
