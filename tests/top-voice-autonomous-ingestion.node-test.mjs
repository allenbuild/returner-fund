import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile("scripts/run-top-voice-ingestion.mjs", "utf8");

test("twice-daily Top Voice discovery covers both audiences and every batch", () => {
  assert.match(source, /\["S2026", "S26", "A16ZSR006"\]/);
  assert.match(source, /\["insiders", "yc_partners"\]/);
  assert.match(source, /topVoices:\s*audience/);
  assert.match(source, /platforms:\s*\["x"\]/);
  assert.match(source, /write:\s*true/);
});

test("Top Voice discovery uses bounded parallelism and emits a durable receipt", () => {
  assert.match(source, /positiveInteger\(args\.xConcurrency, 16\)/);
  assert.match(source, /positiveInteger\(args\.maxPostsPerTarget, 20\)/);
  assert.match(source, /positiveInteger\(args\.maxNetworkRequests, 2_500\)/);
  assert.match(source, /positiveInteger\(args\.deadlineMinutes, 10\)/);
  assert.match(source, /await writeJsonAtomic\(outputPath, receipt\)/);
  assert.match(source, /targetsLoaded:\s*targetEntry\?\.count/);
});
