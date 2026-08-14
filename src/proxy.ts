import { NextResponse, type NextRequest } from "next/server";
import {
  hasTrustedAutomationCredential,
  hasValidSiteAccessToken,
  isSiteAccessConfigured,
  SITE_ACCESS_COOKIE
} from "@/lib/site-access";

const PUBLIC_PATHS = new Set(["/unlock", "/api/access/unlock"]);

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.has(pathname)) {
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
