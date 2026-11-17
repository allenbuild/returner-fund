import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { readRuntimeGraphSnapshotFile } from "@/lib/graph/runtime-graph-snapshot-file";
import { validateStaticGraphSnapshotContract } from "@/lib/graph/static-graph-snapshot-contract.mjs";

const sourceRoot = process.cwd();
const roots: string[] = [];
async function fixture() {
  const rootDir = await mkdtemp(join(tmpdir(), "runtime-published-graph-"));
  roots.push(rootDir);
  await mkdir(join(rootDir, "generated-runtime", "published-graph"), { recursive: true });
  return rootDir;
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("runtime graph snapshot packaging", () => {
  it("loads the exact real Fall snapshot with every raw public graph physically absent", async () => {
    const rootDir = await fixture();
    const original = await readFile(join(sourceRoot, "public", "graph", "f26.json"));
    await writeFile(join(rootDir, "generated-runtime", "published-graph", "f26.json.gz"), gzipSync(original));
    await expect(readFile(join(rootDir, "public", "graph", "f26.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const body = await readRuntimeGraphSnapshotFile("f26.json", { rootDir });
    expect(Buffer.from(body).equals(original)).toBe(true);
    const graph = JSON.parse(body);
    expect(validateStaticGraphSnapshotContract(graph).ok).toBe(true);
    expect(graph.batch.slug).toBe("F26");
    expect(graph.nodes.filter((row: { entityType: string }) => row.entityType === "company")).toHaveLength(235);
  });

  it("keeps local public files authoritative when both copies exist", async () => {
    const rootDir = await fixture();
    await mkdir(join(rootDir, "public", "graph"), { recursive: true });
    await writeFile(join(rootDir, "public", "graph", "s26.json"), '{"local":true}\n');
    await writeFile(join(rootDir, "generated-runtime", "published-graph", "s26.json.gz"), gzipSync('{"old":true}'));
    expect(await readRuntimeGraphSnapshotFile("s26.json", { rootDir })).toBe('{"local":true}\n');
  });

  it("fails on corrupt gzip and preserves non-missing raw-file errors", async () => {
    const rootDir = await fixture();
    await writeFile(join(rootDir, "generated-runtime", "published-graph", "s26.json.gz"), "corrupt");
    await expect(readRuntimeGraphSnapshotFile("s26.json", { rootDir })).rejects.toThrow();
    await mkdir(join(rootDir, "public", "graph", "s26.json"), { recursive: true });
    await writeFile(join(rootDir, "generated-runtime", "published-graph", "s26.json.gz"), gzipSync("{}"));
    await expect(readRuntimeGraphSnapshotFile("s26.json", { rootDir })).rejects.toMatchObject({ code: "EISDIR" });
  });
});
