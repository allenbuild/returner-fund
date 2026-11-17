import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile, rename } from "node:fs/promises";
import { resolve, join } from "node:path";

// Local file intake for observations already read through the authorized UI.
// This has no social credentials, external fetches, or browser-control APIs.
const port = Number(process.env.BROWSER_CHECKPOINT_PORT ?? 34579);
const output = resolve(process.cwd(), "outputs/fall-2026/browser-checkpoints");
const origin = `http://127.0.0.1:${port}`;
const token = randomBytes(32).toString("hex");
await mkdir(output, { recursive: true });
const headers = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff"
};
const page = (message = "") => `<!doctype html><html><head><title>Local browser checkpoint</title></head><body>
<h1>Local browser checkpoint</h1><p>${message}</p>
<form method="post" action="/save"><input type="hidden" name="token" value="${token}">
<p><label>Checkpoint name <input name="name" pattern="[a-z0-9_-]{1,96}" required></label></p>
<p><label>JSON observations <textarea name="payload" rows="12" cols="90" required></textarea></label></p>
<button type="submit">Save checkpoint</button></form></body></html>`;
createServer(async (request, response) => {
  try {
    if (request.headers.host !== `127.0.0.1:${port}`) {
      response.writeHead(403, headers).end("Invalid host"); return;
    }
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, headers).end(page()); return;
    }
    if (request.method !== "POST" || request.url !== "/save" || request.headers.origin !== origin) {
      response.writeHead(403, headers).end("Unsupported request"); return;
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 32 * 1024 * 1024) throw new Error("Checkpoint exceeds 32 MB.");
      chunks.push(chunk);
    }
    const fields = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
    if (fields.get("token") !== token) throw new Error("Invalid form token.");
    const name = fields.get("name") ?? "";
    if (!/^[a-z0-9_-]{1,96}$/.test(name)) throw new Error("Invalid checkpoint name.");
    const payload = fields.get("payload");
    if (!payload) throw new Error("Missing JSON observations.");
    JSON.parse(payload);
    const target = join(output, `${name}.json`);
    const temporary = `${target}.${randomBytes(8).toString("hex")}.tmp`;
    await writeFile(temporary, payload, "utf8");
    await rename(temporary, target);
    const hash = createHash("sha256").update(payload).digest("hex");
    response.writeHead(200, headers).end(page(`Saved ${name}.json (${Buffer.byteLength(payload)} bytes). SHA256 ${hash}`));
    process.stdout.write(`${JSON.stringify({ status: "saved", name, bytes: Buffer.byteLength(payload), sha256: hash })}\n`);
  } catch (error) {
    response.writeHead(400, headers).end(page("Checkpoint rejected. Check JSON, name, and size."));
    process.stderr.write(`${error.message}\n`);
  }
}).listen(port, "127.0.0.1", () => {
  process.stdout.write(`${JSON.stringify({ status: "listening", origin, output })}\n`);
});
