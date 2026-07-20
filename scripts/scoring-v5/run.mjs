import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { publishArtifactSet, validateArtifactSet } from "./artifact-store.mjs";
import { computeV5CodeSnapshot } from "./code-snapshot.mjs";
import { prepareAndAssertV5Runtime } from "./runtime.mjs";
import {
  byteIdentityReport,
  canonicalJson,
  runV5Pipeline,
  sha256Text,
  validateInputManifest,
  validateTrainingSourcesAgainstRegistry
} from "../../src/lib/scoring/v5/index.ts";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const runtimeEnvironment = prepareAndAssertV5Runtime();
const argumentsMap = Object.fromEntries(
  process.argv.slice(2).map((argument) => {
    const [key, ...rest] = argument.replace(/^--/, "").split("=");
    return [key, rest.length === 0 ? true : rest.join("=")];
  })
);
const inputManifestPath = resolveWithinRoot(
  stringArgument("manifest", "artifacts/scoring-v5/input-manifest.json")
);
const outputDirectory = resolveWithinRoot(stringArgument("output", "artifacts/scoring-v5/generated"));
if (outputDirectory === REPOSITORY_ROOT) {
  throw new Error("The V5 artifact output must be a concrete directory below the repository root.");
}
const modelVersion = stringArgument("model-version", "5.0.0-research");
const codeSnapshot = await computeV5CodeSnapshot(REPOSITORY_ROOT);
const codeRevision = codeSnapshot.revision;
const requestedCodeRevision = optionalStringArgument("code-revision");
if (requestedCodeRevision !== undefined && requestedCodeRevision !== codeRevision) {
  throw new Error(
    `Requested code revision ${requestedCodeRevision} does not match computed V5 snapshot ${codeRevision}.`
  );
}
const manifestText = await readFile(inputManifestPath, "utf8");
const inputManifest = JSON.parse(manifestText);
const researchRegistry = JSON.parse(
  await readFile(path.join(REPOSITORY_ROOT, "docs/scoring-research/source-registry.json"), "utf8")
);
validateInputManifest(inputManifest);
validateTrainingSourcesAgainstRegistry(inputManifest, researchRegistry);
const registeredFiles = {};
for (const source of inputManifest.sources ?? []) {
  if (source.status !== "accepted") continue;
  const sourcePath = path.resolve(path.dirname(inputManifestPath), source.relativePath);
  registeredFiles[source.relativePath] = await readFile(sourcePath, "utf8");
}
const dependencyLockHash = sha256Text(await readFile(path.join(REPOSITORY_ROOT, "package-lock.json"), "utf8"));
const options = {
  inputManifest,
  registeredFiles,
  modelVersion,
  codeRevision,
  dependencyLockHash,
  researchRegistry
};
const first = runV5Pipeline(options);
const second = runV5Pipeline(options);
const reproduction = byteIdentityReport(first, second);
if (!reproduction.identical) {
  throw new Error(`Deterministic reproduction failed: ${reproduction.mismatches.join(", ")}`);
}
const generatedFiles = artifactFileSet(first, reproduction);
if (argumentsMap["validate-only"]) {
  await validateArtifactSet(outputDirectory, generatedFiles);
} else {
  await publishArtifactSet(outputDirectory, generatedFiles);
}
process.stdout.write(
  canonicalJson({
    status: first.model.status,
    gateDecision: first.evaluation.gateDecision,
    supportedPlatforms: first.model.supportedPlatforms,
    hashes: reproduction.hashes,
    codeRevision,
    codeSnapshotFiles: codeSnapshot.relativePaths,
    runtimeEnvironment,
    outputDirectory: path.relative(REPOSITORY_ROOT, outputDirectory)
  })
);

function artifactFileSet(artifacts, reproductionReport) {
  return {
    "candidate-search.json": artifacts.serialized.candidateSearch,
    "canonical-dataset.json": artifacts.serialized.dataset,
    "evaluation.json": artifacts.serialized.evaluation,
    "export-manifest.json": artifacts.serialized.manifest,
    "model.json": artifacts.serialized.model,
    "reproducibility.json": canonicalJson(reproductionReport),
    "split-manifest.json": artifacts.serialized.split
  };
}

function stringArgument(name, fallback) {
  const value = argumentsMap[name];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function optionalStringArgument(name) {
  const value = argumentsMap[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function resolveWithinRoot(value) {
  const resolved = path.resolve(REPOSITORY_ROOT, value);
  if (resolved !== REPOSITORY_ROOT && !resolved.startsWith(`${REPOSITORY_ROOT}${path.sep}`)) {
    throw new Error(`Path escapes repository root: ${value}`);
  }
  return resolved;
}
