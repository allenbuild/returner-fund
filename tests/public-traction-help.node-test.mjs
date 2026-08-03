import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

test("public collector help exits before starting collection", () => {
  const output = execFileSync(
    process.execPath,
    ["scripts/fetch-public-traction.mjs", "--help"],
    { cwd: process.cwd(), encoding: "utf8" }
  );

  assert.match(output, /^Usage: node scripts\/fetch-public-traction\.mjs/m);
  assert.match(output, /--plan\s+Print the read-only target plan and exit/);
  assert.doesNotMatch(output, /\[(?:instagram|linkedin|x|web)\/worker-/);
  assert.doesNotMatch(output, /Wrote \d+ evidence items/);
});
