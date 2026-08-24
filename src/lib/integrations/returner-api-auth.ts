const encoder = new TextEncoder();
const RETURNER_FUND_API_PATH = /^\/api\/v1\/companies\/[^/]+\/returner-fund\/?$/;

export function isReturnerFundApiRequest(input: {
  method: string;
  pathname: string;
}): boolean {
  return (input.method === "GET" || input.method === "HEAD") &&
    RETURNER_FUND_API_PATH.test(input.pathname);
}

export function isReturnerApiKeyConfigured(): boolean {
  return configuredApiKey() !== null;
}

/**
 * The read-only API is public when RETURNER_API_KEY is unset. Deployments that
 * want a pre-shared key can set it without changing the Midas response shape.
 */
export async function isReturnerApiRequestAuthorized(
  request: Pick<Request, "headers">
): Promise<boolean> {
  const expected = configuredApiKey();
  if (!expected) return true;

  const authorization = request.headers.get("authorization");
  const bearer = authorization?.match(/^Bearer\s+([^,\s]+)$/i)?.[1] ?? null;
  const candidates = [
    bearer,
    request.headers.get("x-returner-api-key")?.trim() ?? null,
    request.headers.get("x-api-key")?.trim() ?? null,
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (await constantTimeKeyMatch(expected, candidate)) return true;
  }
  return false;
}

function configuredApiKey(): string | null {
  const value = process.env.RETURNER_API_KEY?.trim() ?? "";
  return value || null;
}

async function constantTimeKeyMatch(expected: string, candidate: string): Promise<boolean> {
  if (!candidate) return false;
  const data = encoder.encode("returner-fund-read-only-api");
  const expectedKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(expected),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const candidateKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(candidate),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const signature = await crypto.subtle.sign("HMAC", expectedKey, data);
  return crypto.subtle.verify("HMAC", candidateKey, signature, data);
}
