import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { facebookNativeIdentity, isVerifiedNativeFacebookReceipt, nativeFacebookCaption } from "../src/lib/graph/facebook-native-receipt.mjs";
const root = resolve(import.meta.dirname, ".."), company = { slug: "covera", name: "Covera", websiteUrl: "https://www.covera-agents.com/", ycProfileUrl: "https://www.ycombinator.com/companies/covera" };
const account = "https://www.facebook.com/covera.agents", id = "pfbidExactCaseSensitiveNativePost", observedAt = "2026-11-16T17:20:00Z";
const sha = (value) => createHash("sha256").update(value).digest("hex");

test("Facebook full captions keep native author/permalink ownership and unknown timezone without a traction score", async (t) => {
  const f = await fixture(t), result = convert(f); assert.equal(result.status, 0, result.stderr);
  const [row] = (await json(join(f.directory, "converted.json"))).evidence;
  assert.equal(row.text, "Exact original Facebook caption."); assert.equal(row.originalText, row.text);
  assert.equal(row.nativeContentKind, "authored_post"); assert.equal(row.countsAsAuthoredPost, true);
  assert.deepEqual(row.metrics, {}); assert.equal(row.postedAt, null); assert.equal(row.contributionScore, 0); assert.equal(row.tractionStatus, "unscored");
  assert.equal(row.nativePublishedAtLiteral, "Monday, October 5, 2026 at 4:52 PM");
  assert.equal(isVerifiedNativeFacebookReceipt(row, company), true);
  for (const mutation of [{ text: "Different body" }, { entityId: "company-other" }, { authorName: "Another Author" }, { accountUrl: "https://www.facebook.com/unrelated" }, { metrics: { reactions: 1 } }, { contributionScore: 5 }, { postedAt: "2026-10-05T16:52:00Z" }]) assert.equal(isVerifiedNativeFacebookReceipt({ ...row, ...mutation }, company), false, JSON.stringify(mutation));
});

test("Facebook native profile updates are typed empty metadata rather than invented authored captions", async (t) => {
  const f = await fixture(t, "update"); assert.equal(convert(f).status, 0);
  const [row] = (await json(join(f.directory, "converted.json"))).evidence;
  assert.equal(row.text, ""); assert.equal(row.originalText, ""); assert.equal(row.captionAbsent, true);
  assert.equal(row.nativeContentKind, "profile_photo_update"); assert.equal(row.countsAsAuthoredPost, false);
  assert.equal(isVerifiedNativeFacebookReceipt(row, company), true);
});

test("an actual See more control prevents partial body admission, and See less is removed only with its native control", async (t) => {
  const f = await fixture(t, "partial"); assert.equal(convert(f).status, 0);
  const output = await json(join(f.directory, "converted.json")); assert.equal(output.evidence.length, 0); assert.deepEqual(output.needsReview[0].reasons, ["native_caption_not_expanded"]);
  assert.equal(nativeFacebookCaption({ captionNodes: ["Authored words See less"], controls: [], nativeText: "Authored words See less" }, "Covera").text, "Authored words See less");
});

test("changed physical official ownership HTML and receipt body hashes fail closed", async (t) => {
  const f = await fixture(t); assert.equal(convert(f).status, 0);
  const [row] = (await json(join(f.directory, "converted.json"))).evidence;
  const raw = JSON.parse(row.rawVisibleText); raw.post.nativeObservation.nativeText = "Forged native body"; row.rawVisibleText = JSON.stringify(raw);
  assert.equal(isVerifiedNativeFacebookReceipt(row, company), false);
  await put(f.directory, "home.html", "Changed source archive"); const result = convert(f); assert.notEqual(result.status, 0); assert.match(result.stderr, /ownership archive failed/);
});

test("strict Facebook import requires the explicit scoped unscored-history gate and preserves the original native identity", async (t) => {
  const f = await fixture(t), input = await json(join(f.directory, "input.json"));
  const second = structuredClone(input.nativePosts[0]); second.sourceUrl = `${account}/posts/pfbidSecondDistinctNativePost`; second.links[1].url = second.sourceUrl;
  input.nativePosts.push(second); await put(f.directory, "input.json", input);
  assert.equal(convert(f).status, 0);
  for (const file of ["public-evidence-current.json", "logged-in-evidence-current.json", "targeted-evidence-current.json", "a16z-speedrun-006-social-evidence.json"]) await put(f.directory, `src/lib/social/${file}`, { source: {}, evidence: [] });
  for (const file of ["github-traction.json", "github-traction-summer-2026.json", "github-traction-a16z-speedrun-006.json"]) await put(f.directory, `src/lib/social/${file}`, { source: {}, accounts: [] });
  await put(f.directory, "target.json", { source: {}, evidence: [] });
  const run = (...args) => spawnSync(process.execPath, [join(root, "scripts/import-source-hunt-evidence.mjs"), `--input=${join(f.directory, "converted.json")}`, `--target=${join(f.directory, "target.json")}`, `--external-evidence-root=${f.directory}`, `--observed-at=${observedAt}`, "--include-batches=F26", "--scope-batch-dedupe", "--strict", ...args], { cwd: root, encoding: "utf8" });
  assert.notEqual(run("--dry-run").status, 0);
  const result = run("--retain-zero-engagement", "--write"); assert.equal(result.status, 0, result.stderr || result.stdout);
  const rows = (await json(join(f.directory, "target.json"))).evidence; assert.equal(rows.length, 2, "distinct verified native posts retain their identical captions");
  const [row] = rows; assert.equal(row.platformPostId, id); assert.equal(row.postedAt, null); assert.equal(row.contributionScore, 0); assert.equal(isVerifiedNativeFacebookReceipt(row, company), true);
});

test("native permalink.php keeps page, story and substory identity while tracking is removed", () => {
  const url = "https://www.facebook.com/permalink.php?story_fbid=122123090691317209&id=61589516291255&substory_index=1671907554373987&__tn__=tracking";
  const identity = facebookNativeIdentity(url);
  assert.equal(identity.postId, "permalink:61589516291255:122123090691317209:1671907554373987");
  assert.equal(identity.sourceUrl, "https://www.facebook.com/permalink.php?story_fbid=122123090691317209&id=61589516291255&substory_index=1671907554373987");
  assert.equal(identity.accountKey, facebookNativeIdentity("https://www.facebook.com/people/Rhem-Labs/61589516291255/").accountKey);
  assert.notEqual(identity.postId, facebookNativeIdentity(url.replace("1671907554373987", "1671907554373988")).postId);
  assert.equal(facebookNativeIdentity("https://www.facebook.com/permalink.php?story_fbid=123"), null);
});

test("native Facebook reels require the separately observed own-author heading rather than borrowing profile membership", async (t) => {
  const f = await fixture(t), input = await json(join(f.directory, "input.json")), article = input.nativePosts[0];
  article.sourceUrl = "https://www.facebook.com/reel/2134164507311308/?__tn__=tracking";
  article.links[1].url = article.sourceUrl;
  article.nativeAuthorHeader = { mechanism: "native_post_feed_heading_v1", text: "Covera", url: account };
  article.headings = [{ text: "Covera", links: [{ text: "Covera", url: account }] }];
  await put(f.directory, "input.json", input);
  assert.equal(convert(f).status, 0);
  const [row] = (await json(join(f.directory, "converted.json"))).evidence;
  assert.equal(row.platformPostId, "reel:2134164507311308"); assert.equal(row.sourceUrl, "https://www.facebook.com/reel/2134164507311308");
  assert.equal(isVerifiedNativeFacebookReceipt(row, company), true);
  delete article.nativeAuthorHeader;
  await put(f.directory, "input.json", input); assert.equal(convert(f).status, 0);
  assert.equal((await json(join(f.directory, "converted.json"))).evidence.length, 0);
});

test("an expanded native reel detail may replace its same-ID truncated feed caption, with exact owner and body continuity", async (t) => {
  const f = await fixture(t, "partial"), input = await json(join(f.directory, "input.json")), article = input.nativePosts[0];
  const url = "https://www.facebook.com/reel/2233686067411381", caption = "Truncated words plus the full native body.";
  article.sourceUrl = url; article.links[1].url = url; article.observationPageUrl = account;
  article.nativeAuthorHeader = { mechanism: "native_post_feed_heading_v1", text: "Covera", url: account };
  article.headings = [{ text: "Covera", links: [{ text: "Covera", url: account }] }];
  article.priorIncompleteObservation = structuredClone(article);
  article.captionNodes = [{ visibleText: caption, controlLabels: [] }]; article.nativeText = `Log In\n${caption}\nCovera\nPublic`;
  article.nativeReelDetailReceipt = { mechanism: "native_facebook_reel_caption_v1", url, text: caption, nativeText: article.nativeText, observedAt, ownerHeading: ["Covera"], controls: [], html: `<span><div>${caption}</div></span>` };
  await put(f.directory, "input.json", input); assert.equal(convert(f).status, 0);
  const [row] = (await json(join(f.directory, "converted.json"))).evidence;
  assert.equal(row.originalText, caption); assert.equal(row.nativePublishedAtLiteral, "Monday, October 5, 2026 at 4:52 PM");
  assert.equal(isVerifiedNativeFacebookReceipt(row, company), true);
  for (const mutate of [
    (copy) => { copy.nativeReelDetailReceipt.url = "https://www.facebook.com/reel/999"; },
    (copy) => { copy.nativeReelDetailReceipt.ownerHeading = ["Unrelated owner"]; },
    (copy) => { copy.nativeReelDetailReceipt.html = "<div>Different body</div>"; },
    (copy) => { copy.priorIncompleteObservation.nativeAuthorHeader.url = "https://www.facebook.com/unrelated"; }
  ]) {
    const copy = structuredClone(article); mutate(copy); input.nativePosts = [copy]; await put(f.directory, "input.json", input);
    assert.equal(convert(f).status, 0); assert.equal((await json(join(f.directory, "converted.json"))).evidence.length, 0);
  }
});

async function put(directory, path, value) { await mkdir(dirname(join(directory, path)), { recursive: true }); await writeFile(join(directory, path), typeof value === "string" ? value : JSON.stringify(value)); }
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
async function fixture(t, mode = "full") {
  const directory = await mkdtemp(join(tmpdir(), "fall-facebook-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const anchorHtml = `<a href="${account}">Facebook</a>`, html = `<footer>${anchorHtml}</footer>`; await put(directory, "home.html", html);
  await put(directory, "src/lib/yc/fall-2026-companies.json", { companies: [company] });
  await put(directory, "inventory.json", { ownedTargets: [{ companySlug: company.slug, companyName: company.name, officialWebsite: company.websiteUrl, discoveredOn: company.websiteUrl, platform: "facebook", sourceUrl: account, ownershipStatus: "official_company_account_or_community_link", anchorHtml, sourceHtmlArchivePath: "home.html", sourceHtmlSha256: sha(html) }] });
  const sourceUrl = `${account}/posts/${id}`;
  const captionNodes = mode === "update" ? [] : [{ visibleText: mode === "partial" ? "Truncated words… See more" : "Exact original Facebook caption. See less", controlLabels: [mode === "partial" ? "See more" : "See less"] }];
  const article = { platform: "facebook", companySlug: company.slug, profileUrl: account, sourceUrl, observedAt, captionNodes, controls: [], nativeText: `${mode === "update" ? "Covera updated their profile picture." : "Covera"}\nMonday, October 5, 2026 at 4:52 PM\n${captionNodes[0]?.visibleText ?? ""}\nLike\nComment`, times: [], media: [{ src: "https://example.fbcdn.net/native-post.jpg" }], links: [{ text: "Covera", url: account }, { text: "October 5", url: sourceUrl }] };
  await put(directory, "input.json", { source: { batchSlug: "F26" }, profiles: [{ platform: "facebook", companySlug: company.slug, url: account, identity: "Covera", observedAt }], nativePosts: [article] });
  return { directory };
}
function convert(f) { return spawnSync(process.execPath, [join(root, "scripts/convert-fall-2026-facebook-observations.mjs"), "--input=input.json", "--inventory=inventory.json", "--output=converted.json"], { cwd: f.directory, encoding: "utf8" }); }
