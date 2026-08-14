import { NextResponse } from "next/server";
import {
  createSiteAccessToken,
  isSiteAccessConfigured,
  passwordMatchesSiteAccess,
  SITE_ACCESS_COOKIE,
  siteAccessCookieOptions
} from "@/lib/site-access";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json(
      { error: "Invalid site access request." },
      { headers: { "Cache-Control": "private, no-store" }, status: 403 }
    );
  }

  const formData = await request.formData();
  const returnTo = safeReturnTo(formData.get("returnTo"));

  if (!isSiteAccessConfigured()) {
    return redirectToUnlock(request, returnTo, "configuration");
  }

  const password = formData.get("password");
  if (!await passwordMatchesSiteAccess(password)) {
    return redirectToUnlock(request, returnTo, "invalid");
  }

  const token = await createSiteAccessToken();
  if (!token) {
    return redirectToUnlock(request, returnTo, "configuration");
  }

  const response = NextResponse.redirect(new URL(returnTo, request.url), 303);
  response.cookies.set(SITE_ACCESS_COOKIE, token, siteAccessCookieOptions());
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

function redirectToUnlock(
  request: Request,
  returnTo: string,
  state: "configuration" | "invalid"
) {
  const url = new URL("/unlock", request.url);
  url.searchParams.set("returnTo", returnTo);
  url.searchParams.set(state, "1");
  return NextResponse.redirect(url, 303);
}

function safeReturnTo(value: FormDataEntryValue | null): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }

  try {
    const target = new URL(value, "https://returner.fund");
    if (target.origin !== "https://returner.fund" || target.pathname === "/unlock") {
      return "/";
    }

    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return "/";
  }
}

function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) {
    return true;
  }

  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}
