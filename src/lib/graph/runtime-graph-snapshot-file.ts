import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

export async function readRuntimeGraphSnapshotFile(
  filename: string,
  { rootDir = process.cwd() }: { rootDir?: string } = {}
): Promise<string> {
  const publicPath = join(/* turbopackIgnore: true */ rootDir, "public", "graph", filename);
  try {
    return await readFile(/* turbopackIgnore: true */ publicPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const packedPath = join(/* turbopackIgnore: true */ rootDir, "generated-runtime", "published-graph", `${filename}.gz`);
    const bytes = await readFile(/* turbopackIgnore: true */ packedPath);
    return gunzipSync(bytes).toString("utf8");
  }
}
