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
  assert.equal(scope.crossAudiencePreviewProjectionCount, 0);
  assert.deepEqual(scope.crossAudiencePreviewProjectionKeys, []);
  assert.equal(scope.representedRankableDigest, scope.fullRankableDigest);
});

test("the sidecar rejects an attached company ID absent from the graph", () => {
  const phantom = {
    ...fixtureEvidence("phantom", "company-1"),
    attachedCompanyId: "company-phantom",
    attachedCompanyName: "Phantom"
  };

  assert.throws(() => buildRankedPostsSidecarScope({
    fullGraph: fixtureGraph([phantom]),
    previewGraph: fixtureGraph([phantom]),
    rankableEvidence: (items) => items.filter((item) => item.rankable),
    canonicalPostKey: fixturePostKey,
    canonicalEvidenceUrl: fixtureCanonicalUrl
  }), /rankable posts without company attribution: phantom/);
});

test("the sidecar preserves known canonical projections in an audience preview", () => {
  const audienceOnly = fixtureEvidence("audience-only", "company-1");
  const canonicalProjection = fixtureEvidence("canonical-projection", "company-1");
  const fullGraph = fixtureGraph([audienceOnly], "yc_partners");
  const previewGraph = fixtureGraph([audienceOnly, canonicalProjection], "yc_partners");
  const scope = buildRankedPostsSidecarScope({
    fullGraph,
    previewGraph,
    rankableEvidence: (items) => items.filter((item) => item.rankable),
    canonicalPostKey: fixturePostKey,
    canonicalEvidenceUrl: fixtureCanonicalUrl,
    canonicalPreviewOnlyByKey: new Map([
      [fixturePostKey(canonicalProjection), canonicalProjection]
    ])
  });

  assert.equal(scope.fullRankableCount, 1);
  assert.equal(scope.previewRankableCount, 2);
  assert.equal(scope.crossAudiencePreviewProjectionCount, 1);
  assert.deepEqual(scope.crossAudiencePreviewProjectionKeys, [
    "x:post:canonical-projection"
  ]);
  assert.deepEqual(scope.previewRankableByCompany, { "company-1": 2 });
  assert.deepEqual(scope.fullRankableByCompany, { "company-1": 1 });
});

test("the sidecar rejects a canonical physical key projected onto a different owner", () => {
  const audienceOnly = fixtureEvidence("audience-only", "company-1");
  const canonicalProjection = fixtureEvidence("canonical-projection", "company-1");
  const ownerMismatch = {
    ...canonicalProjection,
    id: "owner-mismatch",
    entityId: "company-2",
    attachedCompanyId: "company-2",
    attachedCompanyName: "company-2",
    authorName: "company-2",
    authorHandle: "company-2",
    sourceUrl: "https://x.com/company-2/status/canonical-projection"
  };

  assert.throws(() => buildRankedPostsSidecarScope({
    fullGraph: fixtureGraph([audienceOnly], "yc_partners"),
    previewGraph: fixtureGraph([audienceOnly, ownerMismatch], "yc_partners"),
    rankableEvidence: (items) => items.filter((item) => item.rankable),
    canonicalPostKey: fixturePostKey,
    canonicalEvidenceUrl: fixtureCanonicalUrl,
    canonicalPreviewOnlyByKey: new Map([
      [fixturePostKey(canonicalProjection), canonicalProjection]
    ])
  }), /canonical projection identity mismatches: x:post:canonical-projection .*canonical URL, native owner, entity identity, attached company identity/);
});

test("the sidecar fails closed on a preview-only physical post outside the canonical corpus", () => {
  const visible = fixtureEvidence("visible", "company-1");
  const previewOnly = fixtureEvidence("preview-only", "company-1");

  assert.throws(() => buildRankedPostsSidecarScope({
    fullGraph: fixtureGraph([visible], "yc_partners"),
    previewGraph: fixtureGraph([visible, previewOnly], "yc_partners"),
    rankableEvidence: (items) => items.filter((item) => item.rankable),
    canonicalPostKey: fixturePostKey,
    canonicalEvidenceUrl: fixtureCanonicalUrl,
    canonicalPreviewOnlyByKey: new Map()
  }), /preview contains 1 rankable physical posts absent from both its full scope and the canonical cohort corpus/);
});

test("the generated sidecar has exact parity with every full cohort/audience graph", {
  // Ubuntu CI can take just over three minutes for the serial, exact-parity build.
  timeout: 300_000
}, async () => {
  const rootDir = process.cwd();
  const expected = await buildRankedPostsSidecarSnapshot({ rootDir });
  const generated = JSON.parse(await readFile(
    path.join(rootDir, "src", "lib", "graph", "ranked-posts-sidecar.generated.json"),
    "utf8"
  ));

  assert.deepEqual(generated, expected);
  assert.ok(expected.canonicalParity.fullRankableCount > 0);
  assert.equal(
    expected.canonicalParity.representedRankableCount,
    expected.canonicalParity.fullRankableCount
  );
  assert.equal(
    expected.canonicalParity.previewRankableCount +
      expected.canonicalParity.overflowRankableCount,
    expected.canonicalParity.fullRankableCount
  );
  assert.equal(
    expected.canonicalParity.crossAudiencePreviewProjectionCount,
    expected.canonicalParity.crossAudiencePreviewProjectionKeys.length
  );
  assert.equal(
    new Set(expected.canonicalParity.crossAudiencePreviewProjectionKeys).size,
    expected.canonicalParity.crossAudiencePreviewProjectionKeys.length
  );
  assert.match(expected.canonicalParity.fullRankableDigest, /^[a-f0-9]{64}$/);
  assert.match(expected.canonicalParity.previewRankableDigest, /^[a-f0-9]{64}$/);
  assert.match(expected.canonicalParity.representedRankableDigest, /^[a-f0-9]{64}$/);
  assert.equal(
    expected.canonicalParity.representedRankableDigest,
    expected.canonicalParity.fullRankableDigest
  );
  if (expected.canonicalParity.overflowRankableCount > 0) {
    assert.notEqual(
      expected.canonicalParity.previewRankableDigest,
      expected.canonicalParity.fullRankableDigest
    );
  }
  const scopes = Object.values(expected.batches).flatMap((batch) => Object.values(batch));
  assert.equal(scopes.length, 9);
  for (const scope of scopes) {
    assert.equal(scope.representedRankableDigest, scope.fullRankableDigest);
    assert.equal(scope.overflowRankableCount, scope.evidence.length);
  }
  for (const batch of Object.values(expected.batches)) {
    assert.ok(batch.off.sourceEvidenceCount >= batch.off.previewEvidenceCount);
    assert.ok(batch.off.previewEvidenceCount <= 5_000);
  }

  const { selectRankedPosts } = await import("../src/lib/graph/ranked-posts.ts");
  for (const file of ["s2026", "s26", "a16zsr006"]) {
    const graph = JSON.parse(await readFile(
      path.join(rootDir, "public", "graph", `${file}.json`),
      "utf8"
    ));
    const ranked = selectRankedPosts(graph, { period: "all_time" });
    assert.equal(ranked.length, 100, `${file} should display exactly 100 ranked posts`);
    assert.equal(
      new Set(ranked.map((item) => item.canonicalPostKey)).size,
      100,
      `${file} should display 100 unique physical posts`
    );
  }
});

function fixtureGraph(evidence, audienceId = "off") {
  return {
    batch: { slug: "S26" },
    selectedTopVoiceAudience: { id: audienceId },
    nodes: [fixtureCompany("company-1"), fixtureCompany("company-2")],
    evidence,
    generatedAt: "2026-08-09T12:00:00.000Z"
  };
}

function fixturePostKey(item) {
  return `x:post:${item.platformPostId}`;
}

function fixtureCanonicalUrl(rawUrl) {
  const url = new URL(rawUrl);
  url.hostname = url.hostname.toLowerCase();
  url.pathname = url.pathname.toLowerCase();
  return url.toString();
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
