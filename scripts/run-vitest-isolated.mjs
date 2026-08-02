import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative, resolve } from "node:path";

const root = resolve(process.cwd());
const forwarded = process.argv.slice(2);
const vitest = join(root, "node_modules", ".bin", process.platform === "win32" ? "vitest.cmd" : "vitest");
const batchSize = positiveInteger(process.env.VITEST_BATCH_SIZE, 12);
const heapLimitMb = positiveInteger(process.env.VITEST_HEAP_LIMIT_MB, 2304);
const childEnv = {
  ...process.env,
  FORCE_COLOR: "0",
  NO_COLOR: "1",
  NODE_OPTIONS: boundedNodeOptions(process.env.NODE_OPTIONS, heapLimitMb),
};

if (forwarded.length) {
  const result = spawnSync(
    vitest,
    ["run", ...forwarded, "--maxWorkers=1", "--no-file-parallelism"],
    { cwd: root, env: childEnv, stdio: "inherit" },
  );
  process.exit(result.status ?? 1);
}

const testFiles = readdirSync(join(root, "tests"), { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.test\.(?:[cm]?[jt]sx?)$/.test(entry.name))
  .map((entry) => relative(root, join(entry.parentPath, entry.name)))
  .sort();

if (!testFiles.length) throw new Error("No Vitest files were discovered.");

let passedTests = 0;
let completedFiles = 0;
const startedAt = Date.now();

// This test intentionally audits the complete 96 MB source snapshot rather
// than the compact graph projection, so keep it in its own recyclable worker.
const alwaysIsolated = new Set(["tests/public-traction-snapshot.test.ts"]);
const regularFiles = testFiles.filter((file) => !alwaysIsolated.has(file));
const batches = chunk(regularFiles, batchSize);
for (const file of testFiles.filter((candidate) => alwaysIsolated.has(candidate))) {
  batches.push([file]);
}

for (const [index, batch] of batches.entries()) {
  runBatchWithOomSplit(batch);
  process.stdout.write(
    `Vitest batch progress: ${index + 1}/${batches.length} batches, ${completedFiles}/${testFiles.length} files, ${passedTests} tests passed.\n`,
  );
}

process.stdout.write(`${JSON.stringify({
  status: "passed",
  files: testFiles.length,
  tests: passedTests,
  batches: batches.length,
  batchSize,
  heapLimitMb,
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

function boundedNodeOptions(raw, limitMb) {
  const withoutHeapLimit = String(raw ?? "")
    .replace(/(?:^|\s)--max[-_]old[-_]space[-_]size(?:=|\s+)\d+(?=\s|$)/g, " ")
    .trim();
  return `${withoutHeapLimit} --max-old-space-size=${limitMb}`.trim();
}
