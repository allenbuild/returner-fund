#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  AUTONOMOUS_COVERAGE_BATCH_LAYOUT,
  prepareIngestionCoverageCampaign
} from "./lib/prepare-ingestion-coverage-campaign.mjs";
import {
  appendGithubOutputs,
  packagePublicIngestionProofArtifact,
  safeIngestionArtifactSegment
} from "./lib/public-ingestion-proof-artifact.mjs";

const execFileAsync = promisify(execFile);

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(helpText());
    return 0;
  }
  const idempotencyKey = requiredText(
    options.idempotencyKey,
    "--idempotency-key"
  );
  const repository = requiredText(
    options.repository ?? process.env.GITHUB_REPOSITORY,
    "--repository or GITHUB_REPOSITORY"
  );
  const workflowRunId = requiredText(
    options.workflowRunId ?? process.env.GITHUB_RUN_ID,
    "--workflow-run-id or GITHUB_RUN_ID"
  );
  const workflowRunAttempt = requiredText(
    options.workflowRunAttempt ?? process.env.GITHUB_RUN_ATTEMPT,
    "--workflow-run-attempt or GITHUB_RUN_ATTEMPT"
  );
  const artifactName = options.artifactName ??
    `ingestion-proof-journals-${workflowRunId}-${workflowRunAttempt}`;
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const root = resolve(options.root ?? process.cwd());
  const segment = safeIngestionArtifactSegment(idempotencyKey);
  const campaignDir = resolve(
    options.campaignDir ?? join(root, "work", "autonomous-ingestion", segment)
  );
  const outputDir = resolve(
    options.outputDir ?? join(root, "work", "ingestion-proof-journals", segment)
  );
  const sourceRevision = options.sourceRevision ?? await gitRevision(root);
  const stagingParent = resolve(process.env.RUNNER_TEMP ?? tmpdir());
  const stagingRoot = await mkdtemp(join(stagingParent, "ingestion-proof-staging-"));

  try {
    const preparedDir = join(stagingRoot, "prepared-campaign");
    await prepareIngestionCoverageCampaign({
      root,
      campaignDir,
      outputDir: preparedDir,
      idempotencyKey,
      campaignKey: idempotencyKey,
      batchSlugs: AUTONOMOUS_COVERAGE_BATCH_LAYOUT.map((layout) => layout.slug),
      materializedAt: generatedAt
    });
    const packaged = await packagePublicIngestionProofArtifact({
      preparedCampaignDir: preparedDir,
      outputDir,
      idempotencyKey,
      artifactName,
      repository,
      workflowRunId,
      workflowRunAttempt,
      sourceRevision,
      generatedAt
    });
    await appendGithubOutputs(process.env.GITHUB_OUTPUT, {
      proof_manifest_sha256: packaged.manifestSha256,
      source_content_manifest_sha256: packaged.sourceContentManifestSha256,
      recent_window_journals: packaged.recentWindowJournals,
      artifact_path: packaged.artifactPath
    });
    process.stdout.write(`${JSON.stringify({
      status: "packaged_public_safe",
      artifactName,
      artifactPath: packaged.artifactPath,
      proofManifestPath: packaged.manifestPath,
      proofManifestSha256: packaged.manifestSha256,
      sourceContentManifestSha256: packaged.sourceContentManifestSha256,
      recentWindowJournals: packaged.recentWindowJournals,
      safeCollectors: packaged.safeCollectors
    }, null, 2)}\n`);
    return 0;
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const options = { help: false };
  for (const argument of argv) {
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    const equals = argument.indexOf("=");
    if (!argument.startsWith("--") || equals < 3) {
      throw new Error(`Expected --name=value; received ${argument}.`);
    }
    const name = argument.slice(2, equals);
    const value = argument.slice(equals + 1);
    if (name === "idempotency-key") options.idempotencyKey = value;
    else if (name === "root") options.root = value;
    else if (name === "campaign-dir") options.campaignDir = value;
    else if (name === "output-dir") options.outputDir = value;
    else if (name === "artifact-name") options.artifactName = value;
    else if (name === "repository") options.repository = value;
    else if (name === "workflow-run-id") options.workflowRunId = value;
    else if (name === "workflow-run-attempt") options.workflowRunAttempt = value;
    else if (name === "source-revision") options.sourceRevision = value;
    else if (name === "generated-at") options.generatedAt = value;
    else throw new Error(`Unknown argument: --${name}.`);
  }
  return options;
}

async function gitRevision(root) {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024
  });
  return stdout.trim();
}

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new TypeError(`${label} is required.`);
  return text;
}

function helpText() {
  return `Usage: node scripts/package-public-ingestion-proof-artifact.mjs --idempotency-key=<key> [options]\n\n` +
    `Builds a public-safe, hash-bound projection of the completed autonomous run. ` +
    `The uploadable directory contains only canonical IDs, run timestamps, allowlisted ` +
    `attempt/proof fields, response digests, and exact recent-window request journals.\n\n` +
    `Raw collector bodies, raw evidence, stored-unpublished rows, credentials, auth headers, ` +
    `and request/response bodies are excluded.\n`;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`${JSON.stringify({
      event: "public_ingestion_proof_artifact.failed",
      error: error instanceof Error ? error.message : String(error)
    })}\n`);
    process.exitCode = 1;
  }
);
