import { readFile, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validatedRepositoryDataRoot } from "./validated-repository-data-root.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REPOSITORY_ROOT_URL = pathToFileURL(`${REPOSITORY_ROOT}${path.sep}`).href;
const CONFIGURED_SCORING_DATA_ROOT =
  argumentValue("--root") ?? process.env.SCORING_DATA_ROOT ?? process.env.SCORING_ROOT;
const EXPLICIT_SCORING_DATA_ROOT = CONFIGURED_SCORING_DATA_ROOT !== undefined;
const SCORING_DATA_ROOT = validatedRepositoryDataRoot(
  CONFIGURED_SCORING_DATA_ROOT,
  { fallbackRoot: REPOSITORY_ROOT, label: "scoring diagnostics data root" }
);
const A16Z_DATASET_PATH = path.join(REPOSITORY_ROOT, "src", "lib", "graph", "a16z-speedrun-006-dataset.ts");
const RESOLUTION_SUFFIXES = ["", ".ts", ".tsx", ".js", ".mjs", ".json"];

export async function resolve(specifier, context, nextResolve) {
  // Next's compile-time server boundary marker has no runtime payload. Node
  // ingestion CLIs execute the same server-only modules outside Next, so map
  // the marker to an inert module while retaining it for application builds.
  if (specifier === "server-only") {
    return { url: "data:text/javascript,export%20default%20undefined%3B", shortCircuit: true };
  }
  const localResolution = localCandidates(specifier, context.parentURL);
  if (!localResolution) {
    return resolveWithLegacyPackageFallback(specifier, context, nextResolve);
  }

  for (const candidate of localResolution.candidates) {
    const resolvedPath = await resolveLocalPath(candidate, {
      exact: localResolution.exact,
      requiredRoot: localResolution.requiredRoot
    });
    if (resolvedPath) {
      return {
        url: pathToFileURL(resolvedPath).href,
        shortCircuit: true
      };
    }
  }
  if (localResolution.required) {
    throw new Error(
      `Explicit scoring data root is missing required in-repository JSON: ${localResolution.displayPath}`
    );
  }
  return resolveWithLegacyPackageFallback(specifier, context, nextResolve);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith(".json")) {
    const jsonPath = fileURLToPath(url);
    const insideExplicitTarget = EXPLICIT_SCORING_DATA_ROOT && pathIsWithin(SCORING_DATA_ROOT, jsonPath);
    if (EXPLICIT_SCORING_DATA_ROOT && isMutableRepositoryJson(jsonPath) && !insideExplicitTarget) {
      throw new Error(
        `Refusing source-checkout JSON fallback while an explicit scoring data root is configured: ${jsonPath}`
      );
    }
    if (insideExplicitTarget) {
      await assertRealPathWithin(SCORING_DATA_ROOT, jsonPath);
    }
    const parsed = JSON.parse(await readFile(jsonPath, "utf8"));
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

function localCandidates(specifier, parentURL) {
  if (specifier.startsWith("@/")) {
    const relativePath = path.join("src", specifier.slice(2));
    if (!specifier.endsWith(".json")) {
      return { candidates: [path.join(REPOSITORY_ROOT, relativePath)] };
    }
    const targetPath = targetJsonPath(relativePath, specifier);
    return {
      candidates: EXPLICIT_SCORING_DATA_ROOT
        ? [targetPath]
        : uniquePaths([targetPath, path.join(REPOSITORY_ROOT, relativePath)]),
      displayPath: relativePath,
      exact: true,
      required: EXPLICIT_SCORING_DATA_ROOT,
      requiredRoot: EXPLICIT_SCORING_DATA_ROOT ? SCORING_DATA_ROOT : null
    };
  }

  if (!specifier.startsWith(".") || !parentURL?.startsWith(REPOSITORY_ROOT_URL)) {
    return null;
  }
  const sourceCandidate = path.resolve(path.dirname(fileURLToPath(parentURL)), specifier);
  if (!specifier.endsWith(".json")) return { candidates: [sourceCandidate] };
  const sourceRelativePath = path.relative(REPOSITORY_ROOT, sourceCandidate);
  const safelyInsideSource = sourceRelativePath !== "" &&
    !sourceRelativePath.startsWith("..") &&
    !path.isAbsolute(sourceRelativePath);
  if (!safelyInsideSource) return { candidates: [sourceCandidate], exact: true };
  const targetPath = targetJsonPath(sourceRelativePath, specifier);
  return {
    candidates: EXPLICIT_SCORING_DATA_ROOT
      ? [targetPath]
      : uniquePaths([targetPath, sourceCandidate]),
    displayPath: sourceRelativePath,
    exact: true,
    required: EXPLICIT_SCORING_DATA_ROOT,
    requiredRoot: EXPLICIT_SCORING_DATA_ROOT ? SCORING_DATA_ROOT : null
  };
}

function targetJsonPath(sourceRelativePath, specifier) {
  const targetPath = path.resolve(SCORING_DATA_ROOT, sourceRelativePath);
  if (!pathIsWithin(SCORING_DATA_ROOT, targetPath)) {
    throw new Error(`JSON import escapes the configured scoring data root (${specifier}).`);
  }
  return targetPath;
}

function uniquePaths(values) {
  return [...new Set(values.map((value) => path.resolve(value)))];
}

function argumentValue(name) {
  const prefix = `${name}=`;
  const argument = process.argv.find((value) => String(value).startsWith(prefix));
  return argument ? String(argument).slice(prefix.length) : undefined;
}

async function resolveWithLegacyPackageFallback(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    // Some installed packages (including Next's `next/server`) expose a
    // concrete legacy file without an ESM `exports` map. Node's ESM resolver
    // requires the extension for that subpath, while require.resolve retains
    // the package's normal legacy resolution. Keep this fallback limited to
    // bare package specifiers and only return a file that the package
    // resolver itself can locate.
    const legacyPath = legacyPackagePath(specifier, context.parentURL);
    if (!legacyPath || error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
    return {
      url: pathToFileURL(legacyPath).href,
      shortCircuit: true
    };
  }
}

function legacyPackagePath(specifier, parentURL) {
  if (
    !parentURL?.startsWith("file:") ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("#") ||
    specifier.includes(":")
  ) {
    return null;
  }
  try {
    return createRequire(fileURLToPath(parentURL)).resolve(specifier);
  } catch {
    return null;
  }
}

async function resolveLocalPath(candidate, { exact = false, requiredRoot = null } = {}) {
  for (const suffix of exact ? [""] : RESOLUTION_SUFFIXES) {
    const filePath = `${candidate}${suffix}`;
    const resolvedPath = await resolvedFilePath(filePath);
    if (resolvedPath) {
      if (requiredRoot) await assertRealPathWithin(requiredRoot, resolvedPath);
      return resolvedPath;
    }
  }

  if (exact) return null;
  for (const suffix of RESOLUTION_SUFFIXES.slice(1)) {
    const indexPath = path.join(candidate, `index${suffix}`);
    const resolvedPath = await resolvedFilePath(indexPath);
    if (resolvedPath) {
      if (requiredRoot) await assertRealPathWithin(requiredRoot, resolvedPath);
      return resolvedPath;
    }
  }

  return null;
}

async function resolvedFilePath(filePath) {
  try {
    if (!(await stat(filePath)).isFile()) return null;
    return await realpath(filePath);
  } catch {
    return null;
  }
}

async function assertRealPathWithin(rootPath, filePath) {
  const resolvedPath = await realpath(filePath);
  if (!pathIsWithin(rootPath, resolvedPath)) {
    throw new Error(
      `Resolved scoring JSON escapes the configured data root: ${filePath} -> ${resolvedPath}`
    );
  }
}

function isMutableRepositoryJson(filePath) {
  if (!pathIsWithin(REPOSITORY_ROOT, filePath)) return false;
  const relativePath = path.relative(REPOSITORY_ROOT, filePath);
  return relativePath !== "" && !relativePath.startsWith(`node_modules${path.sep}`);
}

function pathIsWithin(parentPath, candidatePath) {
  const relativePath = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}
