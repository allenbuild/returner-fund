import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { ingestNativeXArticleContexts, verifyNativeXArticleContextLedger, nativeArticleLocalContextId } from "../scripts/ingest-fall-2026-x-article-context.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const target = "src/lib/social/native-article-context-fall-2026.json", targeted = "src/lib/social/targeted-evidence-current.json";
async function fixture(t) {
  const rootDir = await mkdtemp(resolve(tmpdir(), "fall-x-article-")); t.after(() => rm(rootDir, { recursive: true, force: true }));
  const account = "https://x.com/janefounder", url = `${account}/status/1234567890123456789`, postedAt = "2026-11-16T10:00:00.000Z", observedAt = "2026-11-16T11:00:00.000Z";
  const anchor = '<a href="/janefounder">Jane Founder</a>', header = { text: "Jane Founder\n@janefounder", html: `<div data-testid="User-Name">${anchor}<span>@janefounder</span></div>`, links: [{ href: account, text: "Jane Founder", html: anchor }] };
  const titleHtml = '<div data-testid="twitter-article-title">Native title</div>', bodyHtml = '<div data-testid="twitterArticleRichTextView"><p>Full native &amp; exact body.</p></div>', view = `<div data-testid="twitterArticleReadView">${titleHtml}${bodyHtml}</div>`, timeHtml = `<a href="/janefounder/status/1234567890123456789"><time datetime="${postedAt}">5:00 AM</time></a>`;
  const record = { source: "authorized_native_x_article_dom_v1", pageUrl: url, nativePostUrl: url, nativePublishedAt: postedAt, nativeTimeHtml: timeHtml, nativeAuthorHeader: header, title: "Native title", titleHtml, body: "Full native & exact body.", bodyHtml, readViewHtml: view, nativeMainHtml: `<main>${header.html}${view}${timeHtml}</main>`, observedAt };
  const outer = { batchSlug: "F26", companySlug: "example", entityId: "founder-example-jane-founder-42", platform: "x", platformPostId: "1234567890123456789", sourceUrl: url, accountUrl: account, text: "Preserved outer caption.", postedAt, bodyTruncated: false, rawVisibleText: JSON.stringify({ source: "authenticated_native_x_ui_v1", post: { platformPostId: "1234567890123456789", authorHandle: "janefounder", text: "Preserved outer caption.", bodyTruncated: false } }) };
  const archivePath = "outputs/fall-2026/browser-checkpoints/x-ui-base-1.json", outerPostArchivePath = "outputs/fall-2026/collection/x-native-sealed-1.json", rosterPath = "src/lib/yc/fall-2026-companies.json";
  const data = new Map([[archivePath, { source: { exportedAt: "2026-11-16T12:00:00.000Z", nativeArticleBodiesAfterControlReset: [record] } }], [outerPostArchivePath, { evidence: [outer], candidates: [] }], [rosterPath, { companies: [{ slug: "example", name: "Example", ycProfileUrl: "https://www.ycombinator.com/companies/example", founders: [{ id: "42", name: "Jane Founder", ycProfileUrl: "https://www.ycombinator.com/people/jane-founder", socialLinks: { x: account } }] }] }]]);
  const bytes = new Map();
  for (const [path, value] of data) { await mkdir(dirname(resolve(rootDir, path)), { recursive: true }); const buffer = Buffer.from(`${JSON.stringify(value)}\n`); await writeFile(resolve(rootDir, path), buffer); bytes.set(path, buffer); }
  await mkdir(dirname(resolve(rootDir, targeted)), { recursive: true }); await writeFile(resolve(rootDir, targeted), "unchanged targeted bytes\n");
  return { rootDir, bytes, observedAt: "2026-11-16T12:30:00.000Z", reviewOptions: { archivePath, archiveSha256: sha(bytes.get(archivePath)), outerPostArchivePath, outerPostArchiveSha256: sha(bytes.get(outerPostArchivePath)) } };
}

test("dry-run physically verifies context/outer/roster without any canonical mutation or native post ID", async (t) => {
  const f = await fixture(t), before = await readFile(resolve(f.rootDir, targeted)), result = await ingestNativeXArticleContexts(f);
  assert.equal(result.audit.appended, 1); assert.equal(result.audit.written, false); assert.equal(result.audit.nativePostsAdded, 0);
  await assert.rejects(access(resolve(f.rootDir, target)), { code: "ENOENT" });
  assert.deepEqual(await readFile(resolve(f.rootDir, targeted)), before);
  const row = result.ledger.contexts[0];
  assert.equal(row.identitySourceUrl, "https://www.ycombinator.com/companies/example");
  assert.equal(row.contextId, nativeArticleLocalContextId(row)); assert.match(row.contextId, /^local-body-context-/); assert.equal(Object.hasOwn(row, "platformPostId"), false); assert.equal(row.articleNativeId, null); assert.equal(row.countsAsNativePost, false);
  assert.equal(row.outerPostText, "Preserved outer caption."); assert.equal(row.text, "Full native & exact body."); assert.equal(row.contributionScore, 0);
  const verified = await verifyNativeXArticleContextLedger(result.ledger, { rootDir: f.rootDir }); assert.equal(verified.contexts, 1); assert.equal(verified.archives.length, 3);
});
test("derived person display URLs cannot claim to be the physically fetched founder identity source", async (t) => {
  const f = await fixture(t), result = await ingestNativeXArticleContexts(f);
  result.ledger.contexts[0].identitySourceUrl = "https://www.ycombinator.com/people/jane-founder";
  await assert.rejects(() => verifyNativeXArticleContextLedger(result.ledger, { rootDir: f.rootDir }), /official company-payload founder source/);
});
test("explicit missing CAS writes once; identical body tuple dedupes append-only without rewriting earlier rows", async (t) => {
  const f = await fixture(t), first = await ingestNativeXArticleContexts({ ...f, mode: "write", expectedTargetSha256: "missing" });
  assert.equal(first.audit.written, true); const bytes = await readFile(resolve(f.rootDir, target));
  const second = await ingestNativeXArticleContexts({ ...f, mode: "write", expectedTargetSha256: sha(bytes) });
  assert.equal(second.audit.appended, 0); assert.equal(second.audit.duplicates, 1); assert.equal(second.audit.written, false);
  assert.deepEqual(await readFile(resolve(f.rootDir, target)), bytes); assert.equal(second.audit.targetedEvidenceBytesUnchanged, true);
});
test("write requires an explicit expected SHA or missing, and stale CAS fails before publication", async (t) => {
  const f = await fixture(t);
  await assert.rejects(() => ingestNativeXArticleContexts({ ...f, mode: "write" }), /expected target SHA/);
  await assert.rejects(() => ingestNativeXArticleContexts({ ...f, mode: "write", expectedTargetSha256: "a".repeat(64) }), /CAS precondition/);
  await assert.rejects(access(resolve(f.rootDir, target)), { code: "ENOENT" });
});
test("native/outer/roster archives are rehashed and an optional frozen byte resolver remains verifiable", async (t) => {
  const f = await fixture(t), result = await ingestNativeXArticleContexts(f);
  await writeFile(resolve(f.rootDir, f.reviewOptions.archivePath), "changed native bytes");
  await assert.rejects(() => verifyNativeXArticleContextLedger(result.ledger, { rootDir: f.rootDir }), /archive SHA mismatch/);
  const frozen = await verifyNativeXArticleContextLedger(result.ledger, { rootDir: f.rootDir, readArchive: async (path) => f.bytes.get(path) }); assert.equal(frozen.ok, true);
  await assert.rejects(() => verifyNativeXArticleContextLedger(result.ledger, { rootDir: f.rootDir, readArchive: async () => Buffer.from("wrong frozen bytes") }), /archive SHA mismatch/);
});
test("existing body corruption, native-ID conflation and pointer substitution are rejected on the next write", async (t) => {
  const f = await fixture(t), result = await ingestNativeXArticleContexts(f);
  for (const mutate of [(row) => { row.text += " changed"; }, (row) => { row.platformPostId = row.outerNativePostId; }, (row) => { const raw = JSON.parse(row.rawVisibleText); raw.outerPostRecordPointer = "/evidence/999"; row.rawVisibleText = JSON.stringify(raw); }]) {
    const copy = structuredClone(result.ledger); mutate(copy.contexts[0]); const bytes = Buffer.from(JSON.stringify(copy)); await writeFile(resolve(f.rootDir, target), bytes);
    await assert.rejects(() => ingestNativeXArticleContexts({ ...f, mode: "write", expectedTargetSha256: sha(bytes) }));
    assert.deepEqual(await readFile(resolve(f.rootDir, target)), bytes);
  }
});
test("targeted-evidence byte guard catches concurrent changes before a context ledger commit", async (t) => {
  const f = await fixture(t); let changed = false;
  await assert.rejects(() => ingestNativeXArticleContexts({ ...f, mode: "write", expectedTargetSha256: "missing", readArchive: async (path) => { if (!changed) { changed = true; await writeFile(resolve(f.rootDir, targeted), "external concurrent change"); } return f.bytes.get(path); } }), /Targeted-evidence byte guard/);
  await assert.rejects(access(resolve(f.rootDir, target)), { code: "ENOENT" });
});
test("another writer's exclusive lock is preserved and prevents a context commit", async (t) => {
  const f = await fixture(t), lock = `${resolve(f.rootDir, target)}.lock`; await writeFile(lock, "other writer");
  await assert.rejects(() => ingestNativeXArticleContexts({ ...f, mode: "write", expectedTargetSha256: "missing" }), { code: "EEXIST" });
  assert.equal(await readFile(lock, "utf8"), "other writer"); await assert.rejects(access(resolve(f.rootDir, target)), { code: "ENOENT" });
});
