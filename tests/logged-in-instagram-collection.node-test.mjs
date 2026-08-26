import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { JSDOM } from "jsdom";
import {
  appendInstagramAttemptEvidence,
  canonicalInstagramPostUrl,
  compactLoggedInStoredRows,
  instagramAdapterProfileIdentityDecision,
  instagramBrowserProfileIdentityDecision,
  instagramCircuitDecision,
  instagramCollectionAttemptState,
  instagramDetailObservationMatchesMeta,
  instagramDetailUrlsNeedingEnrichment,
  instagramDeepScrollPaginationDecision,
  normalizeInstagramDeepScrollPagination,
  instagramEvidenceProvenance,
  instagramFailureKind,
  instagramGridOnlyOwnershipDecision,
  instagramMetaDescriptionFields,
  instagramPostIdFromUrl,
  instagramPublicationDate,
  instagramRecencyDecision,
  instagramShouldRetryTransientBrowserFailure,
  instagramTargetIsVerifiedForIngestion,
  LOGGED_IN_STORED_RAW_TEXT_LIMIT,
  mergeInstagramGridPassObservations,
  mergeVerifiedSocialAccountCandidates,
  normalizeInstagramDetailObservation,
  prioritizeInstagramTargets
} from "../scripts/lib/logged-in-instagram-collection.mjs";

const loggedInCollectorSource = readFileSync(
  new URL("../scripts/fetch-logged-in-social-traction.mjs", import.meta.url),
  "utf8"
);
const instagramCollectionSource = readFileSync(
  new URL("../scripts/lib/logged-in-instagram-collection.mjs", import.meta.url),
  "utf8"
);

function instagramGridExtractorScript() {
  const start = loggedInCollectorSource.indexOf(
    "function instagramGridExtractJs()"
  );
  const end = loggedInCollectorSource.indexOf(
    "function instagramProfileScrollJs(",
    start
  );
  assert.ok(start >= 0 && end > start, "Instagram grid extractor must exist");
  const functionSource = loggedInCollectorSource.slice(start, end).trim();
  const template = functionSource.match(/return `([\s\S]*)`;\n}$/);
  assert.ok(template, "Instagram grid extractor must return one template literal");
  assert.doesNotMatch(template[1], /\$\{/);
  return Function(`return \`${template[1]}\`;`)();
}

function executeInstagramGridExtractor(dom) {
  return dom.window.eval(instagramGridExtractorScript());
}

describe("logged-in Instagram collection", () => {
  it("passes a numeric collection clock into every strict publication-date check", () => {
    assert.match(loggedInCollectorSource, /const collectionNowMs = Date\.now\(\)/);
    assert.equal(
      [...loggedInCollectorSource.matchAll(/instagramPublicationDate\([^\n]+collectionNowMs\)/g)].length,
      6
    );
    assert.doesNotMatch(loggedInCollectorSource, /instagramPublicationDate\([^\n]+, now\)/);
  });

  it("serializes each account's adapter and browser reads while retaining the worker pool", () => {
    const start = loggedInCollectorSource.indexOf(
      "async function fetchInstagramPosts(target, workerIndex)"
    );
    const end = loggedInCollectorSource.indexOf(
      "  const profile = parseJsonOutput(profileRaw)",
      start
    );
    const targetReader = loggedInCollectorSource.slice(start, end);
    assert.doesNotMatch(targetReader, /Promise\.all\(/);
    assert.match(targetReader, /runInstagramAdapterWithRetry/);
    assert.match(targetReader, /fetchInstagramGridUrls\(handle, workerIndex\)/);
    assert.doesNotMatch(targetReader, /paginationSeed|nextScrollPass/);
    assert.match(loggedInCollectorSource, /const runners = Array\.from\(\{ length: concurrency \}/);
  });

  it("treats force as rerun selection and never deletes durable Instagram history", () => {
    assert.doesNotMatch(loggedInCollectorSource, /removeTargetEvidence/);
    assert.doesNotMatch(
      loggedInCollectorSource,
      /if \(force\)[\s\S]{0,120}(?:splice|remove|delete).*evidence/i
    );
    assert.match(
      loggedInCollectorSource,
      /appendInstagramAttemptEvidence\(evidence, result\.evidence\)/
    );
    assert.match(
      loggedInCollectorSource,
      /item\.batchSlug === target\.batchSlug[\s\S]{0,160}item\.entityId === target\.entityId/
    );

    const oldSameBatch = {
      id: "old-s26",
      batchSlug: "S26",
      platform: "instagram",
      entityId: "company-acme",
      sourceUrl: "https://www.instagram.com/p/OLD_S26/"
    };
    const oldOtherBatch = {
      id: "old-s2026",
      batchSlug: "S2026",
      platform: "instagram",
      entityId: "company-acme",
      sourceUrl: "https://www.instagram.com/p/OLD_S2026/"
    };
    const rows = [oldSameBatch, oldOtherBatch];

    // A failed forced collection has no replacement rows and must retain both
    // the target's prior evidence and identically named entities in other batches.
    assert.equal(appendInstagramAttemptEvidence(rows, []), rows);
    assert.deepEqual(rows, [oldSameBatch, oldOtherBatch]);

    const refreshed = {
      id: "new-s26",
      batchSlug: "S26",
      platform: "instagram",
      entityId: "company-acme",
      sourceUrl: "https://www.instagram.com/p/NEW_S26/"
    };
    assert.equal(appendInstagramAttemptEvidence(rows, [refreshed]), rows);
    assert.deepEqual(
      rows.map((row) => row.id),
      ["old-s26", "old-s2026", "new-s26"]
    );
  });

  it("keeps the complete bounded grid union and fails closed on scroll/eval errors", () => {
    const start = loggedInCollectorSource.indexOf(
      "async function fetchInstagramGridUrls("
    );
    const end = loggedInCollectorSource.indexOf(
      "async function fetchInstagramPostDetails(",
      start
    );
    const gridReader = loggedInCollectorSource.slice(start, end);
    assert.match(gridReader, /mergeInstagramGridPassObservations/);
    assert.match(gridReader, /items: \[\.\.\.byUrl\.values\(\)\]/);
    assert.doesNotMatch(gridReader, /\.slice\(-Math\.max\(1, desiredCount\)\)/);
    assert.doesNotMatch(
      gridReader,
      /nextScrollPass|candidateExhausted|stablePasses/
    );
    assert.doesNotMatch(gridReader, /\.catch\(/);
    assert.match(gridReader, /untrusted_geometry_stall/);
    assert.match(gridReader, /coverageStatus: "non_exhaustive"/);
    assert.doesNotMatch(
      loggedInCollectorSource,
      /failure\([\s\S]{0,120}Instagram authenticated history remains non-exhaustive/
    );
    assert.match(loggedInCollectorSource, /document\.createTreeWalker/);
    assert.doesNotMatch(
      loggedInCollectorSource,
      /Array\.from\(main\.querySelectorAll\(["']a\[href\]["']\)\)/
    );
    assert.match(loggedInCollectorSource, /profile_grid_anchor_limit_exceeded/);
    assert.match(loggedInCollectorSource, /item\?\.gridOverflow === true/);
    assert.match(loggedInCollectorSource, /profileGridProven: true/);
    assert.match(loggedInCollectorSource, /profileHandle,/);
    assert.match(loggedInCollectorSource, /\[role=\\?"dialog\\?"\]/);
    assert.match(loggedInCollectorSource, /suggested\|recommended\|people you may know/i);
    assert.match(loggedInCollectorSource, /duplicateIdentity: true/);
    assert.doesNotMatch(loggedInCollectorSource, /\.slice\(-240\)/);
  });

  it("excludes a nested suggested section and its sibling grid in the same tab panel", () => {
    const dom = new JSDOM(`<!doctype html><main>
      <div id="profile-panel" role="tabpanel"><div style="display:grid">
        <a href="/p/PROFILE_ONE/"><img src="https://cdn.test/one.jpg" alt="one"></a>
        <a href="/reel/PROFILE_TWO/"><img src="https://cdn.test/two.jpg" alt="two"></a>
      </div></div>
      <div id="suggested-panel" role="tabpanel">
        <section id="suggested-heading-section">
          <div>
            <header><div><h2>Suggested for you</h2></div></header>
            <a href="/p/FOREIGN_SUGGESTED_ONE/"><img src="https://cdn.test/s1.jpg"></a>
          </div>
        </section>
        <div id="suggested-sibling-grid" style="display:grid">
          <a href="/p/FOREIGN_SUGGESTED_TWO/"><img src="https://cdn.test/s2.jpg"></a>
          <a href="/p/FOREIGN_SUGGESTED_THREE/"><img src="https://cdn.test/s3.jpg"></a>
        </div>
      </div>
      <aside><div style="display:grid"><a href="/p/FOREIGN_ASIDE/"></a></div></aside>
      <div role="dialog"><div style="display:grid"><a href="/p/FOREIGN_DIALOG/"></a></div></div>
      <article><div style="display:grid"><a href="/p/FOREIGN_ARTICLE/"></a></div></article>
    </main>`, {
      url: "https://www.instagram.com/exact.owner/",
      runScripts: "outside-only"
    });

    try {
      const rows = executeInstagramGridExtractor(dom);
      assert.deepEqual(
        Array.from(
          rows.filter((row) => row.profileGridProven === true),
          (row) => row.platformPostId
        ),
        ["PROFILE_ONE", "PROFILE_TWO"]
      );
      assert.equal(
        rows.some((row) => /FOREIGN_/.test(row.platformPostId ?? "")),
        false
      );
    } finally {
      dom.window.close();
    }
  });

  it("stops DOM anchor extraction at limit plus one and emits an overflow sentinel", () => {
    const anchors = Array.from(
      { length: 10_025 },
      (_, index) => `<a href="/p/OVERFLOW_${index}/"></a>`
    ).join("");
    const dom = new JSDOM(`<!doctype html><main><div style="display:grid">${anchors}</div></main>`, {
      url: "https://www.instagram.com/exact.owner/",
      runScripts: "outside-only"
    });
    const originalCreateTreeWalker = dom.window.document.createTreeWalker.bind(
      dom.window.document
    );
    let nextNodeCalls = 0;
    dom.window.document.createTreeWalker = (...args) => {
      const walker = originalCreateTreeWalker(...args);
      if (args[0]?.tagName !== "MAIN") return walker;
      return new Proxy(walker, {
        get(target, field) {
          if (field === "nextNode") {
            return () => {
              nextNodeCalls += 1;
              return target.nextNode();
            };
          }
          const value = Reflect.get(target, field, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
    };

    try {
      const rows = executeInstagramGridExtractor(dom);
      assert.deepEqual(JSON.parse(JSON.stringify(rows)), [{
        gridOverflow: true,
        reason: "profile_grid_anchor_limit_exceeded",
        anchorLimit: 10_000,
        scannedAnchorCount: 10_001
      }]);
      assert.equal(nextNodeCalls, 10_001);
    } finally {
      dom.window.close();
    }
  });

  it("retains 40k stored rows while deterministically bounding raw diagnostics", () => {
    assert.match(loggedInCollectorSource, /payload: compactStoredPayload\(/);
    assert.match(loggedInCollectorSource, /const currentOutput = compactStoredPayload\(/);
    assert.match(loggedInCollectorSource, /const snapshot = compactStoredPayload\(\{/);
    assert.match(
      loggedInCollectorSource,
      /rawVisibleText: rawVisibleText\.slice\(0, LOGGED_IN_STORED_RAW_TEXT_LIMIT\)/
    );
    assert.match(loggedInCollectorSource, /JSON\.stringify\(value, \(_field, nested\) =>/);
    const oversizedDiagnostic = "diagnostic ".repeat(2_000);
    const rows = Array.from({ length: 40_000 }, (_, index) => ({
      id: `post-${index}`,
      platformPostId: `NATIVE_${index}`,
      sourceUrl: `https://www.instagram.com/p/NATIVE_${index}/`,
      postedAt: "2026-08-01T00:00:00.000Z",
      text: `topic scoring text ${index}`,
      metrics: { likes: index + 1, comments: index % 10 },
      rawVisibleText: oversizedDiagnostic
    }));

    assert.equal(compactLoggedInStoredRows(rows), rows);
    assert.equal(rows.length, 40_000);
    assert.equal(rows[0].rawVisibleText.length, LOGGED_IN_STORED_RAW_TEXT_LIMIT);
    assert.equal(rows.at(-1).platformPostId, "NATIVE_39999");
    assert.deepEqual(rows.at(-1).metrics, { likes: 40_000, comments: 9 });
    assert.equal(rows.at(-1).text, "topic scoring text 39999");

    const serialized = JSON.stringify({ evidence: rows });
    assert.ok(Buffer.byteLength(serialized) < 65_000_000);
    let serializedRowCount = 0;
    let searchFrom = 0;
    while (true) {
      const foundAt = serialized.indexOf('{"id":"post-', searchFrom);
      if (foundAt < 0) break;
      serializedRowCount += 1;
      searchFrom = foundAt + 12;
    }
    assert.equal(serializedRowCount, 40_000);
  });

  it("exposes the historical replay terminal-platform flag without changing its default", () => {
    assert.match(
      loggedInCollectorSource,
      /platformSetArg\(\s*"--terminal-completed-platforms"\s*\)/
    );
    assert.match(
      loggedInCollectorSource,
      /--terminal-completed-platforms=linkedin\s+Keep successful done attempts terminal/
    );
  });

  it("signals a LinkedIn child safety stop only after payload and checkpoint persistence", () => {
    assert.match(
      loggedInCollectorSource,
      /const childSafetyStop = linkedinChildSafetyStopDecision\(failureKind\)/
    );
    assert.doesNotMatch(
      loggedInCollectorSource,
      /\["account_safety", "auth", "rate_limited", "transport"\]/
    );
    const payloadWrite = loggedInCollectorSource.indexOf(
      "await writeJson(outputPath, payload);"
    );
    const checkpointWrite = loggedInCollectorSource.indexOf(
      "await writeCheckpoint();",
      payloadWrite
    );
    const childSignal = loggedInCollectorSource.indexOf(
      "if (linkedinChildSafetyStop)",
      checkpointWrite
    );
    assert.ok(payloadWrite >= 0);
    assert.ok(checkpointWrite > payloadWrite);
    assert.ok(childSignal > checkpointWrite);
    assert.match(loggedInCollectorSource, /LINKEDIN_CHILD_SAFETY_STOP_EXIT_CODE/);
    assert.match(
      loggedInCollectorSource,
      /process\.exitCode = LINKEDIN_CHILD_SAFETY_STOP_EXIT_CODE/
    );
    assert.doesNotMatch(
      loggedInCollectorSource.slice(childSignal, childSignal + 1_200),
      /process\.exit\(/
    );
  });

  it("extracts native post, reel, and TV shortcodes only", () => {
    assert.equal(
      instagramPostIdFromUrl("https://www.instagram.com/p/ABC_123/?utm_source=test"),
      "ABC_123"
    );
    assert.equal(
      instagramPostIdFromUrl("https://instagram.com/reel/XYZ-9/"),
      "XYZ-9"
    );
    assert.equal(
      canonicalInstagramPostUrl("https://instagram.com/reels/XYZ-9/"),
      "https://www.instagram.com/reel/XYZ-9/"
    );
    assert.equal(
      instagramPostIdFromUrl("https://instagram.com/tv/TV42/"),
      "TV42"
    );
    assert.equal(
      instagramPostIdFromUrl("https://instagram.com/example/"),
      null
    );
    assert.equal(
      canonicalInstagramPostUrl("https://instagram.com.evil.example/p/ABC_123/"),
      null
    );
    assert.equal(
      canonicalInstagramPostUrl("https://instagram.com/example/p/ABC_123/"),
      null
    );
  });

  it("joins adapter, grid, and detail provenance by exact shortcode without positional fallback", () => {
    const post = {
      url: "https://www.instagram.com/reel/RIGHT_1/",
      caption: "adapter caption",
      likes: 12
    };
    const wrongGridItem = {
      href: "https://www.instagram.com/reel/WRONG_1/",
      caption: "wrong caption",
      likes: 999_999
    };
    const rightGridItem = {
      href: "https://www.instagram.com/reel/RIGHT_1/",
      caption: "right caption",
      likes: 13
    };
    const wrongDetail = {
      url: "https://www.instagram.com/reel/WRONG_1/",
      caption: "wrong detail",
      likes: 888_888
    };
    const rightDetail = {
      url: "https://www.instagram.com/reel/RIGHT_1/",
      caption: "right detail",
      likes: 14
    };

    assert.deepEqual(
      instagramEvidenceProvenance({
        post,
        gridItems: [wrongGridItem, rightGridItem],
        detailItems: [wrongDetail, rightDetail]
      }),
      {
        sourceUrl: "https://www.instagram.com/reel/RIGHT_1/",
        platformPostId: "RIGHT_1",
        gridItem: rightGridItem,
        detail: rightDetail
      }
    );
    assert.equal(
      instagramEvidenceProvenance({
        post: { caption: "no native identity", likes: 100 },
        gridItems: [wrongGridItem]
      }),
      null
    );
  });

  it("admits grid-only posts only with exact profile-grid and native detail-author proof", () => {
    const gridItem = {
      href: "https://www.instagram.com/p/GRID_ONLY_1/",
      profileGridProven: true,
      profileHandle: "acme"
    };
    assert.deepEqual(
      instagramGridOnlyOwnershipDecision({
        requestedHandle: "acme",
        gridItem,
        detail: {
          authorHandle: "acme",
          authorUrl: "https://www.instagram.com/acme/",
          authorProof: "native_post_header_profile_link"
        }
      }),
      { ok: true, reason: "exact_profile_grid_and_native_detail_author" }
    );
    assert.deepEqual(
      instagramGridOnlyOwnershipDecision({
        requestedHandle: "acme",
        gridItem,
        detail: {
          authorHandle: "other",
          authorUrl: "https://www.instagram.com/other/",
          authorProof: "native_post_header_profile_link"
        }
      }),
      { ok: false, reason: "detail_author_identity_mismatch" }
    );
    assert.deepEqual(
      instagramGridOnlyOwnershipDecision({
        requestedHandle: "acme",
        gridItem,
        detail: {}
      }),
      { ok: false, reason: "detail_author_identity_missing" }
    );
    assert.deepEqual(
      instagramGridOnlyOwnershipDecision({
        requestedHandle: "acme",
        gridItem: { ...gridItem, profileGridProven: false },
        detail: {
          authorHandle: "acme",
          authorUrl: "https://www.instagram.com/acme/",
          authorProof: "native_post_header_profile_link"
        }
      }),
      { ok: false, reason: "exact_profile_grid_not_proven" }
    );
    assert.match(
      loggedInCollectorSource,
      /const ownership = instagramGridOnlyOwnershipDecision\(\{[\s\S]{0,180}requestedHandle: handle/
    );
    assert.match(
      loggedInCollectorSource,
      /Instagram grid-only native post quarantined/
    );
    assert.match(loggedInCollectorSource, /authorHandle: nativeAuthor\?\.handle/);
    assert.match(loggedInCollectorSource, /authorUrl: nativeAuthor\?\.url/);
    assert.match(
      loggedInCollectorSource,
      /native_post_header_profile_link/
    );
  });

  it("does not open detail pages for 100 sufficiently represented adapter posts", () => {
    assert.match(
      loggedInCollectorSource,
      /const detailItems = detailUrls\.length\s*\n\s*\? await fetchInstagramPostDetails\(handle, detailUrls/
    );
    assert.match(
      loggedInCollectorSource,
      /async function fetchInstagramPostDetails\(handle, detailUrls, workerIndex\)\s*\{\s*\n\s*if \(!Array\.isArray\(detailUrls\).*?return \[\];/s
    );
    const adapterPosts = Array.from({ length: 100 }, (_, index) => ({
      url: `https://www.instagram.com/p/ADAPTER_${index}/`,
      postedAt: "2026-07-01T00:00:00.000Z",
      likes: index === 99 ? "1.2K" : 10
    }));
    const gridItems = adapterPosts.map((post) => ({
      href: post.url,
      likes: post.likes
    }));

    assert.deepEqual(
      instagramDetailUrlsNeedingEnrichment({
        adapterPosts,
        gridItems,
        now: Date.parse("2026-08-12T00:00:00.000Z"),
        limit: 100
      }),
      []
    );
  });

  it("returns no detail URLs when enrichment is explicitly bounded to zero", () => {
    assert.deepEqual(
      instagramDetailUrlsNeedingEnrichment({
        adapterPosts: [{
          url: "https://www.instagram.com/p/ADAPTER_1/",
          date: "8/1/2026",
          likes: 12
        }],
        gridItems: [{
          href: "https://www.instagram.com/p/GRID_1/"
        }],
        limit: 0
      }),
      []
    );
  });

  it("does not re-detail post IDs already admitted to the account checkpoint", () => {
    assert.deepEqual(
      instagramDetailUrlsNeedingEnrichment({
        gridItems: [
          { href: "https://www.instagram.com/p/KNOWN_1/" },
          { href: "https://www.instagram.com/p/NEW_1/" }
        ],
        existingPostIds: new Set(["KNOWN_1"]),
        limit: 10
      }),
      ["https://www.instagram.com/p/NEW_1/"]
    );
  });

  it("rotates bounded detail work without changing positive-limit semantics", () => {
    const gridItems = ["ONE", "TWO", "THREE", "FOUR"].map((postId) => ({
      href: `https://www.instagram.com/p/${postId}/`
    }));
    assert.deepEqual(
      instagramDetailUrlsNeedingEnrichment({
        gridItems,
        offset: 2,
        limit: 3
      }),
      [
        "https://www.instagram.com/p/THREE/",
        "https://www.instagram.com/p/FOUR/",
        "https://www.instagram.com/p/ONE/"
      ]
    );
    assert.deepEqual(
      instagramDetailUrlsNeedingEnrichment({ gridItems, limit: 2 }),
      [
        "https://www.instagram.com/p/ONE/",
        "https://www.instagram.com/p/TWO/"
      ]
    );
  });

  it("merges every canonical item from every bounded grid pass", () => {
    const observedByUrl = new Map();
    let merged = mergeInstagramGridPassObservations({
      observedByUrl,
      items: [
        { href: "https://www.instagram.com/p/PASS_A/", likes: 1 },
        { href: "https://www.instagram.com/p/PASS_B/", likes: 2 }
      ]
    });
    merged = mergeInstagramGridPassObservations({
      observedByUrl,
      items: [
        { href: "https://www.instagram.com/p/PASS_B/", comments: 3 },
        { href: "https://www.instagram.com/reel/PASS_C/", views: 4 },
        null,
        { unrelated: true },
        {
          duplicateIdentity: true,
          href: "https://www.instagram.com/p/PASS_C/"
        },
        { rawText: "non-native unrelated observation" },
        { malformedIdentity: true, rawHref: "/p/" }
      ],
      malformedItemCount: merged.malformedItemCount
    });

    assert.deepEqual(
      merged.items.map((item) => item.platformPostId),
      ["PASS_A", "PASS_B", "PASS_C"]
    );
    assert.equal(merged.items[1].likes, 2);
    assert.equal(merged.items[1].comments, 3);
    assert.equal(merged.malformedItemCount, 1);
  });

  it("migrates legacy scroll state into bounded metadata without trusting exhaustion", () => {
    const legacyIds = Array.from({ length: 20_050 }, (_, index) => `POST_${index}`);
    const state = normalizeInstagramDeepScrollPagination({
      version: 1,
      mode: "deterministic-browser-deep-scroll-v1",
      handle: "acme",
      observedPostIds: legacyIds,
      nextScrollPass: 99_999,
      stablePasses: 3,
      exhausted: true
    }, { handle: "acme" });

    assert.equal(state.version, 2);
    assert.equal(state.mode, "bounded-authenticated-window-v2");
    assert.equal(state.observedPostIds.length, 512);
    assert.equal(state.observedPostIds.at(-1), "POST_20049");
    assert.equal(state.exhausted, false);
    assert.equal(state.status, "non_exhaustive");
    assert.equal("nextScrollPass" in state, false);
  });

  it("compares bounded-window newness with durable evidence and exposes malformed identity", () => {
    const state = normalizeInstagramDeepScrollPagination({
      version: 2,
      mode: "bounded-authenticated-window-v2",
      handle: "acme",
      observedPostIds: ["RECENT_1"],
      detailWindowOffset: 2
    }, { handle: "acme" });
    const decision = instagramDeepScrollPaginationDecision({
      identityOk: true,
      candidateItems: [
        { href: "https://www.instagram.com/p/RECENT_1/" },
        { href: "https://www.instagram.com/p/EVIDENCE_1/" },
        { href: "https://www.instagram.com/p/NEW_1/" }
      ],
      persistedObservedPostIds: new Set(["EVIDENCE_1"]),
      priorState: state,
      nextDetailWindowOffset: 3
    });
    assert.deepEqual(decision.newPostIds, ["NEW_1"]);
    assert.deepEqual(
      decision.previouslyObservedPostIds,
      ["RECENT_1", "EVIDENCE_1"]
    );
    assert.equal(decision.status, "non_exhaustive");
    assert.equal(decision.exhausted, false);
    assert.equal(decision.detailWindowOffset, 3);

    const malformed = instagramDeepScrollPaginationDecision({
      identityOk: true,
      candidateItems: [{ href: "https://www.instagram.com/p/VALID_1/" }],
      priorState: state,
      malformedItemCount: 1
    });
    assert.equal(malformed.status, "blocked");
    assert.equal(malformed.reason, "malformed_native_post_identity");
    assert.equal(malformed.malformedItemCount, 1);
    assert.equal(malformed.exhausted, false);
  });

  it("details missing-date and grid-only posts while preserving the complete shortcode union", () => {
    const adapterPosts = [
      {
        url: "https://www.instagram.com/p/COMPLETE/",
        postedAt: "2026-07-01T00:00:00.000Z",
        likes: 20,
        caption: "complete"
      },
      { url: "https://www.instagram.com/p/MISSING_DATE/", likes: 20 }
    ];
    const gridItems = [
      { href: "https://www.instagram.com/p/COMPLETE/", likes: 20 },
      { href: "https://www.instagram.com/p/MISSING_DATE/", likes: 20 },
      { href: "https://www.instagram.com/reel/GRID_ONLY/", likes: 7 },
      { href: "https://www.instagram.com/p/GRID_ONLY/", likes: 8 }
    ];

    assert.deepEqual(
      instagramDetailUrlsNeedingEnrichment({
        adapterPosts,
        gridItems,
        now: Date.parse("2026-08-12T00:00:00.000Z"),
        limit: 30
      }),
      [
        "https://www.instagram.com/p/MISSING_DATE/",
        "https://www.instagram.com/reel/GRID_ONLY/"
      ]
    );

    const adapterIds = new Set(adapterPosts.map((post) => instagramPostIdFromUrl(post.url)));
    const gridIds = new Set(gridItems.map((item) => instagramPostIdFromUrl(item.href)));
    assert.deepEqual(
      [...new Set([...adapterIds, ...gridIds])].sort(),
      ["COMPLETE", "GRID_ONLY", "MISSING_DATE"].sort()
    );
    for (const item of gridItems) {
      const adapter = adapterPosts.find(
        (post) => instagramPostIdFromUrl(post.url) === instagramPostIdFromUrl(item.href)
      );
      assert.ok(
        instagramEvidenceProvenance({
          post: adapter ?? { url: item.href, likes: item.likes },
          gridItems: [item],
          detailItems: []
        })
      );
    }
  });

  it("treats the canonical meta description as authoritative over adjacent modal JSON", () => {
    const description =
      '2,418 likes, 81 comments - farza954 on July 8, 2026: "The source reel caption."';

    assert.deepEqual(instagramMetaDescriptionFields(description), {
      caption: "The source reel caption.",
      dateLabel: "July 8, 2026",
      likes: 2_418,
      comments: 81,
      views: null
    });
    assert.deepEqual(
      normalizeInstagramDetailObservation({
        description,
        caption: "Caption from an adjacent modal post",
        dateLabel: "2026-07-11T00:00:00.000Z",
        likes: 4_675,
        comments: 42,
        views: 99_000
      }),
      {
        description,
        caption: "The source reel caption.",
        dateLabel: "July 8, 2026",
        likes: 2_418,
        comments: 81,
        views: 99_000
      }
    );
  });

  it("parses compact Instagram metrics and falls back field-by-field", () => {
    assert.deepEqual(
      normalizeInstagramDetailObservation({
        description:
          '1.2M views, 10.6K likes - founder on June 4, 2026: "Launch day"',
        comments: 17
      }),
      {
        description:
          '1.2M views, 10.6K likes - founder on June 4, 2026: "Launch day"',
        caption: "Launch day",
        dateLabel: "June 4, 2026",
        likes: 10_600,
        comments: 17,
        views: 1_200_000
      }
    );
  });

  it("preserves newer exact metrics when the detail caption matches canonical metadata", () => {
    const detail = {
      description:
        '293 likes, 12 comments - mirrormirror.ai on June 9, 2026: "Introducing Digital Twin Studio!"',
      caption: "Introducing Digital Twin Studio!",
      dateLabel: "2026-06-10T13:31:09.000Z",
      likes: 398,
      comments: 16
    };

    assert.equal(instagramDetailObservationMatchesMeta(detail), true);
    assert.deepEqual(normalizeInstagramDetailObservation(detail), {
      ...detail,
      views: null
    });
    assert.equal(
      instagramDetailObservationMatchesMeta({
        ...detail,
        caption: "Caption from an adjacent modal card"
      }),
      false
    );
  });

  it("uses an explicit adapter shortcode only when the browser independently proves the same post", () => {
    const matchingGridItem = {
      href: "https://www.instagram.com/p/CODE_42/",
      caption: "visible grid caption"
    };
    assert.deepEqual(
      instagramEvidenceProvenance({
        post: { shortcode: "CODE_42", caption: "adapter caption" },
        gridItems: [matchingGridItem]
      }),
      {
        sourceUrl: "https://www.instagram.com/p/CODE_42/",
        platformPostId: "CODE_42",
        gridItem: matchingGridItem,
        detail: null
      }
    );
    assert.equal(
      instagramEvidenceProvenance({
        post: { shortcode: "CODE_42", caption: "adapter caption" },
        gridItems: []
      }),
      null
    );
  });

  it("fails closed unless the adapter profile proves the exact verified handle", () => {
    assert.deepEqual(
      instagramAdapterProfileIdentityDecision({
        requestedHandle: "_heyclicky",
        profile: { username: "_heyclicky" },
        targetVerified: true
      }),
      { ok: true, reason: "verified_exact_profile_handle" }
    );
    assert.equal(
      instagramAdapterProfileIdentityDecision({
        requestedHandle: "_heyclicky",
        profile: { username: "somebody_else" },
        targetVerified: true
      }).ok,
      false
    );
    assert.equal(
      instagramAdapterProfileIdentityDecision({
        requestedHandle: "_heyclicky",
        profile: null,
        targetVerified: true
      }).ok,
      false
    );
    assert.equal(
      instagramAdapterProfileIdentityDecision({
        requestedHandle: "_heyclicky",
        profile: { username: "_heyclicky" },
        targetVerified: false
      }).ok,
      false
    );
  });

  it("requires final browser URL plus visible or canonical exact profile identity", () => {
    assert.deepEqual(
      instagramBrowserProfileIdentityDecision({
        requestedHandle: "_heyclicky",
        currentUrl: "https://www.instagram.com/_heyclicky/",
        canonicalUrl: "https://www.instagram.com/_heyclicky/",
        visibleHandles: ["heyclicky (@_heyclicky)"]
      }),
      { ok: true, reason: "verified_browser_profile_identity" }
    );
    assert.equal(
      instagramBrowserProfileIdentityDecision({
        requestedHandle: "_heyclicky",
        currentUrl: "https://www.instagram.com/explore/",
        canonicalUrl: "https://www.instagram.com/_heyclicky/",
        visibleHandles: ["@_heyclicky"]
      }).ok,
      false
    );
    assert.equal(
      instagramBrowserProfileIdentityDecision({
        requestedHandle: "_heyclicky",
        currentUrl: "https://www.instagram.com/_heyclicky/",
        visibleHandles: []
      }).ok,
      false
    );
    assert.equal(
      instagramBrowserProfileIdentityDecision({
        requestedHandle: "_heyclicky",
        currentUrl: "https://www.instagram.com/_heyclicky/",
        visibleHandles: ["@_heyclicky"],
        loginWall: true
      }).ok,
      false
    );
  });

  it("accepts only explicitly verified target mappings", () => {
    assert.equal(
      instagramTargetIsVerifiedForIngestion({
        account: { review_state: "verified" }
      }),
      true
    );
    assert.equal(
      instagramTargetIsVerifiedForIngestion({
        matchReason:
          "The exact official company website links directly to this native Instagram company profile."
      }),
      true
    );
    assert.equal(
      instagramTargetIsVerifiedForIngestion({
        matchReason: "OpenCLI Instagram search found an exact company handle."
      }),
      false
    );
    assert.equal(
      instagramTargetIsVerifiedForIngestion({
        matchReason: "No verification metadata was supplied."
      }),
      false
    );
  });

  it("preserves structured verification when duplicate plain links are merged", () => {
    assert.deepEqual(
      mergeVerifiedSocialAccountCandidates([
        {
          platform: "instagram",
          url: "https://www.instagram.com/example/",
          review_state: "verified",
          matchReason: "Verified graph account"
        },
        {
          platform: "instagram",
          url: "https://www.instagram.com/example/"
        }
      ]),
      [
        {
          platform: "instagram",
          url: "https://www.instagram.com/example/",
          review_state: "verified",
          matchReason: "Verified graph account"
        }
      ]
    );
  });

  it("normalizes every adapter and detail publication-date field", () => {
    const now = Date.parse("2026-08-02T20:00:00.000Z");
    const exact = "2026-07-31T18:04:57.270Z";
    const exactResult = {
      postedAt: exact,
      publishedAtPrecision: "exact"
    };

    for (const field of ["date", "timestamp", "publishedAt", "postedAt"]) {
      assert.deepEqual(
        instagramPublicationDate({ [field]: exact }, now),
        exactResult,
        field
      );
    }

    const epochMs = Date.parse(exact);
    assert.deepEqual(
      instagramPublicationDate({ taken_at: epochMs / 1_000 }, now),
      exactResult
    );
    assert.deepEqual(
      instagramPublicationDate({ takenAt: String(epochMs / 1_000) }, now),
      exactResult
    );
    assert.deepEqual(
      instagramPublicationDate({ timestamp: epochMs }, now),
      exactResult
    );
    assert.deepEqual(
      instagramPublicationDate({ date: String(epochMs) }, now),
      exactResult
    );
    assert.deepEqual(
      instagramPublicationDate({ dateLabel: "July 31, 2026" }, now),
      { postedAt: "2026-07-31", publishedAtPrecision: "day" }
    );
    assert.deepEqual(
      instagramPublicationDate("2026-07-31", now),
      { postedAt: "2026-07-31", publishedAtPrecision: "day" }
    );
    assert.deepEqual(
      instagramPublicationDate({ timestamp: "2026-07-31T18:04:57.270+0000" }, now),
      exactResult
    );
  });

  it("prefers native exact timestamps to display labels", () => {
    const now = Date.parse("2026-08-02T20:00:00.000Z");
    const exact = "2026-07-31T18:04:57.000Z";
    const exactSeconds = Date.parse(exact) / 1_000;

    assert.deepEqual(
      instagramPublicationDate({
        date: "July 30, 2026",
        dateLabel: "July 29, 2026",
        taken_at: exactSeconds
      }, now),
      { postedAt: exact, publishedAtPrecision: "exact" }
    );
    assert.deepEqual(
      instagramPublicationDate({
        postedAt: exact,
        taken_at: Date.parse("2026-07-30T00:00:00.000Z") / 1_000
      }, now),
      { postedAt: exact, publishedAtPrecision: "exact" }
    );
  });

  it("fails closed on malformed, impossible, pre-Instagram, and future dates", () => {
    const now = Date.parse("2026-08-02T20:00:00.000Z");
    const unknown = { postedAt: null, publishedAtPrecision: "unknown" };
    const rejected = [
      null,
      {},
      "not-a-date",
      "2026-07-31T18:04:57",
      "2026-02-30",
      "February 30, 2026",
      0,
      -1,
      12_345,
      Date.parse("2009-12-31T23:59:59.999Z"),
      { timestamp: now + 1 },
      { taken_at: Math.floor(now / 1_000) + 1 },
      { date: "2026-08-03" },
      { dateLabel: "August 3, 2026" },
      { postedAt: "not-a-date", taken_at: Date.parse("2026-07-31T00:00:00.000Z") / 1_000 }
    ];

    for (const value of rejected) {
      assert.deepEqual(instagramPublicationDate(value, now), unknown, String(value));
    }
    assert.deepEqual(
      instagramPublicationDate({ postedAt: "2026-07-31T00:00:00.000Z" }, Number.NaN),
      unknown
    );
  });

  it("rejects missing, invalid, and stale publication dates instead of silently passing them", () => {
    const cutoff = Date.parse("2025-01-01T00:00:00.000Z");
    assert.deepEqual(
      instagramRecencyDecision(null, cutoff),
      { eligible: false, reason: "missing_publication_date" }
    );
    assert.deepEqual(
      instagramRecencyDecision("not-a-date", cutoff),
      { eligible: false, reason: "invalid_publication_date" }
    );
    assert.deepEqual(
      instagramRecencyDecision("2024-12-31T23:59:59.000Z", cutoff),
      { eligible: false, reason: "before_recency_cutoff" }
    );
    assert.deepEqual(
      instagramRecencyDecision("2026-07-29T00:00:00.000Z", cutoff),
      { eligible: true, reason: "within_recency_window" }
    );
  });

  it("classifies Instagram auth, challenge, rate-limit, and command/profile failures", () => {
    assert.equal(
      instagramFailureKind(
        "Instagram browser grid extractor failed: login_wall"
      ),
      "auth"
    );
    assert.equal(
      instagramFailureKind(
        "Instagram browser profile identity was not proven: challenge_page"
      ),
      "challenge"
    );
    assert.equal(
      instagramFailureKind("HTTP 429 Too Many Requests"),
      "rate_limited"
    );
    assert.equal(
      instagramFailureKind(
        "HTTP 400 - make sure you are logged in to Instagram"
      ),
      "auth"
    );
    assert.equal(
      instagramFailureKind(
        "Instagram profile adapter failed: command timed out"
      ),
      "command_or_profile"
    );
    assert.equal(
      instagramFailureKind(
        "No scored recent Instagram posts found with adapter or browser grid/detail extractor."
      ),
      "empty"
    );
  });

  it("treats legacy authenticated non-exhaustion text as neutral progress", () => {
    const legacyMessage =
      "Instagram authenticated history remains non-exhaustive: no_new_native_post_identity.";
    assert.equal(instagramFailureKind(legacyMessage), "progress");
    assert.deepEqual(
      instagramCircuitDecision({
        consecutiveFailures: 99,
        maxConsecutiveFailures: 3,
        failureKind: instagramFailureKind(legacyMessage)
      }),
      { open: false, reason: null }
    );
    assert.equal(
      instagramCollectionAttemptState({
        evidenceCount: 1,
        completedTimelineSourceCount: 1,
        profileIdentityOk: true,
        failureMessages: [legacyMessage]
      }).collectionFailed,
      false
    );
  });

  it("retries only transient browser detach/transport failures", () => {
    assert.equal(
      instagramShouldRetryTransientBrowserFailure(
        "Pre-navigation to https://www.instagram.com failed: Detached while handling command."
      ),
      true
    );
    assert.equal(
      instagramShouldRetryTransientBrowserFailure(
        'Browser profile "4dwub6zw" is not connected'
      ),
      true
    );
    assert.equal(
      instagramShouldRetryTransientBrowserFailure("profile_disconnected"),
      true
    );
    assert.equal(
      instagramShouldRetryTransientBrowserFailure(
        "HTTP 400 - make sure you are logged in to Instagram"
      ),
      false
    );
    assert.equal(
      instagramShouldRetryTransientBrowserFailure("challenge_page"),
      false
    );
    assert.equal(
      instagramShouldRetryTransientBrowserFailure("HTTP 429 Too Many Requests"),
      false
    );
  });

  it("fails closed on systemic reads while preserving legitimate empty native timelines", () => {
    assert.deepEqual(
      instagramCollectionAttemptState({
        evidenceCount: 0,
        completedTimelineSourceCount: 2,
        profileIdentityOk: true,
        failureMessages: [
          "No scored recent Instagram posts found with adapter or browser grid/detail extractor."
        ]
      }),
      {
        status: "done",
        collectionFailed: false,
        failureKind: "empty"
      }
    );
    assert.deepEqual(
      instagramCollectionAttemptState({
        evidenceCount: 0,
        completedTimelineSourceCount: 0,
        profileIdentityOk: true,
        failureMessages: [
          "Instagram user adapter failed: command timed out",
          "Instagram browser grid extractor failed: command timed out"
        ]
      }),
      {
        status: "failed",
        collectionFailed: true,
        failureKind: "command_or_profile"
      }
    );
    assert.deepEqual(
      instagramCollectionAttemptState({
        evidenceCount: 12,
        completedTimelineSourceCount: 1,
        profileIdentityOk: true,
        failureMessages: [
          "Instagram browser grid extractor failed: challenge_page"
        ]
      }),
      {
        status: "failed",
        collectionFailed: true,
        failureKind: "challenge"
      }
    );
    assert.equal(
      instagramCollectionAttemptState({
        evidenceCount: 0,
        completedTimelineSourceCount: 2,
        profileIdentityOk: false,
        failureMessages: ["profile_handle_mismatch"]
      }).collectionFailed,
      true
    );
  });

  it("opens the Instagram circuit immediately for auth/challenge/rate limits and after three command failures", () => {
    for (const failureKind of ["auth", "challenge", "rate_limited"]) {
      assert.deepEqual(
        instagramCircuitDecision({
          consecutiveFailures: 1,
          maxConsecutiveFailures: 3,
          failureKind
        }),
        { open: true, reason: failureKind }
      );
    }
    assert.deepEqual(
      instagramCircuitDecision({
        consecutiveFailures: 2,
        maxConsecutiveFailures: 3,
        failureKind: "command_or_profile"
      }),
      { open: false, reason: null }
    );
    assert.deepEqual(
      instagramCircuitDecision({
        consecutiveFailures: 3,
        maxConsecutiveFailures: 3,
        failureKind: "command_or_profile"
      }),
      { open: true, reason: "consecutive_failures" }
    );
  });

  it("prioritizes failed zero/low native coverage without counting profile rows or duplicates", () => {
    const targets = [
      target("covered", "https://instagram.com/covered/"),
      target("zero", "https://instagram.com/zero/"),
      target("failed", "https://instagram.com/failed/")
    ];
    const attempts = new Map([
      ["S26:instagram:failed:https://instagram.com/failed/", {
        status: "failed",
        checkedAt: "2026-07-29T00:00:00.000Z"
      }]
    ]);
    const evidence = [
      row("covered", "https://instagram.com/p/ONE/"),
      row("covered", "https://instagram.com/p/ONE/?duplicate=1"),
      row("covered", "https://instagram.com/p/TWO/"),
      row("zero", "https://instagram.com/zero/")
    ];

    assert.deepEqual(
      prioritizeInstagramTargets(targets, {
        evidence,
        attempts,
        attemptKey: (item) =>
          `${item.batchSlug}:${item.platform}:${item.entityId}:${item.url}`
      }).map((item) => item.entityId),
      ["failed", "zero", "covered"]
    );
  });

  it("counts a large Instagram evidence ledger in linear time with one mutable Set per owner", () => {
    assert.doesNotMatch(
      instagramCollectionSource,
      /new Set\(\[\.\.\.\(evidenceIds\.get/
    );
    assert.match(instagramCollectionSource, /postIds\.add\(postId\)/);
    const denseEvidence = Array.from({ length: 30_000 }, (_, index) => ({
      batchSlug: "S26",
      platform: "instagram",
      entityId: "dense",
      sourceUrl: `https://www.instagram.com/p/LINEAR_${index}/`
    }));
    denseEvidence.push({
      ...denseEvidence[0],
      sourceUrl: `${denseEvidence[0].sourceUrl}?duplicate=1`
    });
    const targets = [
      target("dense", "https://instagram.com/dense/"),
      target("empty", "https://instagram.com/empty/")
    ];
    const startedAt = performance.now();
    const prioritized = prioritizeInstagramTargets(targets, {
      evidence: denseEvidence
    });
    const elapsedMs = performance.now() - startedAt;

    assert.deepEqual(
      prioritized.map((item) => item.entityId),
      ["empty", "dense"]
    );
    assert.ok(elapsedMs < 3_000, `30k-row prioritization took ${elapsedMs}ms`);
  });
});

function target(entityId, url) {
  return {
    batchSlug: "S26",
    platform: "instagram",
    entityId,
    url
  };
}

function row(entityId, sourceUrl) {
  return {
    batchSlug: "S26",
    platform: "instagram",
    entityId,
    sourceUrl
  };
}
