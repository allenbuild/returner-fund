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
  "xiaohongshu"
]);

const ingestBatchSchema = z
  .object({
    batchSlug: z.string().trim().min(1).max(64).default("YC Spring 2026"),
    options: z
      .object({
        demo: z.boolean().optional(),
        refreshProfiles: z.boolean().optional(),
        refreshPosts: z.boolean().optional(),
        maxCompanies: z.number().int().min(1).max(200).optional(),
        platforms: z.array(platformSchema).max(12).optional()
      })
      .strict()
      .optional()
  })
  .strict();

export async function POST(request: Request) {
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
