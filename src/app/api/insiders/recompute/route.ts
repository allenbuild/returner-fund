import { NextResponse } from "next/server";
import { applyStoredBenchmarkMomentum } from "@/lib/graph/benchmarks";
import { clearGraphResponseCache } from "@/lib/graph/graph-response-cache";
import { personalizeInsiderGraphSnapshot } from "@/lib/graph/personalized-insider-snapshot";
import { readRuntimeGraphSnapshotFile } from "@/lib/graph/runtime-graph-snapshot-file";
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
const GRAPH_SNAPSHOT_MAX_BYTES = 20 * 1024 * 1024;
const GRAPH_SNAPSHOT_FETCH_TIMEOUT_MS = 12_000;
const ALLOWED_GRAPH_SNAPSHOTS = new Set(
  Object.values(BATCH_FILES).flatMap((filename) => [
    `${filename}.json`,
    `${filename}-insiders.json`
  ])
);

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
      loadGraphSnapshot(`${filename}-insiders.json`, input.batchSlug, "insiders"),
      loadGraphSnapshot(`${filename}.json`, input.batchSlug, "off")
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
    // Static graph files can lag the benchmark store while a daily publisher
    // or deployment is converging. Rehydrate the canonical company momentum
    // with the exact scoring-model history before applying private weights so
    // a personalized recompute cannot silently turn an observed baseline into
    // "Awaiting same-model snapshot".
    const benchmarkedBaseGraph = applyStoredBenchmarkMomentum(baseGraph);
    const graph = personalizeInsiderGraphSnapshot({
      insiderGraph,
      baseGraph: benchmarkedBaseGraph,
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

async function loadGraphSnapshot(
  filename: string,
  expectedBatchSlug: SupportedBatchSlug,
  expectedAudienceId: "insiders" | "off"
): Promise<GraphResponse> {
  if (!ALLOWED_GRAPH_SNAPSHOTS.has(filename)) {
    throw new Error(`Published graph snapshot ${filename} is not allowlisted.`);
  }
  let raw: string;
  try {
    raw = await readRuntimeGraphSnapshotFile(filename);
  } catch (fileError) {
    const snapshotUrl = new URL(`/graph/${filename}`, trustedDeploymentOrigin());
    let response: Response;
    try {
      response = await fetch(snapshotUrl, {
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(GRAPH_SNAPSHOT_FETCH_TIMEOUT_MS)
      });
    } catch (fetchError) {
      throw new AggregateError(
        [fileError, fetchError],
        `Published graph snapshot ${filename} was unavailable from disk and CDN.`
      );
    }
    if (!response.ok) {
      throw new AggregateError(
        [fileError, new Error(`HTTP ${response.status} from ${snapshotUrl.pathname}`)],
        `Published graph snapshot ${filename} could not be loaded.`
      );
    }
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (contentLength > GRAPH_SNAPSHOT_MAX_BYTES) {
      throw new Error(
        `Published graph snapshot ${filename} exceeded the ${GRAPH_SNAPSHOT_MAX_BYTES}-byte limit.`
      );
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > GRAPH_SNAPSHOT_MAX_BYTES) {
      throw new Error(
        `Published graph snapshot ${filename} exceeded the ${GRAPH_SNAPSHOT_MAX_BYTES}-byte limit.`
      );
    }
    raw = bytes.toString("utf8");
  }
  if (Buffer.byteLength(raw) > GRAPH_SNAPSHOT_MAX_BYTES) {
    throw new Error(
      `Published graph snapshot ${filename} exceeded the ${GRAPH_SNAPSHOT_MAX_BYTES}-byte limit.`
    );
  }
  let graph: GraphResponse;
  try {
    graph = JSON.parse(raw) as GraphResponse;
  } catch (error) {
    throw new Error(`Published graph snapshot ${filename} contained invalid JSON.`, {
      cause: error
    });
  }
  if (
    !graph ||
    !Array.isArray(graph.nodes) ||
    !Array.isArray(graph.evidence) ||
    !Array.isArray(graph.leaderboard) ||
    graph.batch?.slug !== expectedBatchSlug ||
    graph.selectedTopVoiceAudience?.id !== expectedAudienceId
  ) {
    throw new Error(`Published graph snapshot ${filename} was invalid.`);
  }
  return graph;
}

function trustedDeploymentOrigin(): URL {
  const vercelHost = process.env.VERCEL_URL?.trim();
  if (vercelHost) {
    try {
      return new URL(
        vercelHost.startsWith("http://") || vercelHost.startsWith("https://")
          ? vercelHost
          : `https://${vercelHost}`
      );
    } catch {
      // Fall through to the configured public origin.
    }
  }
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === "https:" || url.protocol === "http:") return url;
    } catch {
      // Fall through to the canonical production origin.
    }
  }
  return new URL("https://www.returner.fund");
}

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store, max-age=0" }
  });
}
