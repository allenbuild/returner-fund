import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultInsiderMembers } from "@/lib/social/top-voices";
import { emptyInsiderConfiguration } from "@/lib/social/user-insiders";

const authenticateInsiderRequest = vi.fn();
const loadUserInsiderConfiguration = vi.fn();

vi.mock("@/lib/social/user-insiders-server", () => ({
  authenticateInsiderRequest,
  loadUserInsiderConfiguration
}));

describe("/api/insiders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the exact default list without exposing private data to an anonymous request", async () => {
    authenticateInsiderRequest.mockResolvedValue(null);
    const { GET } = await import("@/app/api/insiders/route");

    const response = await GET(new Request("http://localhost/api/insiders"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("private");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body.authenticated).toBe(false);
    expect(body.defaultMembers).toEqual(defaultInsiderMembers());
    expect(body.effectiveMembers).toHaveLength(58);
    expect(loadUserInsiderConfiguration).not.toHaveBeenCalled();
  });

  it("loads only the authenticated user's private configuration", async () => {
    const client = { rpc: vi.fn() };
    authenticateInsiderRequest.mockResolvedValue({ client, userId: "user-a" });
    loadUserInsiderConfiguration.mockResolvedValue({
      ...emptyInsiderConfiguration(),
      version: 3,
      excludedDefaultIds: [defaultInsiderMembers()[0].personId]
    });
    const { GET } = await import("@/app/api/insiders/route");

    const response = await GET(new Request("http://localhost/api/insiders", {
      headers: { Authorization: "Bearer trusted-session-token" }
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(loadUserInsiderConfiguration).toHaveBeenCalledWith(client, "user-a");
    expect(body.authenticated).toBe(true);
    expect(body.configuration.version).toBe(3);
    expect(body.effectiveMembers).toHaveLength(57);
  });

  it("rejects anonymous saves before parsing or writing any configuration", async () => {
    authenticateInsiderRequest.mockResolvedValue(null);
    const { PUT } = await import("@/app/api/insiders/route");

    const response = await PUT(new Request("http://localhost/api/insiders", {
      method: "PUT",
      body: JSON.stringify({
        expectedVersion: 0,
        excludedDefaultIds: [],
        weightOverrides: {},
        addedInsiders: []
      })
    }));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("authentication_required");
  });

  it("saves one validated snapshot atomically without accepting a client-supplied user id", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        version: 1,
        excluded_default_ids: [],
        weight_overrides: {},
        added_insiders: [],
        created_at: "2026-07-23T00:00:00.000Z",
        updated_at: "2026-07-23T00:00:00.000Z"
      },
      error: null
    });
    authenticateInsiderRequest.mockResolvedValue({
      client: { rpc },
      userId: "trusted-user"
    });
    const { PUT } = await import("@/app/api/insiders/route");

    const response = await PUT(new Request("http://localhost/api/insiders", {
      method: "PUT",
      headers: {
        Authorization: "Bearer trusted-session-token",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        expectedVersion: 0,
        excludedDefaultIds: [],
        weightOverrides: {},
        addedInsiders: []
      })
    }));

    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith("save_user_insider_configuration", {
      p_expected_version: 0,
      p_excluded_default_ids: [],
      p_weight_overrides: {},
      p_added_insiders: []
    });
    expect(JSON.stringify(rpc.mock.calls)).not.toContain("trusted-user");
  });

  it("maps an optimistic-lock failure to a non-destructive conflict response", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: {
        code: "40001",
        message: "Insiders configuration changed in another session."
      }
    });
    authenticateInsiderRequest.mockResolvedValue({
      client: { rpc },
      userId: "trusted-user"
    });
    const { PUT } = await import("@/app/api/insiders/route");

    const response = await PUT(new Request("http://localhost/api/insiders", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 2,
        excludedDefaultIds: [],
        weightOverrides: {},
        addedInsiders: []
      })
    }));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("configuration_conflict");
  });
});
