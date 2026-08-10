import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export function validatedRepositoryDataRoot(
  configuredRoot,
  { fallbackRoot = process.cwd(), label = "repository data root" } = {}
) {
  const explicit = configuredRoot !== undefined && configuredRoot !== null;
  const raw = String(explicit ? configuredRoot : fallbackRoot).trim();
  if (!raw) throw new Error(`${label} must not be empty.`);
  if (explicit && !isAbsolute(raw)) {
    throw new Error(`${label} must be an absolute path.`);
  }

  let root;
  try {
    root = realpathSync(resolve(raw));
  } catch (error) {
    throw new Error(`${label} could not be resolved: ${errorMessage(error)}`, { cause: error });
  }

  for (const requiredPath of ["package.json", join("src", "lib")]) {
    try {
      const entry = statSync(join(root, requiredPath));
      if (requiredPath === "package.json" ? !entry.isFile() : !entry.isDirectory()) {
        throw new Error("wrong filesystem type");
      }
    } catch (error) {
      throw new Error(
        `${label} is not a repository data root; missing ${requiredPath}: ${errorMessage(error)}`,
        { cause: error }
      );
    }
  }
  return root;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
