import { adminJsonResponse } from "@/lib/admin/request-auth";
import {
  authorizeTimelineAdminRequest,
  parseTimelineAdminResourceId,
  timelineAdminErrorResponse,
} from "@/lib/timeline/admin-http";
import { getTimelineSourceDocumentAdmin } from "@/lib/timeline/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

interface SourceRouteContext {
  params: Promise<{ sourceId: string }>;
}

export async function GET(request: Request, context: SourceRouteContext): Promise<Response> {
  const authFailure = authorizeTimelineAdminRequest(request);
  if (authFailure) return authFailure;
  try {
    const sourceId = parseTimelineAdminResourceId((await context.params).sourceId, "sourceId");
    const source = await getTimelineSourceDocumentAdmin(sourceId);
    if (!source) {
      return adminJsonResponse({
        error: { code: "timeline_source_not_found", message: "Timeline source document was not found." },
      }, 404);
    }
    return adminJsonResponse({ generatedAt: new Date().toISOString(), source }, 200);
  } catch (error) {
    console.error("Timeline source document request failed", {
      error: error instanceof Error ? error.message : "Unknown source detail error",
    });
    return timelineAdminErrorResponse(error);
  }
}
