import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import {
  V5_ARTIFACT_FILENAMES,
  publishArtifactSet,
  validateArtifactSet
} from "../scripts/scoring-v5/artifact-store.mjs";
import {
  V5_RUNTIME_ENVIRONMENT,
  assertV5Runtime,
  prepareAndAssertV5Runtime
} from "../scripts/scoring-v5/runtime.mjs";

const FILE_OPERATIONS = Object.freeze({ mkdir, mkdtemp, readFile, rename, rm, writeFile });

test("runner asserts the actual pinned Node, UTC, and en-US environment", () => {
  assert.deepEqual(prepareAndAssertV5Runtime(), V5_RUNTIME_ENVIRONMENT);
  assert.throws(
    () => assertV5Runtime({ ...V5_RUNTIME_ENVIRONMENT, timezone: "America/Chicago" }),
    /timezone must be UTC/
  );
  assert.throws(
    () => assertV5Runtime({ ...V5_RUNTIME_ENVIRONMENT, nodeVersion: "24.13.0" }),
    /nodeVersion must be 24\.14\.0/
  );
});

test("validation rejects corruption in every generated V5 artifact", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "scoring-v5-corruption-"));
  const outputDirectory = path.join(temporaryRoot, "generated");
  const expected = artifactFixture("expected");
  try {
    await publishArtifactSet(outputDirectory, expected);
    for (const filename of V5_ARTIFACT_FILENAMES) {
      await writeFile(path.join(outputDirectory, filename), `${expected[filename]}corrupt`, "utf8");
      await assert.rejects(
        validateArtifactSet(outputDirectory, expected),
        new RegExp(`stale or corrupt: ${filename.replace(".", "\\.")}`)
      );
      await writeFile(path.join(outputDirectory, filename), expected[filename], "utf8");
    }
    await validateArtifactSet(outputDirectory, expected);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("staged publication rolls back the complete prior set after a swap failure", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "scoring-v5-rollback-"));
  const outputDirectory = path.join(temporaryRoot, "generated");
  const previous = artifactFixture("previous");
  const next = artifactFixture("next");
  try {
    await publishArtifactSet(outputDirectory, previous);
    let renameCalls = 0;
    const failingOperations = {
      ...FILE_OPERATIONS,
      async rename(from, to) {
        renameCalls += 1;
        if (renameCalls === 2) {
          const error = new Error("injected staged-directory swap failure");
          error.code = "EIO";
          throw error;
        }
        return rename(from, to);
      }
    };
    await assert.rejects(
      publishArtifactSet(outputDirectory, next, failingOperations),
      /injected staged-directory swap failure/
    );
    assert.equal(renameCalls, 3, "the third rename restores the prior directory");
    await validateArtifactSet(outputDirectory, previous);
    await assert.rejects(validateArtifactSet(outputDirectory, next), /stale or corrupt/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("staged publication exposes one complete validated artifact set", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "scoring-v5-publish-"));
  const outputDirectory = path.join(temporaryRoot, "generated");
  const expected = artifactFixture("published");
  try {
    await publishArtifactSet(outputDirectory, expected);
    await validateArtifactSet(outputDirectory, expected);
    assert.deepEqual(
      (await readdir(outputDirectory)).sort((left, right) => left.localeCompare(right, "en")),
      V5_ARTIFACT_FILENAMES
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

function artifactFixture(prefix) {
  return Object.fromEntries(
    V5_ARTIFACT_FILENAMES.map((filename) => [filename, `${prefix}:${filename}\n`])
  );
}
