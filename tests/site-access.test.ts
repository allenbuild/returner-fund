import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  createSiteAccessToken,
  hasValidSiteAccessToken,
  isSiteAccessConfigured,
  passwordMatchesSiteAccess,
  SITE_ACCESS_COOKIE
} from "@/lib/site-access";
import { POST as unlock } from "@/app/api/access/unlock/route";
import { proxy } from "@/proxy";

describe("site access", () => {
  it("requires both configuration values before enabling the lock", () => {
    vi.stubEnv("SITE_PASSWORD", "");
    vi.stubEnv("SITE_ACCESS_SECRET", "signing-secret");
    expect(isSiteAccessConfigured()).toBe(false);

    vi.stubEnv("SITE_PASSWORD", "correct horse battery staple");
    vi.stubEnv("SITE_ACCESS_SECRET", "");
    expect(isSiteAccessConfigured()).toBe(false);
  });

  it("validates the configured password and issues expiring signed sessions", async () => {
    vi.stubEnv("SITE_PASSWORD", "correct horse battery staple");
    vi.stubEnv("SITE_ACCESS_SECRET", "signing-secret");

    expect(await passwordMatchesSiteAccess("correct horse battery staple")).toBe(true);
    expect(await passwordMatchesSiteAccess("incorrect")).toBe(false);

    const now = Date.UTC(2026, 7, 14, 12, 0, 0);
    const token = await createSiteAccessToken(now);
    expect(token).toBeTruthy();
    expect(await hasValidSiteAccessToken(token ?? undefined, now)).toBe(true);
    expect(await hasValidSiteAccessToken(`${token}changed`, now)).toBe(false);
    expect(await hasValidSiteAccessToken(token ?? undefined, now + 15 * 24 * 60 * 60 * 1000)).toBe(false);
  });

  it("redirects browser traffic to the lock and rejects unauthenticated API requests", async () => {
    vi.stubEnv("SITE_PASSWORD", "correct horse battery staple");
    vi.stubEnv("SITE_ACCESS_SECRET", "signing-secret");

    const pageResponse = await proxy(new NextRequest("https://returner.fund/rankings?batch=S26"));
    expect(pageResponse.headers.get("location")).toBe(
      "https://returner.fund/unlock?returnTo=%2Frankings%3Fbatch%3DS26"
    );

    const apiResponse = await proxy(new NextRequest("https://returner.fund/api/yc-partners?batch=S26"));
    expect(apiResponse.status).toBe(401);
    await expect(apiResponse.json()).resolves.toEqual({ error: "Site access is required." });

    const graphResponse = await proxy(new NextRequest("https://returner.fund/graph/s2026.json"));
    expect(graphResponse.headers.get("location")).toBe(
      "https://returner.fund/unlock?returnTo=%2Fgraph%2Fs2026.json"
    );
  });

  it("allows a request carrying a valid signed access cookie", async () => {
    vi.stubEnv("SITE_PASSWORD", "correct horse battery staple");
    vi.stubEnv("SITE_ACCESS_SECRET", "signing-secret");

    const token = await createSiteAccessToken();
    const request = new NextRequest("https://returner.fund/api/yc-partners", {
      headers: { cookie: `${SITE_ACCESS_COOKIE}=${token}` }
    });

    const response = await proxy(request);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("preserves scoped automation calls that already present their route secret", async () => {
    vi.stubEnv("SITE_PASSWORD", "correct horse battery staple");
    vi.stubEnv("SITE_ACCESS_SECRET", "signing-secret");
    vi.stubEnv("REFRESH_SECRET", "refresh-secret");

    const response = await proxy(new NextRequest("https://returner.fund/api/graph/refresh", {
      headers: { authorization: "Bearer refresh-secret" }
    }));

    expect(response.headers.get("x-middleware-next")).toBe("1");

    const unrelatedApiResponse = await proxy(new NextRequest("https://returner.fund/api/yc-partners", {
      headers: { authorization: "Bearer refresh-secret" }
    }));
    expect(unrelatedApiResponse.status).toBe(401);
  });

  it("fails closed when site access credentials are not configured", async () => {
    vi.stubEnv("SITE_PASSWORD", "");
    vi.stubEnv("SITE_ACCESS_SECRET", "");

    const pageResponse = await proxy(new NextRequest("https://returner.fund/"));
    expect(pageResponse.headers.get("location")).toBe(
      "https://returner.fund/unlock?returnTo=%2F&configuration=1"
    );

    const apiResponse = await proxy(new NextRequest("https://returner.fund/api/graph"));
    expect(apiResponse.status).toBe(503);
  });
});

describe("site access unlock route", () => {
  it("sets an HttpOnly signed session and returns the visitor to the requested page", async () => {
    vi.stubEnv("SITE_PASSWORD", "correct horse battery staple");
    vi.stubEnv("SITE_ACCESS_SECRET", "signing-secret");

    const response = await unlock(unlockRequest({
      password: "correct horse battery staple",
      returnTo: "/rankings?batch=S26"
    }));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://returner.fund/rankings?batch=S26");
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${SITE_ACCESS_COOKIE}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/");
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toContain("Max-Age=1209600");
  });

  it("rejects an external form origin and never follows an external return URL", async () => {
    vi.stubEnv("SITE_PASSWORD", "correct horse battery staple");
    vi.stubEnv("SITE_ACCESS_SECRET", "signing-secret");

    const crossOriginResponse = await unlock(unlockRequest(
      { password: "correct horse battery staple", returnTo: "/" },
      "https://attacker.example"
    ));
    expect(crossOriginResponse.status).toBe(403);

    const externalReturnResponse = await unlock(unlockRequest({
      password: "correct horse battery staple",
      returnTo: "https://attacker.example"
    }));
    expect(externalReturnResponse.headers.get("location")).toBe("https://returner.fund/");
  });
});

function unlockRequest(fields: Record<string, string>, origin = "https://returner.fund"): Request {
  const formData = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    formData.set(name, value);
  }

  return new Request("https://returner.fund/api/access/unlock", {
    body: formData,
    headers: { origin },
    method: "POST"
  });
}
