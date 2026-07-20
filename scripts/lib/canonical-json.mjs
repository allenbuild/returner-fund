import { readFile } from "node:fs/promises";

export async function readRequiredCanonicalJson(path, label = "Canonical JSON") {
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(
      `${label} could not be read at ${path}: ${errorMessage(error)}`,
      { cause: error }
    );
  }

  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(
      `${label} is malformed at ${path}: ${errorMessage(error)}`,
      { cause: error }
    );
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
