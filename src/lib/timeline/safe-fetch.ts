import { isIP } from "node:net";
import { resolve4, resolve6 } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { isPrivateOrReservedAddress as isPrivateOrReservedNetworkAddress } from "./network-address";
import { canonicalizeSourceUrl } from "./source-document";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.google.com",
  "instance-data",
]);

export interface SafeSourceFetchOptions {
  timeoutMs?: number;
  /** Absolute wall-clock deadline shared across redirects and body reads. */
  deadlineAt?: number;
  maxBytes?: number;
  maxRedirects?: number;
  allowedMimeTypes?: readonly string[];
  fetchImpl?: typeof fetch;
  /**
   * Production transports may pin the TCP destination to one of the already
   * validated addresses while preserving the URL hostname for TLS/SNI.
   */
  pinnedFetchImpl?: (url: URL, validatedAddresses: readonly string[], init: RequestInit) => Promise<Response>;
  resolveAddresses?: (hostname: string) => Promise<string[]>;
}

export interface SafeSourceFetchResult {
  originalUrl: string;
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  fetchedAt: string;
  redirects: string[];
}

export function isPrivateOrReservedAddress(address: string): boolean {
  return isPrivateOrReservedNetworkAddress(address);
}

export function assertSafeSourceUrl(value: string): URL {
  const canonical = new URL(canonicalizeSourceUrl(value));
  const hostname = canonical.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new TypeError(`Blocked timeline source hostname: ${hostname}`);
  }
  if (canonical.port && canonical.port !== "80" && canonical.port !== "443") {
    throw new TypeError("Timeline source URLs may use only ports 80 and 443.");
  }
  if (isIP(hostname) && isPrivateOrReservedAddress(hostname)) {
    throw new TypeError("Timeline source URL resolves to a private or reserved address.");
  }
  return canonical;
}

async function defaultResolveAddresses(hostname: string): Promise<string[]> {
  if (isIP(hostname)) return [hostname];
  const [v4, v6] = await Promise.all([
    resolve4(hostname).catch(() => []),
    resolve6(hostname).catch(() => []),
  ]);
  return [...v4, ...v6];
}

export async function fetchSafeTimelineSource(
  value: string,
  options: SafeSourceFetchOptions = {},
): Promise<SafeSourceFetchResult> {
  const originalUrl = assertSafeSourceUrl(value).toString();
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 12_000, 1_000), 30_000);
  const maxBytes = Math.min(Math.max(options.maxBytes ?? 2_000_000, 1_024), 5_000_000);
  const maxRedirects = Math.min(Math.max(options.maxRedirects ?? 4, 0), 5);
  const allowedMimeTypes = options.allowedMimeTypes ?? ["text/html", "text/plain", "application/json", "application/xml", "text/xml", "application/rss+xml", "application/atom+xml"];
  const resolveAddresses = options.resolveAddresses ?? defaultResolveAddresses;
  const fetchImpl = options.fetchImpl ?? fetch;
  const redirects: string[] = [];
  let currentUrl = originalUrl;

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const safeUrl = assertSafeSourceUrl(currentUrl);
    const controller = new AbortController();
    const remainingMs = options.deadlineAt === undefined
      ? timeoutMs
      : Math.min(timeoutMs, Math.floor(options.deadlineAt - Date.now()));
    if (remainingMs <= 0) throw new Error("Timeline source fetch exceeded its shared deadline.");
    const timeout = setTimeout(() => controller.abort(), Math.max(1, remainingMs));
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let bodyConsumed = false;
    try {
      const hostname = safeUrl.hostname.replace(/^\[|\]$/g, "");
      const addresses = [...new Set(await abortable(resolveAddresses(hostname), controller.signal))].sort();
      if (!addresses.length || addresses.some(isPrivateOrReservedAddress)) {
        throw new TypeError("Timeline source DNS resolution was empty or included a private address.");
      }
      const requestInit: RequestInit = {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Accept: "text/html,text/plain,application/json,application/xml;q=0.9,*/*;q=0.1",
          "User-Agent": "ReturnerTimelineBot/1.0 (+https://www.returner.fund)",
        },
      };
      if (options.pinnedFetchImpl || !options.fetchImpl) {
        response = await (options.pinnedFetchImpl ?? defaultPinnedFetch)(safeUrl, addresses, requestInit);
      } else {
        // Native fetch cannot pin DNS. Re-resolve immediately before opening
        // the request and require the same public address set. This closes the
        // common rebinding window; deployments with a pin-capable dispatcher
        // should supply `pinnedFetchImpl` to eliminate the TOCTOU entirely.
        const revalidated = [...new Set(await abortable(resolveAddresses(hostname), controller.signal))].sort();
        if (revalidated.length !== addresses.length || revalidated.some((address, index) => address !== addresses[index])
            || revalidated.some(isPrivateOrReservedAddress)) {
          throw new TypeError("Timeline source DNS changed during validation.");
        }
        response = await fetchImpl(safeUrl, requestInit);
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error(`Timeline source redirect ${response.status} omitted Location.`);
        if (redirectCount === maxRedirects) throw new Error("Timeline source exceeded redirect limit.");
        currentUrl = new URL(location, safeUrl).toString();
        redirects.push(assertSafeSourceUrl(currentUrl).toString());
        continue;
      }

      // An error document can still be HTML and can repeat company/event terms.
      // Treating that body as verified evidence would allow a branded 404 or a
      // provider error page to become a publishable source document.
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Timeline source returned HTTP ${response.status}.`);
      }

      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
      if (!allowedMimeTypes.includes(contentType)) {
        throw new TypeError(`Timeline source MIME type is not allowed: ${contentType || "missing"}`);
      }
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw new RangeError("Timeline source exceeds the configured content-size limit.");
      }

      reader = response.body?.getReader();
      if (!reader) throw new Error("Timeline source response body is unavailable.");
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value: chunk } = await abortable(reader.read(), controller.signal);
        if (done) break;
        size += chunk.byteLength;
        if (size > maxBytes) {
          await reader.cancel("content-size limit exceeded");
          throw new RangeError("Timeline source exceeds the configured content-size limit.");
        }
        chunks.push(chunk);
      }
      bodyConsumed = true;
      reader.releaseLock();
      reader = undefined;
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return {
        originalUrl,
        finalUrl: canonicalizeSourceUrl(response.url || currentUrl),
        status: response.status,
        contentType,
        body: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
        fetchedAt: new Date().toISOString(),
        redirects,
      };
    } finally {
      if (reader && !bodyConsumed) {
        try {
          await reader.cancel("timeline source request ended before the body was consumed");
        } catch {
          // The transport abort may have already errored the stream.
        }
        try { reader.releaseLock(); } catch { /* The stream may already be detached. */ }
      }
      if (response && !bodyConsumed) await cancelResponseBody(response);
      clearTimeout(timeout);
    }
  }
  throw new Error("Timeline source fetch failed unexpectedly.");
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel("timeline source response was not consumed");
  } catch {
    // A stream may already be locked or aborted; the transport signal still
    // guarantees that the underlying request is torn down.
  }
}

/**
 * Node's request transport keeps the URL hostname for Host and TLS/SNI while
 * its custom lookup returns only the already validated public address. This
 * eliminates DNS-rebinding TOCTOU in production without trusting a later
 * resolver invocation. Tests may inject `fetchImpl` to exercise fallback
 * behavior, and deployments may replace this with another pin-capable client.
 */
async function defaultPinnedFetch(
  url: URL,
  validatedAddresses: readonly string[],
  init: RequestInit,
): Promise<Response> {
  const address = validatedAddresses[0];
  const family = address ? isIP(address) : 0;
  if (!address || (family !== 4 && family !== 6) || isPrivateOrReservedAddress(address)) {
    throw new TypeError("Timeline source has no validated public destination address.");
  }
  return new Promise<Response>((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: init.method ?? "GET",
      headers: requestHeaders(init.headers),
      signal: init.signal ?? undefined,
      lookup: ((_hostname: string, lookupOptions: { all?: boolean }, callback: (...args: unknown[]) => void) => {
        if (lookupOptions?.all) callback(null, [{ address, family }]);
        else callback(null, address, family);
      }) as never,
    }, (incoming) => resolve(nodeResponse(incoming)));
    request.once("error", reject);
    if (init.body === undefined || init.body === null) request.end();
    else if (typeof init.body === "string" || init.body instanceof Uint8Array) request.end(init.body);
    else {
      request.destroy(new TypeError("Pinned timeline fetch accepts only string or byte request bodies."));
    }
  });
}

function requestHeaders(input: HeadersInit | undefined): Record<string, string> {
  const headers = new Headers(input);
  return Object.fromEntries(headers.entries());
}

function nodeResponse(incoming: IncomingMessage): Response {
  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else if (value !== undefined) headers.set(key, value);
  }
  return new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, {
    status: incoming.statusCode ?? 500,
    statusText: incoming.statusMessage,
    headers,
  });
}
