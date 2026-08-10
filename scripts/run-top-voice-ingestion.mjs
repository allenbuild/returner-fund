import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runLiveSourceRefresh } from "../src/lib/ingestion/live-source-refresh.ts";
import {
  completeAutonomousCollectorProvenance,
  readAutonomousCollectorLaunchProvenance
} from "./lib/autonomous-collector-provenance.mjs";
import { validatedRepositoryDataRoot } from "./lib/validated-repository-data-root.mjs";

const DEFAULT_BATCHES = Object.freeze(["S2026", "S26", "A16ZSR006"]);
const DEFAULT_AUDIENCES = Object.freeze(["insiders", "yc_partners"]);

const args = parseArgs(process.argv.slice(2));
const rootDir = validatedRepositoryDataRoot(args.root, {
  fallbackRoot: process.cwd(),
  label: "Top Voice collector catalog root"
});
const autonomousLaunchProvenance = readAutonomousCollectorLaunchProvenance();
const outputPath = resolve(rootDir, args.output ?? "work/autonomous-ingestion/top-voice-refresh.json");
const isolatedEvidencePath = resolve(
  dirname(outputPath),
  `top-voice-targeted-evidence-${process.pid}-${Date.now()}.json`
);
const batchSlugs = csv(args.batches, DEFAULT_BATCHES);
const audiences = csv(args.audiences, DEFAULT_AUDIENCES);
const xConcurrency = positiveInteger(args.xConcurrency, 16);
const maxPostsPerTarget = positiveInteger(args.maxPostsPerTarget, 20);
const maxTopVoiceXTargets = positiveInteger(args.maxTopVoiceXTargets, 250);
const maxNetworkRequests = positiveInteger(args.maxNetworkRequests, 2_500);
const deadlineMinutes = positiveInteger(args.deadlineMinutes, 10);
const generatedAt = new Date().toISOString();
const audienceResults = [];

for (const audience of audiences) {
  if (audience !== "insiders" && audience !== "yc_partners") {
    throw new Error(`Unsupported Top Voice audience: ${audience}`);
  }

  const deadlineAt = Date.now() + deadlineMinutes * 60_000;
  const result = await runLiveSourceRefresh({
    rootDir,
    batchSlugs,
    platforms: ["x"],
    topVoices: audience,
    write: true,
    targetedEvidencePath: isolatedEvidencePath,
    xConcurrency,
    maxPostsPerTarget,
    maxTopVoiceXTargets,
    maxNetworkRequests,
    deadlineAt,
    stageLogPath: resolve(dirname(outputPath), `top-voice-${audience}-stages.json`)
  });
  const targetEntry = result.stageLog.find((entry) =>
    entry.stage === "parsed" && entry.platform === "x" && typeof entry.count === "number"
  );
  audienceResults.push({
    audience,
    status: result.cancellationReason ? "partial" : "completed",
    cancellationReason: result.cancellationReason,
    targetsLoaded: targetEntry?.count ?? 0,
    networkRequests: result.networkRequests,
    networkRequestBudget: result.networkRequestBudget,
    accepted: result.acceptedEvidence.length,
    stored: result.storedEvidence.length,
    platformRows: result.platformRows,
    targetedEvidenceBefore: result.sourceSnapshots.targetedEvidenceBefore,
    targetedEvidenceAfter: result.sourceSnapshots.targetedEvidenceAfter,
    failureReasonCounts: result.failureReasonCounts
  });
}

if (audienceResults.some((result) => result.targetsLoaded === 0)) {
  throw new Error("Top Voice discovery loaded zero curated targets for at least one audience.");
}

const isolatedEvidenceSnapshot = await readIsolatedEvidenceSnapshot(isolatedEvidencePath);
const completedAt = new Date().toISOString();
const autonomousAttempt = completeAutonomousCollectorProvenance(
  autonomousLaunchProvenance,
  {
    kind: "top_voice",
    batchSlug: batchSlugs.join(","),
    shardIndex: 0,
    shardCount: 1,
    fetchedAt: generatedAt,
    completedAt
  }
);

const receipt = {
  schemaVersion: 2,
  status: audienceResults.every((result) => result.status === "completed") ? "completed" : "partial",
  generatedAt,
  ...(autonomousAttempt ? { autonomousAttempt } : {}),
  batches: batchSlugs,
  audiences: audienceResults,
  isolatedEvidence: {
    path: isolatedEvidencePath,
    evidenceCount: isolatedEvidenceSnapshot.evidence.length,
    needsReviewCount: isolatedEvidenceSnapshot.needsReview.length,
    snapshot: isolatedEvidenceSnapshot
  },
  totals: {
    targetsLoaded: sum(audienceResults, "targetsLoaded"),
    networkRequests: sum(audienceResults, "networkRequests"),
    accepted: sum(audienceResults, "accepted"),
    stored: sum(audienceResults, "stored")
  }
};

await writeJsonAtomic(outputPath, receipt);
console.log(JSON.stringify(receipt, null, 2));

function parseArgs(rawArgs) {
  return Object.fromEntries(rawArgs.map((argument) => {
    const normalized = argument.replace(/^--/, "");
    const separatorIndex = normalized.indexOf("=");
    return separatorIndex === -1
      ? [camelCase(normalized), true]
      : [camelCase(normalized.slice(0, separatorIndex)), normalized.slice(separatorIndex + 1)];
  }));
}

function camelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function csv(value, fallback) {
  if (typeof value !== "string") return [...fallback];
  const values = value.split(",").map((item) => item.trim()).filter(Boolean);
  return values.length ? [...new Set(values)] : [...fallback];
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sum(results, key) {
  return results.reduce((total, result) => total + Number(result[key] ?? 0), 0);
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

async function readIsolatedEvidenceSnapshot(path) {
  let snapshot;
  try {
    snapshot = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Top Voice isolated evidence artifact could not be read at ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.evidence)) {
    throw new Error(`Top Voice isolated evidence artifact at ${path} is missing its evidence array.`);
  }
  if (snapshot.needsReview !== undefined && !Array.isArray(snapshot.needsReview)) {
    throw new Error(`Top Voice isolated evidence artifact at ${path} has an invalid needsReview value.`);
  }
  return {
    ...snapshot,
    needsReview: snapshot.needsReview ?? []
  };
}
