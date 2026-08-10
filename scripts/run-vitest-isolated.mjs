import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, relative, resolve } from "node:path";

const root = resolve(process.cwd());

export const ALWAYS_ISOLATED_TEST_FILES = Object.freeze([
  "tests/public-traction-snapshot.test.ts",
  "tests/timeline-backfill-checkpoint.test.ts",
]);

export function partitionTestFiles(testFiles, shardIndex, shardCount) {
  return testFiles.filter((_, index) => index % shardCount === shardIndex - 1);
}

export function readShardConfig(environment = process.env, commandLineShard) {
  const hasEnvironmentIndex = environment.VITEST_SHARD_INDEX !== undefined;
  const hasEnvironmentCount = environment.VITEST_SHARD_COUNT !== undefined;
  if (hasEnvironmentIndex !== hasEnvironmentCount) {
    throw new Error("VITEST_SHARD_INDEX and VITEST_SHARD_COUNT must be set together.");
  }
  const shardIndex = positiveIntegerEnvironment(
    environment.VITEST_SHARD_INDEX,
    commandLineShard?.shardIndex ?? 1,
    "VITEST_SHARD_INDEX",
  );
  const shardCount = positiveIntegerEnvironment(
    environment.VITEST_SHARD_COUNT,
    commandLineShard?.shardCount ?? 1,
    "VITEST_SHARD_COUNT",
  );
  if (commandLineShard && (shardIndex !== commandLineShard.shardIndex || shardCount !== commandLineShard.shardCount)) {
    throw new Error("--shard must match VITEST_SHARD_INDEX and VITEST_SHARD_COUNT.");
  }
  if (shardIndex > shardCount) {
    throw new Error(`VITEST_SHARD_INDEX (${shardIndex}) must be less than or equal to VITEST_SHARD_COUNT (${shardCount}).`);
  }
  return { shardIndex, shardCount };
}

function main() {
  const forwarded = process.argv.slice(2);
  const commandLineShard = parseCommandLineShard(forwarded);
  const vitestArguments = forwarded.filter((argument) => !argument.startsWith("--shard="));
  const vitest = join(root, "node_modules", ".bin", process.platform === "win32" ? "vitest.cmd" : "vitest");
  const batchSize = positiveInteger(process.env.VITEST_BATCH_SIZE, 12);
  const heapLimitMb = positiveInteger(process.env.VITEST_HEAP_LIMIT_MB, 2304);
  const childEnv = {
    ...process.env,
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    NODE_OPTIONS: boundedNodeOptions(process.env.NODE_OPTIONS, heapLimitMb),
  };
  const { shardIndex, shardCount } = readShardConfig(process.env, commandLineShard);

  if (vitestArguments.length) {
    const result = spawnSync(
      vitest,
      ["run", ...vitestArguments, "--maxWorkers=1", "--no-file-parallelism"],
      { cwd: root, env: childEnv, stdio: "inherit" },
    );
    process.exit(result.status ?? 1);
  }

  const testFiles = readdirSync(join(root, "tests"), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.test\.(?:[cm]?[jt]sx?)$/.test(entry.name))
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .sort();

  if (!testFiles.length) throw new Error("No Vitest files were discovered.");

  const shardFiles = partitionTestFiles(testFiles, shardIndex, shardCount);
  let passedTests = 0;
  let completedFiles = 0;
  const startedAt = Date.now();

  // These tests either load unusually large source snapshots or have timed out
  // when imported alongside other files, so give each its own recyclable worker.
  const alwaysIsolated = new Set(ALWAYS_ISOLATED_TEST_FILES);
  const regularFiles = shardFiles.filter((file) => !alwaysIsolated.has(file));
  const batches = chunk(regularFiles, batchSize);
  for (const file of shardFiles.filter((candidate) => alwaysIsolated.has(candidate))) {
    batches.push([file]);
  }

  for (const [index, batch] of batches.entries()) {
    runBatchWithOomSplit(batch);
    process.stdout.write(
      `Vitest batch progress: ${index + 1}/${batches.length} batches, ${completedFiles}/${shardFiles.length} files, ${passedTests} tests passed.\n`,
    );
  }

  process.stdout.write(`${JSON.stringify({
    status: "passed",
    files: shardFiles.length,
    totalFiles: testFiles.length,
    tests: passedTests,
    batches: batches.length,
    batchSize,
    heapLimitMb,
    shardIndex,
    shardCount,
    durationMs: Date.now() - startedAt,
  })}\n`);

  function runBatchWithOomSplit(files) {
    const result = spawnSync(vitest, ["run", ...files, "--maxWorkers=1", "--no-file-parallelism", "--reporter=dot"], {
      cwd: root,
      env: childEnv,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    if (result.status === 0) {
      const match = output.match(/Tests\s+(\d+)\s+passed/);
      passedTests += Number(match?.[1] ?? 0);
      completedFiles += files.length;
      return;
    }

    if (isOutOfMemory(result, output) && files.length > 1) {
      const midpoint = Math.ceil(files.length / 2);
      process.stdout.write(
        `Vitest batch reached its ${heapLimitMb} MB heap bound; retrying as ${midpoint} and ${files.length - midpoint} file batches.\n`,
      );
      runBatchWithOomSplit(files.slice(0, midpoint));
      runBatchWithOomSplit(files.slice(midpoint));
      return;
    }

    process.stderr.write(`\nVitest failure in ${files.join(", ")}:\n${output}\n`);
    process.exit(result.status ?? 1);
  }
}

function isOutOfMemory(result, output) {
  return /heap out of memory|allocation failed|ineffective mark-compacts/i.test(output)
    || result.signal === "SIGABRT"
    || result.signal === "SIGKILL";
}

function chunk(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function positiveInteger(raw, fallback) {
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveIntegerEnvironment(raw, fallback, name) {
  if (raw === undefined) return fallback;
  const value = String(raw).trim();
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${name} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a safe positive integer.`);
  }
  return parsed;
}

function parseCommandLineShard(argumentsList) {
  const shardArguments = argumentsList.filter((argument) => argument.startsWith("--shard="));
  if (!shardArguments.length) return undefined;
  if (shardArguments.length > 1) throw new Error("Only one --shard argument is supported.");

  const match = shardArguments[0].match(/^--shard=(.*)\/(.*)$/);
  if (!match) throw new Error("--shard must use the INDEX/COUNT format.");
  const shardIndex = positiveIntegerEnvironment(match[1], undefined, "--shard index");
  const shardCount = positiveIntegerEnvironment(match[2], undefined, "--shard count");
  if (shardIndex > shardCount) {
    throw new Error(`--shard index (${shardIndex}) must be less than or equal to --shard count (${shardCount}).`);
  }
  return { shardIndex, shardCount };
}

function boundedNodeOptions(raw, limitMb) {
  const withoutHeapLimit = String(raw ?? "")
    .replace(/(?:^|\s)--max[-_]old[-_]space[-_]size(?:=|\s+)\d+(?=\s|$)/g, " ")
    .trim();
  return `${withoutHeapLimit} --max-old-space-size=${limitMb}`.trim();
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main();
}
