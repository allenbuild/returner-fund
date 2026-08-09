import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateSupabaseConfiguration } from "../scripts/lib/supabase-configuration.mjs";

const VALID_URL = "https://project-ref.supabase.co";
const VALID_SIGNATURE = "aB3dE5fG7hJ9kL2mN4pQ6rS8tU1vW3xY5z_7-A9bC2d";

describe("Supabase service-role key validation", () => {
  it("accepts a JWT-like key with canonical base64url JSON segments", () => {
    const key = jwtLikeKey({ role: "service_role", ref: "project-ref" });

    assert.deepEqual(validateSupabaseConfiguration(VALID_URL, key), {
      valid: true,
      blockers: []
    });
  });

  it("accepts a modern sb_secret_ key with a suitably long opaque suffix", () => {
    const key = "sb_secret_aB3dE5fG7hJ9kL2mN4pQ6rS8tU1vW3xY5z_7-A9bC2d";

    assert.deepEqual(validateSupabaseConfiguration(VALID_URL, key), {
      valid: true,
      blockers: []
    });
  });

  it("preserves the missing-key blocker for empty values", () => {
    assert.deepEqual(validateSupabaseConfiguration(VALID_URL, "  "), {
      valid: false,
      blockers: ["SUPABASE_SERVICE_ROLE_KEY"]
    });
  });

  it("rejects redacted, placeholder, short, and publishable-key values", () => {
    const invalidKeys = [
      "[redacted]",
      "configured-but-not-used",
      "your-service-role-key",
      "short",
      "sb_secret_short",
      `sb_secret_${"aB3dE5fG7hJ9kL2mN4pQ6rS8tU1vW3xY".slice(0, 31)}`,
      `sb_secret_${"x".repeat(40)}`,
      "sb_secret_placeholder_value_that_is_long_enough_123456",
      "sb_secret_aB3dE5fG7hJ9kL2mN4pQ6rS8tU1vW3xY5z+7-A9bC2d",
      "sb_publishable_aB3dE5fG7hJ9kL2mN4pQ6rS8tU1vW3xY5z_7-A9bC2d"
    ];

    for (const key of invalidKeys) {
      assert.deepEqual(
        validateSupabaseConfiguration(VALID_URL, key),
        {
          valid: false,
          blockers: ["SUPABASE_SERVICE_ROLE_KEY:invalid_format"]
        },
        key
      );
    }
  });

  it("rejects malformed or implausibly short JWT-like keys", () => {
    const validHeader = encodeJson({ alg: "HS256", typ: "JWT" });
    const validPayload = encodeJson({ role: "service_role" });
    const invalidKeys = [
      `${validHeader}.${validPayload}`,
      "a.b.c",
      `${validHeader}..${VALID_SIGNATURE}`,
      `.${validPayload}.${VALID_SIGNATURE}`,
      `${validHeader}.${validPayload}.${VALID_SIGNATURE}.extra`,
      `${validHeader}.${validPayload}.short`,
      `${validHeader}.${validPayload}.${"x".repeat(43)}`,
      `${validHeader}.not+base64url.${VALID_SIGNATURE}`,
      `${encodeJson({ alg: "none", typ: "JWT" })}.${validPayload}.${VALID_SIGNATURE}`,
      `${encodeJson({ typ: "JWT" })}.${validPayload}.${VALID_SIGNATURE}`
    ];

    for (const key of invalidKeys) {
      assert.deepEqual(
        validateSupabaseConfiguration(VALID_URL, key),
        {
          valid: false,
          blockers: ["SUPABASE_SERVICE_ROLE_KEY:invalid_format"]
        },
        key
      );
    }
  });

  it("reports URL and service-key format blockers together without exposing either value", () => {
    const result = validateSupabaseConfiguration("masked-url", "masked-key");

    assert.deepEqual(result, {
      valid: false,
      blockers: [
        "NEXT_PUBLIC_SUPABASE_URL:invalid_http_url",
        "SUPABASE_SERVICE_ROLE_KEY:invalid_format"
      ]
    });
    assert.doesNotMatch(JSON.stringify(result), /masked-url|masked-key/);
  });
});

function jwtLikeKey(payload) {
  return `${encodeJson({ alg: "HS256", typ: "JWT" })}.${encodeJson(payload)}.${VALID_SIGNATURE}`;
}

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
