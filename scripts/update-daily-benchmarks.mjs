import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  formatStaticGraphSnapshotContractIssue,
  STATIC_GRAPH_SCORING_MODEL_ID,
  STATIC_GRAPH_SCORING_MODEL_VERSION,
  validateStaticGraphSnapshotContract
} from "../src/lib/graph/static-graph-snapshot-contract.mjs";
import { validatedRepositoryDataRoot } from "./lib/validated-repository-data-root.mjs";

export const BATCH_SNAPSHOTS = [
  { slug: "S2026", filename: "s2026.json" },
  { slug: "S2026", filename: "s2026-yc-partners.json", topVoices: "yc_partners" },
  { slug: "S2026", filename: "s2026-insiders.json", topVoices: "insiders" },
  { slug: "S26", filename: "s26.json" },
  { slug: "S26", filename: "s26-yc-partners.json", topVoices: "yc_partners" },
  { slug: "S26", filename: "s26-insiders.json", topVoices: "insiders" },
  { slug: "A16ZSR006", filename: "a16zsr006.json" },
  { slug: "A16ZSR006", filename: "a16zsr006-yc-partners.json", topVoices: "yc_partners" },
  { slug: "A16ZSR006", filename: "a16zsr006-insiders.json", topVoices: "insiders" }
];

const DEFAULT_PORT = 3100;
// Cold starts load the complete evidence corpus and can exceed two minutes on
// hosted runners. Keep the publisher alive long enough to record the exact
// Central-day snapshot instead of creating an irreversible history gap.
const SERVER_READY_TIMEOUT_MS = 8 * 60_000;
const SERVER_READY_FETCH_TIMEOUT_MS = 10_000;
const SERVER_READY_POLL_MS = 1_000;
// The first full graph request loads and scores the complete runtime evidence
// corpus. On Actions this legitimately takes longer than a short HTTP request,
// so readiness uses a cheap invalid-query probe and publication requests get a
// bounded five-minute window of their own.
const GRAPH_FETCH_TIMEOUT_MS = 5 * 60_000;
const SERVER_COMMAND_TIMEOUT_MS = 45 * 60_000;
const SERVER_STOP_TIMEOUT_MS = 5_000;
const TERMINATION_SIGNALS = ["SIGINT", "SIGTERM"];
const GENERATED_AT_CLOCK_SKEW_MS = 60_000;
const CENTRAL_TIME_ZONE = "America/Chicago";
const PROJECTED_SCORE_MODEL_VERSION = "4.3.1";
const PROJECTED_SCORE_CALIBRATION_KIND = "linear_model_rebase";
const CANONICAL_NODE_FIELDS = [
  "score",
  "previousScore",
  "scoreDelta",
  "radius",
  "topPlatform",
  "platformScores",
  "scoreBreakdown"
];
const CANONICAL_LEADERBOARD_FIELDS = ["rank", "score", "topPlatform"];
const CENTRAL_DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: CENTRAL_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23"
});

export async function main(
  rawArgs = process.argv.slice(2),
  options = {}
) {
  const args = parseArgs(rawArgs);
  const rootDir = args.root
    ? validatedRepositoryDataRoot(args.root, { label: "benchmark publication root" })
    : path.resolve(options.rootDir ?? process.cwd());
  const fetchGraphImpl = options.fetchGraphImpl ?? fetchGraph;
  const graphServerOptions = options.graphServerOptions;
  const publicationOptions = options.publicationOptions;
  const runStartedAt = args.now ? new Date(args.now) : new Date();
  if (!Number.isFinite(runStartedAt.getTime())) {
    throw new Error(`Invalid benchmark run timestamp: ${args.now}`);
  }
  const windowStart = args.windowStart ? new Date(args.windowStart) : runStartedAt;
  if (!Number.isFinite(windowStart.getTime()) || windowStart.getTime() > runStartedAt.getTime()) {
    throw new Error(`Invalid benchmark generation-window timestamp: ${args.windowStart}`);
  }

  if (
    args.scheduledUtcHour !== undefined &&
    !scheduledUtcHourRepresentsCentralMidnight(runStartedAt, args.scheduledUtcHour)
  ) {
    await assertSkippedRunHasCurrentBenchmarks({ rootDir, now: runStartedAt });
    console.log(
      `Skipping daily benchmark update; the ${String(args.scheduledUtcHour).padStart(2, "0")}:00 UTC slot is not midnight in ${CENTRAL_TIME_ZONE} for ${centralDayKey(runStartedAt)}.`
    );
    return { status: "skipped" };
  }

  const pinnedProvider = args.pinnedSourceInProcess
    ? options.graphSnapshotProvider ?? await createPinnedSourceGraphProvider()
    : null;
  const server = pinnedProvider ? null : getGraphApiServer(args, graphServerOptions);

  try {
    if (server) {
      await waitForGraphApi(server.baseUrl, {
        publicationToken: server.publicationToken,
        diagnosticsSecret: server.diagnosticsSecret,
        signal: server.signal
      });
    }
    const snapshots = [];

    for (const descriptor of BATCH_SNAPSHOTS) {
      const graph = pinnedProvider
        ? await pinnedProvider.fetchGraph(descriptor.slug, descriptor.topVoices)
        : await fetchGraphImpl(server.baseUrl, descriptor.slug, descriptor.topVoices, {
            publicationToken: server.publicationToken,
            diagnosticsSecret: server.diagnosticsSecret,
            signal: server.signal
          });
      snapshots.push({ descriptor, graph });
    }
    throwIfAborted(server?.signal);

    const recordedAt = args.now ? runStartedAt : new Date();
    const result = await publishBenchmarkSnapshots(snapshots, {
      signal: server?.signal,
      rootDir,
      recordedAt,
      validationNow: recordedAt,
      windowStart,
      expectedCentralDate: args.expectedCentralDate,
      publicationOptions
    });
    throwIfAborted(server?.signal);
    const payload = {
      status: "updated",
      baseUrl: server?.baseUrl ?? "pinned-source-in-process",
      scoringModelVersion: result.scoringModelVersion,
      writtenFiles: result.writtenFiles
    };
    console.log(JSON.stringify(payload, null, 2));
    return payload;
  } finally {
    if (pinnedProvider) await pinnedProvider.finish();
    else await server.finish();
  }
}

export async function createPinnedSourceGraphProvider() {
  const publicationToken = randomBytes(32).toString("base64url");
  const previousToken = process.env.GRAPH_PUBLICATION_BUILD_TOKEN;
  process.env.GRAPH_PUBLICATION_BUILD_TOKEN = publicationToken;
  let finished = false;
  try {
    const { GET } = await import("../src/app/api/graph/full/route.ts");
    return {
      async fetchGraph(batchSlug, topVoices) {
        if (finished) throw new Error("Pinned graph provider was already finalized.");
        const url = new URL("http://127.0.0.1/api/graph/full");
        url.searchParams.set("batch", batchSlug);
        url.searchParams.set("includeNonScoring", "true");
        if (topVoices) url.searchParams.set("topVoices", topVoices);
        const response = await GET(new Request(url, {
          headers: { "x-returner-publication-build": publicationToken }
        }));
        if (!response.ok) {
          throw new Error(
            `Pinned graph computation failed for ${batchSlug}/${topVoices ?? "off"}: ` +
            `${response.status} ${response.statusText}`
          );
        }
        return response.json();
      },
      async finish() {
        if (finished) return;
        finished = true;
        restoreEnvironmentValue("GRAPH_PUBLICATION_BUILD_TOKEN", previousToken);
      }
    };
  } catch (error) {
    restoreEnvironmentValue("GRAPH_PUBLICATION_BUILD_TOKEN", previousToken);
    throw error;
  }
}

function restoreEnvironmentValue(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

export async function publishBenchmarkSnapshots(
  snapshots,
  {
    rootDir,
    recordedAt,
    validationNow = recordedAt,
    windowStart,
    expectedCentralDate,
    signal,
    publicationOptions
  }
) {
  throwIfAborted(signal);
  const canonicalSnapshots = inheritCanonicalAudienceSnapshotState(snapshots);
  const validation = validateGraphSnapshots(canonicalSnapshots, { now: validationNow, windowStart });
  throwIfAborted(signal);
  const operations = await buildPublicationOperations(canonicalSnapshots, { rootDir, recordedAt, signal });
  throwIfAborted(signal);
  assertExpectedCentralDateMatchesRecordedAt(expectedCentralDate, recordedAt);
  await publishOperationsAtomically(operations, { ...publicationOptions, signal });
  throwIfAborted(signal);

  return {
    scoringModelVersion: validation.scoringModelVersion,
    writtenFiles: operations.map((operation) => ({
      outputPath: operation.targetPath,
      kind: operation.kind,
      batch: operation.batch,
      topVoices: operation.topVoices
    }))
  };
}

export function validateGraphSnapshots(
  snapshots,
  { now = new Date(), windowStart } = {}
) {
  if (!Array.isArray(snapshots) || snapshots.length !== BATCH_SNAPSHOTS.length) {
    throw new Error(`Expected all ${BATCH_SNAPSHOTS.length} graph snapshots before publication.`);
  }
  if (!isValidDate(now) || (windowStart !== undefined && !isValidDate(windowStart))) {
    throw new Error("Benchmark validation requires valid generation-window timestamps.");
  }

  const expectedByKey = new Map(BATCH_SNAPSHOTS.map((descriptor) => [snapshotKey(descriptor), descriptor]));
  const seenKeys = new Set();
  const snapshotsByKey = new Map();
  const modelVersions = new Set();
  const modelIds = new Set();

  for (const entry of snapshots) {
    const { descriptor, graph } = entry ?? {};
    const key = snapshotKey(descriptor ?? {});
    const expected = expectedByKey.get(key);
    if (!expected || expected.filename !== descriptor?.filename || seenKeys.has(key)) {
      throw new Error(`Unexpected or duplicate graph snapshot descriptor: ${key}`);
    }
    seenKeys.add(key);
    snapshotsByKey.set(key, entry);
    validateGraphSnapshot(graph, descriptor, { now, windowStart });
    modelVersions.add(graph.scoringContext.modelVersion);
    modelIds.add(graph.scoringContext.modelId);
  }

  if (seenKeys.size !== expectedByKey.size) {
    throw new Error("The graph snapshot set is incomplete.");
  }
  if (modelVersions.size !== 1 || modelIds.size !== 1) {
    throw new Error("All nine graph snapshots must use one scoring model id and version.");
  }
  validateCanonicalAudienceSnapshots(snapshotsByKey);

  return {
    scoringModelId: [...modelIds][0],
    scoringModelVersion: [...modelVersions][0]
  };
}

function validateGraphSnapshot(graph, descriptor, { now, windowStart }) {
  const label = snapshotKey(descriptor);
  if (!graph || typeof graph !== "object") {
    throw new Error(`${label} did not return a graph object.`);
  }
  const contract = validateStaticGraphSnapshotContract(graph);
  if (!contract.ok) {
    const issue = contract.issues[0]
      ? formatStaticGraphSnapshotContractIssue(contract.issues[0])
      : "unknown canonical contract violation";
    throw new Error(
      `${label} is missing a complete ${STATIC_GRAPH_SCORING_MODEL_ID}@${STATIC_GRAPH_SCORING_MODEL_VERSION} score breakdown or static graph contract: ${issue}.`
    );
  }
  if (graph.batch?.slug !== descriptor.slug) {
    throw new Error(`${label} returned batch ${graph.batch?.slug ?? "missing"}.`);
  }

  const expectedAudience = descriptor.topVoices ?? "off";
  if (graph.selectedTopVoiceAudience?.id !== expectedAudience) {
    throw new Error(`${label} returned audience ${graph.selectedTopVoiceAudience?.id ?? "missing"}.`);
  }
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.leaderboard) || !Array.isArray(graph.fastestGaining)) {
    throw new Error(`${label} is missing graph ranking arrays.`);
  }
  if (graph.fastestGaining.length !== graph.leaderboard.length) {
    throw new Error(`${label} has inconsistent leaderboard and benchmark row counts.`);
  }
  if (expectedAudience === "off") {
    const observedCount = graph.batch?.companyCountObserved;
    if (!Number.isInteger(observedCount) || observedCount <= 0 || graph.leaderboard.length !== observedCount) {
      throw new Error(`${label} does not contain the complete observed company cohort.`);
    }
  }

  validateLeaderboard(graph.leaderboard, label);

  const context = graph.scoringContext;
  if (
    !context ||
    context.modelId !== STATIC_GRAPH_SCORING_MODEL_ID ||
    context.modelVersion !== STATIC_GRAPH_SCORING_MODEL_VERSION
  ) {
    throw new Error(
      `${label} must use scoringContext ${STATIC_GRAPH_SCORING_MODEL_ID}@${STATIC_GRAPH_SCORING_MODEL_VERSION}.`
    );
  }
  if (context.scoreScope !== "all_platforms") {
    throw new Error(`${label} has scoring scope ${context.scoreScope ?? "missing"}; expected all_platforms.`);
  }
  if (!Array.isArray(context.selectedPlatforms) || context.selectedPlatforms.length !== 0) {
    throw new Error(`${label} must have an empty canonical scoringContext.selectedPlatforms array.`);
  }
  if (!isIsoTimestamp(graph.generatedAt) || !isIsoTimestamp(context.responseBuiltAt)) {
    throw new Error(`${label} has invalid generated/input timestamps.`);
  }
  if (Date.parse(graph.generatedAt) !== Date.parse(context.responseBuiltAt)) {
    throw new Error(`${label} generatedAt does not match scoringContext.responseBuiltAt.`);
  }
  if (context.evidenceAsOf !== null && !isIsoTimestamp(context.evidenceAsOf)) {
    throw new Error(`${label} has an invalid scoringContext.evidenceAsOf timestamp.`);
  }

  const generatedTime = Date.parse(graph.generatedAt);
  if (generatedTime > now.getTime() + GENERATED_AT_CLOCK_SKEW_MS) {
    throw new Error(`${label} was generated in the future.`);
  }
  if (windowStart && generatedTime < windowStart.getTime() - GENERATED_AT_CLOCK_SKEW_MS) {
    throw new Error(`${label} was generated before this benchmark run began.`);
  }
}

export function inheritCanonicalAudienceSnapshotState(snapshots) {
  if (!Array.isArray(snapshots)) {
    return snapshots;
  }

  const baseGraphByBatch = new Map(
    snapshots
      .filter((entry) => entry?.descriptor && !entry.descriptor.topVoices)
      .map((entry) => [entry.descriptor.slug, entry.graph])
  );

  return snapshots.map((entry) => {
    if (!entry?.descriptor?.topVoices) {
      return entry;
    }
    const baseGraph = baseGraphByBatch.get(entry.descriptor.slug);
    if (!baseGraph) {
      return entry;
    }
    return {
      ...entry,
      graph: inheritCanonicalAudienceGraphState(entry.graph, baseGraph)
    };
  });
}

function inheritCanonicalAudienceGraphState(graph, baseGraph) {
  if (!graph || !baseGraph || !Array.isArray(graph.leaderboard)) {
    return graph;
  }

  const visibleCompanyIds = new Set(graph.leaderboard.map((row) => row?.companyId));
  const baseMomentum = Array.isArray(baseGraph.fastestGaining) ? baseGraph.fastestGaining : [];
  const baseMomentumCompanyIds = new Set(baseMomentum.map((row) => row?.companyId));
  const unknownMomentum = (Array.isArray(graph.fastestGaining) ? graph.fastestGaining : []).filter(
    (row) => !baseMomentumCompanyIds.has(row?.companyId)
  );

  return {
    ...graph,
    fastestGaining: [
      ...baseMomentum.filter((row) => visibleCompanyIds.has(row?.companyId)),
      ...unknownMomentum
    ]
  };
}

function validateCanonicalAudienceSnapshots(snapshotsByKey) {
  for (const descriptor of BATCH_SNAPSHOTS) {
    if (!descriptor.topVoices) continue;

    const label = snapshotKey(descriptor);
    const baseGraph = snapshotsByKey.get(snapshotKey({ slug: descriptor.slug }))?.graph;
    const audienceGraph = snapshotsByKey.get(label)?.graph;
    if (!baseGraph || !audienceGraph) continue;

    validateCanonicalAudienceGraph(baseGraph, audienceGraph, label);
  }
}

function validateCanonicalAudienceGraph(baseGraph, audienceGraph, label) {
  const baseNodes = new Map(baseGraph.nodes.map((node) => [node.entityId, node]));
  for (const node of audienceGraph.nodes) {
    const baseNode = baseNodes.get(node.entityId);
    if (!baseNode) {
      throw new Error(`${label} contains company ${node.entityId} outside its canonical base snapshot.`);
    }
    for (const field of CANONICAL_NODE_FIELDS) {
      if (!isDeepStrictEqual(node[field], baseNode[field])) {
        throw new Error(`${label} changes canonical node ${node.entityId} field ${field}.`);
      }
    }
  }

  const audienceCompanyIds = new Set(audienceGraph.leaderboard.map((row) => row.companyId));
  const expectedLeaderboard = baseGraph.leaderboard.filter((row) => audienceCompanyIds.has(row.companyId));
  const actualLeaderboardIds = audienceGraph.leaderboard.map((row) => row.companyId);
  if (!isDeepStrictEqual(actualLeaderboardIds, expectedLeaderboard.map((row) => row.companyId))) {
    throw new Error(`${label} must preserve canonical base leaderboard ordering.`);
  }
  const baseLeaderboardByCompanyId = new Map(baseGraph.leaderboard.map((row) => [row.companyId, row]));
  for (const row of audienceGraph.leaderboard) {
    const baseRow = baseLeaderboardByCompanyId.get(row.companyId);
    if (!baseRow) {
      throw new Error(`${label} contains leaderboard company ${row.companyId} outside its canonical base snapshot.`);
    }
    for (const field of CANONICAL_LEADERBOARD_FIELDS) {
      if (!isDeepStrictEqual(row[field], baseRow[field])) {
        throw new Error(`${label} changes canonical leaderboard ${row.companyId} field ${field}.`);
      }
    }
  }

  const expectedMomentum = baseGraph.fastestGaining.filter((row) => audienceCompanyIds.has(row.companyId));
  if (!isDeepStrictEqual(audienceGraph.fastestGaining, expectedMomentum)) {
    throw new Error(`${label} must preserve canonical benchmark momentum rows.`);
  }
  if (audienceGraph.scoringContext?.evidenceAsOf !== baseGraph.scoringContext?.evidenceAsOf) {
    throw new Error(`${label} must preserve canonical scoringContext.evidenceAsOf.`);
  }
}

function validateLeaderboard(leaderboard, label) {
  const companyIds = new Set();
  for (const row of leaderboard) {
    if (
      !row ||
      typeof row.companyId !== "string" ||
      !row.companyId ||
      typeof row.companyName !== "string" ||
      !row.companyName ||
      !Number.isFinite(row.score) ||
      !Number.isInteger(row.rank) ||
      row.rank <= 0 ||
      companyIds.has(row.companyId)
    ) {
      throw new Error(`${label} contains an invalid or duplicate leaderboard row.`);
    }
    companyIds.add(row.companyId);
  }
}

async function buildPublicationOperations(snapshots, { rootDir, recordedAt, signal }) {
  throwIfAborted(signal);
  if (!isValidDate(recordedAt)) {
    throw new Error("Benchmark publication requires a valid recordedAt timestamp.");
  }

  const operations = snapshots.map(({ descriptor, graph }) => ({
    kind: "graph",
    batch: descriptor.slug,
    topVoices: descriptor.topVoices ?? "off",
    targetPath: path.join(rootDir, "public", "graph", descriptor.filename),
    content: `${JSON.stringify(graph)}\n`
  }));

  for (const { descriptor, graph } of snapshots) {
    throwIfAborted(signal);
    if (descriptor.topVoices) {
      continue;
    }
    const targetPath = path.join(
      rootDir,
      "outputs",
      "benchmarks",
      `${descriptor.slug.toLowerCase()}-score-benchmarks.json`
    );
    const store = await readBenchmarkStoreForAppend(targetPath, descriptor.slug);
    throwIfAborted(signal);
    const nextStore = appendObservedBenchmarkSnapshot(store, graph, recordedAt);
    if (nextStore !== store) {
      operations.push({
        kind: "history",
        batch: descriptor.slug,
        topVoices: "off",
        targetPath,
        content: `${JSON.stringify(nextStore, null, 2)}\n`
      });
    }
  }

  return operations;
}

async function readBenchmarkStoreForAppend(storePath, batchSlug) {
  let raw;
  try {
    raw = await readFile(storePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        version: 1,
        batchSlug,
        updatedAt: new Date(0).toISOString(),
        daily: [],
        weekly: []
      };
    }
    throw error;
  }

  const parsed = JSON.parse(raw);
  if (
    parsed?.version !== 1 ||
    parsed.batchSlug !== batchSlug ||
    typeof parsed.updatedAt !== "string" ||
    !Array.isArray(parsed.daily) ||
    !Array.isArray(parsed.weekly)
  ) {
    throw new Error(`Refusing to append to invalid benchmark history ${storePath}.`);
  }
  return parsed;
}

export function appendObservedBenchmarkSnapshot(store, graph, recordedAt) {
  const scoringModelVersion = graph.scoringContext.modelVersion;
  const snapshot = {
    recordedAt: recordedAt.toISOString(),
    scoringModelVersion,
    inputGeneratedAt: graph.generatedAt,
    companies: graph.leaderboard.map((row) => ({
      companyId: row.companyId,
      companyName: row.companyName,
      score: row.score,
      rank: row.rank
    }))
  };
  const dayKey = centralDayKey(recordedAt);
  const recordedDailyIndex = store.daily.findIndex(
    (candidate) =>
      candidate?.scoringModelVersion === scoringModelVersion &&
      !isProjectedBenchmarkSnapshot(candidate) &&
      isIsoTimestamp(candidate.recordedAt) &&
      centralDayKey(new Date(candidate.recordedAt)) === dayKey
  );
  const alreadyRecordedDaily = recordedDailyIndex >= 0;
  const recordedDaily = alreadyRecordedDaily ? store.daily[recordedDailyIndex] : null;
  // A run can begin before Central midnight and finish after it. If that
  // straddled publication wrote today's recordedAt against yesterday's graph,
  // a same-day retry must repair the daily entry instead of treating the
  // calendar key alone as an idempotency receipt.
  const replaceStaleDaily = alreadyRecordedDaily && (
    !isIsoTimestamp(recordedDaily?.inputGeneratedAt) ||
    centralDayKey(new Date(recordedDaily.inputGeneratedAt)) !== dayKey ||
    Date.parse(graph.generatedAt) > Date.parse(recordedDaily.inputGeneratedAt)
  );
  const matchingWeekly = store.weekly.filter(
    (candidate) =>
      candidate?.scoringModelVersion === scoringModelVersion &&
      !isProjectedBenchmarkSnapshot(candidate) &&
      isIsoTimestamp(candidate.recordedAt)
  );
  const latestWeekly = matchingWeekly.reduce(
    (latest, candidate) =>
      !latest || Date.parse(candidate.recordedAt) > Date.parse(latest.recordedAt) ? candidate : latest,
    null
  );
  const weeklyDue =
    !latestWeekly || centralDayDistance(new Date(latestWeekly.recordedAt), recordedAt) >= 7;

  const upsertedDaily = !alreadyRecordedDaily
    ? replaceProjectedSnapshotOnCentralDay(store.daily, snapshot, recordedAt, scoringModelVersion)
    : replaceStaleDaily
      ? store.daily.map((candidate, index) => index === recordedDailyIndex ? snapshot : candidate)
      : store.daily;
  const upsertedWeekly = weeklyDue
    ? replaceProjectedSnapshotOnCentralDay(store.weekly, snapshot, recordedAt, scoringModelVersion)
    : store.weekly;
  const daily = sortBenchmarkSnapshotsChronologically(upsertedDaily);
  const weekly = sortBenchmarkSnapshotsChronologically(upsertedWeekly);
  const observedSnapshotChanged = !alreadyRecordedDaily || replaceStaleDaily || weeklyDue;

  // Historical model-version backfills can be appended after newer rows. A
  // same-day publisher retry must still repair that ordering even when the
  // current observation itself is already recorded, otherwise atomic release
  // validation keeps seeing a stale, non-chronological history.
  if (!observedSnapshotChanged && daily === store.daily && weekly === store.weekly) {
    return store;
  }

  return {
    ...store,
    updatedAt: observedSnapshotChanged ? recordedAt.toISOString() : store.updatedAt,
    daily,
    weekly
  };
}

function replaceProjectedSnapshotOnCentralDay(
  snapshots,
  observedSnapshot,
  recordedAt,
  scoringModelVersion
) {
  const dayKey = centralDayKey(recordedAt);
  let replaced = false;
  const next = snapshots.flatMap((candidate) => {
    const isSameProjectedDay =
      candidate?.scoringModelVersion === scoringModelVersion &&
      isProjectedBenchmarkSnapshot(candidate) &&
      isIsoTimestamp(candidate.recordedAt) &&
      centralDayKey(new Date(candidate.recordedAt)) === dayKey;
    if (!isSameProjectedDay) return [candidate];
    if (replaced) return [];
    replaced = true;
    return [observedSnapshot];
  });
  return replaced ? next : [...snapshots, observedSnapshot];
}

function isProjectedBenchmarkSnapshot(snapshot) {
  return (
    snapshot?.scoringModelVersion === PROJECTED_SCORE_MODEL_VERSION &&
    snapshot?.scoreCalibration?.kind === PROJECTED_SCORE_CALIBRATION_KIND
  );
}

function sortBenchmarkSnapshotsChronologically(snapshots) {
  const ordered = snapshots
    .map((snapshot, originalIndex) => ({
      originalIndex,
      recordedAt: isIsoTimestamp(snapshot?.recordedAt)
        ? Date.parse(snapshot.recordedAt)
        : Number.POSITIVE_INFINITY,
      snapshot
    }))
    .sort(
      (left, right) =>
        left.recordedAt - right.recordedAt || left.originalIndex - right.originalIndex
    );

  if (ordered.every((entry, index) => entry.originalIndex === index)) {
    return snapshots;
  }

  return ordered.map((entry) => entry.snapshot);
}

export async function assertSkippedRunHasCurrentBenchmarks({ rootDir, now }) {
  if (typeof rootDir !== "string" || !rootDir || !isValidDate(now)) {
    throw new Error("Skipped benchmark validation requires a root directory and valid timestamp.");
  }

  const dayKey = centralDayKey(now);
  const staleBatches = [];
  const baseSnapshots = BATCH_SNAPSHOTS.filter((descriptor) => !descriptor.topVoices);

  for (const descriptor of baseSnapshots) {
    const storePath = path.join(
      rootDir,
      "outputs",
      "benchmarks",
      `${descriptor.slug.toLowerCase()}-score-benchmarks.json`
    );
    const store = await readBenchmarkStoreForAppend(storePath, descriptor.slug);
    const hasCurrentSnapshot = store.daily.some((candidate) => {
      if (
        candidate?.scoringModelVersion !== STATIC_GRAPH_SCORING_MODEL_VERSION ||
        !isIsoTimestamp(candidate.recordedAt) ||
        !isIsoTimestamp(candidate.inputGeneratedAt)
      ) {
        return false;
      }
      const recordedAt = new Date(candidate.recordedAt);
      const inputGeneratedAt = new Date(candidate.inputGeneratedAt);
      return (
        recordedAt.getTime() <= now.getTime() + GENERATED_AT_CLOCK_SKEW_MS &&
        inputGeneratedAt.getTime() <= recordedAt.getTime() &&
        centralDayKey(recordedAt) === dayKey &&
        centralDayKey(inputGeneratedAt) === dayKey
      );
    });

    if (!hasCurrentSnapshot) {
      staleBatches.push(descriptor.slug);
    }
  }

  if (staleBatches.length > 0) {
    throw new Error(
      `Refusing to skip stale daily benchmark update for ${dayKey} in ${CENTRAL_TIME_ZONE}; ` +
      `missing ${STATIC_GRAPH_SCORING_MODEL_ID}@${STATIC_GRAPH_SCORING_MODEL_VERSION} history for ${staleBatches.join(", ")}.`
    );
  }
}

export async function publishOperationsAtomically(
  operations,
  {
    signal,
    accessImpl = access,
    mkdirImpl = mkdir,
    readFileImpl = readFile,
    renameImpl = rename,
    removeImpl = rm,
    statImpl = stat,
    writeFileImpl = writeFile
  } = {}
) {
  const publicationId = `${process.pid}-${randomUUID()}`;
  const staged = [];
  const fileOperations = { renameImpl, removeImpl, writeFileImpl };

  try {
    throwIfAborted(signal);
    for (const operation of operations) {
      await mkdirImpl(path.dirname(operation.targetPath), { recursive: true });
      throwIfAborted(signal);
      const temporaryPath = `${operation.targetPath}.${publicationId}.tmp`;
      const backupPath = `${operation.targetPath}.${publicationId}.bak`;
      const rollbackPath = `${operation.targetPath}.${publicationId}.rollback.tmp`;
      const stagedOperation = {
        ...operation,
        temporaryPath,
        backupPath,
        rollbackPath,
        hadOriginal: false,
        originalContent: undefined,
        originalMode: undefined,
        originalMoved: false,
        backupPresent: false,
        targetPublished: false
      };
      staged.push(stagedOperation);
      await writeFileImpl(temporaryPath, operation.content, { encoding: "utf8", flag: "wx" });
      throwIfAborted(signal);
    }

    for (const operation of staged) {
      throwIfAborted(signal);
      operation.hadOriginal = await pathExists(operation.targetPath, accessImpl);
      throwIfAborted(signal);
      if (operation.hadOriginal) {
        const [originalContent, originalStats] = await Promise.all([
          readFileImpl(operation.targetPath),
          statImpl(operation.targetPath)
        ]);
        operation.originalContent = originalContent;
        operation.originalMode = originalStats.mode;
        throwIfAborted(signal);
        await renameImpl(operation.targetPath, operation.backupPath);
        operation.originalMoved = true;
        operation.backupPresent = true;
        throwIfAborted(signal);
      }
      await renameImpl(operation.temporaryPath, operation.targetPath);
      operation.targetPublished = true;
      throwIfAborted(signal);
    }

    // Retain original bytes until the last abort check so backup cleanup is also reversible.
    for (const operation of staged) {
      if (operation.backupPresent) {
        await removeImpl(operation.backupPath, { force: true });
        operation.backupPresent = false;
        throwIfAborted(signal);
      }
    }

    for (const operation of staged) {
      await removeImpl(operation.temporaryPath, { force: true });
      throwIfAborted(signal);
      await removeImpl(operation.rollbackPath, { force: true });
      throwIfAborted(signal);
    }

    throwIfAborted(signal);
  } catch (error) {
    const rollbackErrors = await rollbackPublication(staged, fileOperations);
    const cleanupErrors = await cleanupPublicationFiles(staged, fileOperations);
    const recoveryErrors = [...rollbackErrors, ...cleanupErrors];
    if (recoveryErrors.length > 0) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AggregateError(
        [error, ...recoveryErrors],
        `Benchmark publication failed (${message}) and rollback cleanup was incomplete.`,
        { cause: error }
      );
    }
    throw error;
  }
}

async function rollbackPublication(staged, { renameImpl, removeImpl, writeFileImpl }) {
  const errors = [];

  for (const operation of [...staged].reverse()) {
    try {
      if (operation.targetPublished) {
        await removeImpl(operation.targetPath, { force: true });
        operation.targetPublished = false;
      }
      if (!operation.originalMoved) {
        continue;
      }

      let restored = false;
      if (operation.backupPresent) {
        try {
          await renameImpl(operation.backupPath, operation.targetPath);
          operation.backupPresent = false;
          restored = true;
        } catch (error) {
          if (error?.code !== "ENOENT") {
            throw error;
          }
          operation.backupPresent = false;
        }
      }

      if (!restored) {
        if (operation.originalContent === undefined) {
          throw new Error(`Missing original content for rollback of ${operation.targetPath}.`);
        }
        await removeImpl(operation.rollbackPath, { force: true });
        await writeFileImpl(operation.rollbackPath, operation.originalContent, {
          flag: "wx",
          mode: operation.originalMode
        });
        await renameImpl(operation.rollbackPath, operation.targetPath);
      }
      operation.originalMoved = false;
    } catch (error) {
      errors.push(new Error(`Failed to roll back ${operation.targetPath}: ${error.message}`, { cause: error }));
    }
  }

  return errors;
}

async function cleanupPublicationFiles(staged, { removeImpl }) {
  const errors = [];

  for (const operation of staged) {
    const cleanupPaths = [operation.temporaryPath, operation.rollbackPath];
    if (!operation.originalMoved) {
      cleanupPaths.push(operation.backupPath);
    }
    for (const cleanupPath of cleanupPaths) {
      try {
        await removeImpl(cleanupPath, { force: true });
      } catch (error) {
        errors.push(new Error(`Failed to remove publication file ${cleanupPath}: ${error.message}`, { cause: error }));
      }
    }
  }

  return errors;
}

export function getGraphApiServer(args, options = {}) {
  if (args.baseUrl) {
    const publicationToken = isLoopbackBaseUrl(args.baseUrl)
      ? cleanSecret(args.publicationToken)
      : undefined;
    const diagnosticsSecret = cleanSecret(args.diagnosticsSecret);
    if (!publicationToken && !diagnosticsSecret) {
      throw new Error(
        "External graph recomputation requires GRAPH_PUBLICATION_BUILD_TOKEN or GRAPH_DIAGNOSTICS_SECRET; refusing to publish from a stale public snapshot."
      );
    }
    return {
      baseUrl: trimTrailingSlash(args.baseUrl),
      publicationToken,
      diagnosticsSecret,
      signal: undefined,
      stop: async () => undefined,
      finish: async () => undefined
    };
  }

  const port = args.port ?? DEFAULT_PORT;
  const baseUrl = `http://127.0.0.1:${port}`;
  const cwd = options.cwd ?? process.cwd();
  const spawnImpl = options.spawnImpl ?? spawn;
  const execPath = options.execPath ?? process.execPath;
  const nextCliPath = options.nextCliPath ?? path.join(cwd, "node_modules", "next", "dist", "bin", "next");
  const signalTarget = options.signalTarget ?? process;
  const forwardSignal = options.forwardSignal ?? forwardTerminationSignal;
  const commandTimeoutMs = options.commandTimeoutMs ?? SERVER_COMMAND_TIMEOUT_MS;
  const stopTimeoutMs = options.stopTimeoutMs ?? SERVER_STOP_TIMEOUT_MS;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const publicationToken = randomBytes(32).toString("base64url");
  const childEnv = {
    ...(options.env ?? process.env),
    GRAPH_PUBLICATION_BUILD_TOKEN: publicationToken
  };
  const child = spawnImpl(execPath, [nextCliPath, "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd,
    detached: false,
    env: childEnv,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const controller = new AbortController();
  let stopping = false;
  let stopPromise;
  let finishPromise;
  let commandTimeout;
  let receivedSignal;
  const signalHandlers = new Map();

  const removeSignalHandlers = () => {
    for (const [signal, handler] of signalHandlers) {
      signalTarget.removeListener(signal, handler);
    }
    signalHandlers.clear();
  };
  const stop = () => {
    if (!stopPromise) {
      stopping = true;
      clearTimeout(commandTimeout);
      stopPromise = stopChild(child, { timeoutMs: stopTimeoutMs });
    }
    return stopPromise;
  };
  const finish = () => {
    if (!finishPromise) {
      finishPromise = (async () => {
        await stop();
        removeSignalHandlers();
        if (receivedSignal) {
          forwardSignal(receivedSignal);
        }
      })();
    }
    return finishPromise;
  };
  const handleSignal = (signal) => {
    if (receivedSignal) {
      return;
    }
    receivedSignal = signal;
    controller.abort(new Error(`Benchmark update received ${signal}.`));
    void stop().catch((error) => {
      stderr.write(`[next] Failed to stop graph server after ${signal}: ${error.message}\n`);
    });
  };

  for (const signal of TERMINATION_SIGNALS) {
    const handler = () => handleSignal(signal);
    signalHandlers.set(signal, handler);
    signalTarget.on(signal, handler);
  }

  commandTimeout = setTimeout(() => {
    const error = new Error(`Graph server command exceeded ${commandTimeoutMs}ms.`);
    controller.abort(error);
    void stop().catch(() => undefined);
  }, commandTimeoutMs);
  commandTimeout.unref();

  child.stdout?.on("data", (chunk) => stdout.write(`[next] ${chunk}`));
  child.stderr?.on("data", (chunk) => stderr.write(`[next] ${chunk}`));
  child.once("error", (error) => controller.abort(new Error(`Graph server command failed: ${error.message}`)));
  child.once("exit", (code, signal) => {
    if (!stopping && !controller.signal.aborted) {
      controller.abort(new Error(`Graph server exited before publication (${code ?? signal ?? "unknown"}).`));
    }
  });

  return {
    baseUrl,
    publicationToken,
    diagnosticsSecret: undefined,
    signal: controller.signal,
    stop,
    finish
  };
}

async function stopChild(child, { timeoutMs }) {
  if (childHasExited(child) || child.pid === undefined) {
    return;
  }

  if (await signalChildAndWait(child, "SIGTERM", timeoutMs)) {
    return;
  }
  if (await signalChildAndWait(child, "SIGKILL", timeoutMs)) {
    return;
  }
  throw new Error(`Graph server process ${child.pid} did not exit after SIGKILL.`);
}

function signalChildAndWait(child, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout;
    const finish = (exited) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        child.removeListener("exit", onExit);
        resolve(exited);
      }
    };
    const onExit = () => finish(true);

    child.once("exit", onExit);
    timeout = setTimeout(() => finish(childHasExited(child)), timeoutMs);

    try {
      if (childHasExited(child)) {
        finish(true);
      } else {
        child.kill(signal);
      }
    } catch (error) {
      if (childHasExited(child)) {
        finish(true);
      } else {
        clearTimeout(timeout);
        child.removeListener("exit", onExit);
        reject(error);
      }
    }
  });
}

function childHasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForGraphApi(baseUrl, { publicationToken, diagnosticsSecret, signal } = {}) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < SERVER_READY_TIMEOUT_MS) {
    throwIfAborted(signal);
    try {
      await probeGraphApi(baseUrl, {
        publicationToken,
        diagnosticsSecret,
        signal,
        timeoutMs: SERVER_READY_FETCH_TIMEOUT_MS
      });
      return;
    } catch (error) {
      lastError = error;
      throwIfAborted(signal);
      await sleep(SERVER_READY_POLL_MS, signal);
    }
  }

  throw new Error(`Graph API was not ready after ${SERVER_READY_TIMEOUT_MS}ms: ${lastError}`);
}

async function probeGraphApi(
  baseUrl,
  { publicationToken, diagnosticsSecret, signal, timeoutMs = SERVER_READY_FETCH_TIMEOUT_MS } = {}
) {
  // An invalid batch reaches the authenticated route and query parser without
  // importing or scoring the multi-gigabyte graph dependencies. A 400 response
  // therefore proves the server is ready without doing the first publication
  // build twice or repeatedly aborting it during startup polling.
  const url = new URL("/api/graph/full", `${trimTrailingSlash(baseUrl)}/`);
  url.searchParams.set("batch", "__benchmark_readiness__");
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(signal?.reason ?? new Error("Graph readiness probe aborted."));
  if (signal?.aborted) abortFromParent();
  else signal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new Error(`Graph API readiness probe timed out after ${timeoutMs}ms.`)),
    timeoutMs
  );
  timeout.unref();

  try {
    const headers = { accept: "application/json" };
    if (publicationToken) headers["x-returner-publication-build"] = publicationToken;
    else if (diagnosticsSecret) headers.authorization = `Bearer ${diagnosticsSecret}`;
    const response = await fetch(url, { headers, signal: controller.signal });
    if (response.status !== 400) {
      throw new Error(
        `Graph API readiness probe returned ${response.status} ${response.statusText}; expected the invalid-query contract.`
      );
    }
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason instanceof Error) {
      throw controller.signal.reason;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromParent);
  }
}

export async function fetchGraph(
  baseUrl,
  batchSlug,
  topVoices,
  { publicationToken, diagnosticsSecret, signal, timeoutMs = GRAPH_FETCH_TIMEOUT_MS } = {}
) {
  // Daily publication must recompute the graph from canonical evidence. The
  // public /api/graph route intentionally serves the last published snapshot,
  // which cannot be used to create its own next generation.
  const url = new URL("/api/graph/full", `${trimTrailingSlash(baseUrl)}/`);
  url.searchParams.set("batch", batchSlug);
  if (topVoices) {
    url.searchParams.set("topVoices", topVoices);
  }
  if (!publicationToken) {
    // External servers use the authenticated diagnostics contract. At least
    // one explicit diagnostic flag is required by the full-graph route.
    // Non-scoring owners are required for catalog census reconciliation; raw
    // provider payloads must not be copied into the published graph bundle.
    url.searchParams.set("includeNonScoring", "true");
  }
  // Release snapshots must retain catalog owners even when a company has no
  // scored evidence yet; otherwise a zero-score owner silently disappears
  // from the graph and the graph/catalog census no longer reconciles.
  url.searchParams.set("includeNonScoring", "true");

  const controller = new AbortController();
  const abortFromParent = () => controller.abort(signal?.reason ?? new Error("Graph fetch aborted."));
  if (signal?.aborted) {
    abortFromParent();
  } else {
    signal?.addEventListener("abort", abortFromParent, { once: true });
  }
  const timeout = setTimeout(
    () => controller.abort(new Error(`Graph API fetch timed out after ${timeoutMs}ms for ${batchSlug}/${topVoices ?? "off"}.`)),
    timeoutMs
  );
  timeout.unref();

  try {
    const headers = { accept: "application/json" };
    if (publicationToken) {
      headers["x-returner-publication-build"] = publicationToken;
    } else if (diagnosticsSecret) {
      headers.authorization = `Bearer ${diagnosticsSecret}`;
    }
    const response = await fetch(url, {
      headers,
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`Graph API failed for ${batchSlug}/${topVoices ?? "off"}: ${response.status} ${response.statusText}`);
    }
    return await response.json();
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason instanceof Error) {
      throw controller.signal.reason;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromParent);
  }
}

export function scheduledUtcHourRepresentsCentralMidnight(date, scheduledUtcHour) {
  if (!isValidDate(date) || !Number.isInteger(scheduledUtcHour) || scheduledUtcHour < 0 || scheduledUtcHour > 23) {
    return false;
  }
  // GitHub cron dates are UTC, including when the run starts on the prior Central day.
  const scheduledInstant = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    scheduledUtcHour
  ));
  return centralDateTimeParts(scheduledInstant).hour === "00";
}

function parseArgs(rawArgs) {
  const parsed = {
    baseUrl: process.env.GRAPH_API_BASE_URL,
    publicationToken: process.env.GRAPH_PUBLICATION_BUILD_TOKEN,
    diagnosticsSecret: process.env.GRAPH_DIAGNOSTICS_SECRET,
    port: Number(process.env.GRAPH_API_PORT) || DEFAULT_PORT,
    now: process.env.BENCHMARK_NOW,
    windowStart: process.env.BENCHMARK_WINDOW_START,
    expectedCentralDate: process.env.BENCHMARK_EXPECTED_CENTRAL_DATE,
    scheduledUtcHour: undefined,
    root: undefined,
    pinnedSourceInProcess: false
  };

  for (const arg of rawArgs) {
    if (arg.startsWith("--base-url=")) {
      parsed.baseUrl = arg.slice("--base-url=".length);
      continue;
    }
    if (arg.startsWith("--port=")) {
      const port = Number(arg.slice("--port=".length));
      if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
        throw new Error(`Invalid graph API port: ${arg}`);
      }
      parsed.port = port;
      continue;
    }
    if (arg.startsWith("--now=")) {
      parsed.now = arg.slice("--now=".length);
      continue;
    }
    if (arg.startsWith("--window-start=")) {
      parsed.windowStart = arg.slice("--window-start=".length);
      continue;
    }
    if (arg.startsWith("--expected-central-date=")) {
      parsed.expectedCentralDate = arg.slice("--expected-central-date=".length);
      continue;
    }
    if (arg.startsWith("--scheduled-utc-hour=")) {
      const hour = Number(arg.slice("--scheduled-utc-hour=".length));
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
        throw new Error(`Invalid scheduled UTC hour: ${arg}`);
      }
      parsed.scheduledUtcHour = hour;
      continue;
    }
    if (arg.startsWith("--root=")) {
      parsed.root = arg.slice("--root=".length);
      continue;
    }
    if (arg === "--pinned-source-in-process") {
      parsed.pinnedSourceInProcess = true;
      continue;
    }
    throw new Error(`Unknown benchmark update argument: ${arg}`);
  }

  if (parsed.expectedCentralDate !== undefined) {
    assertRealCentralDate(parsed.expectedCentralDate, "expected Central date");
  }

  return parsed;
}

function assertExpectedCentralDateMatchesRecordedAt(expectedCentralDate, recordedAt) {
  if (expectedCentralDate === undefined) {
    return;
  }
  assertRealCentralDate(expectedCentralDate, "expected Central date");
  const recordedCentralDate = centralDayKey(recordedAt);
  if (recordedCentralDate !== expectedCentralDate) {
    throw new Error(
      `Daily benchmark Central date changed before publication: expected ${expectedCentralDate}, ` +
      `but recordedAt ${recordedAt.toISOString()} is ${recordedCentralDate}.`
    );
  }
}

function assertRealCentralDate(value, label) {
  if (!isRealCalendarDate(value)) {
    throw new Error(`Invalid ${label}: ${String(value)}; expected a real YYYY-MM-DD date.`);
  }
}

function isRealCalendarDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  if (!match) {
    return false;
  }
  const [, year, month, day] = match.map(Number);
  const instant = new Date(0);
  instant.setUTCFullYear(year, month - 1, day);
  instant.setUTCHours(0, 0, 0, 0);
  return instant.getUTCFullYear() === year &&
    instant.getUTCMonth() === month - 1 &&
    instant.getUTCDate() === day;
}

function cleanSecret(value) {
  const cleaned = String(value ?? "").trim();
  return cleaned || undefined;
}

function isLoopbackBaseUrl(value) {
  try {
    const hostname = new URL(value).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

function snapshotKey({ slug, topVoices }) {
  return `${slug ?? "missing"}:${topVoices ?? "off"}`;
}

function centralDateTimeParts(date) {
  return Object.fromEntries(
    CENTRAL_DATE_TIME_FORMATTER.formatToParts(date).map((part) => [part.type, part.value])
  );
}

function centralDayKey(date) {
  const parts = centralDateTimeParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function centralDayDistance(from, to) {
  const fromDay = Date.parse(`${centralDayKey(from)}T00:00:00.000Z`);
  const toDay = Date.parse(`${centralDayKey(to)}T00:00:00.000Z`);
  return Math.floor((toDay - fromDay) / (24 * 60 * 60 * 1000));
}

function isIsoTimestamp(value) {
  if (typeof value !== "string") {
    return false;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isValidDate(value) {
  return value instanceof Date && Number.isFinite(value.getTime());
}

async function pathExists(value, accessImpl = access) {
  try {
    await accessImpl(value);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Benchmark update aborted.");
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Benchmark update aborted."));
    };
    function finish() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    if (signal?.aborted) {
      abort();
    } else {
      signal?.addEventListener("abort", abort, { once: true });
    }
  });
}

function forwardTerminationSignal(signal) {
  const exitCode = signal === "SIGINT" ? 130 : 143;
  if (process.platform === "win32") {
    process.exitCode = exitCode;
    return;
  }

  try {
    process.kill(process.pid, signal);
  } catch {
    process.exitCode = exitCode;
  }
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((error) => {
    console.error(error);
    process.exitCode ??= 1;
  });
}
