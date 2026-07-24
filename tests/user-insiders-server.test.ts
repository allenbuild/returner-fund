import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  authenticateInsiderRequest,
  createInsiderRlsClient
} from "@/lib/social/user-insiders-server";

const { createServerSupabaseClient } = vi.hoisted(() => ({
  createServerSupabaseClient: vi.fn()
}));

vi.mock("@/lib/db/client", () => ({
  createServerSupabaseClient
}));

describe("user Insiders server authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a bearer-bound RLS client without an extra Auth round trip", () => {
    const client = { rpc: vi.fn() };
    createServerSupabaseClient.mockReturnValue(client);

    const result = createInsiderRlsClient(new Request("http://localhost/api/insiders", {
      headers: { Authorization: "Bearer trusted-token" }
    }));

    expect(result).toBe(client);
    expect(createServerSupabaseClient).toHaveBeenCalledWith({ accessToken: "trusted-token" });
  });

  it("refuses to create an RLS client when no bearer token is present", () => {
    const result = createInsiderRlsClient(new Request("http://localhost/api/insiders"));

    expect(result).toBeNull();
    expect(createServerSupabaseClient).not.toHaveBeenCalled();
  });

  it("uses verified JWT claims when a route needs the authenticated user id", async () => {
    const getClaims = vi.fn().mockResolvedValue({
      data: { claims: { sub: "user-a" } },
      error: null
    });
    const client = { auth: { getClaims } };
    createServerSupabaseClient.mockReturnValue(client);

    const result = await authenticateInsiderRequest(new Request("http://localhost/api/graph", {
      headers: { Authorization: "Bearer trusted-token" }
    }));

    expect(getClaims).toHaveBeenCalledWith("trusted-token");
    expect(result).toEqual({ client, userId: "user-a" });
  });

  it("rejects a token whose claims cannot be verified", async () => {
    createServerSupabaseClient.mockReturnValue({
      auth: {
        getClaims: vi.fn().mockResolvedValue({
          data: null,
          error: new Error("Invalid JWT")
        })
      }
    });

    const result = await authenticateInsiderRequest(new Request("http://localhost/api/graph", {
      headers: { Authorization: "Bearer invalid-token" }
    }));

    expect(result).toBeNull();
  });
});
