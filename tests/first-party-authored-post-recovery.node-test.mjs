import assert from "node:assert/strict";
import test from "node:test";

import {
  authoredContentFingerprint,
  buildFirstPartyPromotionArtifact,
  buildFirstPartyReferenceIndex,
  buildOfficialDomainCatalog,
  classifyAuthoredPostUrl,
  evaluateFirstPartyAuthoredPost,
  extractFirstPartyRows,
  normalizeUrl,
  reconcileFirstPartyCandidates,
  stableJson,
} from "../scripts/lib/first-party-authored-post-recovery.mjs";

const graph = {
  batch: { slug: "S2026" },
  nodes: [
    {
      entityType: "company",
      entityId: "company-acme",
      batchSlug: "S2026",
      label: "Acme",
      websiteUrl: "https://www.acme.example/",
      founders: [{ id: "founder-acme-alice", name: "Alice Founder" }],
    },
  ],
};

test("accepts zero-engagement RSS items on an exact current official domain", () => {
  const catalog = buildOfficialDomainCatalog([graph]);
  const decision = evaluateFirstPartyAuthoredPost(rssRow(), {
    catalog,
    referenceIndex: emptyReferenceIndex(),
    sourcePath: "outputs/public-ingestion-review-ledger-current.json",
    sourceKind: "current_review_ledger",
  });

  assert.equal(decision.accepted, true);
  assert.equal(decision.owner.entityId, "company-acme");
  assert.equal(
    decision.candidate.sourceUrl,
    "https://acme.example/blog/launching-acme",
  );
  assert.deepEqual(decision.candidate.metrics, {});
  assert.equal(
    decision.candidate._recoveryProvenance.zeroEngagementAccepted,
    true,
  );
  assert.ok(
    decision.candidate.attributionSignals.includes(
      "verified_first_party_feed_item",
    ),
  );
});

test("rejects third-party domains, homepages, collections, generic pages, and assets", () => {
  const catalog = buildOfficialDomainCatalog([graph]);
  const cases = [
    [
      "https://news.example/blog/launching-acme",
      "outside_current_official_domain",
    ],
    ["https://acme.example/", "official_homepage_not_post"],
    ["https://acme.example/tags/launch", "collection_or_search_page_not_post"],
    ["https://acme.example/login", "generic_website_page_not_post"],
    [
      "https://acme.example/product/launch-agent",
      "generic_website_page_not_post",
    ],
    ["https://acme.example/changelog", "collection_or_search_page_not_post"],
    ["https://acme.example/assets/launch.pdf", "asset_url_not_post"],
    [
      "https://acme.example/blog/[redacted-public-token]",
      "redacted_article_url_not_stable",
    ],
  ];

  for (const [sourceUrl, reason] of cases) {
    const decision = evaluateFirstPartyAuthoredPost(
      { ...rssRow(), sourceUrl },
      {
        catalog,
        referenceIndex: emptyReferenceIndex(),
      },
    );
    assert.equal(decision.accepted, false, sourceUrl);
    assert.ok(
      decision.reasons.includes(reason),
      `${sourceUrl}: ${decision.reasons.join(", ")}`,
    );
  }
});

test("web rows require a post-like path while verified RSS items may use an opaque item slug", () => {
  const rss = classifyAuthoredPostUrl("https://acme.example/launching-acme", {
    platform: "rss",
    officialWebsiteUrl: "https://acme.example",
    title: "Launching Acme to the world",
  });
  assert.equal(rss.accepted, true);

  const web = classifyAuthoredPostUrl("https://acme.example/launching-acme", {
    platform: "web",
    officialWebsiteUrl: "https://acme.example",
    title: "Launching Acme to the world",
  });
  assert.equal(web.accepted, false);
  assert.ok(web.reasons.includes("generic_web_page_without_post_path"));

  const webArticle = classifyAuthoredPostUrl(
    "https://acme.example/news/launching-acme",
    {
      platform: "web",
      officialWebsiteUrl: "https://acme.example",
      title: "Launching Acme to the world",
    },
  );
  assert.equal(webArticle.accepted, true);
});

test("requires title, authored text, publication date, and a clean source attribution state", () => {
  const catalog = buildOfficialDomainCatalog([graph]);
  const cases = [
    [{ ...rssRow(), title: "" }, "authored_title_missing"],
    [
      { ...rssRow(), title: "Example Advisory Template" },
      "authored_title_missing",
    ],
    [{ ...rssRow(), text: "" }, "authored_text_missing"],
    [{ ...rssRow(), postedAt: null }, "publication_date_missing"],
    [{ ...rssRow(), linkStatus: "invalid" }, "source_link_marked_invalid"],
    [
      {
        ...rssRow(),
        matchReason: "Candidate belongs to a foreign third-party author.",
      },
      "source_has_hard_attribution_rejection",
    ],
  ];
  for (const [row, reason] of cases) {
    const decision = evaluateFirstPartyAuthoredPost(row, {
      catalog,
      referenceIndex: emptyReferenceIndex(),
    });
    assert.equal(decision.accepted, false);
    assert.ok(decision.reasons.includes(reason), decision.reasons.join(", "));
  }
});

test("founder attribution requires an exact current founder byline", () => {
  const catalog = buildOfficialDomainCatalog([graph]);
  const founderRow = {
    ...rssRow(),
    entityType: "founder",
    entityId: "founder-acme-alice",
    authorName: "Alice Founder",
  };
  assert.equal(
    evaluateFirstPartyAuthoredPost(founderRow, {
      catalog,
      referenceIndex: emptyReferenceIndex(),
    }).accepted,
    true,
  );

  const wrongByline = evaluateFirstPartyAuthoredPost(
    { ...founderRow, authorName: "Outside Writer" },
    { catalog, referenceIndex: emptyReferenceIndex() },
  );
  assert.equal(wrongByline.accepted, false);
  assert.ok(wrongByline.reasons.includes("founder_byline_not_proven"));
});

test("rejects URL and content duplicates already present in current evidence", () => {
  const catalog = buildOfficialDomainCatalog([graph]);
  const referenceIndex = buildFirstPartyReferenceIndex([
    { evidence: [rssRow()] },
  ]);
  const duplicateUrl = evaluateFirstPartyAuthoredPost(rssRow(), {
    catalog,
    referenceIndex,
  });
  assert.ok(duplicateUrl.reasons.includes("already_in_current_evidence"));
  assert.ok(
    duplicateUrl.reasons.includes("content_already_in_current_evidence"),
  );

  const duplicateContent = evaluateFirstPartyAuthoredPost(
    { ...rssRow(), sourceUrl: "https://acme.example/blog/acme-launch-details" },
    { catalog, referenceIndex },
  );
  assert.equal(
    duplicateContent.reasons.includes("already_in_current_evidence"),
    false,
  );
  assert.ok(
    duplicateContent.reasons.includes("content_already_in_current_evidence"),
  );
});

test("reconciliation deterministically removes candidate URL and content duplicates", () => {
  const catalog = buildOfficialDomainCatalog([graph]);
  const history = evaluateFirstPartyAuthoredPost(rssRow(), {
    catalog,
    referenceIndex: emptyReferenceIndex(),
    sourcePath: "public/graph/s2026.json",
    sourceKind: "repository_history",
  });
  const live = evaluateFirstPartyAuthoredPost(
    { ...rssRow(), id: "live", text: `${rssRow().text} Extra live detail.` },
    {
      catalog,
      referenceIndex: emptyReferenceIndex(),
      sourcePath: "work/live/s2026-rss.json",
      sourceKind: "anonymous_public_refresh",
    },
  );
  const contentDuplicate = evaluateFirstPartyAuthoredPost(
    { ...rssRow(), sourceUrl: "https://acme.example/blog/acme-launch-copy" },
    {
      catalog,
      referenceIndex: emptyReferenceIndex(),
      sourceKind: "current_artifact",
    },
  );

  const first = reconcileFirstPartyCandidates(
    [history, live, contentDuplicate],
    {
      referenceIndex: emptyReferenceIndex(),
    },
  );
  const second = reconcileFirstPartyCandidates(
    [contentDuplicate, live, history],
    {
      referenceIndex: emptyReferenceIndex(),
    },
  );
  assert.equal(first.evidence.length, 2);
  assert.equal(first.audit.duplicateCandidateUrls, 1);
  assert.equal(first.audit.zeroDuplicateAudit, true);
  assert.equal(stableJson(first.evidence), stableJson(second.evidence));
  assert.equal(
    first.evidence.find((row) => row.sourceUrl.includes("launching-acme"))
      ._recoveryProvenance.sourceKind,
    "anonymous_public_refresh",
  );
});

test("promotion artifact reports exact cohort, source, and zero-engagement counts", () => {
  const catalog = buildOfficialDomainCatalog([graph]);
  const decision = evaluateFirstPartyAuthoredPost(rssRow(), {
    catalog,
    referenceIndex: emptyReferenceIndex(),
    sourcePath: "work/live/s2026-rss.json",
    sourceKind: "anonymous_public_refresh",
  });
  const reconciliation = reconcileFirstPartyCandidates([decision], {
    referenceIndex: emptyReferenceIndex(),
  });
  const artifact = buildFirstPartyPromotionArtifact({
    baselineCommit: "a".repeat(40),
    generatedAt: "2026-08-09T00:00:00.000Z",
    sources: ["work/live/s2026-rss.json"],
    reconciliation,
    scanAudit: { scannedRows: 1 },
  });

  assert.deepEqual(artifact.counts, {
    total: 1,
    zeroEngagement: 1,
    byCohort: { S2026: 1 },
    byPlatform: { rss: 1 },
    byCohortSource: { "S2026:anonymous_public_refresh": 1 },
  });
  assert.equal(artifact.audit.zeroDuplicateAudit, true);
  assert.equal(artifact.constraints.linkedinAccess, false);
  assert.equal(artifact.constraints.canonicalArtifactsModified, false);
});

test("recursive extraction finds RSS/web rows without interpreting raw JSON strings", () => {
  const rows = extractFirstPartyRows({
    evidence: [rssRow()],
    needsReview: [
      {
        ...rssRow(),
        platform: "web",
        sourceUrl: "https://acme.example/news/update",
      },
    ],
    rawVisibleText: JSON.stringify({
      platform: "rss",
      sourceUrl: "https://acme.example/fake",
    }),
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(
    new Set(rows.map((row) => row.platform)),
    new Set(["rss", "web"]),
  );
});

test("URL and content identities normalize tracking, host aliases, and prose", () => {
  assert.equal(
    normalizeUrl(
      "http://www.Acme.Example/blog/launching-acme/?utm_source=test#top",
    ),
    "https://acme.example/blog/launching-acme",
  );
  assert.equal(
    authoredContentFingerprint(rssRow()),
    authoredContentFingerprint({
      ...rssRow(),
      title: "  Launching ACME to the world ",
      text: "We built Acme for serious teams.  Read more at https://acme.example.",
    }),
  );
});

function rssRow() {
  return {
    id: "rss-company-acme-launch",
    batchSlug: "S2026",
    entityType: "company",
    entityId: "company-acme",
    companySlug: "acme",
    companyName: "Acme",
    platform: "rss",
    title: "Launching Acme to the world",
    sourceUrl: "https://www.acme.example/blog/launching-acme/",
    text: "We built Acme for serious teams. Read more at https://acme.example.",
    postedAt: "2026-07-20T12:00:00Z",
    metrics: {},
    matchReason: "Public RSS/Atom item from the company website.",
    review_state: "needs_review",
  };
}

function emptyReferenceIndex() {
  return { rows: 0, urlKeys: new Set(), contentKeys: new Set() };
}
