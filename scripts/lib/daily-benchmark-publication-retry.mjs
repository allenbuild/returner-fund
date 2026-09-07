import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { TextDecoder } from "node:util";
import { pathToFileURL } from "node:url";
import path from "node:path";
import {
  assertReplaySafePublicationChanges,
  isValidatedPublicationRetryReuseSafePath
} from "./autonomous-publication-trust.mjs";

const FULL_SHA = /^[0-9a-f]{40}$/;
const STRUCTURED_GIT_OUTPUT_LIMIT = 256 * 1024 * 1024;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function exactCommit(value, label) {
  const commit = String(value ?? "").trim().toLowerCase();
  assert.match(commit, FULL_SHA, `${label} must be a full 40-hex commit SHA`);
  return commit;
}

function gitEnvironment() {
  const environment = {
    ...process.env,
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/dev/null",
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: "",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C"
  };
  delete environment.GITHUB_TOKEN;
  delete environment.PUBLICATION_EXTRAHEADER;
  delete environment.NEXT_PUBLIC_SUPABASE_URL;
  delete environment.SUPABASE_SERVICE_ROLE_KEY;
  return environment;
}

function runGit(repositoryRoot, args, { encoding = "utf8" } = {}) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding,
    env: gitEnvironment(),
    maxBuffer: STRUCTURED_GIT_OUTPUT_LIMIT,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function decodeStructuredGitOutput(value, label) {
  try {
    return utf8Decoder.decode(value);
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8`, { cause: error });
  }
}

export function parseRawGitDelta(value, { label = "Git delta" } = {}) {
  const decoded = Buffer.isBuffer(value)
    ? decodeStructuredGitOutput(value, label)
    : String(value ?? "");
  const fields = decoded.split("\0");
  if (fields.at(-1) === "") fields.pop();
  assert.equal(fields.length % 2, 0, `${label} contains an incomplete path record`);

  const changes = [];
  for (let index = 0; index < fields.length; index += 2) {
    const header = fields[index];
    const filePath = fields[index + 1];
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([AMD])$/.exec(header);
    assert.ok(match, `${label} contains an unsupported raw record: ${header}`);
    assert.ok(filePath, `${label} contains an empty tracked path`);
    changes.push({
      oldMode: match[1],
      newMode: match[2],
      oldObject: match[3],
      newObject: match[4],
      status: match[5],
      path: filePath
    });
  }
  return changes;
}

function rawDelta(repositoryRoot, baseCommit, targetCommit, label) {
  const output = runGit(
    repositoryRoot,
    ["diff", "--raw", "-z", "--no-abbrev", "--no-renames", baseCommit, targetCommit, "--"],
    { encoding: null }
  );
  return parseRawGitDelta(output, { label });
}

function assertSingleParent(repositoryRoot, candidateCommit, expectedParent) {
  const parents = runGit(repositoryRoot, ["show", "-s", "--format=%P", candidateCommit])
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((value) => value.toLowerCase());
  assert.deepEqual(
    parents,
    [expectedParent],
    `Daily benchmark candidate must be a direct child of ${expectedParent}`
  );
}

function assertAncestor(repositoryRoot, ancestor, descendant, label) {
  try {
    runGit(repositoryRoot, ["merge-base", "--is-ancestor", ancestor, descendant]);
  } catch (error) {
    throw new Error(`${label} must descend from ${ancestor}`, { cause: error });
  }
}

function assertSafeTreeModes(repositoryRoot, commit, label) {
  const output = runGit(
    repositoryRoot,
    ["ls-tree", "-r", "-z", "--full-tree", commit],
    { encoding: null }
  );
  const decoded = decodeStructuredGitOutput(output, `${label} tree`);
  const unsafe = decoded.split("\0").filter(Boolean).flatMap((entry) => {
    const match = /^(\d{6})\s+\S+\s+[0-9a-f]+\t([\s\S]+)$/i.exec(entry);
    return match && ["120000", "160000"].includes(match[1])
      ? [`${match[2]} (${match[1]})`]
      : [];
  });
  assert.deepEqual(unsafe, [], `${label} contains prohibited symlink/submodule entries`);
}

export function inspectDailyBenchmarkPublicationRetry({
  repositoryRoot,
  candidateBaseCommit,
  candidateCommit,
  retryBaseCommit
}) {
  const root = path.resolve(repositoryRoot);
  const candidateBase = exactCommit(candidateBaseCommit, "candidate base");
  const candidate = exactCommit(candidateCommit, "candidate");
  const retryBase = exactCommit(retryBaseCommit, "retry base");

  assertSingleParent(root, candidate, candidateBase);
  assertAncestor(root, candidateBase, retryBase, "Daily benchmark retry base");
  assert.notEqual(retryBase, candidateBase, "Daily benchmark retry requires a newer remote base");
  assertSafeTreeModes(root, candidate, "Daily benchmark candidate");
  assertSafeTreeModes(root, retryBase, "Daily benchmark retry base");

  const candidateDelta = rawDelta(root, candidateBase, candidate, "daily benchmark candidate delta");
  assert.ok(candidateDelta.length > 0, "Daily benchmark candidate delta must not be empty");
  assertReplaySafePublicationChanges(candidateDelta.map(({ path: filePath }) => filePath), {
    label: "daily benchmark candidate delta"
  });

  const concurrentDelta = rawDelta(root, candidateBase, retryBase, "concurrent main delta");
  assert.ok(concurrentDelta.length > 0, "Concurrent main delta must not be empty");
  const unsafeConcurrent = concurrentDelta.filter(({ path: filePath, status, oldMode, newMode }) =>
    !isValidatedPublicationRetryReuseSafePath(filePath) ||
    status !== "M" ||
    oldMode !== "100644" ||
    newMode !== "100644"
  );
  assert.deepEqual(
    unsafeConcurrent,
    [],
    "Concurrent main may change only validated regular-file dashboard artifacts"
  );

  const concurrentPaths = new Set(concurrentDelta.map(({ path: filePath }) => filePath));
  const overlaps = candidateDelta
    .map(({ path: filePath }) => filePath)
    .filter((filePath) => concurrentPaths.has(filePath));
  assert.deepEqual(overlaps, [], "Concurrent main overlaps the daily benchmark candidate delta");

  return { root, candidateBase, candidate, retryBase, candidateDelta, concurrentDelta };
}

export function transplantDailyBenchmarkPublicationCandidate(options) {
  const inspection = inspectDailyBenchmarkPublicationRetry(options);
  const { root, candidate, retryBase, candidateDelta } = inspection;

  runGit(root, ["reset", "--hard", retryBase]);
  const deleted = candidateDelta.filter(({ status }) => status === "D").map(({ path: filePath }) => filePath);
  if (deleted.length > 0) {
    runGit(root, ["rm", "-f", "--ignore-unmatch", "--", ...deleted]);
  }
  const restored = candidateDelta
    .filter(({ status }) => status !== "D")
    .map(({ path: filePath }) => filePath);
  if (restored.length > 0) {
    runGit(root, ["checkout", candidate, "--", ...restored]);
  }

  const transplantedDelta = parseRawGitDelta(
    runGit(
      root,
      ["diff", "--cached", "--raw", "-z", "--no-abbrev", "--no-renames", retryBase, "--"],
      { encoding: null }
    ),
    { label: "transplanted daily benchmark delta" }
  );
  assert.deepEqual(
    transplantedDelta,
    candidateDelta,
    "Transplanted daily benchmark delta must exactly preserve path/status/mode/blob identity"
  );
  assert.equal(
    runGit(root, ["diff", "--quiet", "--no-ext-diff", "--"]).trim(),
    "",
    "Daily benchmark transplant left unstaged tracked changes"
  );
  return inspection;
}

function cliArgument(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? "";
}

async function main() {
  const result = transplantDailyBenchmarkPublicationCandidate({
    repositoryRoot: cliArgument("root") || process.cwd(),
    candidateBaseCommit: cliArgument("candidate-base"),
    candidateCommit: cliArgument("candidate"),
    retryBaseCommit: cliArgument("retry-base")
  });
  process.stdout.write(`${JSON.stringify({
    candidateBase: result.candidateBase,
    candidate: result.candidate,
    retryBase: result.retryBase,
    candidatePaths: result.candidateDelta.map(({ path: filePath }) => filePath),
    concurrentPaths: result.concurrentDelta.map(({ path: filePath }) => filePath)
  })}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
