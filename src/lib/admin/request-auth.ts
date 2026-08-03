import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

export const ADMIN_NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
} as const;

export interface AdminRequestAuthorizationOptions {
  secretEnvironmentVariables: readonly string[];
  secretHeaderNames: readonly string[];
  allowInsecureLoopbackEnvironmentVariable: string;
  realm: string;
  unavailableCode: string;
  unavailableMessage: string;
  unauthorizedCode: string;
  unauthorizedMessage: string;
}

/**
 * Fail-closed, constant-time bearer/header authorization shared by protected
 * admin APIs. Loopback access is available only in development and only when
 * the route-specific opt-in variable is explicitly enabled.
 */
export function authorizeAdminRequest(
  request: Request,
  options: AdminRequestAuthorizationOptions,
): NextResponse | null {
  if (
    process.env.NODE_ENV === "development" &&
    process.env[options.allowInsecureLoopbackEnvironmentVariable] === "true" &&
    isLoopbackRequest(request)
  ) {
    return null;
  }

  const configuredSecrets = options.secretEnvironmentVariables
    .map((name) => process.env[name]?.trim())
    .filter((value): value is string => Boolean(value));

  if (configuredSecrets.length === 0) {
    return adminJsonResponse(
      {
        error: {
          code: options.unavailableCode,
          message: options.unavailableMessage,
        },
      },
      503,
    );
  }

  const authorization = request.headers.get("authorization");
  const bearer = authorization?.match(/^Bearer\s+([^,\s]+)$/i)?.[1];
  const candidates = [
    bearer,
    ...options.secretHeaderNames.map((name) => request.headers.get(name)?.trim()),
  ].filter((value): value is string => Boolean(value));
  const authorized = candidates.some((candidate) =>
    configuredSecrets.some((expected) => secretsMatch(candidate, expected)),
  );

  if (authorized) return null;
  return adminJsonResponse(
    {
      error: {
        code: options.unauthorizedCode,
        message: options.unauthorizedMessage,
      },
    },
    401,
    { "WWW-Authenticate": `Bearer realm="${options.realm}"` },
  );
}

export function adminJsonResponse(
  body: unknown,
  status: number,
  headers: Record<string, string> = {},
): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { ...ADMIN_NO_STORE_HEADERS, ...headers },
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
