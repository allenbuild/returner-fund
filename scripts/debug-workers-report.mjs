import fs from "node:fs/promises";
import path from "node:path";

const apiUrl = process.env.GRAPH_API_URL ?? "http://127.0.0.1:3001/api/graph?batch=S2026&includeNonScoring=1";
const workerCount = Number(process.env.PUBLIC_WORKER_COUNT ?? 12);
const platforms = ["github", "x", "linkedin", "instagram", "product_hunt", "youtube", "rss", "web", "reddit", "hacker_news", "bilibili"];
const slowPlatforms = new Set(["x", "linkedin", "instagram", "reddit", "bilibili"]);
const graph = await fetchJson(apiUrl);
const evidenceById = new Map(graph.evidence.map((item) => [item.id, item]));
const needsReview = new Set(graph.needsReview.map((item) => `${item.entityId}:${item.platform}`));
const platformStatus = new Map(graph.platformStatus.map((item) => [item.platform, item.status]));
const ingestionCheckpoint = await readJson(path.join("work", "public-traction-checkpoint.json"), null);
const activeRun = await readJson(path.join("outputs", "longrun", "active-run.json"), null);

const tasks = graph.nodes.flatMap((node) => {
  const evidence = (node.evidenceIds ?? []).map((id) => evidenceById.get(id)).filter(Boolean);
  const entityIds = new Set([node.entityId, ...(node.relatedEntityIds ?? [])]);
  return platforms.map((platform) => {
    const platformEvidence = evidence.filter((item) => item.platform === platform);
    const hasNeedsReview = [...entityIds].some((entityId) => needsReview.has(`${entityId}:${platform}`));
    const status = taskStatus(platform, platformStatus.get(platform), platformEvidence, hasNeedsReview);
    return {
      id: `task-${node.entityId}-${platform}`,
      company_id: node.entityId,
      company_name: node.label,
      platform,
      status,
      attempts: platformEvidence.length || status === "needs_review" || status === "blocked_or_empty" ? 1 : 0,
      checkpoint_key: `${node.batchSlug}:${node.entityId}:${platform}`,
      rate_limit_ms: slowPlatforms.has(platform) ? 4500 : 1200,
      last_error:
        status === "blocked_or_empty"
          ? "No public post-level evidence was visible, or unauthenticated access was blocked. Batch continues."
          : null
    };
  });
});

const lanes = Array.from({ length: workerCount }, (_, index) => ({
  worker_id: `worker-${String(index + 1).padStart(2, "0")}`,
  tasks: []
}));
tasks.forEach((task, index) => lanes[index % workerCount].tasks.push(task));

const report = {
  generated_at: new Date().toISOString(),
  api_url: apiUrl,
  worker_count: workerCount,
  task_count: tasks.length,
  status_counts: tasks.reduce((counts, task) => {
    counts[task.status] = (counts[task.status] ?? 0) + 1;
    return counts;
  }, {}),
  live_ingestion_checkpoint: checkpointSummary(ingestionCheckpoint, activeRun),
  lanes: lanes.map((lane) => ({
    worker_id: lane.worker_id,
    task_count: lane.tasks.length,
    completed: lane.tasks.filter((task) => task.status === "completed").length,
    needs_review: lane.tasks.filter((task) => task.status === "needs_review").length,
    blocked_or_empty: lane.tasks.filter((task) => task.status === "blocked_or_empty").length,
    queued: lane.tasks.filter((task) => task.status === "queued").length,
    sample_tasks: lane.tasks.slice(0, 25)
  }))
};

const outputPath = path.join("outputs", "workers-debug-s2026.json");
await fs.mkdir("outputs", { recursive: true });
await writeJson(outputPath, report);
console.log(JSON.stringify({ outputPath, workerCount, taskCount: tasks.length, statusCounts: report.status_counts }, null, 2));

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Graph API failed with ${response.status}`);
  }
  return response.json();
}

function taskStatus(platform, connectorStatus, evidence, hasNeedsReview) {
  if (evidence.length > 0) return "completed";
  if (hasNeedsReview) return "needs_review";
  if (connectorStatus === "disabled") return "skipped";
  if (slowPlatforms.has(platform)) return "blocked_or_empty";
  return "queued";
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function checkpointSummary(checkpoint, activeRun) {
  if (!checkpoint) {
    return {
      available: false,
      active_run: activeRunSummary(activeRun),
      note: "No public ingestion checkpoint found."
    };
  }

  const attempts = Object.entries(checkpoint.attempts ?? {});
  const statusCounts = attempts.reduce((counts, [, attempt]) => {
    const status = attempt?.status ?? "unknown";
    counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  }, {});
  const attemptsByPlatform = attempts.reduce((counts, [key]) => {
    const platform = normalizePlatform(key.split(":")[0]);
    counts[platform] = (counts[platform] ?? 0) + 1;
    return counts;
  }, {});
  const failureRows = [...(checkpoint.failures ?? [])];
  const recentFailures = failureRows
    .slice(-20)
    .reverse()
    .map((row) => ({
      platform: normalizePlatform(row.platform),
      company_name: row.companyName,
      entity_type: row.entityType,
      source_url: row.sourceUrl,
      message: row.message,
      checked_at: row.checkedAt
    }));

  return {
    available: true,
    active_run: activeRunSummary(activeRun),
    attempt_count: attempts.length,
    attempt_status_counts: statusCounts,
    attempts_by_platform: attemptsByPlatform,
    evidence_rows: checkpoint.evidence?.length ?? 0,
    needs_review_rows: checkpoint.needsReview?.length ?? 0,
    failure_rows: failureRows.length,
    discovery_attempt_rows: checkpoint.discoveryAttempts?.length ?? 0,
    source_discovery_path_rows: checkpoint.sourceDiscoveryPaths?.length ?? 0,
    recent_failures: recentFailures
  };
}

function activeRunSummary(activeRun) {
  if (!activeRun) {
    return null;
  }

  return {
    run_id: activeRun.runId,
    pid: activeRun.pid,
    started_at: activeRun.startedAt,
    launched_at: activeRun.launchedAt,
    command: activeRun.command,
    stdout_path: activeRun.stdoutPath,
    stderr_path: activeRun.stderrPath
  };
}

function normalizePlatform(platform) {
  if (platform === "news_web" || platform === "website") return "web";
  if (platform === "twitter") return "x";
  return platform;
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await fs.rename(tempPath, filePath);
      return;
    } catch (error) {
      if (!["EPERM", "UNKNOWN", "EBUSY"].includes(error?.code) || attempt === 7) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 200 + attempt * 250));
    }
  }
}
