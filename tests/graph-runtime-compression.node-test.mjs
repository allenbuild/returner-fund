import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { gzipSync, gunzipSync } from "node:zlib";
import { prepareGraphRuntimeEvidence } from "../scripts/prepare-graph-runtime-evidence.mjs";
import { readGraphRuntimeJson } from "../src/lib/graph/runtime-json.mjs";
import nextConfig from "../next.config.mjs";

const runtimePaths = ["public", "logged-in", "targeted", "volume"].map(
  (name) => `generated-runtime/graph/${name}-evidence-current.json`
);
const targetedPath = "generated-runtime/graph/targeted-evidence-current.json";
const write = async (root, path, body) => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), body);
};

test("prepare gzip preserves exact compact bytes and native row semantics", async () => {
  const root = await mkdtemp(join(tmpdir(), "graph-runtime-compression-"));
  try {
    await write(root, "package.json", "{}");
    await write(root, "src/lib/yc/summer-2026-companies.json", '{"companies":[]}');
    await write(root, "src/lib/yc/spring-2026-companies.json", '{"companies":[]}');
    await write(root, "src/lib/social/verified-social-overrides.json", "{}");
    const row = {
      id: "native-1", batchSlug: "F26", text: "Exact — native body\n\n🦉 ".repeat(40),
      metrics: { likes: 23 }, contributionScore: 0,
      rawVisibleText: '{"original":"untouched"}'
    };
    const source = {
      source: { fetchedAt: "2026-11-16T22:00:00.000Z" },
      evidence: [row, { id: "other-batch", batchSlug: "OTHER" }],
      needsReview: [{ id: "held", batchSlug: "F26", review_state: "held", unused: true }]
    };
    const original = JSON.stringify(source, null, 2);
    for (const name of ["public", "logged-in", "targeted", "volume"]) {
      await write(root, `src/lib/social/${name}-evidence-current.json`, original);
    }
    await prepareGraphRuntimeEvidence({ rootDir: root });
    for (const path of runtimePaths) {
      const raw = await readFile(join(root, path));
      const packed = await readFile(join(root, `${path}.gz`));
      assert.deepEqual(gunzipSync(packed), raw, path);
      assert.ok(packed.length < raw.length, path);
      const expected = JSON.parse(raw.toString("utf8"));
      assert.deepEqual(expected.evidence, [row]);
      assert.deepEqual(expected.source, source.source);
      assert.deepEqual(expected.needsReview, [{ id: "held", batchSlug: "F26", review_state: "held" }]);
      const sourcePath = path.replace("generated-runtime/graph/", "src/lib/social/");
      assert.equal(await readFile(join(root, sourcePath), "utf8"), original);
      await rm(join(root, path));
      assert.deepEqual(readGraphRuntimeJson(path, { roots: [root] }), expected, path);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("raw local projection wins over gzip without changing existing callers", async () => {
  const root = await mkdtemp(join(tmpdir(), "graph-runtime-raw-"));
  try {
    await write(root, targetedPath, '{"version":"local"}');
    await write(root, `${targetedPath}.gz`, gzipSync('{"version":"packed"}'));
    assert.deepEqual(readGraphRuntimeJson(targetedPath, { roots: [root] }), { version: "local" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("current-root gzip takes precedence over another root's raw file", async () => {
  const root = await mkdtemp(join(tmpdir(), "graph-runtime-roots-"));
  try {
    const current = join(root, "current"), fallback = join(root, "fallback");
    await write(current, `${targetedPath}.gz`, gzipSync('{"version":"current"}'));
    await write(fallback, targetedPath, '{"version":"stale"}');
    assert.deepEqual(readGraphRuntimeJson(targetedPath, { roots: [current, fallback] }), { version: "current" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("gzip is narrow to the four runtime projections and corruption fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "graph-runtime-invalid-"));
  try {
    const other = "src/lib/social/targeted-evidence-current.json";
    await write(root, `${other}.gz`, gzipSync("{}"));
    assert.throws(() => readGraphRuntimeJson(other, { roots: [root] }), /Missing graph runtime JSON/);
    await write(root, `${targetedPath}.gz`, "not gzip");
    assert.throws(() => readGraphRuntimeJson(targetedPath, { roots: [root] }), /header|gzip/i);
    await write(root, `${targetedPath}.gz`, gzipSync("not JSON"));
    assert.throws(() => readGraphRuntimeJson(targetedPath, { roots: [root] }), SyntaxError);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("every full-data route includes gzip and excludes all uncompressed runtime snapshots", () => {
  for (const route of [
    "/api/graph/full", "/api/graph/refresh", "/debug/duplicates",
    "/debug/evidence", "/debug/instagram-coverage", "/debug/scoring",
    "/debug/thumbnails", "/debug/workers"
  ]) {
    for (const path of runtimePaths) {
      assert.ok(nextConfig.outputFileTracingIncludes[route].includes(`${path}.gz`), `${route}: ${path}`);
      assert.ok(!nextConfig.outputFileTracingIncludes[route].includes(path), `${route}: ${path}`);
      assert.ok(nextConfig.outputFileTracingExcludes[route].includes(path), `${route}: ${path}`);
    }
  }
});
