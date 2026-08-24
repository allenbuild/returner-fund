import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isReturnerApiKeyConfigured,
  isReturnerApiRequestAuthorized,
  isReturnerFundApiRequest,
} from "@/lib/integrations/returner-api-auth";

describe("Returner Fund API authentication", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("keeps the read-only endpoint public when no key is configured", async () => {
    vi.stubEnv("RETURNER_API_KEY", "");

    expect(isReturnerApiKeyConfigured()).toBe(false);
    await expect(isReturnerApiRequestAuthorized(new Request("https://returner.fund/api")))
      .resolves.toBe(true);
  });

  it("accepts the configured key as Bearer or the integration header", async () => {
    vi.stubEnv("RETURNER_API_KEY", "shared-secret");

    expect(isReturnerApiKeyConfigured()).toBe(true);
    await expect(isReturnerApiRequestAuthorized(new Request("https://returner.fund/api")))
      .resolves.toBe(false);
    await expect(isReturnerApiRequestAuthorized(new Request("https://returner.fund/api", {
      headers: { authorization: "Bearer shared-secret" },
    }))).resolves.toBe(true);
    await expect(isReturnerApiRequestAuthorized(new Request("https://returner.fund/api", {
      headers: { "x-returner-api-key": "shared-secret" },
    }))).resolves.toBe(true);
    await expect(isReturnerApiRequestAuthorized(new Request("https://returner.fund/api", {
      headers: { authorization: "Bearer wrong-secret" },
    }))).resolves.toBe(false);
  });

  it("recognizes only GET and HEAD on the exact versioned route", () => {
    const pathname = "/api/v1/companies/atlia/returner-fund";
    expect(isReturnerFundApiRequest({ method: "GET", pathname })).toBe(true);
    expect(isReturnerFundApiRequest({ method: "HEAD", pathname: `${pathname}/` })).toBe(true);
    expect(isReturnerFundApiRequest({ method: "POST", pathname })).toBe(false);
    expect(isReturnerFundApiRequest({ method: "GET", pathname: "/api/v1/companies/atlia" })).toBe(false);
  });
});
