import { execFile } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MANIFEST_PATH = "public/graph/manifest.json";

export async function comparePublicationSemantics({
  rootDir = process.cwd(),
  baseRef = "HEAD",
  targetRef = "index",
  ignoredPaths = []
} = {}) {
  const repositoryRoot = path.resolve(rootDir);
  const normalizedBaseRef = requiredRef(baseRef, "baseRef");
  const normalizedTargetRef = requiredRef(targetRef, "targetRef");
  const ignored = new Set(ignoredPaths.map((filePath) => normalizeRepositoryPath(filePath)));

  await git(repositoryRoot, ["rev-parse", "--verify", `${normalizedBaseRef}^{commit}`]);
  if (normalizedTargetRef !== "index") {
    await git(repositoryRoot, ["rev-parse", "--verify", `${normalizedTargetRef}^{commit}`]);
  }

  // A publication comparison is authoritative only when the canonical
  // manifest and every declared target-side provenance receipt are present
  // and structurally valid, even if their bytes happen to be unchanged.
  await assertChangedManifestIsValid(repositoryRoot, normalizedBaseRef, normalizedTargetRef);
  await Promise.all(
    [...ignored].map((filePath) =>
      assertTargetJsonIsValid(repositoryRoot, normalizedTargetRef, filePath)
    )
  );

  const changedPaths = await listChangedPaths(repositoryRoot, normalizedBaseRef, normalizedTargetRef);
  const semanticPaths = [];

  for (const filePath of changedPaths) {
    if (filePath === MANIFEST_PATH) {
      if (await manifestHasSemanticChange(repositoryRoot, normalizedBaseRef, normalizedTargetRef)) {
        semanticPaths.push(filePath);
      }
      continue;
    }

    if (ignored.has(filePath)) {
      continue;
    }

    semanticPaths.push(filePath);
  }

  return {
    changed: semanticPaths.length > 0,
    changedPaths: semanticPaths
  };
}

async function listChangedPaths(repositoryRoot, baseRef, targetRef) {
  const args = ["diff", "--no-renames", "--name-only", "-z"];
  if (targetRef === "index") {
    args.push("--cached", baseRef, "--");
  } else {
    args.push(baseRef, targetRef, "--");
  }

  const { stdout } = await git(repositoryRoot, args, { encoding: "buffer" });
  return [...new Set(stdout.toString("utf8").split("\0").filter(Boolean))]
    .map(normalizeRepositoryPath)
    .sort();
}

async function assertChangedManifestIsValid(repositoryRoot, baseRef, targetRef) {
  const baseBytes = await readGitFile(repositoryRoot, baseRef, MANIFEST_PATH);
  const targetBytes = await readGitFile(repositoryRoot, targetRef, MANIFEST_PATH);

  if (baseBytes === null) {
    throw new Error(`${MANIFEST_PATH} is missing at base ${baseRef}.`);
  }
  if (targetBytes === null) {
    throw new Error(`${MANIFEST_PATH} is missing at target ${targetRef}.`);
  }

  parseManifest(baseBytes, `base ${baseRef}`);
  parseManifest(targetBytes, `target ${targetRef}`);
}

async function manifestHasSemanticChange(repositoryRoot, baseRef, targetRef) {
  const baseManifest = parseManifest(
    await readGitFile(repositoryRoot, baseRef, MANIFEST_PATH),
    `base ${baseRef}`
  );
  const targetManifest = parseManifest(
    await readGitFile(repositoryRoot, targetRef, MANIFEST_PATH),
    `target ${targetRef}`
  );

  delete baseManifest.publishedAt;
  delete baseManifest.ingestionRunId;
  delete targetManifest.publishedAt;
  delete targetManifest.ingestionRunId;

  return canonicalJson(baseManifest) !== canonicalJson(targetManifest);
}

async function assertTargetJsonIsValid(repositoryRoot, targetRef, filePath) {
  const targetBytes = await readGitFile(repositoryRoot, targetRef, filePath);
  if (targetBytes === null) {
    throw new Error(`Ignored provenance path ${filePath} is missing at target ${targetRef}.`);
  }

  let value;
  try {
    value = JSON.parse(targetBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Ignored provenance path ${filePath} is not valid JSON at target ${targetRef}: ${error.message}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `Ignored provenance path ${filePath} must contain a JSON object at target ${targetRef}.`
    );
  }
}

function parseManifest(bytes, location) {
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${MANIFEST_PATH} is not valid JSON at ${location}: ${error.message}`);
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`${MANIFEST_PATH} must contain a JSON object at ${location}.`);
  }
  return manifest;
}

async function readGitFile(repositoryRoot, ref, filePath) {
  const objectSpec = ref === "index" ? `:${filePath}` : `${ref}:${filePath}`;
  try {
    const { stdout } = await git(repositoryRoot, ["show", "--no-ext-diff", objectSpec], {
      encoding: "buffer"
    });
    return stdout;
  } catch (error) {
    if (error?.code === 128) return null;
    throw error;
  }
}

async function git(repositoryRoot, args, options = {}) {
  try {
    return await execFileAsync("git", args, {
      cwd: repositoryRoot,
      maxBuffer: 32 * 1024 * 1024,
      ...options
    });
  } catch (error) {
    const detail = String(error?.stderr ?? error?.message ?? "git command failed").trim();
    const wrapped = new Error(`Git command failed (${args.join(" ")}): ${detail}`, { cause: error });
    wrapped.code = error?.code;
    throw wrapped;
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function requiredRef(value, label) {
  const normalized = String(value ?? "").trim();
  if (
    !normalized ||
    normalized.startsWith("-") ||
    normalized.includes(":") ||
    /[\u0000-\u0020\u007f]/u.test(normalized)
  ) {
    throw new Error(`${label} is missing or unsafe.`);
  }
  return normalized;
}

function normalizeRepositoryPath(value) {
  const normalized = String(value ?? "").replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    /[\u0000-\u001f\u007f]/u.test(normalized) ||
    path.posix.normalize(normalized) !== normalized
  ) {
    throw new Error(`Unsafe repository path: ${String(value)}`);
  }
  return normalized;
}

function parseArgs(argv) {
  const options = { rootDir: process.cwd(), baseRef: "HEAD", targetRef: "index", ignoredPaths: [] };
  const valueFlags = new Map([
    ["--root", "rootDir"],
    ["--base", "baseRef"],
    ["--target", "targetRef"]
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const equalsIndex = argument.indexOf("=");
    const flag = equalsIndex === -1 ? argument : argument.slice(0, equalsIndex);
    if (flag === "--ignore") {
      const value = equalsIndex === -1 ? argv[++index] : argument.slice(equalsIndex + 1);
      if (!value || value.startsWith("--")) throw new Error("--ignore requires a path.");
      options.ignoredPaths.push(value);
      continue;
    }

    if (!valueFlags.has(flag)) throw new Error(`Unknown argument: ${argument}`);
    const value = equalsIndex === -1 ? argv[++index] : argument.slice(equalsIndex + 1);
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
    options[valueFlags.get(flag)] = value;
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const result = await comparePublicationSemantics(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.changed ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error) => {
      process.stderr.write(`${error.stack ?? error.message}\n`);
      process.exitCode = 2;
    }
  );
}
