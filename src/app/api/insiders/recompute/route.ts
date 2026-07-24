import { NextResponse } from "next/server";
import { clearTopVoiceRollupCache } from "@/lib/graph/graph-builder";
import { clearGraphResponseCache } from "@/lib/graph/graph-response-cache";
import {
  authenticateInsiderRequest,
  loadUserInsiderConfiguration
} from "@/lib/social/user-insiders-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const authenticated = await authenticateInsiderRequest(request);
  if (!authenticated) {
    return json(
      { error: { code: "authentication_required", message: "Sign in to recompute private Insider scores." } },
      401
    );
  }

  try {
    const configuration = await loadUserInsiderConfiguration(
      authenticated.client,
      authenticated.userId
    );
    clearTopVoiceRollupCache();
    clearGraphResponseCache();
    return json({
      status: "recomputed",
      configurationVersion: configuration.version,
      recomputedAt: new Date().toISOString(),
      source: "stored_evidence",
      reportRegenerated: false
    });
  } catch (error) {
    console.error("Insider score recomputation failed", error);
    return json(
      {
        error: {
          code: "score_recompute_failed",
          message: "Scores could not be recomputed from stored evidence."
        }
      },
      500
    );
  }
}

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store, max-age=0" }
  });
}
