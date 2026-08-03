import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const publisher = await readFile(
  path.join(process.cwd(), "scripts", "publish-single-batch-graphs.mjs"),
  "utf8"
);

test("graph publication refreshes compact runtime evidence before starting the server", () => {
  const prepareIndex = publisher.indexOf('"prepare-graph-runtime-evidence.mjs"');
  const serverIndex = publisher.indexOf("getGraphApiServer({ port })");

  assert.notEqual(prepareIndex, -1, "missing runtime evidence preparation");
  assert.notEqual(serverIndex, -1, "missing graph server startup");
  assert.ok(prepareIndex < serverIndex, "runtime evidence must be prepared before server startup");
  assert.match(publisher, /execFileSync\(\s*process\.execPath/);
  assert.match(publisher, /stdio:\s*"inherit"/);
});
