import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import test from "node:test";
import { ingestFallPublicationContext } from "../scripts/ingest-fall-2026-publication-context.mjs";
import { publicationContextSha256 as sha, isVerifiedOfficialPublicationArticleContext, officialPublicationArticleContextReasons } from "../src/lib/graph/official-publication-context-receipt.mjs";

test("official publication imports exact full native text and byline, stays unscored, and preserves older cohorts", async (t) => {
  const f = await fixture(t), before = await readFile(f.target, "utf8"), audit = await run(f, "dry-run", "preview");
  assert.deepEqual([audit.accepted, audit.rejected, audit.archiveFilesVerified], [1, 0, 5]);
  assert.equal(await readFile(f.target, "utf8"), before);
  const row = (await json(join(f.directory, "preview/accepted-context.json"))).context[0];
  assert.equal(row.originalText, "Exact original article prose.\n\nA second paragraph.");
  assert.equal(row.authorName, "Native Author"); assert.equal(row.postedAt, "2026-11-16T12:00:00.100Z");
  assert.equal(row.nativePostId, "12345"); assert.equal(row.nativePublicationId, 6322238);
  assert.deepEqual(row.metrics, {}); assert.equal(row.contributionScore, 0); assert.equal(row.tractionStatus, "unscored");
  assert.equal(isVerifiedOfficialPublicationArticleContext(row, f.company), true);
  await run(f, "write", "written", { expectedTargetSha256: sha(before) });
  const next = await json(f.target);
  assert.equal(JSON.stringify(next.evidence[0]), JSON.stringify(f.older));
  assert.equal(next.source.fetchedAt, "2026-11-16T13:00:00.000Z");
  const replay = await run(f, "dry-run", "replay");
  assert.deepEqual([replay.accepted, replay.duplicates, replay.rejected], [0, 1, 0]);
});

test("native HTML body, immutable article ID and bylines defeat matching forged rendered receipts", async (t) => {
  for (const mutate of [
    (r) => { r.text = "Forged prose."; r.originalText = r.text; r.originalBodyHtml = "<p>Forged prose.</p>"; r.originalBodyHtmlSha256 = sha(r.originalBodyHtml); },
    (r) => { r.nativePostId = "99999"; },
    (r) => { r.nativePublishedBylines = [{ id: 8, name: "Different Author" }]; r.authorName = "Different Author"; }
  ]) {
    const f = await fixture(t), row = structuredClone(f.row); mutate(row); rebuildRaw(row); await f.save(row);
    const audit = await run(f, "dry-run", "forged");
    assert.equal(audit.rejected, 1);
    assert.ok(audit.rejectedRows[0].reasons.includes("native_publication_article_fields_or_body_conflict"));
  }
});

test("an external publication mention outside the actual official footer cannot establish publisher ownership", async (t) => {
  const f = await fixture(t, { footer: false });
  const audit = await run(f, "dry-run", "no-footer");
  assert.equal(audit.accepted, 0); assert.equal(audit.rejected, 1);
  assert.ok(audit.rejectedRows[0].reasons.includes("publication_link_is_not_exact_official_footer_anchor"));
});

test("changed on-disk native and RSS receipts fail before any write", async (t) => {
  for (const which of ["htmlPath", "feedPath", "nativePath"]) {
    const f = await fixture(t), before = await readFile(f.target, "utf8");
    await writeFile(f[which], (await readFile(f[which], "utf8")) + "\n");
    const audit = await run(f, "write", "changed", { expectedTargetSha256: sha(before) });
    assert.equal(audit.rejected, 1); assert.equal(audit.canonicalWritten, false);
    assert.ok(audit.rejectedRows[0].reasons.includes("publication_archive_hash_conflict"));
    assert.equal(await readFile(f.target, "utf8"), before);
  }
});

test("strict publication scope, body visibility and native publication clock remain receipt bound", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(officialPublicationArticleContextReasons(f.row, f.company), []);
  for (const mutation of [
    { sourceUrl: "https://thirdparty.substack.com/p/original", platformPostId: "https://thirdparty.substack.com/p/original" },
    { companySlug: "other", entityId: "company-other" }, { nativePublicationId: 9 }, { nativeIsPublished: false },
    { nativeAudience: "only_paid" }, { bodyPaywalled: true }, { metrics: { likes: 20 } }, { contributionScore: 50 },
    { postedAt: "2026-11-16T14:00:00Z", nativePublishedAtLiteral: "2026-11-16T14:00:00Z" }
  ]) assert.ok(officialPublicationArticleContextReasons({ ...f.row, ...mutation }, f.company).length, JSON.stringify(mutation));
  await run(f, "dry-run", "runtime");
  const row = (await json(join(f.directory, "runtime/accepted-context.json"))).context[0];
  const forged = structuredClone(row); forged.text = "New prose"; forged.originalText = forged.text; rebuildRaw(forged, JSON.parse(row.rawVisibleText).validation);
  assert.equal(isVerifiedOfficialPublicationArticleContext(forged, f.company), false);
});

test("publication write requires exact target compare-and-swap SHA", async (t) => {
  const f = await fixture(t), before = await readFile(f.target, "utf8");
  await assert.rejects(run(f, "write", "missing"), /Write requires/);
  await assert.rejects(run(f, "write", "wrong", { expectedTargetSha256: "0".repeat(64) }), /compare_and_swap_hash_conflict/);
  assert.equal(await readFile(f.target, "utf8"), before);
});

function rebuildRaw(row, validation) {
  row.rawVisibleText = JSON.stringify({ source: "official_company_publication_article_v1", company: { slug: row.companySlug, name: row.companyName, entityId: row.entityId },
    post: { nativePostId: row.nativePostId, sourceUrl: row.sourceUrl, title: row.title, text: row.text, nativePublishedAtLiteral: row.postedAt, nativePublicationId: row.nativePublicationId, nativePublishedBylines: row.nativePublishedBylines },
    officialPublicationOwnership: row.officialPublicationOwnership, sourceHtmlArchivePath: row.fullOriginalHtmlArchivePath, sourceHtmlSha256: row.sourceHtmlSha256,
    nativePostArchivePath: row.nativePostArchivePath, nativePostArchiveSha256: row.nativePostArchiveSha256, originalBodyHtmlSha256: row.originalBodyHtmlSha256,
    nativeFeedArchivePath: row.testFeedPath ?? JSON.parse(row.rawVisibleText ?? "{}").nativeFeedArchivePath,
    nativeFeedArchiveSha256: row.testFeedSha ?? JSON.parse(row.rawVisibleText ?? "{}").nativeFeedArchiveSha256,
    ...(validation ? { validation } : {}) });
}
async function fixture(t, { footer = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "fall-publication-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const put = async (path, text) => { await mkdir(dirname(join(directory, path)), { recursive: true }); await writeFile(join(directory, path), text); return sha(text); };
  const company = { slug: "particularity", name: "Particularity", websiteUrl: "https://particularity.io", ycProfileUrl: "https://www.ycombinator.com/companies/particularity" };
  const publication = "https://particularity.substack.com/", sourceUrl = `${publication}p/original`, title = "Original article", text = "Exact original article prose.\n\nA second paragraph.";
  const body = "<p>Exact original article prose.</p><p>A second paragraph.</p>", bylines = [{ id: 7, name: "Native Author" }], postedAt = "2026-11-16T12:00:00.100Z", observedAt = "2026-11-16T13:00:00Z";
  const native = { id: 12345, publication_id: 6322238, canonical_url: sourceUrl, title, body_html: body, post_date: postedAt, publishedBylines: bylines, audience: "everyone", is_published: true, is_geoblocked: false };
  const root = "outputs/fall-2026/particularity-substack-cache", htmlPath = `${root}/article.html`, nativePath = `${root}/native.json`, feedPath = `${root}/feed.xml`;
  const html = `<html><script id="preloads-json" type="application/json">${JSON.stringify({ post: native })}</script></html>`, htmlSha = await put(htmlPath, html);
  const nativeSha = await put(nativePath, JSON.stringify({ requestedUrl: sourceUrl, observedAt, sourceHtmlArchivePath: htmlPath, sourceHtmlSha256: htmlSha, nativePost: native }));
  const feedLiteral = "Mon, 16 Nov 2026 12:00:00 GMT", feedSha = await put(feedPath, `<rss><channel><item><title>${title}</title><link>${sourceUrl}</link><pubDate>${feedLiteral}</pubDate></item></channel></rss>`);
  const anchorHtml = `<a href="${publication}">Substack</a>`, homePath = "outputs/fall-2026/public-history-cache/particularity/home.html", homeSha = await put(homePath, footer ? `<footer>${anchorHtml}</footer>` : `<section class="testimonial">${anchorHtml}</section>`);
  const inventoryPath = "outputs/source-hunt/2026-11-15-fall-2026-other-platform-official-outbound-inventory.json";
  const inventorySha = await put(inventoryPath, JSON.stringify({ ownedTargets: [{ companySlug: company.slug, sourceUrl: publication, ownershipStatus: "official_company_publication_link", sourceHtmlSha256: homeSha, sourceHtmlArchivePath: homePath, anchorHtml, anchorText: "Substack", discoveredOn: `${company.websiteUrl}/` }] }));
  const owner = { source: "official_company_homepage_publication_anchor_v1", companySlug: company.slug, companyName: company.name, officialYcProfileUrl: company.ycProfileUrl, officialWebsite: company.websiteUrl, discoveredOn: `${company.websiteUrl}/`, publicationUrl: publication, nativePublicationId: 6322238, anchorHtml, anchorText: "Substack", ownershipInventoryPath: inventoryPath, ownershipInventorySha256: inventorySha, officialHomepageArchivePath: homePath, officialHomepageSha256: homeSha };
  const row = { platform: "web", publisherPlatform: "substack", platformPostId: sourceUrl, sourceUrl, nativePostId: "12345", nativePublicationId: 6322238, batchSlug: "F26", companySlug: company.slug, companyName: company.name, entityType: "company", entityId: "company-particularity", authorName: "Native Author", nativePublishedBylines: bylines, title, text, originalText: text, postedAt, nativePublishedAtLiteral: postedAt, nativeFeedPublishedAtLiteral: feedLiteral, observedAt,
    metrics: {}, contributionScore: 0, originalBodyHtml: body, originalBodyHtmlSha256: sha(body), fullOriginalHtmlArchivePath: htmlPath, sourceHtmlSha256: htmlSha, nativePostArchivePath: nativePath, nativePostArchiveSha256: nativeSha, bodyCompleteness: "full_native_publication_body_html", nativeAudience: "everyone", nativeIsPublished: true, bodyPaywalled: false, officialPublicationOwnership: owner, testFeedPath: feedPath, testFeedSha: feedSha };
  rebuildRaw(row); delete row.testFeedPath; delete row.testFeedSha;
  await put("src/lib/yc/fall-2026-companies.json", JSON.stringify({ companies: [company] }));
  const older = { id: "older-row", batchSlug: "S26", entityId: "company-particularity", sourceUrl, text: "Older original stays unchanged." };
  await put("target.json", JSON.stringify({ source: {}, evidence: [older] }));
  const save = (r) => put("input.json", JSON.stringify({ context: [r] })); await save(row);
  return { directory, company, row, older, target: join(directory, "target.json"), htmlPath: join(directory, htmlPath), nativePath: join(directory, nativePath), feedPath: join(directory, feedPath), save };
}
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const run = (f, mode, output, extra = {}) => ingestFallPublicationContext({ root: f.directory, mode, input: "input.json", target: "target.json", output, ...extra });
