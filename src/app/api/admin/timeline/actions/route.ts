import { adminJsonResponse } from "@/lib/admin/request-auth";
import { revalidatePath } from "next/cache";
import {
  authorizeTimelineAdminRequest,
  readTimelineAdminActionRequest,
  timelineAdminActor,
  timelineAdminErrorResponse,
} from "@/lib/timeline/admin-http";
import { invalidateTimelineHttpCache } from "@/lib/timeline/http-cache";
import {
  applyTimelineAdminCandidateAction,
  applyTimelineAdminCompanyAction,
  applyTimelineAdminEventAction,
} from "@/lib/timeline/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: Request): Promise<Response> {
  const authFailure = authorizeTimelineAdminRequest(request);
  if (authFailure) return authFailure;

  try {
    const command = await readTimelineAdminActionRequest(request);
    const actor = timelineAdminActor(request);
    const result = command.scope === "event"
      ? await applyTimelineAdminEventAction(command.action, actor)
      : command.scope === "candidate"
        ? await applyTimelineAdminCandidateAction(command.action, actor)
        : await applyTimelineAdminCompanyAction(command.action, actor);

    if (!result.auditId || !result.cacheInvalidated) {
      throw new Error(
        "Timeline store rejected the admin action because audit or cache invalidation was not confirmed.",
      );
    }

    if (command.scope === "company") {
      invalidateTimelineHttpCache({ companyId: command.action.companyId });
    } else {
      // Event/candidate actions may publish, unpublish, merge, or otherwise
      // change more than one company artifact. The store writes the durable
      // invalidation; conservatively clear this process's small HTTP cache.
      invalidateTimelineHttpCache();
    }
    invalidateSharedTimelineRoutes();
    return adminJsonResponse({
      status: "completed",
      completedAt: new Date().toISOString(),
      result,
    }, 200);
  } catch (error) {
    console.error("Timeline admin action failed", {
      error: error instanceof Error ? error.message : "Unknown timeline action error",
    });
    return timelineAdminErrorResponse(error);
  }
}

function invalidateSharedTimelineRoutes(): void {
  try {
    // Dynamic patterns cover every filtered/paginated public response. The
    // durable invalidation row remains authoritative if a deployment does not
    // expose a shared Next cache (for example, a focused unit-test runtime).
    revalidatePath("/api/companies/[slug]/timeline", "page");
    revalidatePath("/api/timeline/events/[eventId]", "page");
  } catch (error) {
    console.warn("Shared timeline route cache invalidation was unavailable", {
      error: error instanceof Error ? error.message : "Unknown cache invalidation error",
    });
  }
}
