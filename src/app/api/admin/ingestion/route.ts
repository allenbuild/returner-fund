import { authorizeAdminRequest, adminJsonResponse } from "@/lib/admin/request-auth";
import { parseDiagnosticsQuery, readIngestionDiagnostics } from "@/lib/admin/ingestion-diagnostics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authFailure = authorizeAdminRequest(request, {
    secretEnvironmentVariables: ["ADMIN_INGESTION_SECRET", "REFRESH_SECRET"],
    secretHeaderNames: ["x-admin-ingestion-secret"],
    allowInsecureLoopbackEnvironmentVariable: "ADMIN_INGESTION_ALLOW_INSECURE_LOOPBACK",
    realm: "admin-ingestion",
    unavailableCode: "admin_ingestion_secret_not_configured",
    unavailableMessage: "Ingestion diagnostics are unavailable because the server admin secret is not configured.",
    unauthorizedCode: "admin_ingestion_unauthorized",
    unauthorizedMessage: "A valid ingestion diagnostics admin secret is required.",
  });
  if (authFailure) return authFailure;

  let query;
  try {
    query = parseDiagnosticsQuery(new URL(request.url).searchParams);
  } catch (error) {
    return adminJsonResponse(
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
    return adminJsonResponse(await readIngestionDiagnostics(query), 200);
  } catch {
    return adminJsonResponse(
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
