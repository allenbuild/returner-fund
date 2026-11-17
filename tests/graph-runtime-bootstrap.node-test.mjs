import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import nextConfig from "../next.config.mjs";

const require = createRequire(import.meta.url);
const { nodeFileTrace } = require("next/dist/compiled/@vercel/nft");
const root = process.cwd();
const bootstrap = "node_modules/next/dist/build/adapter/setup-node-env.external.js";
const descriptor = "node_modules/next/dist/compiled/source-map/package.json";
const launcherDependencies = [
  "node_modules/next/dist/lib/framework/boundary-constants.js",
  "node_modules/@swc/helpers/_/_interop_require_default/package.json"
];
const routes = [
  "/api/graph!(/**)", "/api/graph/route", "/api/graph/full",
  "/api/graph/refresh", "/api/insiders/recompute",
  "/api/v1/companies/*/returner-fund"
];

test("bounded graph routes preserve Node package descriptors without broad data includes", () => {
  for (const route of routes) {
    const exclusions = nextConfig.outputFileTracingExcludes[route];
    assert.ok(exclusions, route);
    assert.ok(!exclusions.includes("package.json"), `${route} prunes every dependency descriptor`);
    for (const dependency of launcherDependencies) {
      assert.ok(nextConfig.outputFileTracingIncludes[route].includes(dependency), `${route}: ${dependency}`);
    }
    assert.ok(exclusions.includes("src/lib/social/targeted-evidence-current.json"), route);
    assert.ok(!nextConfig.outputFileTracingIncludes[route].some((entry) => entry === "node_modules/**/*"), route);
  }
});

test("the real Next bootstrap cold-starts from its isolated trace and fails when main-entry metadata is pruned", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "next-bootstrap-trace-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const trace = await nodeFileTrace([bootstrap], {
    base: root,
    processCwd: root,
    conditions: ["node", "production"]
  });
  assert.ok(trace.fileList.has(descriptor), "Next's own trace must retain the source-map descriptor");
  for (const dependency of launcherDependencies) {
    assert.ok(trace.fileList.has(dependency), `Next bootstrap requires ${dependency}`);
  }
  for (const relativePath of trace.fileList) {
    const target = join(sandbox, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(root, relativePath), target);
  }
  const run = () => spawnSync(process.execPath, ["-e", `require('./${bootstrap}'); console.log('BOOTSTRAP_OK')`], {
    cwd: sandbox,
    env: { ...process.env, NODE_ENV: "production", NEXT_RUNTIME: "nodejs", NODE_PATH: "" },
    encoding: "utf8",
    timeout: 10_000
  });
  const complete = run();
  assert.equal(complete.status, 0, complete.stderr);
  assert.match(complete.stdout, /BOOTSTRAP_OK/);

  const mainDescriptor = JSON.parse(await readFile(join(sandbox, descriptor), "utf8"));
  assert.equal(mainDescriptor.main, "source-map.js");
  await rm(join(sandbox, descriptor));
  const pruned = run();
  assert.notEqual(pruned.status, 0);
  assert.match(pruned.stderr, /Cannot find module ['"]next\/dist\/compiled\/source-map['"]/);
  assert.match(pruned.stderr, /patch-error-inspect/);
});
