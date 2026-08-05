import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./scoring-v4-ops-lib.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EXPERIMENT_ARTIFACTS = Object.freeze([
  "docs/outputs/scoring-experiments-v4.json",
  "docs/outputs/scoring-experiments-v4.md",
  "docs/SCORING_EXPERIMENTS.md"
]);

export function parseExperimentParityArgs(rawArgs) {
  const parsed = { dryRun: false };
  for (const argument of rawArgs) {
    if (argument === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }
    throw new Error(`Unknown experiment parity argument: ${argument}`);
  }
  return parsed;
}

export async function main(
  rawArgs = process.argv.slice(2),
  { rootDir = REPOSITORY_ROOT, env = process.env, commandRunner = runCommand } = {}
) {
  const args = parseExperimentParityArgs(rawArgs);
  if (args.dryRun) {
    const result = {
      status: "dry-run",
      operation: "run scoring experiments in an isolated temporary repository copy",
      checks: [
        "canonical normalizer parity assertions are positive",
        "production scoring config is not mutated",
        "all three cohorts and nine variants pass reverse-order stability"
      ],
      repositoryArtifactsWritten: false
    };
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  const beforeHashes = await hashRepositoryArtifacts(rootDir);
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "returner-scoring-v4-parity-"));
  try {
    await Promise.all([
      cp(path.join(rootDir, "src"), path.join(temporaryRoot, "src"), { recursive: true }),
      cp(path.join(rootDir, "scripts"), path.join(temporaryRoot, "scripts"), { recursive: true }),
      symlink(path.join(rootDir, "node_modules"), path.join(temporaryRoot, "node_modules"), "dir")
    ]);

    const loaderPath = path.join(
      temporaryRoot,
      "scripts",
      "lib",
      "scoring-diagnostics-ts-loader.mjs"
    );
    const prepareRuntimePath = path.join(
      temporaryRoot,
      "scripts",
      "prepare-graph-runtime-evidence.mjs"
    );
    const scriptPath = path.join(temporaryRoot, "scripts", "run-scoring-experiments.mjs");
    await commandRunner(process.execPath, [prepareRuntimePath], {
      cwd: temporaryRoot,
      env: { ...env },
      capture: true,
      timeoutMs: 2 * 60_000
    });
    await commandRunner(
      process.execPath,
      ["--experimental-strip-types", "--loader", loaderPath, scriptPath],
      {
        cwd: temporaryRoot,
        env: { ...env, SCORING_EXPERIMENTS_TYPESCRIPT_READY: "1" },
        capture: true,
        // The parity matrix is intentionally isolated, but it now exercises
        // the verified volume projection as well as the compact scored set.
        // Keep the guard below the workflow's 55-minute step ceiling while
        // allowing the larger three-cohort matrix to finish deterministically.
        timeoutMs: 15 * 60_000
      }
    );

    const report = JSON.parse(
      await readFile(
        path.join(temporaryRoot, "docs", "outputs", "scoring-experiments-v4.json"),
        "utf8"
      )
    );
    const result = validateExperimentParityReport(report);
    console.log(JSON.stringify({ status: "ok", ...result, repositoryArtifactsWritten: false }, null, 2));
    return result;
  } finally {
    const afterHashes = await hashRepositoryArtifacts(rootDir);
    await rm(temporaryRoot, { recursive: true, force: true });
    for (const artifact of EXPERIMENT_ARTIFACTS) {
      if (afterHashes[artifact] !== beforeHashes[artifact]) {
        throw new Error(`Experiment parity check changed repository artifact ${artifact}.`);
      }
    }
  }
}

export function validateExperimentParityReport(report) {
  if (report?.metadata?.production_config_mutated !== false) {
    throw new Error("Experiment parity check detected production config mutation.");
  }
  const assertions = report?.metadata?.normalization_parity_assertions;
  if (!Number.isInteger(assertions) || assertions <= 0) {
    throw new Error("Experiment parity check did not run canonical normalizer assertions.");
  }
  if (!Array.isArray(report.cohorts) || report.cohorts.length !== 3) {
    throw new Error("Experiment parity check did not cover all three cohorts.");
  }
  for (const cohort of report.cohorts) {
    if (!Array.isArray(cohort.variants) || cohort.variants.length !== 9) {
      throw new Error(`Experiment parity check has incomplete variants for ${cohort.cohort}.`);
    }
    if (
      cohort.variants.some(
        (variant) => variant?.perturbation_stability?.reverse_input?.exact_score_and_rank_match !== true
      )
    ) {
      throw new Error(`Experiment parity check failed reverse-order stability for ${cohort.cohort}.`);
    }
  }
  return {
    cohorts: report.cohorts.length,
    candidatesPerCohort: 9,
    normalizationParityAssertions: assertions,
    productionConfigMutated: false
  };
}

async function hashRepositoryArtifacts(rootDir) {
  return Object.fromEntries(
    await Promise.all(
      EXPERIMENT_ARTIFACTS.map(async (artifact) => [
        artifact,
        createHash("sha256").update(await readFile(path.join(rootDir, artifact))).digest("hex")
      ])
    )
  );
}

const isMainModule =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
