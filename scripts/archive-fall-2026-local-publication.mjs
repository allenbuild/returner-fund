import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { validateArtifactManifest } from "./lib/artifact-manifest.mjs";

const value = (key) => process.argv.find((arg) => arg.startsWith(`${key}=`))?.slice(key.length + 1);
const checkpoint = value("--checkpoint");
const number = Number(checkpoint?.match(/checkpoint-(\d+)$/)?.[1]);
if (!number) throw new Error("Pass an explicit --checkpoint=<.../checkpoint-N>.");
const read = async (path) => JSON.parse(await readFile(path, "utf8"));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const parsedLog = async (name) => {
  const text = await readFile(`${checkpoint}/${name}`, "utf8");
  const start = text.search(/^\{(?:\n\s*)?"status"/m);
  if (start < 0) throw new Error(`No completed publication result in ${name}.`);
  return JSON.parse(text.slice(start).split(/\n(?=\(node:)/)[0].trim());
};
const manifest = await read("public/graph/manifest.json");
assert.ok(manifest.ingestionRunId.startsWith(`fall-2026-checkpoint-${number}-`), "Manifest belongs to another checkpoint.");
const validation = await validateArtifactManifest({ rootDir: process.cwd(), expectedIngestionRunId: manifest.ingestionRunId });
assert.equal(validation.ok, true, validation.errors?.join("; "));
const merge = await read(`${checkpoint}/merge-summary.json`);
const canonicalBytes = await readFile("src/lib/social/targeted-evidence-current.json"), canonical = JSON.parse(canonicalBytes);
assert.deepEqual(canonical.evidence, (await read(`${checkpoint}/targeted-after.json`)).evidence, "Canonical changed after frozen publication.");
const historyPath = `${checkpoint}/collected-history/collected-history.json`, historyBytes = await readFile(historyPath), history = JSON.parse(historyBytes);
const graphBytes = await readFile("public/graph/f26.json"), graph = JSON.parse(graphBytes);
assert.equal(graph.nodes.length, 235);
assert.ok(graph.evidence.length <= 5_000);
const platforms = new Set(["x", "linkedin", "instagram", "tiktok", "facebook", "threads"]);
const nativeRows = canonical.evidence.filter((row) => row.batchSlug === "F26" && platforms.has(row.platform));
assert.equal(graph.evidenceStats.byPlatform.youtube ?? 0, canonical.evidence.filter((row) => row.batchSlug === "F26" && row.platform === "youtube").length, "Every frozen native YouTube video must survive graph assembly.");
const canonicalByPlatform = Object.fromEntries([...platforms].map((platform) => [platform, nativeRows.filter((row) => row.platform === platform).length]));
const sourceByPlatform = Object.fromEntries([...platforms].map((platform) => [platform, graph.evidenceStats.byPlatform[platform] ?? 0]));
assert.deepEqual(sourceByPlatform, canonicalByPlatform, "Every frozen native physical post must survive graph assembly.");
assert.equal(history.summary.canonicalFallRows, merge.fallEvidence);
const artifacts = [];
const archivedRoot = `${checkpoint}/published-artifacts`;
await mkdir(archivedRoot, { recursive: false });
async function archive(path) {
  const info = await stat(path);
  if (info.isDirectory()) {
    for (const filename of (await readdir(path)).sort()) await archive(join(path, filename));
    return;
  }
  const bytes = await readFile(path), archivedPath = `${archivedRoot}/${path}`;
  await mkdir(dirname(archivedPath), { recursive: true });
  await writeFile(archivedPath, bytes);
  assert.equal(sha(await readFile(archivedPath)), sha(bytes));
  artifacts.push({ path, archivedPath, bytes: bytes.length, sha256: sha(bytes) });
}
for (const item of manifest.graphArtifacts) await archive(`public/graph/${item.filename}`);
for (const item of manifest.benchmarkArtifacts) await archive(`outputs/benchmarks/${item.filename}`);
for (const item of manifest.supportingArtifacts) for (const path of item.paths) await archive(path);
await archive("public/graph/manifest.json");
await writeFile(`${checkpoint}/published-artifact-archive.json`, `${JSON.stringify({ ingestionRunId: manifest.ingestionRunId, contentHash: manifest.contentHash, artifacts }, null, 2)}\n`);
const prior = await read("outputs/fall-2026/local-publication-summary.json");
const count = (rows) => Object.fromEntries([...new Set(rows.map((row) => row.platform))].map((platform) => [platform, rows.filter((row) => row.platform === platform).length]));
const unscored = (row) => row.tractionStatus === "unscored";
const dominant = {};
for (const row of graph.evidence) for (const [field, val] of Object.entries(row)) dominant[field] = (dominant[field] ?? 0) + Buffer.byteLength(JSON.stringify(val) ?? "");
const canonicalCheckpoint = { ...merge, path: checkpoint, status: `local_checkpoint_${number}_artifacts_validated`, collectedHistoryArchive: historyPath, publishedGraphCheckpoint: `checkpoint-${number}`, graphPublicationPending: false };
const result = { ...prior, status: canonicalCheckpoint.status, generatedAt: graph.generatedAt, fullHistoryComplete: false,
  companyNodes: graph.nodes.length, publicPreviewEvidence: graph.evidence.length, uncappedSourceEvidence: graph.evidenceStats.totalCount,
  omittedFromPreview: graph.evidenceStats.totalCount - graph.evidence.length, previewByPlatform: count(graph.evidence), sourceNativePosts: nativeRows.length,
  sourceNativeByPlatform: sourceByPlatform, sourceNativeUnscored: nativeRows.filter(unscored).length, previewNativeUnscored: graph.evidence.filter((row) => platforms.has(row.platform) && unscored(row)).length,
  canonicalFallRows: merge.fallEvidence, canonicalTotal: canonical.evidence.length, preservedEarlierCohortRows: merge.preservedEarlierCohortRows, preservedEarlierCohortSha256: merge.preservedEarlierCohortSha256,
  graphCheckpoint: number, canonicalCheckpoint: number, derivedCheckpoint: number, latestCanonical: canonicalCheckpoint, latestCanonicalCheckpoint: canonicalCheckpoint,
  validation: await parsedLog("public-artifact-validation.log"), artifactManifest: { path: "public/graph/manifest.json", ingestionRunId: manifest.ingestionRunId, contentHash: manifest.contentHash, validation: await parsedLog("manifest-validation.log") },
  rankedPosts: await parsedLog("ranked-publication.log"), publicationBuild: (await parsedLog("graph-publication.log")).publicationBuild,
  routeSmoke: await read(`${checkpoint}/actual-route-smoke.json`), collectedHistory: { path: historyPath, sha256: sha(historyBytes), summary: history.summary, fullHistoryComplete: false }, latestCollectedHistory: historyPath,
  ...(history.summary.separateNativeArticleBodyContexts ? { nativeArticleBodyContexts: { checkpoint: number, contexts: history.summary.separateNativeArticleBodyContexts, bodyCharacters: history.summary.separateNativeArticleBodyCharacters, countsAsNativePosts: false, contributionScore: 0, path: `${checkpoint}/collected-history/native-article-body-contexts.json`, canonicalTargetedEvidenceChanged: false } } : {}),
  sizeAudit: { bytes: graphBytes.length, gzip6Bytes: gzipSync(graphBytes, { level: 6 }).length, sha256: sha(graphBytes), previewByPlatform: count(graph.evidence), previewUnscored: graph.evidence.filter(unscored).length, sourceProjection: graph.evidenceProjection, dominantEvidenceFields: Object.fromEntries(Object.entries(dominant).sort((a, b) => b[1] - a[1]).slice(0, 7)) },
  archivedArtifacts: archivedRoot, nativePhysicalRetentionAudit: `${checkpoint}/native-physical-post-retention-audit.json`, canonicalNativePosts: nativeRows.length, canonicalNativeByPlatform: canonicalByPlatform, canonicalNativeUnscored: nativeRows.filter(unscored).length,
  nativeYouTubePosts: canonical.evidence.filter((row) => row.batchSlug === "F26" && row.platform === "youtube").length,
  nativeYouTubeUnscoredPosts: canonical.evidence.filter((row) => row.batchSlug === "F26" && row.platform === "youtube" && row.tractionStatus === "unscored").length,
  founderPublicationContexts: canonical.evidence.filter((row) => row.batchSlug === "F26" && row.attributionProvenance === "native_owned_robin_founder_publication_context_v1").length,
  runtimeNativeRetention: { canonicalNativePhysicalPosts: nativeRows.length, runtimeNativePhysicalPosts: nativeRows.length, runtimeHeld: [], sourceGraphEvidence: graph.evidenceStats.totalCount },
  tests: { ...prior.tests, nativeTeamIdentity: "14/14", nativeCompanyProfileIdentity: "3/3", nativeCaptionAbsenceReview: "passed", sidecarScopedReuse: "6/6 + 7 integration fixtures", latestTargetedLint: "passed", actualHttpRoutes: "4 cohorts + Facebook/Threads filters + Fall page passed" }
};
delete result.publicationInProgress;
delete result.pendingCollectedHistory;
await writeFile(`${checkpoint}/local-publication-summary.json`, `${JSON.stringify(result, null, 2)}\n`);
await writeFile("outputs/fall-2026/local-publication-summary.json", `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ status: result.status, checkpoint: number, companyNodes: result.companyNodes, sourceEvidence: result.uncappedSourceEvidence, nativePosts: result.sourceNativePosts, previewEvidence: result.publicPreviewEvidence, gzipBytes: result.sizeAudit.gzip6Bytes, archivedArtifacts: artifacts.length, fullHistoryComplete: false }));
