import assert from "node:assert/strict";
import test from "node:test";

import {
  ALWAYS_ISOLATED_TEST_FILES,
  partitionTestFiles,
  readShardConfig,
} from "../scripts/run-vitest-isolated.mjs";

test("partitions the sorted discovered file list deterministically without overlap", () => {
  const files = ["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts", "tests/d.test.ts", "tests/e.test.ts"];
  const shards = [1, 2, 3].map((shardIndex) => partitionTestFiles(files, shardIndex, 3));

  assert.deepEqual(shards, [
    ["tests/a.test.ts", "tests/d.test.ts"],
    ["tests/b.test.ts", "tests/e.test.ts"],
    ["tests/c.test.ts"],
  ]);
  assert.deepEqual(shards.flat().sort(), files);
  assert.equal(new Set(shards.flat()).size, files.length);
});

test("keeps timeout-prone files explicitly isolated", () => {
  assert.deepEqual(ALWAYS_ISOLATED_TEST_FILES, [
    "tests/public-traction-snapshot.test.ts",
    "tests/timeline-backfill-checkpoint.test.ts",
  ]);
});

test("assigns every file to exactly one of four shards", () => {
  const files = [
    "tests/a.test.ts",
    "tests/b.test.ts",
    "tests/c.test.ts",
    "tests/d.test.ts",
    "tests/e.test.ts",
    "tests/f.test.ts",
    ...ALWAYS_ISOLATED_TEST_FILES,
  ].sort();
  const shards = [1, 2, 3, 4].map((shardIndex) => partitionTestFiles(files, shardIndex, 4));
  const flattened = shards.flat();

  assert.deepEqual(flattened.toSorted(), files);
  assert.equal(new Set(flattened).size, files.length);
  for (const isolatedFile of ALWAYS_ISOLATED_TEST_FILES) {
    assert.equal(flattened.filter((file) => file === isolatedFile).length, 1);
  }
  assert.ok(Math.max(...shards.map((shard) => shard.length)) - Math.min(...shards.map((shard) => shard.length)) <= 1);
});

test("defaults shard configuration to one shard", () => {
  assert.deepEqual(readShardConfig({}), { shardIndex: 1, shardCount: 1 });
  assert.deepEqual(readShardConfig({}, { shardIndex: 2, shardCount: 3 }), { shardIndex: 2, shardCount: 3 });
});

test("validates shard configuration", () => {
  assert.deepEqual(readShardConfig({ VITEST_SHARD_INDEX: "2", VITEST_SHARD_COUNT: "3" }), {
    shardIndex: 2,
    shardCount: 3,
  });
  assert.throws(() => readShardConfig({ VITEST_SHARD_INDEX: "0", VITEST_SHARD_COUNT: "3" }), /positive integer/);
  assert.throws(() => readShardConfig({ VITEST_SHARD_INDEX: "1.5", VITEST_SHARD_COUNT: "3" }), /positive integer/);
  assert.throws(() => readShardConfig({ VITEST_SHARD_INDEX: "4", VITEST_SHARD_COUNT: "3" }), /less than or equal/);
  assert.throws(() => readShardConfig({ VITEST_SHARD_INDEX: "1" }), /must be set together/);
  assert.throws(() => readShardConfig({ VITEST_SHARD_COUNT: "3" }), /must be set together/);
  assert.throws(
    () => readShardConfig({ VITEST_SHARD_INDEX: "1", VITEST_SHARD_COUNT: "3" }, { shardIndex: 2, shardCount: 3 }),
    /must match/,
  );
});
