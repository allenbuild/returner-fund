import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  buildRankedPostsSidecarScope,
  buildRankedPostsSidecarSnapshot
} from "../scripts/build-ranked-posts-sidecar.mjs";

test("the sidecar stores every rankable post omitted by a bounded preview", () => {
  const fullGraph = fixtureGraph([
    fixtureEvidence("visible", "company-1"),
    fixtureEvidence("overflow-a", "company-1"),
    fixtureEvidence("overflow-b", "company-2"),
    fixtureEvidence("unranked", "company-2", false)
  ]);
  const previewGraph = fixtureGraph([fixtureEvidence("visible", "company-1")]);
  const scope = buildRankedPostsSidecarScope({
    fullGraph,
    previewGraph,
    rankableEvidence: (items) => items.filter((item) => item.rankable),
    canonicalPostKey: (item) => `x:post:${item.platformPostId}`
  });

  assert.equal(scope.sourceEvidenceCount, 4);
  assert.equal(scope.previewEvidenceCount, 1);
  assert.equal(scope.fullRankableCount, 3);
  assert.equal(scope.previewRankableCount, 1);
  assert.equal(scope.overflowRankableCount, 2);
  assert.deepEqual(scope.evidence.map((item) => item.id), ["overflow-a", "overflow-b"]);
  assert.deepEqual(scope.previewRankableByCompany, { "company-1": 1 });
  assert.deepEqual(scope.fullRankableByCompany, { "company-1": 2, "company-2": 1 });
  assert.equal(scope.representedRankableDigest, scope.fullRankableDigest);
});

test("the generated sidecar has exact parity with every full cohort/audience graph", {
  timeout: 180_000
}, async () => {
  const rootDir = process.cwd();
  const expected = await buildRankedPostsSidecarSnapshot({ rootDir });
  const generated = JSON.parse(await readFile(
    path.join(rootDir, "src", "lib", "graph", "ranked-posts-sidecar.generated.json"),
    "utf8"
  ));

  assert.deepEqual(generated, expected);
  const scopes = Object.values(expected.batches).flatMap((batch) => Object.values(batch));
  assert.equal(scopes.length, 9);
  for (const scope of scopes) {
    assert.equal(scope.representedRankableDigest, scope.fullRankableDigest);
    assert.equal(scope.overflowRankableCount, scope.evidence.length);
  }
  for (const batch of Object.values(expected.batches)) {
    assert.ok(batch.off.sourceEvidenceCount > batch.off.previewEvidenceCount);
  }
});

function fixtureGraph(evidence) {
  return {
    batch: { slug: "S26" },
    selectedTopVoiceAudience: { id: "off" },
    nodes: [fixtureCompany("company-1"), fixtureCompany("company-2")],
    evidence,
    generatedAt: "2026-08-09T12:00:00.000Z"
  };
}

function fixtureCompany(companyId) {
  return {
    entityType: "company",
    entityId: companyId,
    founders: []
  };
}

function fixtureEvidence(id, companyId, rankable = true) {
  return {
    id,
    rankable,
    batchSlug: "S26",
    entityType: "company",
    entityId: companyId,
    attachedCompanyId: companyId,
    attachedCompanyName: companyId,
    platform: "x",
    authorName: companyId,
    authorHandle: companyId,
    postedAt: "2026-08-09T12:00:00.000Z",
    publishedAtPrecision: "exact",
    text: id,
    mediaType: "text",
    metrics: { likes: 1 },
    contributionScore: rankable ? 1 : 0,
    normalizedScore: rankable ? 1 : 0,
    tractionStatus: "scored",
    sourceUrl: `https://x.com/${companyId}/status/${id}`,
    platformPostId: id,
    why: "fixture",
    review_state: "verified",
    linkStatus: "verified"
  };
}
