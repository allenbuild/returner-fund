import { NextResponse } from "next/server";
import { loadPublicDashboardFeedSnapshot } from "@/lib/dashboard/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Public, read-only projection of an already-published snapshot. It must stay
 * small and side-effect free: no connector, scoring, clustering, or summary
 * work is allowed on the visitor request path.
 */
export async function GET() {
  const snapshot = await loadPublicDashboardFeedSnapshot();
  return NextResponse.json(snapshot, {
    headers: {
      "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
      "X-Dashboard-Generated-At": snapshot.generatedAt,
      "X-Dashboard-Window-Start": snapshot.windowStart
    }
  });
}
