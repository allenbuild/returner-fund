const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const SITE_ACCESS_COOKIE = "returner_site_access";
export const SITE_ACCESS_DURATION_SECONDS = 60 * 60 * 24 * 14;

type SiteAccessConfiguration = {
  password: string;
  signingSecret: string;
};

type SiteAccessSession = {
  expiresAt: number;
  nonce: string;
  version: 1;
};

function siteAccessConfiguration(): SiteAccessConfiguration | null {
  const password = process.env.SITE_PASSWORD ?? "";
  const signingSecret = process.env.SITE_ACCESS_SECRET?.trim() ?? "";

  if (!password || !signingSecret) {
    return null;
  }

  return { password, signingSecret };
}

export function isSiteAccessConfigured(): boolean {
  return siteAccessConfiguration() !== null;
}

export async function passwordMatchesSiteAccess(password: unknown): Promise<boolean> {
  const configuration = siteAccessConfiguration();
  if (!configuration || typeof password !== "string") {
    return false;
  }

  const key = await signingKey(configuration.signingSecret);
  const configuredPasswordSignature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(configuration.password)
  );

  return crypto.subtle.verify(
    "HMAC",
    key,
    configuredPasswordSignature,
    encoder.encode(password)
  );
}

export async function createSiteAccessToken(now = Date.now()): Promise<string | null> {
  const configuration = siteAccessConfiguration();
  if (!configuration) {
    return null;
  }

  const session: SiteAccessSession = {
    expiresAt: now + SITE_ACCESS_DURATION_SECONDS * 1000,
    nonce: bytesToBase64Url(crypto.getRandomValues(new Uint8Array(18))),
    version: 1
  };
  const payload = bytesToBase64Url(encoder.encode(JSON.stringify(session)));
  const signature = await sign(payload, configuration.signingSecret);

  return `${payload}.${signature}`;
}

export async function hasValidSiteAccessToken(token: string | undefined, now = Date.now()): Promise<boolean> {
  const configuration = siteAccessConfiguration();
  if (!configuration || !token || token.length > 1024) {
    return false;
  }

  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) {
    return false;
  }

  try {
    const verified = await verify(payload, signature, configuration.signingSecret);
    if (!verified) {
      return false;
    }

    const session = JSON.parse(decoder.decode(base64UrlToBytes(payload))) as Partial<SiteAccessSession>;
    return session.version === 1 &&
      typeof session.expiresAt === "number" &&
      Number.isFinite(session.expiresAt) &&
      session.expiresAt > now &&
      typeof session.nonce === "string" &&
      session.nonce.length >= 16;
  } catch {
    return false;
  }
}

/**
 * Preserve existing server-to-server jobs that already authenticate to one of
 * the scoped mutation/diagnostic routes. The route itself rechecks the same
 * credential after this site-wide browser gate lets it through.
 */
export async function hasTrustedAutomationCredential(
  request: Pick<Request, "headers">,
  pathname: string
): Promise<boolean> {
  const configuration = siteAccessConfiguration();
  if (!configuration) {
    return false;
  }

  const configuredSecrets = automationSecretEnvironmentVariables(pathname)
    .map((name) => process.env[name])
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  if (configuredSecrets.length === 0) {
    return false;
  }

  const authorization = request.headers.get("authorization");
  const bearer = authorization?.match(/^Bearer\s+([^,\s]+)$/i)?.[1];
  const candidates = [
    bearer,
    request.headers.get("x-admin-ingestion-secret")?.trim(),
    request.headers.get("x-admin-timeline-secret")?.trim(),
    request.headers.get("x-graph-diagnostics-secret")?.trim(),
    request.headers.get("x-graph-refresh-secret")?.trim(),
    request.headers.get("x-ingest-batch-secret")?.trim(),
    request.headers.get("x-refresh-secret")?.trim()
  ].filter((value): value is string => Boolean(value));

  if (candidates.length === 0) {
    return false;
  }

  const key = await signingKey(configuration.signingSecret);
  const expectedSignatures = await Promise.all(
    configuredSecrets.map((secret) => crypto.subtle.sign("HMAC", key, encoder.encode(secret)))
  );

  for (const candidate of candidates) {
    for (const expectedSignature of expectedSignatures) {
      if (await crypto.subtle.verify("HMAC", key, expectedSignature, encoder.encode(candidate))) {
        return true;
      }
    }
  }

  return false;
}

function automationSecretEnvironmentVariables(pathname: string): readonly string[] {
  if (pathname === "/api/graph/refresh") {
    return ["GRAPH_REFRESH_SECRET", "REFRESH_SECRET"];
  }

  if (pathname === "/api/graph/full" || pathname === "/api/admin/ingestion") {
    return ["ADMIN_INGESTION_SECRET", "REFRESH_SECRET"];
  }

  if (pathname === "/api/ingest/batch") {
    return ["INGEST_BATCH_SECRET", "REFRESH_SECRET"];
  }

  if (pathname.startsWith("/api/admin/timeline/")) {
    return ["ADMIN_TIMELINE_SECRET"];
  }

  return [];
}

export function siteAccessCookieOptions() {
  return {
    httpOnly: true,
    maxAge: SITE_ACCESS_DURATION_SECONDS,
    path: "/",
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production"
  };
}

async function signingKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign", "verify"]
  );
}

async function sign(payload: string, secret: string): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", await signingKey(secret), encoder.encode(payload));
  return bytesToBase64Url(new Uint8Array(signature));
}

async function verify(payload: string, signature: string, secret: string): Promise<boolean> {
  return crypto.subtle.verify(
    "HMAC",
    await signingKey(secret),
    base64UrlToBytes(signature).buffer as ArrayBuffer,
    encoder.encode(payload)
  );
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Invalid base64url value.");
  }

  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}
