import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

export const PUBLISHED_GRAPH_FILENAMES = ["s2026", "s26", "f26", "a16zsr006"]
  .flatMap((batch) => ["", "-yc-partners", "-insiders"].map((audience) => `${batch}${audience}.json`));

/** Function packages use gzip copies; public CDN files retain every original byte. */
export async function preparePublishedGraphRuntimeSnapshots({ rootDir = process.cwd(), allowMissing = false } = {}) {
  const outputRoot = join(rootDir, "generated-runtime", "published-graph");
  await mkdir(outputRoot, { recursive: true });
  const snapshots = [];
  for (const filename of PUBLISHED_GRAPH_FILENAMES) {
    const target = join(outputRoot, `${filename}.gz`);
    let bytes;
    try {
      bytes = await readFile(join(rootDir, "public", "graph", filename));
    } catch (error) {
      if (!allowMissing || error.code !== "ENOENT") throw error;
      // A removed public file must never leave a stale deployment copy.
      await rm(target, { force: true });
      continue;
    }
    const packed = gzipSync(bytes, { level: 9 });
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, packed);
    await rename(temporary, target);
    snapshots.push({ filename, bytes: bytes.length, gzipBytes: packed.length });
  }
  return snapshots;
}
