#!/usr/bin/env node

import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  ACCEPTED_FULL_COLLECTION_EVIDENCE_KIND,
  ARTIFACT_DERIVED_EVIDENCE_KIND,
  assertValidArtifactManifest,
  validateArtifactManifest,
  writeArtifactManifest
} from "./lib/artifact-manifest.mjs";

export async function main(rawArgs = process.argv.slice(2), env = process.env) {
  const args = parseArgs(rawArgs);
  if (args.help) {
    console.log(usage());
    return { status: "help" };
  }

  const rootDir = path.resolve(args.rootDir ?? process.cwd());
  const manifestPath = args.output
    ? path.resolve(rootDir, args.output)
    : path.join(rootDir, "public", "graph", "manifest.json");
  const ingestionRunId = args.ingestionRunId ?? env.ARTIFACT_INGESTION_RUN_ID ?? env.INGESTION_RUN_ID;
  const requestedEvidenceOptions = explicitEvidenceCollectionOptions({
    evidenceCollectedAt: args.evidenceCollectedAt ?? env.EVIDENCE_COLLECTED_AT,
    evidenceCollectedAtKind:
      args.evidenceCollectedAtKind ?? env.EVIDENCE_COLLECTED_AT_KIND
  });
  const evidenceOptions = requestedEvidenceOptions ?? (
    args.validate ? {} : await readExistingEvidenceCollection(manifestPath)
  );
  const commonOptions = {
    rootDir,
    manifestPath,
    ...evidenceOptions,
    oldestPlatformRefreshAt: args.oldestPlatformRefreshAt ?? env.OLDEST_PLATFORM_REFRESH_AT
  };

  if (args.validate) {
    const result = await validateArtifactManifest({
      ...commonOptions,
      expectedIngestionRunId: ingestionRunId
    });
    if (!result.ok) {
      throw new Error(`Artifact manifest validation failed:\n- ${result.errors.join("\n- ")}`);
    }
    const payload = {
      status: "valid",
      manifestPath,
      contentHash: result.manifest.contentHash,
      graphArtifacts: result.manifest.graphArtifacts.length,
      benchmarkArtifacts: result.manifest.benchmarkArtifacts.length,
      supportingArtifacts: result.manifest.supportingArtifacts.length
    };
    console.log(JSON.stringify(payload, null, 2));
    return payload;
  }

  if (!ingestionRunId) {
    throw new Error(
      "Missing ingestion run id. Pass --ingestion-run-id or set ARTIFACT_INGESTION_RUN_ID/INGESTION_RUN_ID."
    );
  }

  const { manifest } = await writeArtifactManifest({
    ...commonOptions,
    ingestionRunId,
    publishedAt: args.publishedAt ?? env.ARTIFACT_PUBLISHED_AT ?? new Date()
  });
  await assertValidArtifactManifest(manifest, {
    ...commonOptions,
    expectedIngestionRunId: ingestionRunId
  });

  const payload = {
    status: "written",
    manifestPath,
    contentHash: manifest.contentHash,
    graphArtifacts: manifest.graphArtifacts.length,
    benchmarkArtifacts: manifest.benchmarkArtifacts.length,
    supportingArtifacts: manifest.supportingArtifacts.length
  };
  console.log(JSON.stringify(payload, null, 2));
  return payload;
}

function explicitEvidenceCollectionOptions({
  evidenceCollectedAt,
  evidenceCollectedAtKind
}) {
  const hasTimestamp = evidenceCollectedAt !== undefined;
  const hasKind = evidenceCollectedAtKind !== undefined;
  if (!hasTimestamp && !hasKind) return null;
  if (!hasTimestamp || !hasKind) {
    throw new Error(
      "Explicit accepted collection provenance requires both --evidence-collected-at and " +
      "--evidence-collected-at-kind."
    );
  }
  if (evidenceCollectedAtKind !== ACCEPTED_FULL_COLLECTION_EVIDENCE_KIND) {
    throw new Error(
      `--evidence-collected-at-kind must be ${ACCEPTED_FULL_COLLECTION_EVIDENCE_KIND}.`
    );
  }
  return { evidenceCollectedAt, evidenceCollectedAtKind };
}

async function readExistingEvidenceCollection(manifestPath) {
  let source;
  try {
    source = await readFile(manifestPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch (error) {
    throw new Error(`Existing artifact manifest is invalid JSON: ${error.message}`);
  }
  const kind = manifest?.evidenceCollectedAtKind;
  if (kind === ACCEPTED_FULL_COLLECTION_EVIDENCE_KIND) {
    const value = manifest?.evidenceCollectedAt;
    if (typeof value !== "string" || !value.trim()) {
      throw new Error("Existing accepted artifact manifest is missing evidenceCollectedAt.");
    }
    return {
      evidenceCollectedAt: value,
      evidenceCollectedAtKind: ACCEPTED_FULL_COLLECTION_EVIDENCE_KIND
    };
  }
  if (kind === undefined || kind === ARTIFACT_DERIVED_EVIDENCE_KIND) {
    return { evidenceCollectedAtKind: ARTIFACT_DERIVED_EVIDENCE_KIND };
  }
  throw new Error(`Existing artifact manifest has unsupported evidenceCollectedAtKind: ${kind}.`);
}

export function parseArgs(rawArgs) {
  const parsed = {};
  const valueOptions = new Map([
    ["--root-dir", "rootDir"],
    ["--output", "output"],
    ["--ingestion-run-id", "ingestionRunId"],
    ["--published-at", "publishedAt"],
    ["--evidence-collected-at", "evidenceCollectedAt"],
    ["--evidence-collected-at-kind", "evidenceCollectedAtKind"],
    ["--oldest-platform-refresh-at", "oldestPlatformRefreshAt"]
  ]);

  for (let index = 0; index < rawArgs.length; index += 1) {
    const argument = rawArgs[index];
    if (argument === "--validate") {
      parsed.validate = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      parsed.help = true;
      continue;
    }

    const [flag, inlineValue] = argument.split("=", 2);
    const key = valueOptions.get(flag);
    if (!key) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = inlineValue ?? rawArgs[++index];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}.`);
    }
    parsed[key] = value;
  }
  return parsed;
}

function usage() {
  return [
    "Usage: node scripts/write-artifact-manifest.mjs [options]",
    "",
    "  --ingestion-run-id <id>             Required for writes; env: ARTIFACT_INGESTION_RUN_ID or INGESTION_RUN_ID",
    "  --published-at <timestamp>           Override publication time",
    "  --evidence-collected-at <timestamp>  Accepted full-collection timestamp; requires kind",
    "  --evidence-collected-at-kind <kind>   Must be accepted-full-collection for explicit writes",
    "  --oldest-platform-refresh-at <time>  Override derived platform refresh watermark",
    "  --root-dir <path>                    Repository root (default: cwd)",
    "  --output <path>                      Manifest path relative to root or absolute",
    "  --validate                           Validate the existing manifest without writing",
    "  --help                               Show this help"
  ].join("\n");
}

const isDirectExecution = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
