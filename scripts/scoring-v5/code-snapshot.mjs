import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export async function computeV5CodeSnapshot(repositoryRoot) {
  const runnerDirectory = path.join(repositoryRoot, "scripts/scoring-v5");
  const sourceDirectory = path.join(repositoryRoot, "src/lib/scoring/v5");
  const testsDirectory = path.join(repositoryRoot, "tests");
  const runnerRelativePaths = (await readdir(runnerDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"))
    .map((entry) => `scripts/scoring-v5/${entry.name}`);
  const sourceRelativePaths = (await readdir(sourceDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => `src/lib/scoring/v5/${entry.name}`);
  const testRelativePaths = (await readdir(testsDirectory, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.startsWith("scoring-v5-") &&
        (entry.name.endsWith(".ts") || entry.name.endsWith(".mjs"))
    )
    .map((entry) => `tests/${entry.name}`);
  const relativePaths = [
    ...runnerRelativePaths,
    ...sourceRelativePaths,
    ...testRelativePaths
  ].sort((left, right) => left.localeCompare(right, "en"));
  const entries = await Promise.all(
    relativePaths.map(async (relativePath) => ({
      relativePath,
      bytes: await readFile(path.join(repositoryRoot, relativePath))
    }))
  );
  return {
    relativePaths,
    revision: `sha256:${hashCodeSnapshotEntries(entries)}`
  };
}

export function hashCodeSnapshotEntries(entries) {
  const hash = createHash("sha256");
  for (const { relativePath, bytes } of [...entries].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath, "en")
  )) {
    const pathBytes = Buffer.from(relativePath, "utf8");
    const contentBytes = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    hash.update(uint64(pathBytes.length));
    hash.update(pathBytes);
    hash.update(uint64(contentBytes.length));
    hash.update(contentBytes);
  }
  return hash.digest("hex");
}

function uint64(value) {
  const buffer = Buffer.allocUnsafe(8);
  buffer.writeBigUInt64BE(BigInt(value));
  return buffer;
}
