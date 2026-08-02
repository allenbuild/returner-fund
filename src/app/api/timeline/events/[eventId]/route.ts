import type { CompanyTimelineEventDetailArtifact } from "@/lib/timeline/contracts";
import {
  parseTimelineEventId,
  TimelineHttpInputError,
  timelineJsonResponse,
  timelinePublicErrorResponse,
} from "@/lib/timeline/http";
import { getOrBuildTimelineHttpResult } from "@/lib/timeline/http-cache";
import { projectPublicTimelineEventDetail } from "@/lib/timeline/public-projection";
import { getPublishedTimelineEventDetail } from "@/lib/timeline/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

interface TimelineEventRouteContext {
  params: Promise<{ eventId: string }>;
}

export async function GET(request: Request, context: TimelineEventRouteContext): Promise<Response> {
  let eventId: string;
  try {
    eventId = parseTimelineEventId((await context.params).eventId);
  } catch (error) {
    return timelinePublicErrorResponse({
      status: 400,
      code: "invalid_timeline_event_request",
      message: error instanceof TimelineHttpInputError
        ? error.message
        : "The timeline event request was invalid.",
      issues: error instanceof TimelineHttpInputError ? error.issues : undefined,
    });
  }

  try {
    const cached = await getOrBuildTimelineHttpResult<CompanyTimelineEventDetailArtifact | null>({
      key: `timeline-event-detail.v1:${eventId}`,
      scope: { eventId },
      build: () => getPublishedTimelineEventDetail(eventId),
    });
    const detail = cached.value;
    if (!detail) {
      return timelinePublicErrorResponse({
        status: 404,
        code: "timeline_event_not_found",
        message: "No published timeline event exists for the requested ID.",
      });
    }
    return timelineJsonResponse(request, projectPublicTimelineEventDetail(detail), {
      generatedAt: detail.generatedAt,
      lastModifiedAt: detail.lastModifiedAt,
      responseHeaders: { "X-Timeline-Cache": cached.status },
    });
  } catch (error) {
    console.error("Timeline event detail request failed", {
      eventId,
      error: error instanceof Error ? error.message : "Unknown timeline event error",
    });
    return timelinePublicErrorResponse({
      status: 503,
      code: "timeline_event_unavailable",
      message: "Timeline event evidence is temporarily unavailable.",
    });
  }
}
