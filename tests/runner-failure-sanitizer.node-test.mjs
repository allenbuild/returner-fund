import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeRunnerFailureMessage } from "../scripts/lib/runner-failure-sanitizer.mjs";

function assertSecretsAbsent(sanitized, secrets) {
  for (const secret of secrets) {
    assert.equal(sanitized.includes(secret), false, `leaked secret: ${secret}`);
  }
}

test("runner failure diagnostics redact explicit, encoded, query, token, cookie, and JWT secrets", () => {
  const configured = "configured-secret-value";
  const jwt = "eyJabcdefghijk.eyJabcdefghijk.abcdefghijklmno";
  const message = [
    `configured=${configured}`,
    "https://example.test/fail?access_token=query-secret&safe=yes",
    ["github", "pat", "ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"].join("_"),
    ["xoxb", "123456789012", "abcdefghijkl"].join("-"),
    ["AK", "IA", "ABCDEFGHIJKLMNOP"].join(""),
    `Bearer ${jwt}`,
    `li_at=${encodeURIComponent("cookie-value-abcdefghijkl")}`,
    encodeURIComponent(`encoded=${configured}`),
    "line\nwith\u0000controls"
  ].join(" ");
  const sanitized = sanitizeRunnerFailureMessage(message, { secrets: [configured] });

  assertSecretsAbsent(sanitized, [
    configured,
    "query-secret",
    "github_pat_",
    "xoxb-",
    "AKIA",
    jwt,
    "cookie-value"
  ]);
  assert.doesNotMatch(sanitized, /[\u0000-\u001f\u007f-\u009f]/);
  assert.match(sanitized, /safe=yes/);
});

test(["runner failure diagnostics redact Basic and Bearer", "authorization variants"].join(" "), () => {
  const secrets = [
    "dXNlcjpwYXNzd29yZA==",
    "cHJveHk6c2VjcmV0",
    "short.bearer+/=",
    "github-token-value"
  ];
  const message = [
    `Authorization: Basic ${secrets[0]}`,
    `Proxy-Authorization=Basic ${secrets[1]}`,
    `Bearer ${secrets[2]}`,
    `Authorization: token ${secrets[3]}`
  ].join("\n");
  const sanitized = sanitizeRunnerFailureMessage(message);

  assertSecretsAbsent(sanitized, secrets);
  assert.match(sanitized, /Authorization: \[redacted\]/i);
  assert.match(sanitized, /Bearer \[redacted\]/i);
});

test("runner failure diagnostics redact quoted object-style authorization values", () => {
  const secrets = [
    "dXNlcjpwYXNzd29yZA==",
    "quoted-bearer-secret",
    "quoted-proxy-secret"
  ];
  const message = [
    `{"authorization":"Basic ${secrets[0]}"}`,
    `{ authorization: 'Bearer ${secrets[1]}' }`,
    `{ "proxy-authorization": "token ${secrets[2]}" }`
  ].join(" ");
  const sanitized = sanitizeRunnerFailureMessage(message);

  assertSecretsAbsent(sanitized, secrets);
  assert.equal((sanitized.match(/\[redacted\]/g) ?? []).length, 3);
});

test("runner failure diagnostics redact plain, encoded, and non-HTTP URL userinfo", () => {
  const secrets = ["alice:correct-horse", "svc:p%40ssword", "encoded-user:encoded-pass"];
  const message = [
    "https://alice:correct-horse@example.test/path?safe=yes",
    "postgresql://svc:p%40ssword@db.example.test/returner",
    "https%3A%2F%2Fencoded-user%3Aencoded-pass%40encoded.example.test%2Fprivate"
  ].join(" ");
  const sanitized = sanitizeRunnerFailureMessage(message);

  assertSecretsAbsent(sanitized, [...secrets, "correct-horse", "p@ssword", "encoded-pass"]);
  assert.match(sanitized, /https:\/\/\[redacted\]@example\.test\/path\?safe=yes/);
  assert.match(sanitized, /postgresql:\/\/\[redacted\]@db\.example\.test\/returner/);
  assert.match(sanitized, /https:\/\/\[redacted\]@encoded\.example\.test\/private/);
});

test("runner failure diagnostics redact arbitrary Cookie and Set-Cookie values", () => {
  const secrets = ["secret-cookie-one", "secret-cookie-two", "secret-cookie-three"];
  const message = [
    "request failed safely",
    `Cookie: harmless=one; arbitrary_session=${secrets[0]}; feature=x`,
    `Set-Cookie: completely_custom=${secrets[1]}; Path=/; HttpOnly`,
    `metadata cookie='free_form=${secrets[2]}'`,
    "diagnostic tail"
  ].join("\n");
  const sanitized = sanitizeRunnerFailureMessage(message);

  assertSecretsAbsent(sanitized, secrets);
  assert.match(sanitized, /Cookie:\s*\[redacted\]/i);
  assert.match(sanitized, /Set-Cookie:\s*\[redacted\]/i);
  assert.match(sanitized, /request failed safely/);
  assert.match(sanitized, /diagnostic tail/);
});

test("runner failure diagnostics redact generic API key and token assignments", () => {
  const secrets = [
    "api-key-secret",
    "camel-token-secret",
    "refresh-token-secret",
    "quoted-client-secret",
    "generic-token-secret",
    "AIzaSyExampleApiKeyMaterial123456",
    "sk_live_1234567890abcdefghijkl"
  ];
  const message = [
    `X-API-Key: ${secrets[0]}`,
    `accessToken=${secrets[1]}`,
    `refresh_token='${secrets[2]}'`,
    `"client_secret":"${secrets[3]}"`,
    `token=${secrets[4]}`,
    secrets[5],
    secrets[6],
    "safe_field=visible"
  ].join(" ");
  const sanitized = sanitizeRunnerFailureMessage(message);

  assertSecretsAbsent(sanitized, secrets);
  assert.match(sanitized, /safe_field=visible/);
});

test("runner failure diagnostics redact double-encoded credentials amid malformed escapes", () => {
  const doubleEncoded = encodeURIComponent(encodeURIComponent("https://nested:deep-secret@example.test/path"));
  const sanitized = sanitizeRunnerFailureMessage(`${doubleEncoded} malformed=%ZZ token=last-secret`);

  assertSecretsAbsent(sanitized, ["nested", "deep-secret", "last-secret"]);
  assert.match(sanitized, /https:\/\/\[redacted\]@example\.test\/path/);
});

test("runner failure diagnostics are single-line and bounded", () => {
  const sanitized = sanitizeRunnerFailureMessage(`a\n${"b".repeat(5000)}`);
  assert.equal(sanitized.length, 2048);
  assert.equal(sanitized.includes("\n"), false);
});
