import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { clearGraphResponseCache } from "@/lib/graph/graph-response-cache";
import { personalizeInsiderGraphSnapshot } from "@/lib/graph/personalized-insider-snapshot";
import type { GraphResponse } from "@/lib/graph/types";
import {
  authenticateInsiderRequest,
  loadUserInsiderConfiguration
} from "@/lib/social/user-insiders-server";
import { effectiveInsiderMembers } from "@/lib/social/user-insiders";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BATCH_FILES = {
  S2026: "s2026",
  S26: "s26",
  A16ZSR006: "a16zsr006"
} as const;
type SupportedBatchSlug = keyof typeof BATCH_FILES;

export async function POST(request: Request) {
  const authenticated = await authenticateInsiderRequest(request);
  if (!authenticated) {
    return json(
      { error: { code: "authentication_required", message: "Sign in to recompute private Insider scores." } },
      401
    );
  }

  try {
    const input = await recomputeInput(request);
    if (!input.ok) return input.response;
    const filename = BATCH_FILES[input.batchSlug];
    const [configuration, insiderGraph, baseGraph] = await Promise.all([
      loadUserInsiderConfiguration(authenticated.client, authenticated.userId),
      loadGraphSnapshot(`${filename}-insiders.json`),
      loadGraphSnapshot(`${filename}.json`)
    ]);
    const enabledIds = new Set(
      effectiveInsiderMembers(configuration).map((member) => member.personId)
    );
    const unknownSelection = input.insiderIds.find((personId) => !enabledIds.has(personId));
    if (unknownSelection) {
      return json(
        {
          error: {
            code: "invalid_insider_selection",
            message: `${unknownSelection} is not an enabled insider.`
          }
        },
        400
      );
    }
    const graph = personalizeInsiderGraphSnapshot({
      insiderGraph,
      baseGraph,
      configuration,
      selectedInsiderIds: input.insiderIds
    });
    const serializedBytes = Buffer.byteLength(JSON.stringify(graph));
    if (serializedBytes > 4 * 1024 * 1024) {
      throw new Error(
        `Personalized Insider graph exceeded the safe response budget (${serializedBytes} bytes).`
      );
    }
    if (
      graph.batch.slug !== input.batchSlug ||
      graph.selectedTopVoiceAudience.id !== "insiders" ||
      graph.insiderConfigurationVersion !== configuration.version
    ) {
      throw new Error("Personalized Insider graph did not match the saved configuration.");
    }
    // The legacy response cache can still be populated by local/dev callers.
    // Clearing it is cheap; the personalized response itself is returned from
    // the published snapshots above and does not import the giant graph build.
    clearGraphResponseCache();
    return json({
      status: "recomputed",
      configurationVersion: configuration.version,
      recomputedAt: new Date().toISOString(),
      source: "published_snapshot",
      reportRegenerated: false,
      graph
    });
  } catch (error) {
    console.error("Insider score recomputation failed", error);
    return json(
      {
        error: {
          code: "score_recompute_failed",
          message: "Your list was saved, but scores could not be recomputed from the published evidence."
        }
      },
      500
    );
  }
}

async function recomputeInput(request: Request): Promise<
  | { ok: true; batchSlug: SupportedBatchSlug; insiderIds: string[] }
  | { ok: false; response: Response }
> {
  let value: unknown = {};
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > 16 * 1024) {
    return {
      ok: false,
      response: json(
        { error: { code: "request_too_large", message: "The recompute request was too large." } },
        413
      )
    };
  }
  try {
    const text = await request.text();
    if (Buffer.byteLength(text) > 16 * 1024) {
      return {
        ok: false,
        response: json(
          { error: { code: "request_too_large", message: "The recompute request was too large." } },
          413
        )
      };
    }
    value = text.trim() ? JSON.parse(text) : {};
  } catch {
    return {
      ok: false,
      response: json(
        { error: { code: "invalid_request", message: "The recompute request was not valid JSON." } },
        400
      )
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalidRecomputeInput();
  }
  const record = value as Record<string, unknown>;
  const batchSlug = typeof record.batchSlug === "string" ? record.batchSlug : "S2026";
  if (!(batchSlug in BATCH_FILES)) return invalidRecomputeInput("Unsupported batch.");
  const insiderIds = record.insiderIds ?? [];
  if (
    !Array.isArray(insiderIds) ||
    insiderIds.length > 200 ||
    insiderIds.some(
      (personId) =>
        typeof personId !== "string" ||
        personId.length < 1 ||
        personId.length > 160
    )
  ) {
    return invalidRecomputeInput("Invalid Insider selection.");
  }
  if (Object.keys(record).some((key) => key !== "batchSlug" && key !== "insiderIds")) {
    return invalidRecomputeInput();
  }
  return {
    ok: true,
    batchSlug: batchSlug as SupportedBatchSlug,
    insiderIds: [...new Set(insiderIds as string[])]
  };
}

function invalidRecomputeInput(message = "The recompute request was invalid."): {
  ok: false;
  response: Response;
} {
  return {
    ok: false,
    response: json({ error: { code: "invalid_request", message } }, 400)
  };
}

async function loadGraphSnapshot(filename: string): Promise<GraphResponse> {
  const raw = await readFile(join(process.cwd(), "public", "graph", filename), "utf8");
  const graph = JSON.parse(raw) as GraphResponse;
  if (
    !graph ||
    !Array.isArray(graph.nodes) ||
    !Array.isArray(graph.evidence) ||
    !Array.isArray(graph.leaderboard) ||
    !graph.batch?.slug ||
    !graph.selectedTopVoiceAudience?.id
  ) {
    throw new Error(`Published graph snapshot ${filename} was invalid.`);
  }
  return graph;
}

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store, max-age=0" }
  });
}
