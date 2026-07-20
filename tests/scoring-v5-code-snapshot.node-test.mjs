import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeV5CodeSnapshot,
  hashCodeSnapshotEntries
} from "../scripts/scoring-v5/code-snapshot.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("V5 code revision deterministically covers the runner and every scoring source", async () => {
  const first = await computeV5CodeSnapshot(REPOSITORY_ROOT);
  const second = await computeV5CodeSnapshot(REPOSITORY_ROOT);
  assert.deepEqual(first, second);
  assert.match(first.revision, /^sha256:[a-f0-9]{64}$/);
  assert(first.relativePaths.includes("scripts/scoring-v5/artifact-store.mjs"));
  assert(first.relativePaths.includes("scripts/scoring-v5/run.mjs"));
  assert(first.relativePaths.includes("scripts/scoring-v5/runtime.mjs"));
  assert(first.relativePaths.includes("scripts/scoring-v5/typescript-loader.mjs"));
  assert(first.relativePaths.includes("src/lib/scoring/v5/pipeline.ts"));
  assert(first.relativePaths.includes("src/lib/scoring/v5/inference.ts"));
  assert(first.relativePaths.includes("tests/scoring-v5-code-snapshot.node-test.mjs"));
  assert(first.relativePaths.includes("tests/scoring-v5-runner.node-test.mjs"));
  assert(first.relativePaths.includes("tests/scoring-v5-pipeline.test.ts"));
});

test("V5 code snapshot hash changes after a one-byte source change", () => {
  const before = hashCodeSnapshotEntries([{ relativePath: "source.ts", bytes: Buffer.from("a") }]);
  const after = hashCodeSnapshotEntries([{ relativePath: "source.ts", bytes: Buffer.from("b") }]);
  assert.notEqual(before, after);
});
