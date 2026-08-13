import { open } from "node:fs/promises";
import { join } from "node:path";
import {
  isCurrentTopicFacetSnapshot,
  isTopicFacetBatchSlug,
  TOPIC_FACET_MAX_BYTES,
  type TopicFacetBatchSlug
} from "@/lib/graph/topic-facet-snapshot-loader";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 10;

interface TopicFacetRouteContext {
  params: Promise<{ batchSlug: string }>;
}

export async function GET(
  _request: Request,
  context: TopicFacetRouteContext
): Promise<Response> {
  const batchSlug = (await context.params).batchSlug;
  if (!isTopicFacetBatchSlug(batchSlug)) {
    return jsonError("Unknown topic facet batch.", 404);
  }

  try {
    const raw = await readBoundedTopicFacetFile(batchSlug);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return jsonError("The topic facet snapshot is not valid JSON.", 503);
    }
    if (!isCurrentTopicFacetSnapshot(parsed, batchSlug)) {
      return jsonError("The topic facet snapshot failed schema, batch, or shape validation.", 503);
    }

    return new Response(raw, {
      status: 200,
      headers: {
        "Cache-Control": "no-store, max-age=0, must-revalidate",
        "CDN-Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        "Vercel-CDN-Cache-Control": "no-store",
        "X-Topic-Facets-Batch": batchSlug,
        "X-Topic-Facets-Row-Count": String(parsed.rowCount),
        "X-Topic-Facets-Version": parsed.version
      }
    });
  } catch (error) {
    console.error("Topic facet snapshot request failed", {
      batchSlug,
      error: error instanceof Error ? error.message : "Unknown topic facet error"
    });
    return jsonError("The topic facet snapshot is temporarily unavailable.", 503);
  }
}

async function readBoundedTopicFacetFile(batchSlug: TopicFacetBatchSlug): Promise<string> {
  const path = join(process.cwd(), "public", "topic-facets", `${batchSlug.toLowerCase()}.json`);
  const handle = await open(path, "r");
  try {
    const stats = await handle.stat();
    if (stats.size > TOPIC_FACET_MAX_BYTES) {
      throw new Error(`Topic facet snapshot exceeded the ${TOPIC_FACET_MAX_BYTES}-byte limit.`);
    }
    const file = await handle.readFile();
    if (file.byteLength > TOPIC_FACET_MAX_BYTES) {
      throw new Error(`Topic facet snapshot exceeded the ${TOPIC_FACET_MAX_BYTES}-byte limit.`);
    }
    return file.toString("utf8");
  } finally {
    await handle.close();
  }
}

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, {
    status,
    headers: {
      "Cache-Control": "no-store, max-age=0, must-revalidate",
      "CDN-Cache-Control": "no-store",
      "Vercel-CDN-Cache-Control": "no-store"
    }
  });
}
