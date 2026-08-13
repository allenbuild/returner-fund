import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  RECENT_WINDOW_PAGE_RECEIPT_SCHEMA_VERSION,
  RECENT_WINDOW_PROOF_SCHEMA_VERSION,
  collectHackerNewsRecentWindow,
  instagramRecentWindowObservation,
  persistRecentWindowProof
} from "../scripts/lib/recent-window-proof-instrumentation.mjs";

const REQUESTED_AT = "2026-08-02T03:09:59.000Z";
const COMPLETED_AT = "2026-08-02T03:10:00.000Z";
const COVERAGE_CUTOFF = "2026-08-02T03:09:58.000Z";
const COVERED_FROM = "2026-05-04T03:09:58.000Z";

describe("recent-window proof instrumentation", () => {
  it("persists one hash-pinned receipt only for an exhausted Instagram timeline", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "recent-window-proof-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const responseBody = JSON.stringify({ data: { user: { username: "acme" } } });
    const observation = instagramRecentWindowObservation({
      requestUrl: "https://www.instagram.com/api/v1/users/web_profile_info/?username=acme",
      requestedAt: REQUESTED_AT,
      completedAt: COMPLETED_AT,
      coverageCutoff: COVERAGE_CUTOFF,
      responseBody,
      receipt: instagramReceipt()
    });
    assert.equal(observation.complete, true);
    assert.equal(observation.coveredFrom, COVERED_FROM);

    const result = await persistRecentWindowProof({
      observation,
      attemptKey: "instagram:company:company-acme:https://www.instagram.com/acme/",
      pairKey: "TEST:company:company-acme:instagram",
      journalDirectory: join(root, "recent-window-journals", "shard-0"),
      descriptorRoot: root
    });
    assert.equal(result.recentWindowProof.schemaVersion, RECENT_WINDOW_PROOF_SCHEMA_VERSION);
    assert.equal(result.recentWindowProof.pagesFetched, 1);
    assert.equal(result.recentWindowProof.requestJournal.observedAt, COMPLETED_AT);
    const body = await readFile(
      join(root, result.recentWindowProof.requestJournal.path),
      "utf8"
    );
    assert.equal(sha256(body), result.recentWindowProof.requestJournal.sha256);
    const row = JSON.parse(body.trim());
    assert.equal(row.schemaVersion, RECENT_WINDOW_PAGE_RECEIPT_SCHEMA_VERSION);
    assert.equal(row.cursorIn, null);
    assert.equal(row.cursorOut, null);
    assert.equal(row.sourceExhausted, true);
    assert.equal(row.coverageFrom, COVERED_FROM);
    assert.equal(row.coverageThrough, COVERAGE_CUTOFF);
    assert.equal(row.responseSha256, sha256(responseBody));
  });

  it("keeps truncated, count-mismatched, and cursor-bearing Instagram responses unproved", () => {
    for (const receipt of [
      instagramReceipt({ truncated: true }),
      instagramReceipt({ totalCount: 2 }),
      instagramReceipt({ pageInfo: { hasNextPage: true, endCursor: "next" } })
    ]) {
      const observation = instagramRecentWindowObservation({
        requestUrl: "https://www.instagram.com/api/v1/users/web_profile_info/?username=acme",
        requestedAt: REQUESTED_AT,
        completedAt: COMPLETED_AT,
        coverageCutoff: COVERAGE_CUTOFF,
        responseBody: "{}",
        receipt
      });
      assert.equal(observation.complete, false);
      assert.equal(observation.blocker, "instagram_native_timeline_not_exhausted");
    }
  });

  it("builds a stable, exhaustive Hacker News Algolia cursor chain", async () => {
    const payloads = [
      { page: 0, nbHits: 2, nbPages: 2, hits: [hnHit("1")] },
      { page: 1, nbHits: 2, nbPages: 2, hits: [hnHit("2")] }
    ];
    const requests = [];
    const result = await collectHackerNewsRecentWindow({
      target: { entityName: "Acme", officialDomain: "acme.example" },
      checkedThrough: COVERAGE_CUTOFF,
      pageLimit: 5,
      itemLimit: 10,
      hitsPerPage: 1,
      fetchImpl: async (url) => {
        requests.push(new URL(url));
        return jsonResponse(payloads.shift());
      }
    });
    assert.equal(result.observation.complete, true);
    assert.equal(result.hits.length, 2);
    assert.equal(result.observation.pages.length, 2);
    assert.deepEqual(
      result.observation.pages.map((row) => [row.cursorIn, row.cursorOut, row.sourceExhausted]),
      [[null, "1", false], ["1", null, true]]
    );
    assert.ok(requests.every((url) =>
      url.searchParams.get("numericFilters") ===
        "created_at_i>=1777864198,created_at_i<=1785640198"
    ));

    const root = await mkdtemp(join(tmpdir(), "recent-window-hn-proof-"));
    try {
      const proof = await persistRecentWindowProof({
        observation: result.observation,
        attemptKey: "hacker_news:acme",
        pairKey: "TEST:company:company-acme:hacker_news",
        journalDirectory: join(root, "recent-window-journals"),
        descriptorRoot: root
      });
      assert.equal(proof.blocker, null);
      assert.equal(proof.recentWindowProof.coveredThrough, COVERAGE_CUTOFF);
      assert.equal(proof.recentWindowProof.pagesFetched, 2);
      assert.equal((await readdir(join(root, "recent-window-journals"))).length, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses Hacker News proof at a page cap or when the result census changes", async () => {
    const capped = await collectHackerNewsRecentWindow({
      target: { entityName: "Acme", officialDomain: "acme.example" },
      checkedThrough: COVERAGE_CUTOFF,
      pageLimit: 2,
      itemLimit: 10,
      hitsPerPage: 1,
      fetchImpl: async (url) => jsonResponse({
        page: Number(new URL(url).searchParams.get("page")),
        nbHits: 2,
        nbPages: 2,
        hits: [hnHit(new URL(url).searchParams.get("page"))]
      })
    });
    assert.equal(capped.observation.complete, false);
    assert.match(capped.observation.blocker, /page_limit/);

    let call = 0;
    const changed = await collectHackerNewsRecentWindow({
      target: { entityName: "Acme", officialDomain: "acme.example" },
      checkedThrough: COVERAGE_CUTOFF,
      pageLimit: 5,
      itemLimit: 10,
      hitsPerPage: 1,
      fetchImpl: async () => jsonResponse({
        page: call,
        nbHits: call++ === 0 ? 2 : 3,
        nbPages: 2,
        hits: [hnHit(String(call))]
      })
    });
    assert.equal(changed.observation.complete, false);
    assert.equal(changed.observation.blocker, "hacker_news_window_changed_during_pagination");
  });

  it("does not create a journal for incomplete evidence and rejects escaping directories", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "recent-window-proof-"));
    const outside = await mkdtemp(join(tmpdir(), "recent-window-proof-outside-"));
    t.after(() => Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true })
    ]));
    const incomplete = await persistRecentWindowProof({
      observation: { complete: false, blocker: "source_capped" },
      attemptKey: "hn:acme",
      pairKey: "TEST:company:company-acme:hacker_news"
    });
    assert.equal(incomplete.recentWindowProof, null);
    assert.equal(incomplete.blocker, "source_capped");
    assert.deepEqual(await readdir(root), []);

    await assert.rejects(
      persistRecentWindowProof({
        observation: instagramRecentWindowObservation({
          requestUrl: "https://www.instagram.com/api/v1/users/web_profile_info/?username=acme",
          requestedAt: REQUESTED_AT,
          completedAt: COMPLETED_AT,
          coverageCutoff: COVERAGE_CUTOFF,
          responseBody: "{}",
          receipt: instagramReceipt()
        }),
        attemptKey: "instagram:acme",
        pairKey: "TEST:company:company-acme:instagram",
        journalDirectory: outside,
        descriptorRoot: root
      }),
      /must stay inside descriptorRoot/
    );
  });

  it("rejects requests that start before the immutable cutoff and page intervals that stop short", async (t) => {
    const early = instagramRecentWindowObservation({
      requestUrl: "https://www.instagram.com/api/v1/users/web_profile_info/?username=acme",
      requestedAt: "2026-08-02T03:09:57.999Z",
      completedAt: COMPLETED_AT,
      coverageCutoff: COVERAGE_CUTOFF,
      responseBody: "{}",
      receipt: instagramReceipt()
    });
    assert.equal(early.complete, false);
    assert.equal(early.blocker, "instagram_request_started_before_coverage_cutoff");

    const root = await mkdtemp(join(tmpdir(), "recent-window-proof-gap-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const observation = instagramRecentWindowObservation({
      requestUrl: "https://www.instagram.com/api/v1/users/web_profile_info/?username=acme",
      requestedAt: REQUESTED_AT,
      completedAt: COMPLETED_AT,
      coverageCutoff: COVERAGE_CUTOFF,
      responseBody: "{}",
      receipt: instagramReceipt()
    });
    observation.pages[0].coverageThrough = "2026-08-02T03:09:57.999Z";
    const result = await persistRecentWindowProof({
      observation,
      attemptKey: "instagram:acme",
      pairKey: "TEST:company:company-acme:instagram",
      journalDirectory: join(root, "recent-window-journals"),
      descriptorRoot: root
    });
    assert.equal(result.recentWindowProof, null);
    assert.equal(result.blocker, "native_recent_window_page_receipts_invalid");
    assert.deepEqual(await readdir(root), []);
  });
});

function instagramReceipt(overrides = {}) {
  return {
    verified: true,
    truncated: false,
    totalCount: 1,
    receivedEdgeCount: 1,
    processedEdgeCount: 1,
    pageInfo: { hasNextPage: false, endCursor: null },
    ...overrides
  };
}

function hnHit(objectID) {
  return {
    objectID: String(objectID),
    title: "Acme launches",
    url: "https://acme.example/launch",
    created_at: "2026-07-01T00:00:00.000Z",
    points: 1,
    num_comments: 0
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
