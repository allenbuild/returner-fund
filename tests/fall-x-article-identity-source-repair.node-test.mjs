import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { physicallyReviewNativeXArticleContexts } from "../scripts/review-fall-2026-x-native-article-context.mjs";
import { NATIVE_ARTICLE_LEDGER_KIND, nativeArticleLocalContextId, verifyNativeXArticleContextLedger } from "../scripts/ingest-fall-2026-x-article-context.mjs";
import { planNativeXArticleIdentitySourceRepair, repairNativeXArticleIdentitySources } from "../scripts/repair-fall-2026-x-article-identity-source.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const ledgerPath = "src/lib/social/native-article-context-fall-2026.json", targetedPath = "src/lib/social/targeted-evidence-current.json", rosterPath = "src/lib/yc/fall-2026-companies.json";
const owners = [
  { slug: "acyclic", name: "Acyclic", id: "2012796", founderName: "Varun Latthe", handle: "var1377", person: "varun-latthe", ids: ["2110100931102822530"] },
  { slug: "adsideai", name: "Adside.ai", id: "406206", founderName: "Robin Choy", handle: "choyrb", person: "robin-choy", ids: ["2078193804763680972", "2059381458561851599"] },
  { slug: "agent-37", name: "Agent37", id: "316679", founderName: "Vishnu Krishnaprasad", handle: "an_engineer_log", person: "vishnu-krishnaprasad", ids: ["2111159645419270578", "2042693710127730995", "2042017042539196688"] },
];
async function fixture(t) {
  const rootDir = await mkdtemp(resolve(tmpdir(), "article-source-repair-")); t.after(() => rm(rootDir, { recursive: true, force: true }));
  const observedAt = "2026-11-16T11:00:00.000Z", postedAt = "2026-11-16T10:00:00.000Z", nativeRecords = [], evidence = [];
  const companies = owners.map((owner) => ({ slug: owner.slug, name: owner.name, ycProfileUrl: `https://www.ycombinator.com/companies/${owner.slug}`, founders: [{ id: owner.id, name: owner.founderName, ycProfileUrl: `https://www.ycombinator.com/people/${owner.person}`, socialLinks: { x: `https://x.com/${owner.handle}` } }] }));
  for (const owner of owners) for (const id of owner.ids) {
    const account = `https://x.com/${owner.handle}`, url = `${account}/status/${id}`, anchor = `<a href="/${owner.handle}">${owner.founderName}</a>`;
    const header = { text: `${owner.founderName}\n@${owner.handle}`, html: `<div data-testid="User-Name">${anchor}<span>@${owner.handle}</span></div>`, links: [{ href: account, text: owner.founderName, html: anchor }] };
    const title = `Title ${id}`, body = `Full exact native body ${id}.`, titleHtml = `<div data-testid="twitter-article-title">${title}</div>`, bodyHtml = `<div data-testid="twitterArticleRichTextView"><p>${body}</p></div>`, view = `<div data-testid="twitterArticleReadView">${titleHtml}${bodyHtml}</div>`, timeHtml = `<a href="/${owner.handle}/status/${id}"><time datetime="${postedAt}">5:00 AM</time></a>`;
    nativeRecords.push({ source: "authorized_native_x_article_dom_v1", pageUrl: url, nativePostUrl: url, nativePublishedAt: postedAt, nativeTimeHtml: timeHtml, nativeAuthorHeader: header, title, titleHtml, body, bodyHtml, readViewHtml: view, nativeMainHtml: `<main>${header.html}${view}${timeHtml}</main>`, observedAt });
    const entityId = `founder-${owner.slug}-${owner.founderName.toLowerCase().replaceAll(" ", "-")}-${owner.id}`;
    evidence.push({ batchSlug: "F26", companySlug: owner.slug, entityId, platform: "x", platformPostId: id, sourceUrl: url, accountUrl: account, text: `Outer caption ${id}.`, postedAt, bodyTruncated: false, rawVisibleText: JSON.stringify({ source: "authenticated_native_x_ui_v1", post: { platformPostId: id, authorHandle: owner.handle, text: `Outer caption ${id}.`, bodyTruncated: false } }) });
  }
  const archivePath = "outputs/fall-2026/browser-checkpoints/native.json", outerPostArchivePath = "outputs/fall-2026/collection/outer.json";
  const documents = [[archivePath, { source: { exportedAt: "2026-11-16T12:00:00.000Z", nativeArticleBodiesAfterControlReset: nativeRecords } }], [outerPostArchivePath, { evidence }], [rosterPath, { companies }], [targetedPath, { source: { untouched: true }, evidence: [{ batchSlug: "S26", text: "Earlier cohort bytes stay exact." }] }]];
  const put = async (path, value) => { await mkdir(dirname(resolve(rootDir, path)), { recursive: true }); const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`); await writeFile(resolve(rootDir, path), bytes); return bytes; };
  const bytes = new Map(); for (const [path, value] of documents) bytes.set(path, await put(path, value));
  const reviewed = await physicallyReviewNativeXArticleContexts({ rootDir, archivePath, archiveSha256: sha(bytes.get(archivePath)), outerPostArchivePath, outerPostArchiveSha256: sha(bytes.get(outerPostArchivePath)) });
  assert.equal(reviewed.candidates.length, 6); assert.deepEqual(reviewed.needsReview, []);
  const contexts = reviewed.candidates.map((candidate) => {
    const company = companies.find((company) => company.slug === candidate.companySlug), raw = JSON.parse(candidate.rawVisibleText); raw.admissionStatus = "verified_separate_article_body_context";
    return { ...candidate, identitySourceUrl: company.founders[0].ycProfileUrl, contextId: nativeArticleLocalContextId(candidate), countsAsNativePost: false, admissionStatus: "verified_separate_article_body_context", review_state: "verified", attributionStatus: "verified", rawVisibleText: JSON.stringify(raw) };
  });
  const ledger = { source: { kind: NATIVE_ARTICLE_LEDGER_KIND, batchSlug: "F26", namespace: "local_body_context", countsAsNativePosts: false, contextCount: 6, nativePostsAdded: 0 }, contexts };
  const ledgerBytes = await put(ledgerPath, ledger);
  return { rootDir, ledger, roster: { companies }, ledgerBytes, expectedTargetSha256: sha(ledgerBytes), expectedTargetedSha256: sha(bytes.get(targetedPath)), targetedBytes: bytes.get(targetedPath), observedAt };
}

test("six-source dry-run physically rehashes all native archives and changes only explicit display metadata", async (t) => {
  const f = await fixture(t), result = await repairNativeXArticleIdentitySources(f);
  assert.equal(result.audit.corrected, 6); assert.equal(result.audit.verification.archives.length, 3); assert.equal(result.audit.written, false); assert.equal(result.audit.sourceMetadataUnchanged, true);
  assert.deepEqual(await readFile(resolve(f.rootDir, ledgerPath)), f.ledgerBytes); assert.deepEqual(await readFile(resolve(f.rootDir, targetedPath)), f.targetedBytes);
  for (const [index, row] of result.ledger.contexts.entries()) {
    const before = f.ledger.contexts[index], copy = { ...row }; delete copy.historicalUnverifiedFounderDisplayUrl; copy.identitySourceUrl = before.identitySourceUrl;
    assert.deepEqual(copy, before); assert.equal(row.historicalUnverifiedFounderDisplayUrl.verified, false); assert.equal(row.historicalUnverifiedFounderDisplayUrl.usedForIdentityAdmission, false);
    assert.equal(row.identitySourceUrl, `https://www.ycombinator.com/companies/${row.companySlug}`);
  }
  assert.equal((await verifyNativeXArticleContextLedger(result.ledger, { rootDir: f.rootDir })).ok, true);
});
test("exact existing-ledger CAS write is idempotent and preserves targeted canonical bytes", async (t) => {
  const f = await fixture(t), first = await repairNativeXArticleIdentitySources({ ...f, mode: "write" }); assert.equal(first.audit.written, true);
  const saved = await readFile(resolve(f.rootDir, ledgerPath)), second = await repairNativeXArticleIdentitySources({ ...f, mode: "write", expectedTargetSha256: sha(saved) });
  assert.equal(second.audit.corrected, 0); assert.equal(second.audit.written, false); assert.deepEqual(await readFile(resolve(f.rootDir, ledgerPath)), saved); assert.deepEqual(await readFile(resolve(f.rootDir, targetedPath)), f.targetedBytes);
});
test("write requires exact CAS and respects another writer's lock", async (t) => {
  const f = await fixture(t);
  await assert.rejects(() => repairNativeXArticleIdentitySources({ ...f, mode: "write", expectedTargetSha256: undefined }), /expected existing/);
  await assert.rejects(() => repairNativeXArticleIdentitySources({ ...f, mode: "write", expectedTargetSha256: "a".repeat(64) }), /CAS precondition/);
  await writeFile(resolve(f.rootDir, `${ledgerPath}.lock`), "another writer");
  await assert.rejects(() => repairNativeXArticleIdentitySources({ ...f, mode: "write" }), { code: "EEXIST" });
  assert.equal(await readFile(resolve(f.rootDir, `${ledgerPath}.lock`), "utf8"), "another writer"); assert.deepEqual(await readFile(resolve(f.rootDir, ledgerPath)), f.ledgerBytes);
});
test("extra rows, wrong owners and arbitrary identity replacements fail the exact-six plan", async (t) => {
  const f = await fixture(t);
  for (const mutate of [(ledger) => ledger.contexts.push(ledger.contexts[0]), (ledger) => { ledger.contexts[0].founderId = "wrong"; }, (ledger) => { ledger.contexts[0].identitySourceUrl = "https://example.com/invented-proof"; }]) {
    const ledger = structuredClone(f.ledger); mutate(ledger); assert.throws(() => planNativeXArticleIdentitySourceRepair(ledger, f.roster));
  }
});
test("unchanged-field body corruption and raw archive substitutions fail physical review before repair write", async (t) => {
  const f = await fixture(t);
  for (const mutate of [(row) => { row.text += " fabricated"; }, (row) => { const raw = JSON.parse(row.rawVisibleText); raw.outerPostRecordPointer = "/evidence/999"; row.rawVisibleText = JSON.stringify(raw); }]) {
    const copy = structuredClone(f.ledger); mutate(copy.contexts[0]); const bytes = Buffer.from(JSON.stringify(copy)); await writeFile(resolve(f.rootDir, ledgerPath), bytes);
    await assert.rejects(() => repairNativeXArticleIdentitySources({ ...f, mode: "write", expectedTargetSha256: sha(bytes) })); assert.deepEqual(await readFile(resolve(f.rootDir, ledgerPath)), bytes);
  }
});
test("concurrent targeted changes are detected without committing the Article metadata ledger", async (t) => {
  const f = await fixture(t); let changed = false;
  await assert.rejects(() => repairNativeXArticleIdentitySources({ ...f, mode: "write", readArchive: async (path) => { if (!changed) { changed = true; await writeFile(resolve(f.rootDir, targetedPath), "concurrent targeted write"); } return readFile(resolve(f.rootDir, path)); } }), /Targeted-evidence byte guard/);
  assert.deepEqual(await readFile(resolve(f.rootDir, ledgerPath)), f.ledgerBytes);
});
