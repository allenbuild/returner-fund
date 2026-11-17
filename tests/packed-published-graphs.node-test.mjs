import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { PUBLISHED_GRAPH_FILENAMES, preparePublishedGraphRuntimeSnapshots } from "../scripts/lib/packed-published-graphs.mjs";
import nextConfig from "../next.config.mjs";

test("all twelve runtime graph copies decompress to the exact public bytes", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "published-graphs-pack-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  await mkdir(join(rootDir, "public", "graph"), { recursive: true });
  const originals = new Map(PUBLISHED_GRAPH_FILENAMES.map((filename) => [
    filename, Buffer.from(JSON.stringify({ filename, text: "Exact 🦉 native\n whitespace", score: 0, publishedAt: null }, null, 2) + "\n")
  ]));
  for (const [filename, body] of originals) await writeFile(join(rootDir, "public", "graph", filename), body);
  const result = await preparePublishedGraphRuntimeSnapshots({ rootDir });
  assert.equal(result.length, 12);
  for (const [filename, body] of originals) {
    assert.deepEqual(await readFile(join(rootDir, "public", "graph", filename)), body);
    assert.deepEqual(gunzipSync(await readFile(join(rootDir, "generated-runtime", "published-graph", `${filename}.gz`))), body);
  }
});

test("missing public snapshots fail strict preparation and remove stale optional copies", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "published-graphs-missing-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  await assert.rejects(preparePublishedGraphRuntimeSnapshots({ rootDir }), { code: "ENOENT" });
  const stale = join(rootDir, "generated-runtime", "published-graph", "f26.json.gz");
  await writeFile(stale, "stale");
  assert.deepEqual(await preparePublishedGraphRuntimeSnapshots({ rootDir, allowMissing: true }), []);
  await assert.rejects(readFile(stale), { code: "ENOENT" });
});

test("only snapshot-consuming functions omit public raw files; refresh keeps its direct-reader inputs", () => {
  for (const [route, exclusionKey, count] of [
    ["/api/graph!(/**)", "/api/graph!(/**)", 12],
    ["/api/graph/route", "/api/graph/route", 12],
    ["/api/insiders/recompute", "/api/insiders/recompute", 8],
    ["/api/v1/companies/*/returner-fund", "/api/v1/companies/*/returner-fund", 4]
  ]) {
    const included = nextConfig.outputFileTracingIncludes[route];
    assert.equal(included.filter((path) => path.startsWith("generated-runtime/published-graph/")).length, count);
    assert.ok(included.every((path) => !path.startsWith("public/graph/")));
    assert.ok(nextConfig.outputFileTracingExcludes[exclusionKey].includes("public/graph/**/*"));
  }
  assert.ok(nextConfig.outputFileTracingIncludes["/api/graph/refresh"].includes("public/graph/*.json"));
  assert.ok(!nextConfig.outputFileTracingExcludes["/api/graph/refresh"].includes("public/graph/**/*"));
});


test("trace includes survive both native route-entry and normalized URL matching", () => {
  const require = createRequire(import.meta.url);
  const picomatch = require("next/dist/compiled/picomatch");
  const effective = (route) => {
    const includes = Object.entries(nextConfig.outputFileTracingIncludes)
      .filter(([key]) => picomatch(key, { contains: true, dot: true })(route)).flatMap(([, values]) => values);
    const excludes = Object.entries(nextConfig.outputFileTracingExcludes)
      .filter(([key]) => picomatch(key, { contains: true, dot: true })(route)).flatMap(([, values]) => values);
    const excluded = (path) => excludes.some((pattern) => picomatch(resolve(pattern), { contains: true, dot: true })(resolve(path)));
    return [...new Set(includes)].filter((path) => !excluded(path));
  };
  for (const prefix of ["", "/app"]) {
    for (const suffix of ["", "/route"]) {
      const graph = effective(`${prefix}/api/graph${suffix}`);
      assert.equal(graph.filter((path) => path.startsWith("generated-runtime/published-graph/")).length, 12);
      const company = effective(`${prefix}/api/v1/companies/[slug]/returner-fund${suffix}`);
      assert.equal(company.filter((path) => path.startsWith("generated-runtime/published-graph/")).length, 4);
      for (const scope of ["full", "refresh"]) {
        assert.equal(effective(`${prefix}/api/graph/${scope}${suffix}`)
          .filter((path) => path.startsWith("generated-runtime/published-graph/")).length, 0);
      }
    }
  }
});


test("dual exact graph keys retain the observed native tracing scope", () => {
  const require = createRequire(import.meta.url);
  const proof = require("./fixtures/graph-native-trace-matcher.json");
  assert.equal(require("next/package.json").version, proof.engine.next);
  assert.deepEqual(proof.markerRoutes.native, ["graph"]);
  assert.deepEqual(proof.markerRoutes.extglob, []);
  assert.deepEqual(proof.markerRoutes.broad, ["graph", "graph/full", "graph/refresh"]);
  assert.equal(proof.explicitFullExclusionRemovedBroadMarker, false);
  assert.ok(!Object.hasOwn(nextConfig.outputFileTracingIncludes, "/api/graph"));
  assert.deepEqual(nextConfig.outputFileTracingIncludes["/api/graph/route"], nextConfig.outputFileTracingIncludes["/api/graph!(/**)"]);
  assert.deepEqual(nextConfig.outputFileTracingExcludes["/api/graph/route"], nextConfig.outputFileTracingExcludes["/api/graph!(/**)"]);
});
