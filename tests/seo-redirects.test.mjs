import { describe, expect, it } from "vitest";
import nextConfig from "../next.config.mjs";

describe("legacy SEO route redirects", () => {
  it("permanently consolidates duplicate intent pages into the live map", async () => {
    const redirects = await nextConfig.redirects();

    expect(redirects).toEqual(expect.arrayContaining([
      { source: "/yc-network-map", destination: "/", permanent: true },
      { source: "/yc-social-traction", destination: "/", permanent: true },
      { source: "/a16z-network-map", destination: "/?batch=A16ZSR006", permanent: true },
      { source: "/a16z-social-traction", destination: "/?batch=A16ZSR006", permanent: true }
    ]));
  });
});
