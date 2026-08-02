const STREAM_CHUNK_BYTES = 64 * 1024;

/**
 * Streams JSON so large graph responses are not buffered behind Vercel's
 * Function response-body limit. Encoding is performed once to preserve Unicode
 * code points across chunk boundaries.
 */
export function streamJsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + STREAM_CHUNK_BYTES, bytes.byteLength);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    }
  });
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(stream, { ...init, headers });
}
