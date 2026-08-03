const SUPABASE_URL_BLOCKER = "NEXT_PUBLIC_SUPABASE_URL";
const SUPABASE_KEY_BLOCKER = "SUPABASE_SERVICE_ROLE_KEY";

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

  if (!serviceKey) blockers.push(SUPABASE_KEY_BLOCKER);
  return {
    valid: blockers.length === 0,
    blockers: [...new Set(blockers)]
  };
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
