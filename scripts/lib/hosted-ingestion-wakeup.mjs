import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  INGESTION_RECOVERY_CRON,
  readPublicationWatermark,
  resolveScheduledIngestion
} from "./ingestion-schedule.mjs";

export const HOSTED_WAKEUP_REPOSITORY = "allenbuild/returner-fund";
export const HOSTED_WAKEUP_DEFAULT_BRANCH = "main";
export const HOSTED_WAKEUP_VERCEL_PROJECT_ID = "prj_WwtyjKKnhliHNI5dhnjT1Enfb742";
export const HOSTED_WAKEUP_VERCEL_PROJECT_NAME = "returner-fund";
export const HOSTED_WAKEUP_VERCEL_SENDER = "vercel[bot]";
export const HOSTED_WAKEUP_VERCEL_ACTION = "vercel.deployment.success";

const execFileAsync = promisify(execFile);
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;
const DEPLOYMENT_ID_PATTERN = /^dpl_[A-Za-z0-9]+$/;

export function validateHostedWakeupEvent({
  eventName,
  event,
  headSha,
  repository = HOSTED_WAKEUP_REPOSITORY,
  defaultBranch = HOSTED_WAKEUP_DEFAULT_BRANCH,
  projectId = HOSTED_WAKEUP_VERCEL_PROJECT_ID,
  projectName = HOSTED_WAKEUP_VERCEL_PROJECT_NAME
} = {}) {
  const payload = object(event, "GitHub event");
  const repo = object(payload.repository, "event repository");
  const normalizedHead = normalizedSha(headSha, "checked-out main SHA");
  if (repo.full_name !== repository || repo.default_branch !== defaultBranch) {
    throw new Error("hosted wakeup repository identity is not trusted");
  }
  if (object(payload.sender, "event sender").login !== HOSTED_WAKEUP_VERCEL_SENDER) {
    throw new Error("hosted wakeup sender is not Vercel");
  }

  let deployedSha;
  if (eventName === "repository_dispatch") {
    if (payload.action !== HOSTED_WAKEUP_VERCEL_ACTION) {
      throw new Error("hosted wakeup dispatch action is not a successful Vercel deployment");
    }
    const deployment = object(payload.client_payload, "Vercel deployment payload");
    const project = object(deployment.project, "Vercel project");
    const git = object(deployment.git, "Vercel git provenance");
    const state = object(deployment.state, "Vercel deployment state");
    if (
      deployment.environment !== "production" ||
      project.id !== projectId ||
      project.name !== projectName ||
      state.type !== "success" ||
      git.ref !== defaultBranch ||
      !DEPLOYMENT_ID_PATTERN.test(clean(deployment.id)) ||
      clean(git.shortSha) !== clean(git.sha).slice(0, 7) ||
      !trustedVercelDeploymentUrl(deployment.url)
    ) {
      throw new Error("hosted wakeup Vercel deployment provenance is not trusted");
    }
    deployedSha = normalizedSha(git.sha, "Vercel deployment SHA");
  } else if (eventName === "deployment_status") {
    const status = object(payload.deployment_status, "deployment status");
    const deployment = object(payload.deployment, "GitHub deployment");
    if (
      status.state !== "success" ||
      deployment.environment !== "Production" ||
      deployment.task !== "deploy" ||
      object(deployment.creator, "deployment creator").login !== HOSTED_WAKEUP_VERCEL_SENDER
    ) {
      throw new Error("hosted wakeup GitHub deployment provenance is not trusted");
    }
    deployedSha = normalizedSha(deployment.sha, "GitHub deployment SHA");
    if (![defaultBranch, `refs/heads/${defaultBranch}`, deployedSha].includes(clean(deployment.ref))) {
      throw new Error("hosted wakeup deployment ref is not current main");
    }
  } else {
    throw new Error("hosted wakeup event type is not trusted");
  }

  return Object.freeze({
    deployedSha,
    headSha: normalizedHead,
    isCurrentMain: deployedSha === normalizedHead
  });
}

export async function resolveHostedIngestionWakeup({
  cwd = process.cwd(),
  eventName,
  event,
  headSha,
  now = new Date(),
  readPublicationState = ({ cwd: root, ref, now: clock }) =>
    readPublicationWatermark({ cwd: root, ref, now: clock })
} = {}) {
  const provenance = validateHostedWakeupEvent({ eventName, event, headSha });
  if (!provenance.isCurrentMain) {
    return Object.freeze({
      shouldDispatch: false,
      expectedHeadSha: provenance.headSha,
      reason: "deployment-not-current-main",
      slotKey: "",
      acceptanceStatus: "",
      watermarkStatus: ""
    });
  }
  const publicationState = await readPublicationState({
    cwd,
    ref: provenance.headSha,
    now
  });
  const decision = resolveScheduledIngestion({
    schedule: INGESTION_RECOVERY_CRON,
    publicationState,
    now
  });
  return Object.freeze({
    shouldDispatch: decision.accepted === true,
    expectedHeadSha: provenance.headSha,
    reason: decision.reason,
    slotKey: decision.accepted ? decision.slotKey : decision.latestEligibleSlotKey,
    acceptanceStatus: decision.acceptanceStatus ?? "",
    watermarkStatus: decision.watermarkStatus ?? ""
  });
}

export function writeHostedWakeupOutputs(decision, outputPath = process.env.GITHUB_OUTPUT) {
  if (!outputPath) throw new Error("GITHUB_OUTPUT is required");
  const outputs = {
    should_dispatch: String(decision.shouldDispatch === true),
    expected_head_sha: decision.expectedHeadSha,
    reason: decision.reason,
    slot_key: decision.slotKey ?? "",
    acceptance_status: decision.acceptanceStatus,
    watermark_status: decision.watermarkStatus
  };
  appendFileSync(
    outputPath,
    `${Object.entries(outputs).map(([key, value]) => `${key}=${value}`).join("\n")}\n`,
    "utf8"
  );
  return outputs;
}

export async function main(env = process.env, { cwd = process.cwd(), now = new Date() } = {}) {
  const eventPath = clean(env.GITHUB_EVENT_PATH);
  if (!eventPath) throw new Error("GITHUB_EVENT_PATH is required");
  const event = JSON.parse(await readFile(eventPath, "utf8"));
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8"
  });
  const decision = await resolveHostedIngestionWakeup({
    cwd,
    eventName: env.GITHUB_EVENT_NAME,
    event,
    headSha: stdout.trim(),
    now
  });
  writeHostedWakeupOutputs(decision, env.GITHUB_OUTPUT);
  process.stdout.write(
    decision.shouldDispatch
      ? `Current main has ${decision.reason} for ${decision.slotKey}; recovery dispatch authorized.\n`
      : `Current main has ${decision.reason} for ${decision.slotKey}; no recovery dispatch.\n`
  );
  return decision;
}

function trustedVercelDeploymentUrl(value) {
  try {
    const url = new URL(clean(value));
    return url.protocol === "https:" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      (url.hostname === "returner.fund" || url.hostname.endsWith(".vercel.app"));
  } catch {
    return false;
  }
}

function normalizedSha(value, label) {
  const normalized = clean(value).toLowerCase();
  if (!FULL_SHA_PATTERN.test(normalized)) throw new Error(`${label} is not a full commit SHA`);
  return normalized;
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value;
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

const isEntrypoint = process.argv[1] &&
  pathToFileURL(fileURLToPath(import.meta.url)).href === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
