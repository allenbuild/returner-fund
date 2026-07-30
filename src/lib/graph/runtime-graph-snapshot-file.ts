import { readFile } from "node:fs/promises";
import { join } from "node:path";

export function readRuntimeGraphSnapshotFile(filename: string): Promise<string> {
  return readFile(join(process.cwd(), "public", "graph", filename), "utf8");
}
