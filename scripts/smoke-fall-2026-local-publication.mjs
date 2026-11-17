import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { open, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const option = (key, fallback) => process.argv.find((arg) => arg.startsWith(`${key}=`))?.slice(key.length + 1) ?? fallback;
const checkpoint = option("--checkpoint");
if (!checkpoint) throw new Error("Pass --checkpoint=<frozen-checkpoint-directory>.");
const port = Number(option("--port", "3187")), existingOrigin = option("--existing-origin"), origin = existingOrigin ?? `http://localhost:${port}`;
const parsedOrigin = new URL(origin);
assert.ok(parsedOrigin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsedOrigin.hostname) && parsedOrigin.origin === origin, "Smoke access is restricted to an exact local origin.");
const config = existingOrigin ? JSON.parse(await readFile(option("--access-config", "outputs/fall-2026/local-ui-access.json"), "utf8")) : null;
if (config) assert.equal(config.origin, origin, "Ephemeral access configuration belongs to another origin.");
const password = config?.password ?? randomBytes(24).toString("hex"), secret = randomBytes(32).toString("hex");
const log = existingOrigin ? null : await open(`${checkpoint}/route-smoke-server.log`, "w");
const server = existingOrigin ? null : spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], { detached: true, env: { ...process.env, SITE_PASSWORD: password, SITE_ACCESS_SECRET: secret }, stdio: ["ignore", log.fd, log.fd] });
let exited = false;
server?.once("exit", () => { exited = true; });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  let ready = false;
  for (let attempt = 0; attempt < 45; attempt += 1) {
    if (exited) throw new Error("Local smoke server exited before readiness.");
    try { ready = (await fetch(`${origin}/unlock`, { signal: AbortSignal.timeout(5_000) })).status === 200; } catch { /* Native server startup. */ }
    if (ready) break;
    await pause(1_000);
  }
  assert.equal(ready, true, "Local smoke server did not become ready.");
  const form = new FormData(); form.set("password", password); form.set("returnTo", "/");
  const unlocked = await fetch(`${origin}/api/access/unlock`, { method: "POST", headers: { origin }, body: form, redirect: "manual" });
  assert.equal(unlocked.status, 303);
  const cookie = unlocked.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  assert.ok(cookie, "Normal access route did not issue a local smoke cookie.");
  const graphs = [];
  for (const [batch, expected] of [["F26", 235], ["S26", 237], ["S2026", 197], ["A16ZSR006", 59]]) {
    const response = await fetch(`${origin}/api/graph?batch=${batch}`, { headers: { cookie }, signal: AbortSignal.timeout(120_000) });
    assert.equal(response.status, 200, `${batch} graph route`);
    const graph = await response.json();
    assert.equal(graph.batch.companyCountObserved, expected);
    assert.equal(graph.nodes.length, expected);
    assert.ok(graph.evidence.length <= 5_000);
    graphs.push({ batch, status: response.status, companyCount: graph.batch.companyCountObserved, nodeCount: graph.nodes.length, evidenceCount: graph.evidence.length, generatedAt: graph.generatedAt, projection: graph.evidenceProjection });
  }
  const nativeFilters = [];
  for (const platform of ["facebook", "threads"]) {
    const response = await fetch(`${origin}/api/graph?batch=F26&platforms=${platform}`, { headers: { cookie }, signal: AbortSignal.timeout(120_000) });
    assert.equal(response.status, 200);
    const graph = await response.json();
    assert.ok(graph.evidence.every((row) => row.platform === platform && row.contributionScore === 0 && row.tractionStatus === "unscored"));
    nativeFilters.push({ platform, status: response.status, evidenceCount: graph.evidence.length, allUnscored: true });
  }
  const page = await fetch(`${origin}/?batch=F26`, { headers: { cookie }, signal: AbortSignal.timeout(120_000) });
  const html = await page.text();
  assert.equal(page.status, 200); assert.ok(html.includes("Fall 2026"));
  const result = { localEphemeralAccessConfiguration: true, existingLocalServerReused: Boolean(existingOrigin), graphs, nativeFilters, page: { status: page.status, htmlBytes: Buffer.byteLength(html), hasFallLabel: true } };
  await writeFile(`${checkpoint}/actual-route-smoke.json`, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
} finally {
  if (server && !exited) { try { process.kill(-server.pid, "SIGTERM"); } catch { /* Already exited. */ } }
  await log?.close();
}
