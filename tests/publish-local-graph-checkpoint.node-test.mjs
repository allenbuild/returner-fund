import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { publishLocalGraphCheckpoint } from "../scripts/publish-local-graph-checkpoint.mjs";
import { validateTopicFacetSnapshots, writeTopicFacetSnapshotsAtomically } from "../scripts/build-topic-facets.mjs";

async function fixture(t, mutations = {}) {
  const rootDir = await mkdtemp(path.join(tmpdir(), "single-process-publication-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const checkpoint = "outputs/checkpoint-1", directory = path.join(rootDir, checkpoint), canonicalPath = path.join(rootDir, "src/lib/social/targeted-evidence-current.json");
  await mkdir(path.dirname(canonicalPath), { recursive: true });
  await mkdir(directory, { recursive: true });
  const frozen = '{"source":{"batchSlug":"F26"},"evidence":[]}\n';
  await writeFile(canonicalPath, frozen);
  await writeFile(path.join(directory, "targeted-after.json"), frozen);
  const calls = [], observedContexts = [], sharedModuleContext = { marker: Symbol("same loaded builders") };
  const snapshot = { displayPath: "public/topic-facets/f26.json", outputPath: path.join(rootDir, "public/topic-facets/f26.json"), serialized: '{"rows":[{"nativeBody":"Exact body"}]}' };
  let loads = 0;
  const builders = {
    async benchmarks(args, options) {
      calls.push("benchmarks"); observedContexts.push(sharedModuleContext);
      assert.deepEqual(args, ["--pinned-source-in-process"]);
      assert.equal(options.rootDir, rootDir);
      await mutations.benchmarks?.(canonicalPath);
      return { status: "updated", publicationBuild: { baseBuilds: 4, baseReuses: 8 } };
    },
    async buildTopics(options) {
      calls.push("buildTopics"); observedContexts.push(sharedModuleContext);
      assert.deepEqual(options, { dataRoot: rootDir });
      await mutations.buildTopics?.(canonicalPath);
      return [snapshot];
    },
    writeTopics(snapshots) { calls.push("writeTopics"); writeTopicFacetSnapshotsAtomically(snapshots); },
    validateTopics(snapshots) { calls.push("validateTopics"); return mutations.invalidTopics ? { valid: false, stalePaths: [snapshot.displayPath] } : validateTopicFacetSnapshots(snapshots); },
    async ranked(args) {
      calls.push("ranked"); observedContexts.push(sharedModuleContext);
      assert.deepEqual(args, [`--root=${rootDir}`]);
      await mutations.ranked?.(canonicalPath);
      return { batches: { F26: { off: { sourceEvidenceCount: 3 } } }, canonicalParity: { fullRankableCount: 2, previewRankableCount: 1, representedRankableCount: 2, overflowRankableCount: 1, crossAudiencePreviewProjectionCount: 0 } };
    }
  };
  return { rootDir, checkpoint, directory, canonicalPath, calls, observedContexts, snapshot, loads: () => loads, prepareRuntimeEvidence: async ({ rootDir: observedRoot }) => { assert.equal(observedRoot, rootDir); calls.push("prepareRuntime"); await mutations.prepareRuntime?.(canonicalPath); return { status: "prepared" }; }, loadBuilders: async () => { assert.equal(calls[0], "prepareRuntime"); loads++; return builders; } };
}

test("one process reuses the existing builder functions and writes unchanged topic bytes/options", async (t) => {
  const f = await fixture(t), result = await publishLocalGraphCheckpoint(f);
  assert.equal(result.status, "graph_and_derived_artifacts_written");
  assert.equal(result.manifestPublicationPerformed, false);
  assert.equal(f.loads(), 1);
  assert.deepEqual(f.calls, ["prepareRuntime", "benchmarks", "buildTopics", "writeTopics", "validateTopics", "ranked"]);
  assert.equal(result.runtimePreparedBeforeBuilderImport, true);
  assert.ok(f.observedContexts.every((context) => context === f.observedContexts[0]));
  assert.equal(await readFile(f.snapshot.outputPath, "utf8"), f.snapshot.serialized);
  assert.equal((await readFile(path.join(f.directory, "ranked-publication.log"), "utf8")).trim(), '{"status":"written_and_validated","output":"src/lib/graph/ranked-posts-sidecar.generated.json","scopes":1,"sourceEvidence":3,"fullRankable":2,"previewRankable":1,"representedRankable":2,"overflowRankable":1,"crossAudiencePreviewProjections":0}');
  assert.equal(result.stages.length, 3);
});

test("an initial canonical SHA mismatch cannot load builders or publish files", async (t) => {
  const f = await fixture(t);
  await writeFile(f.canonicalPath, "changed before publication");
  await assert.rejects(publishLocalGraphCheckpoint(f), /SHA changed at initial/);
  assert.equal(f.loads(), 0);
  assert.deepEqual(f.calls, []);
});

test("a canonical change during graphs stops every later stage", async (t) => {
  const f = await fixture(t, { benchmarks: (p) => writeFile(p, "changed during graph build") });
  await assert.rejects(publishLocalGraphCheckpoint(f), /SHA changed at graphs_and_benchmarks:after/);
  assert.deepEqual(f.calls, ["prepareRuntime", "benchmarks"]);
});

test("a canonical change during topic computation stops before writing topic artifacts", async (t) => {
  const f = await fixture(t, { buildTopics: (p) => writeFile(p, "changed during topic build") });
  await assert.rejects(publishLocalGraphCheckpoint(f), /SHA changed at topic_facets:before_write/);
  assert.deepEqual(f.calls, ["prepareRuntime", "benchmarks", "buildTopics"]);
  await assert.rejects(readFile(f.snapshot.outputPath), { code: "ENOENT" });
});

test("topic verification failure cannot run ranks or mark a completed publication", async (t) => {
  const f = await fixture(t, { invalidTopics: true });
  await assert.rejects(publishLocalGraphCheckpoint(f), /Topic facet publication verification failed/);
  assert.ok(!f.calls.includes("ranked"));
  const journal = JSON.parse(await readFile(path.join(f.directory, "publication-pipeline-state.json")));
  assert.equal(journal.status, "failed");
  assert.equal(journal.manifestPublicationPerformed, false);
});

test("a final canonical change is detected even after ranks return", async (t) => {
  const f = await fixture(t, { ranked: (p) => writeFile(p, "changed during rank build") });
  await assert.rejects(publishLocalGraphCheckpoint(f), /SHA changed at ranked_posts:after/);
});

test("runtime preparation mutation stops before any read-once builder import", async (t) => {
  const f = await fixture(t, { prepareRuntime: (p) => writeFile(p, "changed during preparation") });
  await assert.rejects(publishLocalGraphCheckpoint(f), /SHA changed at runtime_preparation:after/);
  assert.equal(f.loads(), 0);
  assert.deepEqual(f.calls, ["prepareRuntime"]);
});
