import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { runIngestBatch } from "@/lib/workers/ingest-batch";
import { findSecretLikeFields } from "@/lib/workers/secret-guard";

export const runtime = "nodejs";

const platformSchema = z.enum([
  "github",
  "x",
  "linkedin",
  "instagram",
  "product_hunt",
  "youtube",
  "rss",
  "web",
  "reddit",
  "bilibili",
  "xiaohongshu",
  "tiktok",
  "bluesky"
]);

const ingestBatchSchema = z
  .object({
    batchSlug: z.string().trim().min(1).max(64).default("YC Summer 2026"),
    options: z
      .object({
        demo: z.boolean().optional(),
        refreshProfiles: z.boolean().optional(),
        refreshPosts: z.boolean().optional(),
        maxCompanies: z.number().int().min(1).max(200).optional(),
        platforms: z.array(platformSchema).max(16).optional()
      })
      .strict()
      .optional()
  })
  .strict();

export async function POST(request: Request) {
  const authFailure = authorizeIngestRequest(request);
  if (authFailure) {
    return authFailure;
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        status: "failed",
        logs: [],
        errors: ["Request body must be valid JSON."]
      },
      { status: 400 }
    );
  }

  const secretFindings = findSecretLikeFields(body);
  if (secretFindings.length > 0) {
    return NextResponse.json(
      {
        status: "failed",
        logs: [],
        errors: [
          "Do not send cookies, tokens, passwords, session data, or API keys to /api/ingest/batch.",
          `Rejected secret-like field(s): ${secretFindings.map((finding) => finding.path).join(", ")}`
        ]
      },
      { status: 400 }
    );
  }

  const parsed = ingestBatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        status: "failed",
        logs: [],
        errors: parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
      },
      { status: 400 }
    );
  }

  const result = await runIngestBatch(parsed.data);
  return NextResponse.json(result, { status: result.status === "failed" ? 501 : 200 });
}

function authorizeIngestRequest(request: Request): NextResponse | null {
  if (process.env.NODE_ENV === "development" && isLoopbackRequest(request)) {
    return null;
  }

  const configuredSecrets = [process.env.INGEST_BATCH_SECRET, process.env.REFRESH_SECRET]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  if (configuredSecrets.length === 0) {
    if (process.env.NODE_ENV === "production") {
      return ingestErrorResponse(
        503,
        "ingest_secret_not_configured",
        "Batch ingest is unavailable because its server secret is not configured."
      );
    }
    return null;
  }

  const authorization = request.headers.get("authorization");
  const bearerSecret = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const providedSecrets = [
    bearerSecret,
    request.headers.get("x-ingest-batch-secret")?.trim(),
    request.headers.get("x-refresh-secret")?.trim()
  ].filter((value): value is string => Boolean(value));

  if (
    !providedSecrets.some((providedSecret) =>
      configuredSecrets.some((configuredSecret) => secretsMatch(providedSecret, configuredSecret))
    )
  ) {
    return ingestErrorResponse(
      401,
      "ingest_unauthorized",
      "A valid batch ingest secret is required.",
      { "WWW-Authenticate": 'Bearer realm="ingest-batch"' }
    );
  }

  return null;
}

function ingestErrorResponse(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {}
): NextResponse {
  return NextResponse.json(
    {
      status: "failed",
      logs: [],
      errors: [message],
      error: { code }
    },
    {
      status,
      headers: {
        "Cache-Control": "no-store, max-age=0",
        ...headers
      }
    }
  );
}

function isLoopbackRequest(request: Request): boolean {
  try {
    const hostname = new URL(request.url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

function secretsMatch(provided: string, expected: string): boolean {
  const providedDigest = createHash("sha256").update(provided, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}
