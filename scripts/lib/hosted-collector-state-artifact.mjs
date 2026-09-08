import { constants as fsConstants } from "node:fs";
import {
  appendFile,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const HOSTED_COLLECTOR_STATE_ARTIFACT_SCHEMA =
  "hosted-collector-state-artifact.v1";
export const HOSTED_COLLECTOR_STATE_ARTIFACT_PREFIX =
  "returner-ingestion-state-v1";
export const HOSTED_COLLECTOR_STATE_MAX_BYTES = 128 * 1024 * 1024;
export const HOSTED_COLLECTOR_STATE_MAX_FILES = 10_000;
// A maximum-file-count manifest is about 2.9 MiB with runtime journal paths;
// retain an explicit ceiling with headroom for every allowlisted path shape.
export const HOSTED_COLLECTOR_STATE_MANIFEST_MAX_BYTES = 8 * 1024 * 1024;
export const HOSTED_COLLECTOR_STATE_REPOSITORY = "allenbuild/returner-fund";
export const HOSTED_COLLECTOR_STATE_WORKFLOW =
  ".github/workflows/autonomous-ingestion.yml";
export const HOSTED_COLLECTOR_STATE_BRANCH = "main";

const FULL_SHA = /^[0-9a-f]{40}$/;
const SLOT_KEY = /^central-\d{4}-\d{2}-\d{2}-(?:0600|1800)$/;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const SAFE_INTEGER = /^[1-9][0-9]*$/;
const ALLOWED_RUN_EVENTS = new Set(["schedule", "repository_dispatch"]);
const ALLOWED_RUN_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out"]);
const ARTIFACTS_PER_PAGE = 100;
const MAX_ARTIFACT_INVENTORY_PAGES = 10;
const MAX_CANDIDATE_ARTIFACTS = 20;
const MAX_API_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_ARTIFACT_AGE_MS = 3 * 24 * 60 * 60 * 1_000;
const FUTURE_SKEW_MS = 5 * 60 * 1_000;
const ROOT_FILE = new RegExp(
  "^(?:public|github|checkpoint-public|discovery-attempts|source-discovery-paths)-" +
    "(?:s26|s2026|a16zsr006)(?:-shard-[0-9]+-of-[0-9]+)?\\.json$"
);
const LOSSLESS_FILE = new Set([
  "raw-envelopes.ndjson",
  "normalized-posts.ndjson",
  "metric-snapshots.ndjson",
  "account-identities.ndjson",
  "checkpoints.ndjson",
  "tombstones.ndjson"
]);
const SENSITIVE_PATH =
  /(?:^|[-_.\/])(?:auth(?:enticated)?|browser|cookie|credential|logged-in|opencli|session)(?:$|[-_.\/])/i;
const TEMPORARY_PATH = /(?:^|\/)(?:\.|[^/]+\.(?:tmp|temp|partial))(?:$|\/)/i;
const SECRET_PATTERNS = Object.freeze([
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9_]{12,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{12,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /(^|[^A-Za-z0-9_])sk-[A-Za-z0-9_-]{12,}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /\bBearer\s+(?!\[(?:redacted|redacted-public-token)\])[^\s"']{12,}/i,
  /\b(?:authorization|proxy-authorization)["']?\s*[:=]\s*["']?(?!\[(?:redacted|redacted-public-token)\])[^\s,"']{12,}/i
]);

export function hostedCollectorStateArtifactName({
  slotKey,
  sourceSha,
  runId,
  runAttempt,
  runnerOs = "Linux"
} = {}) {
  const slot = validSlotKey(slotKey);
  const sha = validSha(sourceSha);
  const id = validPositiveInteger(runId, "runId");
  const attempt = validPositiveInteger(runAttempt, "runAttempt");
  if (runnerOs !== "Linux") throw new Error("Hosted collector artifacts are Linux-only.");
  return `${HOSTED_COLLECTOR_STATE_ARTIFACT_PREFIX}-Linux-${slot}-${sha}-${id}-${attempt}`;
}

export function hostedCollectorStateSlotSegment(slotKey) {
  return safePathSegment(validSlotKey(slotKey));
}

export async function locateHostedCollectorStateArtifact({
  apiBaseUrl = "https://api.github.com",
  repository = HOSTED_COLLECTOR_STATE_REPOSITORY,
  defaultBranch = HOSTED_COLLECTOR_STATE_BRANCH,
  workflowPath = HOSTED_COLLECTOR_STATE_WORKFLOW,
  slotKey,
  sourceSha,
  currentRunId,
  token,
  fetchImpl = fetch,
  now = new Date(),
  maximumPages = MAX_ARTIFACT_INVENTORY_PAGES
} = {}) {
  const apiBase = validApiBase(apiBaseUrl);
  if (repository !== HOSTED_COLLECTOR_STATE_REPOSITORY) {
    throw new Error("Hosted collector artifact repository is not trusted.");
  }
  if (defaultBranch !== HOSTED_COLLECTOR_STATE_BRANCH) {
    throw new Error("Hosted collector artifact branch is not trusted.");
  }
  if (workflowPath !== HOSTED_COLLECTOR_STATE_WORKFLOW) {
    throw new Error("Hosted collector artifact workflow is not trusted.");
  }
  const slot = validSlotKey(slotKey);
  const sha = validSha(sourceSha);
  const currentId = validPositiveInteger(currentRunId, "currentRunId");
  if (typeof token !== "string" || token.length < 12 || /[\r\n]/.test(token)) {
    throw new Error("A bounded GitHub Actions token is required to locate recovery artifacts.");
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("Artifact locator now must be a valid Date.");
  }
  if (!Number.isSafeInteger(maximumPages) || maximumPages < 1 || maximumPages > 10) {
    throw new Error("Artifact locator page bound is invalid.");
  }

  const headers = Object.freeze({
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28"
  });
  const workflowFile = path.posix.basename(workflowPath);
  const workflow = await githubJson(
    `${apiBase}/repos/${repository}/actions/workflows/${encodeURIComponent(workflowFile)}`,
    { headers, fetchImpl }
  );
  const workflowId = validPositiveInteger(workflow?.id, "workflow.id");
  if (workflow?.path !== workflowPath || workflow?.state !== "active") {
    throw new Error("Hosted collector artifact workflow identity is not active and exact.");
  }

  const candidatePrefix =
    `${HOSTED_COLLECTOR_STATE_ARTIFACT_PREFIX}-Linux-${slot}-${sha}-`;
  const candidates = [];
  const seenCandidateNames = new Set();
  let previousCreatedAt = Number.POSITIVE_INFINITY;
  let inventoryComplete = false;
  for (let page = 1; page <= maximumPages; page += 1) {
    const payload = await githubJson(
      `${apiBase}/repos/${repository}/actions/artifacts` +
        `?per_page=${ARTIFACTS_PER_PAGE}&page=${page}`,
      { headers, fetchImpl }
    );
    if (
      !Array.isArray(payload?.artifacts) ||
      payload.artifacts.length > ARTIFACTS_PER_PAGE ||
      !Number.isSafeInteger(payload?.total_count) ||
      payload.total_count <
        (page - 1) * ARTIFACTS_PER_PAGE + payload.artifacts.length
    ) {
      throw new Error("GitHub returned a malformed repository artifact inventory.");
    }
    let pageWhollyOlder = payload.artifacts.length > 0;
    for (const artifact of payload.artifacts) {
      const createdAt = timestamp(artifact?.created_at);
      if (!Number.isFinite(createdAt) || createdAt > previousCreatedAt) {
        throw new Error("GitHub repository artifact inventory is not newest-first and exact.");
      }
      previousCreatedAt = createdAt;
      const olderThanRecoveryWindow = now.getTime() - createdAt > MAX_ARTIFACT_AGE_MS;
      if (!olderThanRecoveryWindow) pageWhollyOlder = false;

      const parsedName = parseHostedCollectorStateArtifactName(
        artifact?.name,
        candidatePrefix
      );
      if (
        !parsedName ||
        parsedName.runId >= currentId ||
        olderThanRecoveryWindow ||
        artifact?.expired !== false ||
        timestamp(artifact?.expires_at) <= now.getTime()
      ) {
        continue;
      }
      if (seenCandidateNames.has(artifact.name)) {
        throw new Error("GitHub returned duplicate immutable recovery artifacts.");
      }
      seenCandidateNames.add(artifact.name);
      candidates.push(Object.freeze({
        artifact,
        createdAt,
        runId: parsedName.runId,
        runAttempt: parsedName.runAttempt
      }));
    }

    if (
      pageWhollyOlder ||
      payload.artifacts.length < ARTIFACTS_PER_PAGE ||
      page * ARTIFACTS_PER_PAGE >= payload.total_count
    ) {
      inventoryComplete = true;
      break;
    }
    if (page === maximumPages) {
      throw new Error("GitHub repository artifact inventory exceeded its recent-page bound.");
    }
  }
  if (!inventoryComplete) {
    throw new Error("GitHub repository artifact inventory did not reach a bounded terminus.");
  }
  candidates.sort((left, right) =>
    right.createdAt - left.createdAt || Number(right.artifact.id) - Number(left.artifact.id)
  );

  for (const candidate of candidates.slice(0, MAX_CANDIDATE_ARTIFACTS)) {
    const runId = validPositiveInteger(candidate.runId, "candidate run id");
    const run = await githubJson(
      `${apiBase}/repos/${repository}/actions/runs/${runId}`,
      { headers, fetchImpl }
    );
    const runAttempt = validateRecoveryRun({
      run,
      repository,
      defaultBranch,
      workflowPath,
      workflowId,
      sourceSha: sha,
      currentRunId: currentId,
      now
    });
    if (validPositiveInteger(run?.id, "recovery run id") !== runId) {
      throw new Error("Recovery artifact run id is not exact.");
    }
    if (runAttempt !== candidate.runAttempt) {
      throw new Error("Recovery artifact run attempt is not exact.");
    }
    const expectedName = hostedCollectorStateArtifactName({
      slotKey: slot,
      sourceSha: sha,
      runId,
      runAttempt
    });
    const artifact = validateRecoveryArtifact({
      artifact: candidate.artifact,
      expectedName,
      run,
      repository,
      sourceSha: sha,
      defaultBranch,
      now
    });
    return Object.freeze({
      found: true,
      artifactId: artifact.id,
      artifactName: artifact.name,
      artifactDigest: artifact.digest,
      artifactRunId: runId,
      artifactRunAttempt: runAttempt
    });
  }

  return Object.freeze({
    found: false,
    artifactId: null,
    artifactName: "",
    artifactDigest: "",
    artifactRunId: null,
    artifactRunAttempt: null
  });
}

function parseHostedCollectorStateArtifactName(value, expectedPrefix) {
  if (typeof value !== "string" || !value.startsWith(expectedPrefix)) return null;
  const match = /^([1-9][0-9]*)-([1-9][0-9]*)$/.exec(value.slice(expectedPrefix.length));
  if (!match) return null;
  return Object.freeze({
    runId: validPositiveInteger(match[1], "artifact run id"),
    runAttempt: validPositiveInteger(match[2], "artifact run attempt")
  });
}

export async function prepareHostedCollectorArtifactFallback({
  managedRoot,
  stateRoot,
  downloadRoot
} = {}) {
  const managed = path.resolve(requiredText(managedRoot, "managedRoot"));
  const state = safeManagedPath(managed, stateRoot, "stateRoot");
  const download = safeManagedPath(managed, downloadRoot, "downloadRoot");
  await assertNoSymlinkedExistingComponents(managed, state, "stateRoot");
  await assertNoSymlinkedExistingComponents(managed, download, "downloadRoot");
  if (!state.endsWith(`${path.sep}returner-fund-autonomous-ingestion-state${path.sep}v1`)) {
    throw new Error("Hosted collector state root does not have the exact managed suffix.");
  }
  if (!download.includes(`${path.sep}returner-fund-hosted-collector-artifact${path.sep}`)) {
    throw new Error("Hosted collector download root does not have the exact managed prefix.");
  }
  await rm(state, { recursive: true, force: true });
  await rm(download, { recursive: true, force: true });
}

export async function stageHostedCollectorStateArtifact({
  managedRoot,
  stateRoot,
  bundleRoot,
  repository = HOSTED_COLLECTOR_STATE_REPOSITORY,
  repositoryId,
  workflowPath = HOSTED_COLLECTOR_STATE_WORKFLOW,
  slotKey,
  sourceSha,
  runId,
  runAttempt,
  secrets = [],
  now = new Date()
} = {}) {
  const provenance = validatedBundleProvenance({
    repository,
    repositoryId,
    workflowPath,
    slotKey,
    sourceSha,
    runId,
    runAttempt,
    now
  });
  const managed = path.resolve(requiredText(managedRoot, "managedRoot"));
  const source = safeManagedPath(managed, stateRoot, "stateRoot");
  const destination = safeManagedPath(managed, bundleRoot, "bundleRoot");
  await assertNoSymlinkedExistingComponents(managed, source, "stateRoot");
  await assertNoSymlinkedExistingComponents(managed, destination, "bundleRoot");
  if (!source.endsWith(`${path.sep}returner-fund-autonomous-ingestion-state${path.sep}v1`)) {
    throw new Error("Hosted collector state root does not have the exact managed suffix.");
  }
  if (!destination.includes(`${path.sep}returner-fund-hosted-collector-artifact${path.sep}`)) {
    throw new Error("Hosted collector bundle root does not have the exact managed prefix.");
  }
  if (await pathExists(destination)) {
    throw new Error("Hosted collector artifact staging must start from a fresh destination.");
  }

  const validated = await inspectHostedCollectorState({
    stateRoot: source,
    slotKey: provenance.slotKey,
    secrets
  });
  const temporary = `${destination}.tmp-${randomUUID()}`;
  try {
    await mkdir(path.join(temporary, "state"), { recursive: true, mode: 0o700 });
    for (const file of validated.files) {
      const target = path.join(temporary, "state", ...file.path.split("/"));
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, file.contents, { mode: 0o600, flag: "wx" });
    }
    const artifactName = hostedCollectorStateArtifactName(provenance);
    const manifest = {
      schemaVersion: HOSTED_COLLECTOR_STATE_ARTIFACT_SCHEMA,
      repository: provenance.repository,
      repositoryId: provenance.repositoryId,
      workflowPath: provenance.workflowPath,
      slotKey: provenance.slotKey,
      sourceSha: provenance.sourceSha,
      runId: provenance.runId,
      runAttempt: provenance.runAttempt,
      artifactName,
      createdAt: provenance.createdAt,
      fileCount: validated.fileCount,
      totalBytes: validated.totalBytes,
      files: validated.files.map((file) => ({
        path: file.path,
        size: file.size,
        sha256: file.sha256
      }))
    };
    await writeFile(
      path.join(temporary, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600, flag: "wx" }
    );
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await rename(temporary, destination);
    return Object.freeze({
      artifactName,
      bundleRoot: destination,
      fileCount: validated.fileCount,
      totalBytes: validated.totalBytes
    });
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function promoteHostedCollectorStateArtifact({
  managedRoot,
  bundleRoot,
  stateRoot,
  repository = HOSTED_COLLECTOR_STATE_REPOSITORY,
  repositoryId,
  workflowPath = HOSTED_COLLECTOR_STATE_WORKFLOW,
  slotKey,
  sourceSha,
  artifactRunId,
  artifactRunAttempt,
  artifactName,
  secrets = [],
  now = new Date()
} = {}) {
  const provenance = validatedBundleProvenance({
    repository,
    repositoryId,
    workflowPath,
    slotKey,
    sourceSha,
    runId: artifactRunId,
    runAttempt: artifactRunAttempt,
    now
  });
  const expectedName = hostedCollectorStateArtifactName(provenance);
  if (artifactName !== expectedName) {
    throw new Error("Downloaded hosted collector artifact name is not exact.");
  }
  const managed = path.resolve(requiredText(managedRoot, "managedRoot"));
  const bundle = safeManagedPath(managed, bundleRoot, "bundleRoot");
  const target = safeManagedPath(managed, stateRoot, "stateRoot");
  await assertNoSymlinkedExistingComponents(managed, bundle, "bundleRoot");
  await assertNoSymlinkedExistingComponents(managed, target, "stateRoot");
  if (!target.endsWith(`${path.sep}returner-fund-autonomous-ingestion-state${path.sep}v1`)) {
    throw new Error("Hosted collector state root does not have the exact managed suffix.");
  }
  const entries = await readdir(bundle, { withFileTypes: true });
  if (
    entries.length !== 2 ||
    !entries.some((entry) => entry.name === "manifest.json" && entry.isFile()) ||
    !entries.some((entry) => entry.name === "state" && entry.isDirectory()) ||
    entries.some((entry) => entry.isSymbolicLink())
  ) {
    throw new Error("Downloaded hosted collector artifact has an unexpected bundle shape.");
  }
  const manifest = JSON.parse(await readBoundedRegularFile(
    path.join(bundle, "manifest.json"),
    HOSTED_COLLECTOR_STATE_MANIFEST_MAX_BYTES,
    "artifact manifest"
  ));
  validateManifest(manifest, { ...provenance, artifactName: expectedName, now });
  const validated = await inspectHostedCollectorState({
    stateRoot: path.join(bundle, "state"),
    slotKey: provenance.slotKey,
    secrets
  });
  assertManifestFiles(manifest, validated);

  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const sourceDevice = (await stat(path.dirname(path.join(bundle, "state")))).dev;
  const targetDevice = (await stat(path.dirname(target))).dev;
  if (sourceDevice !== targetDevice) {
    throw new Error("Hosted collector artifact promotion is not on one atomic filesystem.");
  }
  const backup = `${target}.artifact-backup-${randomUUID()}`;
  let backedUp = false;
  try {
    if (await pathExists(target)) {
      await rename(target, backup);
      backedUp = true;
    }
    await rename(path.join(bundle, "state"), target);
    if (backedUp) await rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (backedUp && !(await pathExists(target)) && await pathExists(backup)) {
      await rename(backup, target);
    }
    throw error;
  }
  return Object.freeze({ fileCount: validated.fileCount, totalBytes: validated.totalBytes });
}

export async function inspectHostedCollectorState({
  stateRoot,
  slotKey,
  secrets = [],
  maximumBytes = HOSTED_COLLECTOR_STATE_MAX_BYTES,
  maximumFiles = HOSTED_COLLECTOR_STATE_MAX_FILES
} = {}) {
  const root = path.resolve(requiredText(stateRoot, "stateRoot"));
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("Hosted collector state root must be a real directory.");
  }
  const slotSegment = safePathSegment(validSlotKey(slotKey));
  const files = [];
  let totalBytes = 0;

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      const relativePath = portableRelative(root, absolute);
      if (!relativePath || relativePath.startsWith("../") || path.isAbsolute(relativePath)) {
        throw new Error("Hosted collector state path escaped its root.");
      }
      if (TEMPORARY_PATH.test(relativePath)) {
        throw new Error(`Hosted collector state contains a temporary path: ${relativePath}`);
      }
      if (SENSITIVE_PATH.test(relativePath)) {
        throw new Error(`Hosted collector state contains an authenticated path: ${relativePath}`);
      }
      const info = await lstat(absolute);
      if (entry.isSymbolicLink() || info.isSymbolicLink()) {
        throw new Error(`Hosted collector state contains a symbolic link: ${relativePath}`);
      }
      if (info.isDirectory()) {
        if (!allowedDirectory(relativePath, slotSegment)) {
          throw new Error(`Hosted collector state contains an unexpected directory: ${relativePath}`);
        }
        await visit(absolute);
        continue;
      }
      if (!info.isFile() || !entry.isFile() || info.nlink !== 1) {
        throw new Error(`Hosted collector state contains a non-regular file: ${relativePath}`);
      }
      if (!allowedFile(relativePath, slotSegment)) {
        throw new Error(`Hosted collector state contains an unexpected file: ${relativePath}`);
      }
      if (files.length + 1 > maximumFiles) {
        throw new Error(`Hosted collector state exceeds ${maximumFiles} files.`);
      }
      totalBytes += info.size;
      if (totalBytes > maximumBytes) {
        throw new Error(`Hosted collector state exceeds ${maximumBytes} bytes.`);
      }
      const contents = await readRegularFileNoFollow(absolute, info);
      const text = decodeUtf8(contents, relativePath);
      validateStructuredText(text, relativePath);
      assertNoSecrets(text, secrets, relativePath);
      files.push(Object.freeze({
        path: relativePath,
        size: contents.length,
        sha256: sha256(contents),
        contents
      }));
    }
  }

  await visit(root);
  if (files.length === 0) throw new Error("Hosted collector state contains no recoverable files.");
  if (!files.some((file) => file.path.startsWith(`slots/${slotSegment}/`))) {
    throw new Error("Hosted collector state does not contain the exact slot.");
  }
  return Object.freeze({ files: Object.freeze(files), fileCount: files.length, totalBytes });
}

function validateRecoveryRun({
  run,
  repository,
  defaultBranch,
  workflowPath,
  workflowId,
  sourceSha,
  currentRunId,
  now
}) {
  const id = validPositiveInteger(run?.id, "recovery run id");
  const repositoryId = validPositiveInteger(run?.repository?.id, "run repository id");
  if (
    id >= currentRunId ||
    run?.workflow_id !== workflowId ||
    run?.path !== workflowPath ||
    run?.repository?.full_name !== repository ||
    run?.head_repository?.full_name !== repository ||
    run?.head_repository?.id !== repositoryId ||
    run?.head_branch !== defaultBranch ||
    String(run?.head_sha ?? "").toLowerCase() !== sourceSha ||
    run?.status !== "completed" ||
    !ALLOWED_RUN_CONCLUSIONS.has(run?.conclusion) ||
    !ALLOWED_RUN_EVENTS.has(run?.event)
  ) {
    throw new Error("Recovery artifact run provenance is not exact.");
  }
  const createdAt = timestamp(run.created_at);
  const updatedAt = timestamp(run.updated_at);
  if (
    !Number.isFinite(createdAt) ||
    !Number.isFinite(updatedAt) ||
    updatedAt < createdAt ||
    createdAt > now.getTime() + FUTURE_SKEW_MS ||
    updatedAt > now.getTime() + FUTURE_SKEW_MS ||
    now.getTime() - updatedAt > MAX_ARTIFACT_AGE_MS
  ) {
    throw new Error("Recovery artifact run timestamp is stale or invalid.");
  }
  return validPositiveInteger(run.run_attempt, "recovery run attempt");
}

function validateRecoveryArtifact({
  artifact,
  expectedName,
  run,
  repository,
  sourceSha,
  defaultBranch,
  now
}) {
  const id = validPositiveInteger(artifact?.id, "artifact id");
  const size = validPositiveInteger(artifact?.size_in_bytes, "artifact size");
  const createdAt = timestamp(artifact?.created_at);
  const expiresAt = timestamp(artifact?.expires_at);
  if (
    artifact?.name !== expectedName ||
    artifact?.expired !== false ||
    !SHA256_DIGEST.test(String(artifact?.digest ?? "")) ||
    size > HOSTED_COLLECTOR_STATE_MAX_BYTES ||
    !Number.isFinite(createdAt) ||
    !Number.isFinite(expiresAt) ||
    createdAt < timestamp(run.created_at) ||
    createdAt > now.getTime() + FUTURE_SKEW_MS ||
    now.getTime() - createdAt > MAX_ARTIFACT_AGE_MS ||
    expiresAt <= now.getTime()
  ) {
    throw new Error("Recovery artifact metadata is stale or invalid.");
  }
  const binding = artifact?.workflow_run;
  if (
    binding?.id !== run.id ||
    binding?.repository_id !== run.repository.id ||
    binding?.head_repository_id !== run.head_repository.id ||
    binding?.head_branch !== defaultBranch ||
    String(binding?.head_sha ?? "").toLowerCase() !== sourceSha ||
    run.repository.full_name !== repository
  ) {
    throw new Error("Recovery artifact workflow binding is not exact.");
  }
  return Object.freeze({ id, name: expectedName, digest: artifact.digest, size });
}

function validatedBundleProvenance({
  repository,
  repositoryId,
  workflowPath,
  slotKey,
  sourceSha,
  runId,
  runAttempt,
  now
}) {
  if (repository !== HOSTED_COLLECTOR_STATE_REPOSITORY) {
    throw new Error("Hosted collector bundle repository is not trusted.");
  }
  if (workflowPath !== HOSTED_COLLECTOR_STATE_WORKFLOW) {
    throw new Error("Hosted collector bundle workflow is not trusted.");
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("Hosted collector bundle now must be a valid Date.");
  }
  return Object.freeze({
    repository,
    repositoryId: validPositiveInteger(repositoryId, "repositoryId"),
    workflowPath,
    slotKey: validSlotKey(slotKey),
    sourceSha: validSha(sourceSha),
    runId: validPositiveInteger(runId, "runId"),
    runAttempt: validPositiveInteger(runAttempt, "runAttempt"),
    runnerOs: "Linux",
    createdAt: now.toISOString()
  });
}

function validateManifest(manifest, expected) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Hosted collector artifact manifest is malformed.");
  }
  const exactKeys = [
    "artifactName",
    "createdAt",
    "fileCount",
    "files",
    "repository",
    "repositoryId",
    "runAttempt",
    "runId",
    "schemaVersion",
    "slotKey",
    "sourceSha",
    "totalBytes",
    "workflowPath"
  ];
  if (JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(exactKeys)) {
    throw new Error("Hosted collector artifact manifest fields are not exact.");
  }
  if (
    manifest.schemaVersion !== HOSTED_COLLECTOR_STATE_ARTIFACT_SCHEMA ||
    manifest.repository !== expected.repository ||
    manifest.repositoryId !== expected.repositoryId ||
    manifest.workflowPath !== expected.workflowPath ||
    manifest.slotKey !== expected.slotKey ||
    manifest.sourceSha !== expected.sourceSha ||
    manifest.runId !== expected.runId ||
    manifest.runAttempt !== expected.runAttempt ||
    manifest.artifactName !== expected.artifactName
  ) {
    throw new Error("Hosted collector artifact manifest provenance is not exact.");
  }
  const createdAt = timestamp(manifest.createdAt);
  if (
    !Number.isFinite(createdAt) ||
    createdAt > expected.now.getTime() + FUTURE_SKEW_MS ||
    expected.now.getTime() - createdAt > MAX_ARTIFACT_AGE_MS
  ) {
    throw new Error("Hosted collector artifact manifest timestamp is stale or invalid.");
  }
  if (
    !Number.isSafeInteger(manifest.fileCount) ||
    manifest.fileCount < 1 ||
    manifest.fileCount > HOSTED_COLLECTOR_STATE_MAX_FILES ||
    !Number.isSafeInteger(manifest.totalBytes) ||
    manifest.totalBytes < 1 ||
    manifest.totalBytes > HOSTED_COLLECTOR_STATE_MAX_BYTES ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error("Hosted collector artifact manifest bounds are invalid.");
  }
}

function assertManifestFiles(manifest, validated) {
  const actual = validated.files.map((file) => ({
    path: file.path,
    size: file.size,
    sha256: file.sha256
  }));
  if (
    manifest.fileCount !== validated.fileCount ||
    manifest.totalBytes !== validated.totalBytes ||
    JSON.stringify(manifest.files) !== JSON.stringify(actual)
  ) {
    throw new Error("Hosted collector artifact contents do not match the content digest manifest.");
  }
}

function allowedDirectory(relativePath, slotSegment) {
  return relativePath === "slots" ||
    relativePath === `slots/${slotSegment}` ||
    relativePath === `slots/${slotSegment}/lossless-public-post-archive` ||
    relativePath === `slots/${slotSegment}/recent-window-journals` ||
    new RegExp(`^slots/${escapeRegExp(slotSegment)}/recent-window-journals/shard-[0-9]+-of-[0-9]+$`)
      .test(relativePath);
}

function allowedFile(relativePath, slotSegment) {
  const rootPrefix = `slots/${slotSegment}/`;
  if (!relativePath.startsWith(rootPrefix)) return false;
  const nested = relativePath.slice(rootPrefix.length);
  if (nested === "top-voice-refresh.json" || ROOT_FILE.test(nested)) return true;
  if (nested.startsWith("lossless-public-post-archive/")) {
    return LOSSLESS_FILE.has(nested.slice("lossless-public-post-archive/".length));
  }
  return /^recent-window-journals\/shard-[0-9]+-of-[0-9]+\/[0-9a-f]{64}\.ndjson$/
    .test(nested);
}

async function readRegularFileNoFollow(filePath, expectedInfo) {
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== expectedInfo.dev || before.ino !== expectedInfo.ino) {
      throw new Error(`Hosted collector state file changed during validation: ${path.basename(filePath)}`);
    }
    const contents = await handle.readFile();
    const after = await handle.stat();
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      contents.length !== before.size
    ) {
      throw new Error(`Hosted collector state file changed during validation: ${path.basename(filePath)}`);
    }
    return contents;
  } finally {
    await handle.close();
  }
}

function validateStructuredText(text, relativePath) {
  if (relativePath.endsWith(".json")) {
    try {
      JSON.parse(text);
    } catch {
      throw new Error(`Hosted collector state contains malformed JSON: ${relativePath}`);
    }
    return;
  }
  if (!relativePath.endsWith(".ndjson")) {
    throw new Error(`Hosted collector state file is not JSON or NDJSON: ${relativePath}`);
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    throw new Error(`Hosted collector state contains empty NDJSON: ${relativePath}`);
  }
  for (const line of lines) {
    try {
      JSON.parse(line);
    } catch {
      throw new Error(`Hosted collector state contains malformed NDJSON: ${relativePath}`);
    }
  }
}

function assertNoSecrets(text, secrets, relativePath) {
  for (const secret of normalizedSecrets(secrets)) {
    if (text.includes(secret)) {
      throw new Error(`Hosted collector state contains an exact configured secret: ${relativePath}`);
    }
  }
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new Error(`Hosted collector state contains credential-shaped text: ${relativePath}`);
  }
}

function normalizedSecrets(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === "string" && value.length >= 8 && !/[\r\n]/.test(value)))];
}

async function githubJson(url, { headers, fetchImpl }) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(15_000)
    });
  } catch {
    throw new Error("GitHub artifact metadata request failed.");
  }
  if (!response?.ok) {
    throw new Error(`GitHub artifact metadata request returned HTTP ${Number(response?.status) || "unknown"}.`);
  }
  const body = await response.text();
  if (Buffer.byteLength(body) > MAX_API_RESPONSE_BYTES) {
    throw new Error("GitHub artifact metadata response exceeded its bound.");
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("GitHub artifact metadata response was not JSON.");
  }
}

async function readBoundedRegularFile(filePath, maximumBytes, label) {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maximumBytes) {
    throw new Error(`${label} is not a bounded regular file.`);
  }
  const contents = await readRegularFileNoFollow(filePath, info);
  return decodeUtf8(contents, label);
}

function decodeUtf8(contents, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } catch {
    throw new Error(`Hosted collector state contains invalid UTF-8: ${label}`);
  }
}

function validApiBase(value) {
  const url = new URL(requiredText(value, "apiBaseUrl"));
  if (
    url.protocol !== "https:" ||
    url.hostname !== "api.github.com" ||
    url.port ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new Error("Hosted collector artifact API base is not trusted.");
  }
  return "https://api.github.com";
}

function validSlotKey(value) {
  const slot = requiredText(value, "slotKey");
  if (!SLOT_KEY.test(slot)) throw new Error("Hosted collector artifact slot key is invalid.");
  return slot;
}

function validSha(value) {
  const sha = requiredText(value, "sourceSha").toLowerCase();
  if (!FULL_SHA.test(sha)) throw new Error("Hosted collector artifact source SHA is invalid.");
  return sha;
}

function validPositiveInteger(value, label) {
  const source = String(value ?? "");
  if (!SAFE_INTEGER.test(source)) throw new Error(`${label} must be a positive integer.`);
  const number = Number(source);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`${label} must be a safe positive integer.`);
  }
  return number;
}

function requiredText(value, label) {
  if (typeof value !== "string" || !value.trim() || /[\r\n\0]/.test(value)) {
    throw new Error(`${label} must be non-empty single-line text.`);
  }
  return value.trim();
}

function safeManagedPath(managedRoot, candidate, label) {
  if (managedRoot === path.parse(managedRoot).root) {
    throw new Error("Managed runner temp root cannot be a filesystem root.");
  }
  const resolved = path.resolve(requiredText(candidate, label));
  const relativePath = path.relative(managedRoot, resolved);
  if (!relativePath || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw new Error(`${label} must stay below the managed runner temp root.`);
  }
  return resolved;
}

async function assertNoSymlinkedExistingComponents(managedRoot, target, label) {
  const rootInfo = await lstat(managedRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("Managed runner temp root must be a real directory.");
  }
  const parts = path.relative(managedRoot, target).split(path.sep).filter(Boolean);
  let cursor = managedRoot;
  for (let index = 0; index < parts.length; index += 1) {
    cursor = path.join(cursor, parts[index]);
    let info;
    try {
      info = await lstat(cursor);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new Error(`${label} contains a symbolic-link component.`);
    }
    if (index < parts.length - 1 && !info.isDirectory()) {
      throw new Error(`${label} contains a non-directory parent component.`);
    }
  }
}

function portableRelative(root, target) {
  return path.relative(root, target).split(path.sep).join("/");
}

function safePathSegment(value) {
  const source = String(value);
  const prefix = source.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "run";
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 16);
  return `${prefix}-${digest}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function timestamp(value) {
  return Date.parse(String(value ?? ""));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function pathExists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function collectorSecrets(environment = process.env) {
  return Object.entries(environment)
    .filter(([key]) => key.startsWith("HOSTED_COLLECTOR_STATE_SECRET_"))
    .map(([, value]) => value)
    .filter(Boolean);
}

async function writeOutputs(values, outputPath = process.env.GITHUB_OUTPUT) {
  if (!outputPath) throw new Error("GITHUB_OUTPUT is required.");
  const body = Object.entries(values).map(([key, value]) => `${key}=${value ?? ""}`).join("\n");
  await appendFile(outputPath, `${body}\n`);
}

async function runCli(command, environment = process.env) {
  if (command === "prepare") {
    await prepareHostedCollectorArtifactFallback({
      managedRoot: environment.RUNNER_TEMP,
      stateRoot: environment.HOSTED_COLLECTOR_STATE_ROOT,
      downloadRoot: environment.HOSTED_COLLECTOR_ARTIFACT_DOWNLOAD_ROOT
    });
    return;
  }
  if (command === "locate") {
    const result = await locateHostedCollectorStateArtifact({
      apiBaseUrl: environment.GITHUB_API_URL,
      repository: environment.GITHUB_REPOSITORY,
      slotKey: environment.HOSTED_COLLECTOR_SLOT_KEY,
      sourceSha: environment.HOSTED_COLLECTOR_SOURCE_SHA,
      currentRunId: environment.GITHUB_RUN_ID,
      token: environment.GITHUB_TOKEN
    });
    await writeOutputs({
      artifact_found: String(result.found),
      artifact_id: result.artifactId,
      artifact_name: result.artifactName,
      artifact_digest: result.artifactDigest,
      artifact_run_id: result.artifactRunId,
      artifact_run_attempt: result.artifactRunAttempt
    });
    return;
  }
  if (command === "stage") {
    const result = await stageHostedCollectorStateArtifact({
      managedRoot: environment.RUNNER_TEMP,
      stateRoot: environment.HOSTED_COLLECTOR_STATE_ROOT,
      bundleRoot: environment.HOSTED_COLLECTOR_ARTIFACT_UPLOAD_ROOT,
      repository: environment.GITHUB_REPOSITORY,
      repositoryId: environment.GITHUB_REPOSITORY_ID,
      slotKey: environment.HOSTED_COLLECTOR_SLOT_KEY,
      sourceSha: environment.HOSTED_COLLECTOR_SOURCE_SHA,
      runId: environment.GITHUB_RUN_ID,
      runAttempt: environment.GITHUB_RUN_ATTEMPT,
      secrets: collectorSecrets(environment)
    });
    await writeOutputs({
      bundle_ready: "true",
      bundle_path: result.bundleRoot,
      artifact_name: result.artifactName,
      file_count: result.fileCount,
      total_bytes: result.totalBytes
    });
    return;
  }
  if (command === "promote") {
    await promoteHostedCollectorStateArtifact({
      managedRoot: environment.RUNNER_TEMP,
      bundleRoot: environment.HOSTED_COLLECTOR_ARTIFACT_DOWNLOAD_ROOT,
      stateRoot: environment.HOSTED_COLLECTOR_STATE_ROOT,
      repository: environment.GITHUB_REPOSITORY,
      repositoryId: environment.GITHUB_REPOSITORY_ID,
      slotKey: environment.HOSTED_COLLECTOR_SLOT_KEY,
      sourceSha: environment.HOSTED_COLLECTOR_SOURCE_SHA,
      artifactRunId: environment.HOSTED_COLLECTOR_ARTIFACT_RUN_ID,
      artifactRunAttempt: environment.HOSTED_COLLECTOR_ARTIFACT_RUN_ATTEMPT,
      artifactName: environment.HOSTED_COLLECTOR_ARTIFACT_NAME,
      secrets: collectorSecrets(environment)
    });
    return;
  }
  throw new Error("Usage: hosted-collector-state-artifact.mjs <prepare|locate|stage|promote>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv[2]).catch((error) => {
    let message = error instanceof Error ? error.message : String(error);
    for (const secret of normalizedSecrets(collectorSecrets())) {
      message = message.split(secret).join("[redacted]");
    }
    console.error(message.slice(0, 1_000));
    process.exitCode = 1;
  });
}
