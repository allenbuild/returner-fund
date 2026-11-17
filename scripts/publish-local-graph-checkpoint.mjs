import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function prepareRuntime(options) {
  const { prepareGraphRuntimeEvidence } = await import("./prepare-graph-runtime-evidence.mjs");
  return prepareGraphRuntimeEvidence(options);
}

async function existingBuilders() {
  // These imports resolve to the same pinned module URLs used inside each
  // existing builder. Their source/data imports live for this invocation only.
  const [benchmark, topics, ranked] = await Promise.all([
    import("./update-daily-benchmarks.mjs"),
    import("./build-topic-facets.mjs"),
    import("./build-ranked-posts-sidecar.mjs")
  ]);
  return {
    benchmarks: benchmark.main,
    buildTopics: topics.buildExpectedTopicFacetSnapshots,
    writeTopics: topics.writeTopicFacetSnapshotsAtomically,
    validateTopics: topics.validateTopicFacetSnapshots,
    ranked: ranked.main
  };
}

/** Run the unchanged artifact builders in one process against one frozen input. */
export async function publishLocalGraphCheckpoint({ checkpoint, rootDir = process.cwd(), loadBuilders = existingBuilders, prepareRuntimeEvidence = prepareRuntime } = {}) {
  if (!checkpoint) throw new Error("An explicit frozen checkpoint directory is required.");
  const absoluteRoot = path.resolve(rootDir), absoluteCheckpoint = path.resolve(absoluteRoot, checkpoint);
  const canonicalPath = path.join(absoluteRoot, "src/lib/social/targeted-evidence-current.json");
  const expectedSha256 = sha(await readFile(path.join(absoluteCheckpoint, "targeted-after.json")));
  const journalPath = path.join(absoluteCheckpoint, "publication-pipeline-state.json");
  const journal = { status: "started", checkpoint, expectedCanonicalSha256: expectedSha256, singleProcess: true, startedAt: new Date().toISOString(), stages: [], manifestPublicationPerformed: false };
  const saveJournal = () => writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  const guard = async (stage) => {
    if (sha(await readFile(canonicalPath)) !== expectedSha256) throw new Error(`Frozen canonical SHA changed at ${stage}; publication stopped.`);
  };
  const stage = async (name, operation) => {
    await guard(`${name}:before`);
    const row = { name, status: "running", startedAt: new Date().toISOString() };
    journal.stages.push(row);
    await saveJournal();
    const started = performance.now();
    const result = await operation();
    await guard(`${name}:after`);
    Object.assign(row, { status: "written_and_validated", finishedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started) });
    await saveJournal();
    return result;
  };
  try {
    await guard("initial");
    await saveJournal();
    // Dataset modules read runtime projections once at first import. Prepare
    // their physical input before loading any builder that can import them.
    const runtime = await prepareRuntimeEvidence({ rootDir: absoluteRoot });
    await guard("runtime_preparation:after");
    await writeFile(path.join(absoluteCheckpoint, "runtime-preparation.log"), `${JSON.stringify(runtime)}\n`);
    journal.runtimePreparedBeforeBuilderImport = true;
    await saveJournal();
    const builders = await loadBuilders();
    const benchmarks = await stage("graphs_and_benchmarks", () => builders.benchmarks(["--pinned-source-in-process"], { rootDir: absoluteRoot }));
    await writeFile(path.join(absoluteCheckpoint, "graph-publication.log"), `${JSON.stringify(benchmarks, null, 2)}\n`);
    const topics = await stage("topic_facets", async () => {
      const snapshots = await builders.buildTopics({ dataRoot: absoluteRoot });
      await guard("topic_facets:before_write");
      await builders.writeTopics(snapshots);
      const validation = await builders.validateTopics(snapshots);
      if (!validation.valid) throw new Error(`Topic facet publication verification failed: ${validation.stalePaths.join(", ")}`);
      return { status: "written_and_validated", paths: snapshots.map((snapshot) => snapshot.displayPath) };
    });
    await writeFile(path.join(absoluteCheckpoint, "topics-publication.log"), `${JSON.stringify(topics)}\n`);
    const ranked = await stage("ranked_posts", () => builders.ranked([`--root=${absoluteRoot}`]));
    const scopes = Object.values(ranked.batches).flatMap((batch) => Object.values(batch));
    const rankedSummary = { status: "written_and_validated", output: "src/lib/graph/ranked-posts-sidecar.generated.json", scopes: scopes.length, sourceEvidence: scopes.reduce((sum, scope) => sum + scope.sourceEvidenceCount, 0), fullRankable: ranked.canonicalParity.fullRankableCount, previewRankable: ranked.canonicalParity.previewRankableCount, representedRankable: ranked.canonicalParity.representedRankableCount, overflowRankable: ranked.canonicalParity.overflowRankableCount, crossAudiencePreviewProjections: ranked.canonicalParity.crossAudiencePreviewProjectionCount };
    await writeFile(path.join(absoluteCheckpoint, "ranked-publication.log"), `${JSON.stringify(rankedSummary)}\n`);
    await guard("complete");
    Object.assign(journal, { status: "graph_and_derived_artifacts_written", finishedAt: new Date().toISOString() });
    await saveJournal();
    return journal;
  } catch (error) {
    Object.assign(journal, { status: "failed", error: error.message, finishedAt: new Date().toISOString() });
    await saveJournal();
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), checkpoint = args.find((arg) => arg.startsWith("--checkpoint="))?.slice("--checkpoint=".length);
  if (args.some((arg) => !arg.startsWith("--checkpoint="))) throw new Error("Only --checkpoint=<frozen-checkpoint-directory> is supported.");
  publishLocalGraphCheckpoint({ checkpoint }).then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error); process.exitCode = 1; });
}
