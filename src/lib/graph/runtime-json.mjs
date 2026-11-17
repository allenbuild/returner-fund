import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

const COMPRESSED_RUNTIME_PATHS = new Set([
  "generated-runtime/graph/public-evidence-current.json",
  "generated-runtime/graph/logged-in-evidence-current.json",
  "generated-runtime/graph/targeted-evidence-current.json",
  "generated-runtime/graph/volume-evidence-current.json"
]);

/** Keep local raw-file compatibility while deployments carry only gzip projections. */
export function readGraphRuntimeJson(relativePath, {
  roots = [process.cwd(), process.env.INIT_CWD, process.env.PWD]
} = {}) {
  for (const root of roots) {
    if (!root) continue;
    // Exact runtime files are declared in next.config; never trace this as a
    // repository-wide dynamic filesystem glob.
    const runtimePath = join(/* turbopackIgnore: true */ root, relativePath);
    if (existsSync(/* turbopackIgnore: true */ runtimePath)) {
      return JSON.parse(readFileSync(/* turbopackIgnore: true */ runtimePath, "utf8"));
    }
    if (COMPRESSED_RUNTIME_PATHS.has(relativePath)) {
      const compressedPath = `${runtimePath}.gz`;
      if (existsSync(/* turbopackIgnore: true */ compressedPath)) {
        const bytes = readFileSync(/* turbopackIgnore: true */ compressedPath);
        return JSON.parse(gunzipSync(bytes).toString("utf8"));
      }
    }
  }
  throw new Error(`Missing graph runtime JSON: ${relativePath}`);
}
