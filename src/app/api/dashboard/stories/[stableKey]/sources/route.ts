import { NextResponse } from "next/server";
import { isDashboardStoryStableKey } from "@/lib/dashboard/contracts";
import { loadPublicDashboardStorySourceDetail } from "@/lib/dashboard/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface DashboardStorySourcesRouteContext {
  params: Promise<{ stableKey: string }>;
}

/**
 * Public, bounded expansion for one already-published story. The store reads
 * a static/database projection only; it cannot trigger source discovery or
 * score calculation on a visitor request.
 */
export async function GET(
  _request: Request,
  context: DashboardStorySourcesRouteContext
): Promise<Response> {
  const stableKey = (await context.params).stableKey;
  if (!isDashboardStoryStableKey(stableKey)) {
    return sourceDetailError("Unknown dashboard story.", 404);
  }

  try {
    const detail = await loadPublicDashboardStorySourceDetail(stableKey);
    if (!detail) return sourceDetailError("No current source detail exists for this story.", 404);

    return NextResponse.json(detail, {
      headers: {
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
        "X-Dashboard-Source-Count": String(detail.sourceCount),
        "X-Dashboard-Source-Detail-Limited": detail.truncated ? "1" : "0"
      }
    });
  } catch {
    return sourceDetailError("Dashboard source detail is temporarily unavailable.", 503);
  }
}

function sourceDetailError(message: string, status: 404 | 503): Response {
  return NextResponse.json(
    { error: message },
    {
      headers: { "Cache-Control": "no-store" },
      status
    }
  );
}
