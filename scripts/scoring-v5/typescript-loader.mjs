import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REPOSITORY_ROOT_URL = pathToFileURL(`${REPOSITORY_ROOT}${path.sep}`).href;
const RESOLUTION_SUFFIXES = ["", ".ts", ".js", ".mjs", ".json"];

export async function resolve(specifier, context, nextResolve) {
  const candidate = localCandidate(specifier, context.parentURL);
  if (!candidate) return nextResolve(specifier, context);
  const resolvedPath = await resolveLocalPath(candidate);
  if (!resolvedPath) return nextResolve(specifier, context);
  return { url: pathToFileURL(resolvedPath).href, shortCircuit: true };
}

function localCandidate(specifier, parentURL) {
  if (!specifier.startsWith(".") || !parentURL?.startsWith(REPOSITORY_ROOT_URL)) return null;
  return path.resolve(path.dirname(fileURLToPath(parentURL)), specifier);
}

async function resolveLocalPath(candidate) {
  for (const suffix of RESOLUTION_SUFFIXES) {
    const filePath = `${candidate}${suffix}`;
    if (await isFile(filePath)) return filePath;
  }
  for (const suffix of RESOLUTION_SUFFIXES.slice(1)) {
    const indexPath = path.join(candidate, `index${suffix}`);
    if (await isFile(indexPath)) return indexPath;
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
