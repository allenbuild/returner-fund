import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { planRobinPublicationAppend, commitRobinPublicationAppend, ingestRobinFounderPublicationContexts } from "../scripts/ingest-fall-2026-robin-publication-context.mjs";
import { ROBIN_FOUNDER_PUBLICATION_SOURCE as SOURCE, ROBIN_FOUNDER_PUBLICATION_VALIDATION as VALIDATION,
  robinPublicationNativeFields, robinPublicationSha256 as sha } from "../src/lib/graph/robin-founder-publication-context-receipt.mjs";

const entity = { entityId: "founder-adsideai-robin-choy-406206", companySlug: "adsideai", companyName: "Adside.ai", founderName: "Robin Choy", socialAccounts: { x: "https://x.com/ChoyRb" } };
function fixture() {
  const owner = { source: "official_founder_native_profile_personal_site_publication_chain_v1", companySlug: "adsideai", founderId: "406206", founderName: "Robin Choy", entityId: entity.entityId,
    officialYcCompanyUrl: "https://www.ycombinator.com/companies/adsideai", officialXProfileUrl: "https://x.com/ChoyRb", personalWebsiteUrl: "https://robinchoy.com/", publicationUrl: "https://robinchoy.substack.com/", nativePublicationId: 2319101,
    nativeXProfileWebsiteAnchor: { href: "https://t.co/t7XtL09Z8N", text: "robinchoy.com", anchorHtml: '<a data-testid="UserUrl" href="https://t.co/t7XtL09Z8N">robinchoy.com</a>' },
    personalHomepageFounderHeadingHtml: "<h1>Robin Choy</h1>", personalHomepageSelfBiographyHtml: "<p>I'm a repeat founder. I am building Adside.</p>",
    personalHomepageReciprocalXAnchorHtml: '<a href="https://x.com/ChoyRb">@ChoyRb</a>', publicationAnchorHtml: '<a href="https://robinchoy.substack.com/">Substack</a>',
    nativeXProfileArchiveSha256: sha("profile"), personalHomepageSha256: sha("homepage"), rosterSha256: sha("roster"), ownershipInventorySha256: sha("ownership") };
  const articles = [
    ["211370047", "every-yc-company-should-be-investing"],
    ["211369744", "my-non-yc-approved-advice-to-yc-companies"]
  ].map(([nativePostId, slug]) => {
    const row = { batchSlug: "F26", companySlug: "adsideai", companyName: "Adside.ai", entityType: "founder", entityId: entity.entityId, founderId: "406206", authorName: "Robin Choy",
      platform: "web", publisherPlatform: "substack", nativePostId, nativePublicationId: 2319101, sourceUrl: `https://robinchoy.substack.com/p/${slug}`,
      platformPostId: `https://robinchoy.substack.com/p/${slug}`, authorUrl: "https://substack.com/@robinchoy1", identitySourceUrl: "https://www.ycombinator.com/companies/adsideai",
      title: `Article ${nativePostId}`, text: `Full original article ${nativePostId}.`, originalText: `Full original article ${nativePostId}.`, originalBodyHtml: `<p>Full original article ${nativePostId}.</p>`,
      postedAt: "2026-07-18T01:30:00.187Z", nativePublishedAtLiteral: "2026-07-18T01:30:00.187Z", nativeFeedPublishedAtLiteral: "Sat, 18 Jul 2026 01:30:00 GMT", observedAt: "2026-11-16T21:11:53.849Z",
      nativePublishedBylines: [{ id: 224124204, name: "Robin Choy", handle: "robinchoy1", is_guest: false }], nativeAudience: "everyone", nativeIsPublished: true, bodyTruncated: false, bodyPaywalled: false,
      metrics: {}, contributionScore: 0, tractionStatus: "unscored", nativeSocialPostAdmission: false, historyComplete: false,
      review_state: "verified", attributionStatus: "verified", attributionMode: "author", attributionProvenance: SOURCE, officialFounderPublicationOwnership: owner };
    row.originalBodyHtmlSha256 = sha(row.originalBodyHtml);
    const raw = { source: SOURCE, ownership: owner, nativePost: robinPublicationNativeFields(row), text: row.text, nativeFeedPublishedAtLiteral: row.nativeFeedPublishedAtLiteral,
      observedAt: row.observedAt, archives: [{ path: "fixture/article.html", sha256: sha("physical article fixture") }] };
    raw.validation = { source: VALIDATION, archiveHashesVerified: true, exactRosterFounderVerified: true, nativeOwnProfileAnchorVerified: true,
      personalSiteSelfBiographyAndReciprocalXVerified: true, literalOwnedPublicationAnchorVerified: true, fullNativePostPreloadAndHtmlVerified: true, fullRssBodyAndNativeClockVerified: true,
      originalTextSha256: sha(row.originalText), originalBodyHtmlSha256: row.originalBodyHtmlSha256, nativeFieldsSha256: sha(JSON.stringify(raw.nativePost)),
      ownershipSha256: sha(JSON.stringify(owner)), archivesSha256: sha(JSON.stringify(raw.archives)) };
    row.rawVisibleText = JSON.stringify(raw);
    return row;
  });
  return { source: { kind: SOURCE }, evidence: articles, audit: { status: "physically_verified_prepared_context_only", exactOwner: entity } };
}
const older = { id: "older-row", batchSlug: "S26", text: 'literal ]}, escaped quote " and \\ and Unicode \u2028', metrics: { views: 9 } };
const target = (rows = [older], source = {}) => JSON.stringify({ source: { fetchedAt: "2026-11-16T20:00:00.000Z", evidenceCount: rows.length, retained: { x: 1 }, ...source }, evidence: rows, unrelated: [1, { a: "evidence" }] }, null, 2) + "\n";

test("appends only two zero-score contexts and preserves every old row plus source metadata", () => {
  const before = target(), plan = planRobinPublicationAppend(before, fixture()), next = JSON.parse(plan.nextText);
  assert.equal(plan.accepted.length, 2);
  assert.deepEqual(next.evidence.slice(0, 1), [older]);
  assert.equal(plan.audit.earlierCohortRowsSha256, sha(JSON.stringify([older])));
  assert.equal(plan.audit.existingRowsByteEquivalent, true);
  assert.deepEqual(next.source, { fetchedAt: "2026-11-16T21:11:53.849Z", evidenceCount: 3, retained: { x: 1 } });
  for (const row of next.evidence.slice(1)) {
    assert.deepEqual(row.metrics, {}); assert.equal(row.contributionScore, 0); assert.equal(row.tractionStatus, "unscored");
    assert.equal(row.publishedAtPrecision, "exact"); assert.equal(row.nativeSocialPostAdmission, false);
    assert.equal(row.first_seen_at, row.observedAt); assert.equal(row.last_checked_at, row.observedAt); assert.equal(row.last_updated_at, row.postedAt);
  }
  assert.equal(next.unrelated[1].a, "evidence");
});

test("literal array bytes and key order survive compact/escaped keys, empty arrays and source after evidence", () => {
  for (const before of [target([]), '{"evid\\u0065nce":[ {"batchSlug":"S26","text":"[\\\"}\\\\]"}  ],"source":{"fetchedAt":"2026-11-16T20:00:00Z"}}\n']) {
    const oldArray = before.slice(before.indexOf("[") + 1, before.lastIndexOf("]"));
    const plan = planRobinPublicationAppend(before, fixture());
    assert.ok(plan.nextText.includes(oldArray));
    assert.equal(JSON.parse(plan.nextText).evidence.length, JSON.parse(before).evidence.length + 2);
  }
});

test("a later existing fetchedAt is retained and native publication instants are independent", () => {
  const next = JSON.parse(planRobinPublicationAppend(target([], { fetchedAt: "2026-11-16T23:00:00.000Z" }), fixture()).nextText);
  assert.equal(next.source.fetchedAt, "2026-11-16T23:00:00.000Z");
  assert.equal(next.evidence[0].postedAt, "2026-07-18T01:30:00.187Z");
});

test("future appended rows carry explicit graph rationale without changing the native article receipt", () => {
  const prepared = fixture(), plan = planRobinPublicationAppend(target(), prepared);
  for (const [index, row] of plan.accepted.entries()) {
    assert.ok(row.why.includes("zero score"));
    assert.ok(row.matchReason.includes("full body, Robin Choy byline and native publication date"));
    assert.equal(row.rawVisibleText, prepared.evidence[index].rawVisibleText);
    assert.equal(row.text, prepared.evidence[index].text);
    assert.equal(row.postedAt, prepared.evidence[index].postedAt);
  }
});

test("an exact rerun is a byte-identical no-op, with both native IDs reported as duplicates", () => {
  const first = planRobinPublicationAppend(target(), fixture()), second = planRobinPublicationAppend(first.nextText, fixture());
  assert.equal(second.accepted.length, 0); assert.equal(second.duplicates.length, 2);
  assert.equal(second.nextText, first.nextText);
});

test("same URL with changed body, owner, date, native ID or namespace is never silently deduplicated", () => {
  for (const change of [r => { r.text += " changed"; }, r => { r.entityId = "founder-other"; }, r => { r.postedAt = "2026-07-19T01:30:00Z"; }, r => { r.nativePostId = "999"; }, r => { r.platform = "x"; }]) {
    const existing = fixture().evidence[0]; change(existing);
    assert.throws(() => planRobinPublicationAppend(target([older, existing]), fixture()), /identity_body_owner_or_date_conflict/);
  }
});

test("same Substack native ID at another canonical URL and evidence-ID collisions are rejected", () => {
  const prior = fixture().evidence[0]; prior.sourceUrl = prior.platformPostId = "https://other.substack.com/p/other";
  assert.throws(() => planRobinPublicationAppend(target([prior]), fixture()), /identity_body_owner_or_date_conflict/);
  const row = planRobinPublicationAppend(target(), fixture()).accepted[0];
  assert.throws(() => planRobinPublicationAppend(target([{ ...older, id: row.id }]), fixture()), /evidence_id_conflict/);
});

test("unverified preparation, modified receipts and duplicate incoming physical identities fail closed", () => {
  for (const change of [p => { p.audit.status = "trusted_json"; }, p => { p.evidence[0].metrics = { likes: 1 }; }, p => { p.evidence[1] = structuredClone(p.evidence[0]); }]) {
    const prepared = fixture(); change(prepared);
    assert.throws(() => planRobinPublicationAppend(target(), prepared));
  }
  assert.throws(() => planRobinPublicationAppend('{"source":{},"evidence":[],"evidence":[]}', fixture()), /duplicate_target_envelope_property/);
});

async function temporary(testContext) {
  const root = await mkdtemp(join(tmpdir(), "robin-publication-cas-"));
  testContext.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "target.json"), before = target(), next = planRobinPublicationAppend(before, fixture()).nextText;
  await writeFile(path, before); return { root, path, before, next };
}

test("atomic commit requires exact expected bytes and releases its cooperative lock", async (t) => {
  const { path, before, next } = await temporary(t);
  const afterSha = await commitRobinPublicationAppend({ targetPath: path, beforeText: before, nextText: next, expectedTargetSha256: sha(before) });
  assert.equal(afterSha, sha(next)); assert.equal(await readFile(path, "utf8"), next);
  await assert.rejects(access(`${path}.lock`), { code: "ENOENT" });
});

test("stale expected SHA and concurrent target changes cannot overwrite newer bytes", async (t) => {
  const { path, before, next } = await temporary(t);
  await assert.rejects(commitRobinPublicationAppend({ targetPath: path, beforeText: before, nextText: next, expectedTargetSha256: sha("stale") }), /hash_conflict/);
  await writeFile(path, "newer writer bytes");
  await assert.rejects(commitRobinPublicationAppend({ targetPath: path, beforeText: before, nextText: next, expectedTargetSha256: sha(before) }), /changed_before_robin_commit/);
  assert.equal(await readFile(path, "utf8"), "newer writer bytes");
  await assert.rejects(access(`${path}.lock`), { code: "ENOENT" });
});

test("an existing writer lock is never removed or taken over", async (t) => {
  const { path, before, next } = await temporary(t); await writeFile(`${path}.lock`, "other writer");
  await assert.rejects(commitRobinPublicationAppend({ targetPath: path, beforeText: before, nextText: next, expectedTargetSha256: sha(before) }), { code: "EEXIST" });
  assert.equal(await readFile(`${path}.lock`, "utf8"), "other writer"); assert.equal(await readFile(path, "utf8"), before);
});

test("CLI entry requires write SHA and always invokes physical preparation, not prepared JSON", async (t) => {
  const { root, path, before } = await temporary(t);
  await assert.rejects(ingestRobinFounderPublicationContexts({ rootDir: root, target: "target.json", mode: "write" }), /write_requires_expected_target_sha256/);
  await writeFile(join(root, "fake-prepared.json"), JSON.stringify(fixture()));
  await assert.rejects(ingestRobinFounderPublicationContexts({ rootDir: root, target: "target.json", mode: "dry-run", inputPath: "fake-prepared.json", expectedInputSha256: sha(JSON.stringify(fixture())) }), /Unexpected frozen founder publication scope/);
  assert.equal(await readFile(path, "utf8"), before);
});
