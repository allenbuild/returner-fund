import { streamJsonResponse } from "@/lib/http/stream-json-response";
import { rankedPostsSidecarSnapshot } from "@/lib/graph/ranked-posts-sidecar";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  return streamJsonResponse(rankedPostsSidecarSnapshot, {
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "X-Ranked-Posts-Sidecar-Version": rankedPostsSidecarSnapshot.version
    }
  });
}
