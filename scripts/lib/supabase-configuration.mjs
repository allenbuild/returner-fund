const SUPABASE_URL_BLOCKER = "NEXT_PUBLIC_SUPABASE_URL";
const SUPABASE_KEY_BLOCKER = "SUPABASE_SERVICE_ROLE_KEY";
const MODERN_SECRET_PREFIX = "sb_secret_";
const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;
const JWT_KEY_MIN_LENGTH = 80;
const JWT_KEY_MAX_LENGTH = 8192;
const MODERN_SECRET_MIN_LENGTH = 32;
const MODERN_SECRET_MAX_LENGTH = 512;
const PLACEHOLDER_MARKERS = [
  "redacted",
  "placeholder",
  "masked",
  "changeme",
  "replaceme",
  "configuredbutnotused",
  "notconfigured",
  "yourservicekey",
  "yourservicerolekey",
  "supabaseservicerolekey",
  "examplekey",
  "dummykey",
  "testkey"
];

/**
 * Validate the privileged Supabase endpoint without returning or interpolating
 * either credential. Production Actions must use TLS; local development may
 * use plain HTTP only for an actual loopback host.
 */
export function validateSupabaseConfiguration(
  rawUrl,
  rawServiceKey,
  { githubActions = process.env.GITHUB_ACTIONS === "true" } = {}
) {
  const url = clean(rawUrl);
  const serviceKey = clean(rawServiceKey);
  const blockers = [];

  if (!url) {
    blockers.push(SUPABASE_URL_BLOCKER);
  } else {
    let parsed = null;
    try {
      parsed = new URL(url);
    } catch {
      blockers.push(`${SUPABASE_URL_BLOCKER}:invalid_http_url`);
    }

    if (parsed) {
      const secureTransport = parsed.protocol === "https:";
      const localLoopbackTransport =
        parsed.protocol === "http:" &&
        githubActions !== true &&
        isLoopbackHostname(parsed.hostname);
      if (!secureTransport && !localLoopbackTransport) {
        blockers.push(
          parsed.protocol === "http:"
            ? `${SUPABASE_URL_BLOCKER}:insecure_transport`
            : `${SUPABASE_URL_BLOCKER}:invalid_http_url`
        );
      }
      if (!parsed.hostname) {
        blockers.push(`${SUPABASE_URL_BLOCKER}:invalid_http_url`);
      }
      if (parsed.username || parsed.password) {
        blockers.push(`${SUPABASE_URL_BLOCKER}:embedded_credentials`);
      }
      if (url.includes("?")) {
        blockers.push(`${SUPABASE_URL_BLOCKER}:query_not_allowed`);
      }
      if (url.includes("#")) {
        blockers.push(`${SUPABASE_URL_BLOCKER}:fragment_not_allowed`);
      }
    }
  }

  if (!serviceKey) {
    blockers.push(SUPABASE_KEY_BLOCKER);
  } else if (!isValidServiceRoleKey(serviceKey)) {
    blockers.push(`${SUPABASE_KEY_BLOCKER}:invalid_format`);
  }
  return {
    valid: blockers.length === 0,
    blockers: [...new Set(blockers)]
  };
}

function isValidServiceRoleKey(value) {
  if (isObviousPlaceholder(value)) return false;
  if (value.startsWith(MODERN_SECRET_PREFIX)) {
    return isValidModernSecretKey(value.slice(MODERN_SECRET_PREFIX.length));
  }
  return isValidJwtLikeKey(value);
}

function isValidModernSecretKey(secret) {
  return (
    secret.length >= MODERN_SECRET_MIN_LENGTH &&
    secret.length <= MODERN_SECRET_MAX_LENGTH &&
    BASE64URL_SEGMENT.test(secret) &&
    hasSensibleCharacterVariety(secret) &&
    !isObviousPlaceholder(secret)
  );
}

function isValidJwtLikeKey(value) {
  if (value.length < JWT_KEY_MIN_LENGTH || value.length > JWT_KEY_MAX_LENGTH) return false;
  const segments = value.split(".");
  if (segments.length !== 3) return false;

  const [header, payload, signature] = segments;
  if (
    header.length < 16 ||
    header.length > 512 ||
    payload.length < 16 ||
    payload.length > 4096 ||
    signature.length < 32 ||
    signature.length > 1024 ||
    !segments.every((segment) => BASE64URL_SEGMENT.test(segment)) ||
    !hasSensibleCharacterVariety(signature)
  ) {
    return false;
  }

  const decodedHeader = decodeBase64UrlJsonObject(header);
  const decodedPayload = decodeBase64UrlJsonObject(payload);
  return (
    decodedHeader !== null &&
    typeof decodedHeader.alg === "string" &&
    decodedHeader.alg.trim().length > 0 &&
    decodedHeader.alg.toLowerCase() !== "none" &&
    decodedPayload !== null &&
    Object.keys(decodedPayload).length > 0
  );
}

function decodeBase64UrlJsonObject(segment) {
  if (segment.length % 4 === 1) return null;
  try {
    const decoded = Buffer.from(segment, "base64url");
    if (decoded.toString("base64url") !== segment) return null;
    const parsed = JSON.parse(decoded.toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function hasSensibleCharacterVariety(value) {
  return new Set(value).size >= 8;
}

function isObviousPlaceholder(value) {
  const compact = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  if (!compact || /^(.)\1+$/.test(compact)) return true;
  return PLACEHOLDER_MARKERS.some((marker) => compact.includes(marker));
}

export function isLoopbackHostname(value) {
  const hostname = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "::1") {
    return true;
  }
  return /^127(?:\.\d{1,3}){3}$/.test(hostname) &&
    hostname.split(".").every((part) => Number(part) <= 255);
}

function clean(value) {
  const text = String(value ?? "").trim();
  return text || null;
}
