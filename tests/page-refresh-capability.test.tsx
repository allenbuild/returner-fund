import { afterEach, describe, expect, it, vi } from "vitest";

describe("page refresh capability", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("enables local manual refresh and disables the unauthenticated production control", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { default: DevelopmentHome } = await import("@/app/page");
    const developmentPage = await DevelopmentHome({ searchParams: Promise.resolve({}) });
    expect(developmentPage.props.manualRefreshEnabled).toBe(true);

    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    const { default: ProductionHome } = await import("@/app/page");
    const productionPage = await ProductionHome({ searchParams: Promise.resolve({}) });
    expect(productionPage.props.manualRefreshEnabled).toBe(false);
  });
});
