import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { parseDiagnosticsQuery, readIngestionDiagnostics } from "@/lib/admin/ingestion-diagnostics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
};

export async function GET(request: Request) {
  const authFailure = authorizeAdminRequest(request);
  if (authFailure) return authFailure;

  let query;
  try {
    query = parseDiagnosticsQuery(new URL(request.url).searchParams);
  } catch (error) {
    return jsonResponse(
      {
        error: {
          code: "invalid_diagnostics_query",
          message: error instanceof Error ? error.message : "Invalid diagnostics query.",
        },
      },
      400,
    );
  }

  try {
    return jsonResponse(await readIngestionDiagnostics(query), 200);
  } catch {
    return jsonResponse(
      {
        error: {
          code: "diagnostics_request_failed",
          message: "The diagnostics request could not be completed.",
        },
      },
      500,
    );
  }
}

function authorizeAdminRequest(request: Request): NextResponse | null {
  if (
    process.env.NODE_ENV === "development" &&
    process.env.ADMIN_INGESTION_ALLOW_INSECURE_LOOPBACK === "true" &&
    isLoopbackRequest(request)
  ) return null;

  const configuredSecrets = [process.env.ADMIN_INGESTION_SECRET, process.env.REFRESH_SECRET]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  if (configuredSecrets.length === 0) {
    return jsonResponse(
      {
        error: {
          code: "admin_ingestion_secret_not_configured",
          message: "Ingestion diagnostics are unavailable because the server admin secret is not configured.",
        },
      },
      503,
    );
  }

  const authorization = request.headers.get("authorization");
  const bearer = authorization?.match(/^Bearer\s+([^,\s]+)$/i)?.[1];
  const candidates = [bearer, request.headers.get("x-admin-ingestion-secret")?.trim()]
    .filter((value): value is string => Boolean(value));
  const authorized = candidates.some((candidate) =>
    configuredSecrets.some((expected) => secretsMatch(candidate, expected)),
  );

  if (authorized) return null;
  return jsonResponse(
    {
      error: {
        code: "admin_ingestion_unauthorized",
        message: "A valid ingestion diagnostics admin secret is required.",
      },
    },
    401,
    { "WWW-Authenticate": 'Bearer realm="admin-ingestion"' },
  );
}

function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { ...NO_STORE_HEADERS, ...headers },
  });
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
