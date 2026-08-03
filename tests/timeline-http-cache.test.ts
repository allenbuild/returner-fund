import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearTimelineHttpCacheForTests,
  getOrBuildTimelineHttpResult,
  getOrBuildTimelineHttpValue,
  invalidateTimelineHttpCache,
} from "@/lib/timeline/http-cache";

describe("timeline HTTP response cache", () => {
  afterEach(() => {
    clearTimelineHttpCacheForTests();
    vi.useRealTimers();
  });

  it("coalesces identical requests and retains the completed value", async () => {
    const build = vi.fn(async () => ({ events: ["event-1"] }));
    const input = {
      key: "acme:all",
      scope: { companyId: "company-acme" },
      build,
    };

    const [first, second] = await Promise.all([
      getOrBuildTimelineHttpValue(input),
      getOrBuildTimelineHttpValue(input),
    ]);
    const third = await getOrBuildTimelineHttpValue(input);

    expect(first).toEqual(second);
    expect(third).toEqual(first);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("invalidates only matching company scopes", async () => {
    const acmeBuild = vi.fn(async () => "acme");
    const otherBuild = vi.fn(async () => "other");
    await getOrBuildTimelineHttpValue({
      key: "acme",
      scope: { companyId: "company-acme" },
      build: acmeBuild,
    });
    await getOrBuildTimelineHttpValue({
      key: "other",
      scope: { companyId: "company-other" },
      build: otherBuild,
    });

    invalidateTimelineHttpCache({ companyId: "company-acme" });
    await getOrBuildTimelineHttpValue({
      key: "acme",
      scope: { companyId: "company-acme" },
      build: acmeBuild,
    });
    await getOrBuildTimelineHttpValue({
      key: "other",
      scope: { companyId: "company-other" },
      build: otherBuild,
    });

    expect(acmeBuild).toHaveBeenCalledTimes(2);
    expect(otherBuild).toHaveBeenCalledTimes(1);
  });

  it("reports miss, coalesced, then hit for benchmark observability", async () => {
    let resolveBuild: ((value: string) => void) | undefined;
    const build = vi.fn(() => new Promise<string>((resolve) => { resolveBuild = resolve; }));
    const input = { key: "observed", scope: { companyId: "company-acme" }, build };
    const first = getOrBuildTimelineHttpResult(input);
    const second = getOrBuildTimelineHttpResult(input);
    await vi.waitFor(() => expect(resolveBuild).toBeTypeOf("function"));
    resolveBuild?.("value");

    expect((await first).status).toBe("miss");
    expect((await second).status).toBe("coalesced");
    expect((await getOrBuildTimelineHttpResult(input)).status).toBe("hit");
  });
});
