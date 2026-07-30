import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyInsiderConfiguration } from "@/lib/social/user-insiders";

const readFile = vi.fn();
const authenticateInsiderRequest = vi.fn();
const loadUserInsiderConfiguration = vi.fn();
const clearGraphResponseCache = vi.fn();

vi.mock("@/lib/graph/runtime-graph-snapshot-file", () => ({
  readRuntimeGraphSnapshotFile: readFile
}));
vi.mock("@/lib/social/user-insiders-server", () => ({
  authenticateInsiderRequest,
  loadUserInsiderConfiguration
}));
vi.mock("@/lib/graph/graph-response-cache", () => ({ clearGraphResponseCache }));

const snapshotBodies = new Map(
  [
    "s2026.json",
    "s2026-insiders.json",
    "s26.json",
    "s26-insiders.json",
    "a16zsr006.json",
    "a16zsr006-insiders.json"
  ].map((filename) => [
    `/graph/${filename}`,
    readFileSync(join(process.cwd(), "public", "graph", filename), "utf8")
  ])
);

describe("POST /api/insiders/recompute snapshot CDN fallback", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv("VERCEL_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    readFile.mockRejectedValue(
      Object.assign(new Error("not traced into the serverless function"), {
        code: "ENOENT"
      })
    );
    authenticateInsiderRequest.mockResolvedValue({
      client: {},
      userId: "user-a"
    });
    loadUserInsiderConfiguration.mockResolvedValue({
      ...emptyInsiderConfiguration(),
      version: 11
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      );
      const body = snapshotBodies.get(url.pathname);
      return body
        ? new Response(body, {
            status: 200,
            headers: {
              "content-type": "application/json",
              "content-length": String(Buffer.byteLength(body))
            }
          })
        : new Response("not found", { status: 404 });
    }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each([
    ["S2026", "s2026"],
    ["S26", "s26"],
    ["A16ZSR006", "a16zsr006"]
  ] as const)(
    "loads the %s base and Insider snapshots from fixed CDN paths",
    async (batchSlug, filename) => {
      const { POST } = await import("@/app/api/insiders/recompute/route");
      const response = await POST(
        new Request("https://www.returner.fund/api/insiders/recompute", {
          method: "POST",
          headers: {
            Authorization: "Bearer token",
            "content-type": "application/json"
          },
          body: JSON.stringify({ batchSlug, insiderIds: [] })
        })
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        status: "recomputed",
        graph: {
          batch: { slug: batchSlug },
          insiderConfigurationVersion: 11
        }
      });
      expect(fetch).toHaveBeenCalledWith(
        new URL(`https://www.returner.fund/graph/${filename}-insiders.json`),
        expect.objectContaining({ cache: "no-store" })
      );
      expect(fetch).toHaveBeenCalledWith(
        new URL(`https://www.returner.fund/graph/${filename}.json`),
        expect.objectContaining({ cache: "no-store" })
      );
    },
    30_000
  );

  it("never derives the snapshot origin from the authenticated request host", async () => {
    const { POST } = await import("@/app/api/insiders/recompute/route");
    const response = await POST(
      new Request("https://attacker.invalid/api/insiders/recompute", {
        method: "POST",
        headers: {
          Authorization: "Bearer token",
          "content-type": "application/json"
        },
        body: JSON.stringify({ batchSlug: "S26", insiderIds: [] })
      })
    );

    expect(response.status).toBe(200);
    const fetchedUrls = vi.mocked(fetch).mock.calls.map(([input]) =>
      new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      )
    );
    expect(fetchedUrls).toHaveLength(2);
    expect(fetchedUrls.every((url) => url.origin === "https://www.returner.fund"))
      .toBe(true);
  });
});
