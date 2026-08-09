#!/usr/bin/env node

import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { planFuturePublicationDateRemediation } from "./lib/future-publication-date-remediation.mjs";
import {
  readPublicEvidenceArtifact,
  writePublicEvidenceArtifactPairAtomic,
} from "./lib/public-evidence-artifact.mjs";

const CANONICAL_PATH = "src/lib/social/public-evidence-current.json";

export async function remediateFuturePublicationDates(
  rawArgs = process.argv.slice(2),
  dependencies = {},
) {
  const args = parseArgs(rawArgs);
  const rootDir = path.resolve(dependencies.rootDir ?? process.cwd());
  const canonicalPath = path.join(rootDir, CANONICAL_PATH);
  const current = await (dependencies.readArtifact ?? readPublicEvidenceArtifact)(
    canonicalPath,
    { rootDir },
  );
  const plan = planFuturePublicationDateRemediation(current.snapshot, {
    now: dependencies.now?.() ?? new Date(),
  });
  if (plan.unresolved.length > 0) {
    throw new Error(
      `Unresolved future publication dates: ${JSON.stringify(plan.unresolved)}`,
    );
  }
  if (plan.repairs.length !== args.expectedRemediations) {
    throw new Error(
      `Expected ${args.expectedRemediations} remediations; received ${plan.repairs.length}.`,
    );
  }
  const repairedIds = plan.repairs.map((repair) => repair.id).sort();
  if (JSON.stringify(repairedIds) !== JSON.stringify(args.expectedIds)) {
    throw new Error(
      `Expected repaired ids ${JSON.stringify(args.expectedIds)}; received ${JSON.stringify(repairedIds)}.`,
    );
  }

  const receipt = {
    schemaVersion: "future-publication-date-remediation.v1",
    status: args.dryRun
      ? "dry_run"
      : plan.newRepairs.length > 0
        ? "remediated"
        : "already_remediated",
    repairs: plan.repairs,
    newRepairs: plan.newRepairs.length,
    alreadyRemediated: plan.alreadyRemediated.length,
    unresolved: plan.unresolved,
    canonicalHashBefore: current.canonicalSha256,
    canonicalHashAfter: current.canonicalSha256,
    operationalLedgerHashBefore: current.ledgerSha256,
    operationalLedgerHashAfter: current.ledgerSha256,
    reviewLedgerHashBefore: current.reviewLedgerSha256,
    reviewLedgerHashAfter: current.reviewLedgerSha256,
  };
  if (args.write && plan.newRepairs.length > 0) {
    const published = await (
      dependencies.publishArtifact ?? writePublicEvidenceArtifactPairAtomic
    )({
      rootDir,
      canonicalPath,
      snapshot: plan.snapshot,
      expectedCanonicalSha256: current.canonicalSha256,
      expectedLedgerSha256: current.ledgerSha256,
      expectedReviewLedgerSha256: current.reviewLedgerSha256,
    });
    receipt.canonicalHashAfter = published.canonicalSha256;
    receipt.operationalLedgerHashAfter = published.ledgerSha256;
    receipt.reviewLedgerHashAfter = published.reviewLedgerSha256;
  }
  if (args.receipt) {
    await atomicWrite(
      path.resolve(rootDir, args.receipt),
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
  }
  (dependencies.stdout ?? process.stdout).write(
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  return receipt;
}

export function parseArgs(rawArgs) {
  const parsed = { dryRun: false, write: false, expectedIds: [] };
  for (const argument of rawArgs) {
    if (argument === "--dry-run") parsed.dryRun = true;
    else if (argument === "--write") parsed.write = true;
    else if (argument.startsWith("--expected-remediations=")) {
      parsed.expectedRemediations = Number(argument.split("=").slice(1).join("="));
    } else if (argument.startsWith("--expected-id=")) {
      parsed.expectedIds.push(argument.split("=").slice(1).join("=").trim());
    } else if (argument.startsWith("--receipt=")) {
      parsed.receipt = argument.split("=").slice(1).join("=").trim();
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (parsed.dryRun === parsed.write) {
    throw new Error("Pass exactly one of --dry-run or --write.");
  }
  if (
    !Number.isSafeInteger(parsed.expectedRemediations) ||
    parsed.expectedRemediations < 0
  ) {
    throw new Error("--expected-remediations must be a non-negative integer.");
  }
  if (parsed.expectedIds.some((id) => !id)) {
    throw new Error("--expected-id must not be empty.");
  }
  parsed.expectedIds.sort();
  if (parsed.expectedIds.length !== parsed.expectedRemediations) {
    throw new Error(
      "Pass one --expected-id for every expected remediation.",
    );
  }
  return parsed;
}

async function atomicWrite(outputPath, body) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.tmp-${process.pid}`;
  await writeFile(temporary, body, { flag: "wx" });
  await rename(temporary, outputPath);
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  remediateFuturePublicationDates().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
