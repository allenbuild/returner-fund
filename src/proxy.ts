import { NextResponse, type NextRequest } from "next/server";
import {
  hasTrustedAutomationCredential,
  hasValidSiteAccessToken,
  isSiteAccessConfigured,
  SITE_ACCESS_COOKIE
} from "@/lib/site-access";

// The discovery dashboard is intentionally public. Keep this list narrow: the
// rest of the app, its graph snapshots, and every existing API remain behind
// the site-access gate. `/api/dashboard` is a read-only sanitized snapshot,
// not a general public API prefix.
const PUBLIC_PATHS = new Set(["/unlock", "/api/access/unlock", "/dashboard", "/dashboard/", "/api/dashboard", "/api/dashboard/"]);
// `stableKey` is an opaque worker-created `story-…` id. This allows the one
// source expansion route without making `/api/dashboard/**` public.
const PUBLIC_DASHBOARD_SOURCE_DETAIL_PATH = /^\/api\/dashboard\/stories\/story-[a-z0-9][a-z0-9_-]{0,127}\/sources\/?$/;

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.has(pathname) || PUBLIC_DASHBOARD_SOURCE_DETAIL_PATH.test(pathname)) {
    return NextResponse.next();
  }

  if (!isSiteAccessConfigured()) {
    return configurationRequiredResponse(request);
  }

  const token = request.cookies.get(SITE_ACCESS_COOKIE)?.value;
  if (await hasValidSiteAccessToken(token)) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/") && await hasTrustedAutomationCredential(request, pathname)) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "Site access is required." },
      {
        headers: { "Cache-Control": "private, no-store" },
        status: 401
      }
    );
  }

  return redirectToUnlock(request);
}

function configurationRequiredResponse(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "Site access is not configured." },
      {
        headers: { "Cache-Control": "private, no-store" },
        status: 503
      }
    );
  }

  return redirectToUnlock(request, "configuration");
}

function redirectToUnlock(request: NextRequest, state?: "configuration") {
  const url = request.nextUrl.clone();
  url.pathname = "/unlock";
  url.search = "";
  url.searchParams.set("returnTo", `${request.nextUrl.pathname}${request.nextUrl.search}`);
  if (state) {
    url.searchParams.set(state, "1");
  }

  const response = NextResponse.redirect(url);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const config = {
  matcher: ["/((?!_next(?:/|$)|favicon\\.ico$|icon\\.png$|manifest\\.webmanifest$).*)"]
};
