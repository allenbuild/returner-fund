import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";

export const V5_ARTIFACT_FILENAMES = Object.freeze([
  "candidate-search.json",
  "canonical-dataset.json",
  "evaluation.json",
  "export-manifest.json",
  "model.json",
  "reproducibility.json",
  "split-manifest.json"
]);

const DEFAULT_OPERATIONS = Object.freeze({ mkdir, mkdtemp, readFile, rename, rm, writeFile });

export async function validateArtifactSet(directory, files, operations = DEFAULT_OPERATIONS) {
  assertCompleteArtifactSet(files);
  for (const filename of V5_ARTIFACT_FILENAMES) {
    let actual;
    try {
      actual = await operations.readFile(path.join(directory, filename));
    } catch (error) {
      throw new Error(`Generated V5 artifact is missing or unreadable: ${filename}`, {
        cause: error
      });
    }
    const expected = Buffer.from(files[filename], "utf8");
    if (!actual.equals(expected)) {
      throw new Error(`Generated V5 artifact is stale or corrupt: ${filename}`);
    }
  }
}

export async function publishArtifactSet(outputDirectory, files, operations = DEFAULT_OPERATIONS) {
  assertCompleteArtifactSet(files);
  const parentDirectory = path.dirname(outputDirectory);
  const outputName = path.basename(outputDirectory);
  if (!outputName || outputDirectory === parentDirectory) {
    throw new Error("A concrete V5 artifact output directory is required.");
  }
  await operations.mkdir(parentDirectory, { recursive: true });
  const stagingDirectory = await operations.mkdtemp(
    path.join(parentDirectory, `.${outputName}.staging-`)
  );
  const backupDirectory = `${stagingDirectory}.backup`;
  let originalMoved = false;
  let stagedPublished = false;
  try {
    for (const filename of V5_ARTIFACT_FILENAMES) {
      await operations.writeFile(path.join(stagingDirectory, filename), files[filename], {
        encoding: "utf8",
        flag: "wx"
      });
    }
    await validateArtifactSet(stagingDirectory, files, operations);

    try {
      await operations.rename(outputDirectory, backupDirectory);
      originalMoved = true;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }

    try {
      await operations.rename(stagingDirectory, outputDirectory);
      stagedPublished = true;
    } catch (publishError) {
      if (originalMoved) {
        try {
          await operations.rename(backupDirectory, outputDirectory);
          originalMoved = false;
        } catch (rollbackError) {
          throw new AggregateError(
            [publishError, rollbackError],
            "V5 artifact publication failed and the prior artifact set could not be restored."
          );
        }
      }
      throw publishError;
    }

    try {
      await validateArtifactSet(outputDirectory, files, operations);
    } catch (validationError) {
      try {
        await operations.rm(outputDirectory, { recursive: true, force: true });
        stagedPublished = false;
        if (originalMoved) {
          await operations.rename(backupDirectory, outputDirectory);
          originalMoved = false;
        }
      } catch (rollbackError) {
        throw new AggregateError(
          [validationError, rollbackError],
          "Published V5 artifacts failed validation and rollback did not complete."
        );
      }
      throw validationError;
    }

    if (originalMoved) {
      await operations.rm(backupDirectory, { recursive: true, force: true });
      originalMoved = false;
    }
  } finally {
    if (!stagedPublished) {
      await operations.rm(stagingDirectory, { recursive: true, force: true });
    }
  }
}

function assertCompleteArtifactSet(files) {
  const actual = Object.keys(files).sort((left, right) => left.localeCompare(right, "en"));
  if (
    actual.length !== V5_ARTIFACT_FILENAMES.length ||
    actual.some((filename, index) => filename !== V5_ARTIFACT_FILENAMES[index]) ||
    actual.some((filename) => typeof files[filename] !== "string")
  ) {
    throw new Error("A complete seven-file V5 artifact set is required.");
  }
}

function isMissingPathError(error) {
  return Boolean(error && typeof error === "object" && error.code === "ENOENT");
}
