import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const [runner, topVoiceRunner, liveRefresh] = await Promise.all([
  readFile("scripts/run-autonomous-ingestion.mjs", "utf8"),
  readFile("scripts/run-top-voice-ingestion.mjs", "utf8"),
  readFile("src/lib/ingestion/live-source-refresh.ts", "utf8")
]);

describe("Top Voice publication isolation contracts", () => {
  it("never lets the network collector write the canonical targeted snapshot directly", () => {
    assert.match(topVoiceRunner, /top-voice-targeted-evidence-\$\{process\.pid\}-\$\{Date\.now\(\)\}\.json/);
    assert.match(topVoiceRunner, /targetedEvidencePath: isolatedEvidencePath/);
    assert.match(topVoiceRunner, /isolatedEvidence:\s*{[\s\S]*snapshot: isolatedEvidenceSnapshot/);
    assert.doesNotMatch(topVoiceRunner, /targeted-evidence-current\.json/);
  });

  it("requires the isolated row-level artifact before durable completion or publication", () => {
    const assertionIndex = runner.indexOf("assertSuccessfulTopVoiceRefresh(topVoiceRefresh)");
    const publicationIndex = runner.indexOf("await mergePublicationInputs(publicationInputs)");
    const assertion = section(runner, "function assertSuccessfulTopVoiceRefresh", "async function persistCoverage");

    assert.ok(assertionIndex > -1 && assertionIndex < publicationIndex);
    assert.match(assertion, /isolatedEvidence\.snapshot\.evidence/);
    assert.match(assertion, /isolatedEvidence\.snapshot\.needsReview/);
    assert.match(assertion, /evidenceCount !== isolatedEvidence\.snapshot\.evidence\.length/);
  });

  it("semantically merges rebased, local, and isolated-run targeted evidence on initial publication and push retry", () => {
    const merge = section(runner, "async function mergePublicationInputs", "async function mergeCollectorDiscoveryState");
    const preparation = section(
      runner,
      "async function prepareSanitizedTargetedSnapshot",
      "function combineAttributionReconciliationLedgers"
    );
    const publication = section(runner, "async function publishRepositoryArtifacts", "async function stageRepositoryArtifacts");

    assert.match(preparation, /baseTargetedSnapshot/);
    assert.match(preparation, /previousTargetedSnapshot/);
    assert.match(preparation, /readRequiredCanonicalJson\(join\(root, targetedEvidencePath\)/);
    assert.match(preparation, /topVoiceRefresh\.isolatedEvidence\.snapshot/);
    assert.match(preparation, /mergeTargetedEvidenceSnapshots/);
    assert.match(preparation, /validateEntityAttribution: isCanonicalBatchEntityAttribution/);
    assert.match(merge, /trustedTargetedSnapshot/);
    assert.match(merge, /sanitizedTargetedSnapshot/);
    assert.ok(
      runner.indexOf("publicationInputs.sanitizedTargetedSnapshot = await prepareSanitizedTargetedSnapshot") <
      runner.indexOf("const durableImport = await importDurableEvidence")
    );
    assert.match(
      publication,
      /const rebasedSanitizedPublicSnapshot = await prepareSanitizedPublicSnapshot\([\s\S]*?\{ baseRef: `origin\/\$\{branch\}` \}[\s\S]*?\);/
    );
    assert.match(
      publication,
      /const rebasedPublicationInputs = \{\s*\.\.\.publicationInputs,\s*sanitizedPublicSnapshot: rebasedSanitizedPublicSnapshot,\s*sanitizedTargetedSnapshot: rebasedSanitizedTargetedSnapshot\s*\};/
    );
    assert.match(
      publication,
      /mergePublicationInputs\(rebasedPublicationInputs, \{ baseRef: `origin\/\$\{branch\}` \}\)/
    );
    assert.doesNotMatch(publication, /mergePublicationInputs\(publicationInputs, \{ baseRef:/);
  });

  it("persists explicit batch provenance and fails closed on missing canonical overrides", () => {
    assert.match(liveRefresh, /batchSlug: target\.batchSlug/);
    assert.match(liveRefresh, /batchSlug: match\.batchSlug/);
    assert.match(liveRefresh, /Required canonical verified social overrides could not be read/);
    assert.doesNotMatch(
      section(liveRefresh, "async function readVerifiedSocialOverrides", "async function readBatchSnapshot"),
      /return\s+{};/
    );
  });
});

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `missing section start: ${start}`);
  assert.ok(endIndex > startIndex, `missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}
