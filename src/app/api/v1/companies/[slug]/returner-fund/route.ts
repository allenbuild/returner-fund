import { NextResponse } from "next/server";
import { z } from "zod";
import {
  RETURNER_FUND_POST_LIMIT_DEFAULT,
  lookupReturnerFundCompany,
  type ReturnerFundCompanyLookupResult,
} from "@/lib/integrations/returner-fund-company";
import {
  isReturnerApiKeyConfigured,
  isReturnerApiRequestAuthorized,
} from "@/lib/integrations/returner-api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

const querySchema = z.object({
  batch: z.enum(["S2026", "S26", "A16ZSR006"]),
  limit: z.coerce.number().int().min(1).max(20).default(RETURNER_FUND_POST_LIMIT_DEFAULT),
}).strict();
const companyReferenceSchema = z.string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Use a company slug or company ID.");

interface RouteContext {
  params: Promise<{ slug: string }>;
}

interface RouteDependencies {
  authorize: typeof isReturnerApiRequestAuthorized;
  keyIsConfigured: typeof isReturnerApiKeyConfigured;
  lookup: typeof lookupReturnerFundCompany;
}

const defaultDependencies: RouteDependencies = {
  authorize: isReturnerApiRequestAuthorized,
  keyIsConfigured: isReturnerApiKeyConfigured,
  lookup: lookupReturnerFundCompany,
};

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  return handleReturnerFundCompanyRequest(request, context, defaultDependencies);
}

export async function handleReturnerFundCompanyRequest(
  request: Request,
  context: RouteContext,
  dependencies: RouteDependencies
): Promise<Response> {
  if (!await dependencies.authorize(request)) {
    return errorResponse(401, "unauthorized", "A valid Returner API key is required.", {
      "WWW-Authenticate": "Bearer",
    });
  }

  const params = new URL(request.url).searchParams;
  const input = queryInput(params);
  const query = querySchema.safeParse(input);
  const companyReference = companyReferenceSchema.safeParse((await context.params).slug);
  if (!query.success || !companyReference.success) {
    const issues = [
      ...(query.success ? [] : query.error.issues),
      ...(companyReference.success ? [] : companyReference.error.issues),
    ].map((issue) => ({
      path: issue.path.map(String).join(".") || "company",
      message: issue.message,
    }));
    return errorResponse(400, "invalid_request", "The company score request is invalid.", {}, issues);
  }

  let result: ReturnerFundCompanyLookupResult;
  try {
    result = await dependencies.lookup({
      companyReference: companyReference.data,
      batchSlug: query.data.batch,
      limit: query.data.limit,
    });
  } catch (error) {
    console.error("Returner Fund company API request failed", {
      companyReference: companyReference.data,
      batchSlug: query.data.batch,
      error: error instanceof Error ? error.message : "Unknown API error",
    });
    return errorResponse(503, "insights_unavailable", "Returner Fund insights are temporarily unavailable.");
  }

  if (result.status === "not_found") {
    return errorResponse(404, "company_not_found", "No company matched that slug or ID in the requested batch.");
  }
  if (result.status === "ambiguous") {
    return errorResponse(
      409,
      "company_ambiguous",
      "More than one company matched that reference.",
      {},
      result.matches
    );
  }
  if (result.status === "unavailable") {
    return errorResponse(
      503,
      "insights_out_of_sync",
      "The score and ranked-post snapshots are being synchronized."
    );
  }

  const modelVersion = result.response.returnerFund.model.version;
  return NextResponse.json(result.response, {
    headers: {
      "Cache-Control": dependencies.keyIsConfigured()
        ? "private, no-store, max-age=0"
        : "public, max-age=60, s-maxage=60, stale-while-revalidate=300",
      "X-Content-Type-Options": "nosniff",
      ...(modelVersion ? { "X-Returner-Fund-Model": modelVersion } : {}),
    },
  });
}

function queryInput(params: URLSearchParams): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const name of new Set(params.keys())) {
    const values = params.getAll(name);
    input[name] = values.length === 1 ? values[0] : values;
  }
  return input;
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  extraHeaders: Record<string, string> = {},
  details?: unknown
): Response {
  return NextResponse.json(
    {
      error: {
        code,
        message,
        ...(details === undefined ? {} : { details }),
      },
    },
    {
      status,
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
        ...extraHeaders,
      },
    }
  );
}
