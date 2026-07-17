import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REPOSITORY_ROOT_URL = pathToFileURL(`${REPOSITORY_ROOT}${path.sep}`).href;
const A16Z_DATASET_PATH = path.join(REPOSITORY_ROOT, "src", "lib", "graph", "a16z-speedrun-006-dataset.ts");
const RESOLUTION_SUFFIXES = ["", ".ts", ".tsx", ".js", ".mjs", ".json"];

export async function resolve(specifier, context, nextResolve) {
  const candidate = localCandidate(specifier, context.parentURL);
  if (!candidate) {
    return nextResolve(specifier, context);
  }

  const resolvedPath = await resolveLocalPath(candidate);
  if (!resolvedPath) {
    return nextResolve(specifier, context);
  }

  return {
    url: pathToFileURL(resolvedPath).href,
    shortCircuit: true
  };
}

export async function load(url, context, nextLoad) {
  if (url.endsWith(".json")) {
    const parsed = JSON.parse(await readFile(fileURLToPath(url), "utf8"));
    return {
      format: "module",
      source: `export default ${JSON.stringify(parsed)};\n`,
      shortCircuit: true
    };
  }

  const loaded = await nextLoad(url, context);
  if (
    !url.startsWith("file:") ||
    fileURLToPath(url) !== A16Z_DATASET_PATH ||
    loaded.source === undefined
  ) {
    return loaded;
  }

  const source =
    typeof loaded.source === "string"
      ? loaded.source
      : Buffer.from(loaded.source).toString("utf8");
  if (/(?:function|const|let|var)\s+round\b/.test(source)) {
    return loaded;
  }

  return {
    ...loaded,
    source: `const round = (value, digits = 2) => { const factor = 10 ** digits; return Math.round(value * factor) / factor; };\n${source}`,
    shortCircuit: true
  };
}

function localCandidate(specifier, parentURL) {
  if (specifier.startsWith("@/")) {
    return path.join(REPOSITORY_ROOT, "src", specifier.slice(2));
  }

  if (!specifier.startsWith(".") || !parentURL?.startsWith(REPOSITORY_ROOT_URL)) {
    return null;
  }

  return path.resolve(path.dirname(fileURLToPath(parentURL)), specifier);
}

async function resolveLocalPath(candidate) {
  for (const suffix of RESOLUTION_SUFFIXES) {
    const filePath = `${candidate}${suffix}`;
    if (await isFile(filePath)) {
      return filePath;
    }
  }

  for (const suffix of RESOLUTION_SUFFIXES.slice(1)) {
    const indexPath = path.join(candidate, `index${suffix}`);
    if (await isFile(indexPath)) {
      return indexPath;
    }
  }

  return null;
}

async function isFile(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}
