import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { isVerifiedNativeTikTokReceipt, nativeTikTokMetrics } from "../src/lib/graph/tiktok-native-receipt.mjs";

const root = resolve(import.meta.dirname, "..");
const company = { slug: "kairos-health", name: "Kairos Health", websiteUrl: "https://kairoshealthai.com", ycProfileUrl: "https://www.ycombinator.com/companies/kairos-health" };
const profileUrl = "https://www.tiktok.com/@kairosdental_", postId = "7695466114939145486";
const observedAt = "2026-11-16T17:20:00.000Z";
const sha = (value) => createHash("sha256").update(value).digest("hex");

test("native TikTok conversion verifies the physical official anchor and keeps full caption, literal counts and unknown year", async (t) => {
  const f = await fixture(t), result = runConverter(f);
  assert.equal(result.status, 0, result.stderr);
  const rows = JSON.parse(await readFile(join(f.directory, "converted.json"), "utf8")).evidence;
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.originalText, "Exact original TikTok caption. 🦷");
  assert.deepEqual(row.metrics, { likes: 3, comments: 0, saves: 2 });
  assert.equal(row.contributionScore, 0); assert.equal(row.tractionStatus, "unscored");
  assert.equal(row.postedAt, null); assert.equal(row.publishedAtPrecision, "unknown");
  assert.equal(isVerifiedNativeTikTokReceipt(row, company), true);
  for (const mutation of [{ text: "Altered body" }, { entityId: "company-other" }, { authorHandle: "unrelated" }, { platformPostId: "1" }, { metrics: { likes: 4, comments: 0, saves: 2 } }, { postedAt: "2026-10-11T00:00:00Z" }]) {
    assert.equal(isVerifiedNativeTikTokReceipt({ ...row, ...mutation }, company), false, JSON.stringify(mutation));
  }
  const forged = structuredClone(row), receipt = JSON.parse(forged.rawVisibleText);
  receipt.post.nativeObservation.caption = "Rewritten original";
  forged.rawVisibleText = JSON.stringify(receipt);
  assert.equal(isVerifiedNativeTikTokReceipt(forged, company), false);
});

test("a genuine empty native description remains empty and unscored with browser media retained only in its receipt", async (t) => {
  const f = await fixture(t, ""), result = runConverter(f);
  assert.equal(result.status, 0, result.stderr);
  const [row] = JSON.parse(await readFile(join(f.directory, "converted.json"), "utf8")).evidence;
  assert.equal(row.text, ""); assert.equal(row.originalText, ""); assert.equal(row.captionAbsent, true);
  assert.equal(row.contributionScore, 0); assert.equal(row.tractionStatus, "unscored"); assert.deepEqual(row.mediaUrls, []);
  assert.equal(isVerifiedNativeTikTokReceipt(row, company), true);
  assert.equal(isVerifiedNativeTikTokReceipt({ ...row, contributionScore: 2 }, company), false);
});

test("changed ownership HTML fails conversion before any candidate is admitted", async (t) => {
  const f = await fixture(t); await writeFile(join(f.directory, "home.html"), "Changed official archive");
  const result = runConverter(f); assert.notEqual(result.status, 0); assert.match(result.stderr, /ownership archive failed/);
});

test("abbreviated TikTok labels stay unknown rather than becoming invented exact counts", () => {
  assert.deepEqual(nativeTikTokMetrics({ metricLabels: [{ nativeField: "browse-like-count", text: "1.3K" }, { nativeField: "browse-comment-count", text: "0" }, { nativeField: "browse-favorite-count", text: "1,234" }] }), { comments: 0, saves: 1234 });
});

test("the newer native unknown-date label preserves null and cannot authorize a fabricated timestamp", async (t) => {
  const f = await fixture(t), input = JSON.parse(await readFile(join(f.directory, "input.json"), "utf8"));
  input.nativePosts[0].publicationPrecision = "native_label_without_full_datetime";
  await put(f.directory, "input.json", input); assert.equal(runConverter(f).status, 0);
  const [row] = JSON.parse(await readFile(join(f.directory, "converted.json"), "utf8")).evidence;
  assert.equal(row.postedAt, null); assert.equal(isVerifiedNativeTikTokReceipt(row, company), true);
  input.nativePosts[0].publishedAt = "2026-10-11T00:00:00.000Z";
  await put(f.directory, "input.json", input); assert.equal(runConverter(f).status, 0);
  const held = JSON.parse(await readFile(join(f.directory, "converted.json"), "utf8"));
  assert.equal(held.evidence.length, 0); assert.ok(held.needsReview[0].reasons.includes("tiktok_unknown_publication_date_conflict"));
});

test("TikTok native photos preserve their media kind and bind the true profile handle separately from its display name", async (t) => {
  const f = await fixture(t, "Exact photo caption.", "photo"), result = runConverter(f);
  assert.equal(result.status, 0, result.stderr);
  const [row] = JSON.parse(await readFile(join(f.directory, "converted.json"), "utf8")).evidence;
  assert.equal(row.mediaType, "image"); assert.equal(row.authorHandle, "kairosdental_");
  assert.equal(isVerifiedNativeTikTokReceipt(row, company), true);
});

test("profile listing whitespace may differ while the native detail caption stays exact; different words remain rejected", async (t) => {
  const f = await fixture(t), input = JSON.parse(await readFile(join(f.directory, "input.json"), "utf8"));
  input.profiles[0].postLinks[0].imageAlt = input.profiles[0].postLinks[0].imageAlt.replace(input.nativePosts[0].caption, input.nativePosts[0].caption.replaceAll(" ", "  "));
  await put(f.directory, "input.json", input);
  assert.equal(runConverter(f).status, 0);
  const output = JSON.parse(await readFile(join(f.directory, "converted.json"), "utf8"));
  assert.equal(output.evidence.length, 1);
  assert.equal(output.evidence[0].originalText, "Exact original TikTok caption. 🦷");
  input.profiles[0].postLinks[0].imageAlt = input.profiles[0].postLinks[0].imageAlt.replace("original", "unrelated");
  await put(f.directory, "input.json", input);
  assert.equal(runConverter(f).status, 0);
  const rejected = JSON.parse(await readFile(join(f.directory, "converted.json"), "utf8"));
  assert.equal(rejected.evidence.length, 0);
  assert.ok(rejected.needsReview[0].reasons.includes("tiktok_native_caption_conflict"));
});

test("native TikTok navigation before the profile header still requires the exact titled handle and profile statistics", async (t) => {
  const f = await fixture(t), input = JSON.parse(await readFile(join(f.directory, "input.json"), "utf8"));
  input.profiles[0].title = "Kairos Health (@kairosdental_) | TikTok";
  input.profiles[0].nativeText = "TikTok\nSearch\nFor You\nKairos Health\nkairosdental_\n3\nFollowing\n38\nFollowers";
  await put(f.directory, "input.json", input); assert.equal(runConverter(f).status, 0);
  assert.equal(JSON.parse(await readFile(join(f.directory, "converted.json"), "utf8")).evidence.length, 1);
  input.profiles[0].title = "Other Account (@unrelated) | TikTok";
  await put(f.directory, "input.json", input); assert.equal(runConverter(f).status, 0);
  assert.equal(JSON.parse(await readFile(join(f.directory, "converted.json"), "utf8")).evidence.length, 0);
});

test("strict native importer retains captionless TikTok only through the scoped history option and rejects forged ownership", async (t) => {
  const f = await fixture(t, ""); assert.equal(runConverter(f).status, 0);
  for (const file of ["public-evidence-current.json", "logged-in-evidence-current.json", "targeted-evidence-current.json", "a16z-speedrun-006-social-evidence.json"]) await put(f.directory, `src/lib/social/${file}`, { source: {}, evidence: [] });
  for (const file of ["github-traction.json", "github-traction-summer-2026.json", "github-traction-a16z-speedrun-006.json"]) await put(f.directory, `src/lib/social/${file}`, { source: {}, accounts: [] });
  await put(f.directory, "target.json", { source: {}, evidence: [] });
  const flags = ["--include-batches=F26", "--scope-batch-dedupe", "--strict"];
  const run = (...args) => spawnSync(process.execPath, [join(root, "scripts/import-source-hunt-evidence.mjs"), `--target=${join(f.directory, "target.json")}`, `--input=${join(f.directory, "converted.json")}`, `--external-evidence-root=${f.directory}`, `--observed-at=${observedAt}`, ...flags, ...args], { cwd: root, encoding: "utf8" });
  assert.notEqual(run("--dry-run").status, 0);
  const accepted = run("--retain-zero-engagement", "--write"); assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
  const [row] = JSON.parse(await readFile(join(f.directory, "target.json"), "utf8")).evidence;
  assert.equal(row.text, ""); assert.equal(row.postedAt, null); assert.equal(row.contributionScore, 0);
  assert.equal(isVerifiedNativeTikTokReceipt(row, company), true);
  const input = JSON.parse(await readFile(join(f.directory, "converted.json"), "utf8")); input.evidence[0].accountUrl = "https://www.tiktok.com/@unrelated";
  await put(f.directory, "converted.json", input);
  const denied = run("--retain-zero-engagement", "--dry-run"); assert.notEqual(denied.status, 0); assert.match(denied.stdout, /tiktok_native_author_conflict/);
});

test("strict native import preserves positive TikTok engagement while assigning no uncalibrated traction contribution", async (t) => {
  const f = await fixture(t); assert.equal(runConverter(f).status, 0);
  for (const file of ["public-evidence-current.json", "logged-in-evidence-current.json", "targeted-evidence-current.json", "a16z-speedrun-006-social-evidence.json"]) await put(f.directory, `src/lib/social/${file}`, { source: {}, evidence: [] });
  for (const file of ["github-traction.json", "github-traction-summer-2026.json", "github-traction-a16z-speedrun-006.json"]) await put(f.directory, `src/lib/social/${file}`, { source: {}, accounts: [] });
  await put(f.directory, "target.json", { source: {}, evidence: [] });
  const result = spawnSync(process.execPath, [join(root, "scripts/import-source-hunt-evidence.mjs"), `--target=${join(f.directory, "target.json")}`, `--input=${join(f.directory, "converted.json")}`, `--external-evidence-root=${f.directory}`, `--observed-at=${observedAt}`, "--include-batches=F26", "--scope-batch-dedupe", "--strict", "--write"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const [row] = JSON.parse(await readFile(join(f.directory, "target.json"), "utf8")).evidence;
  assert.deepEqual(row.metrics, { likes: 3, comments: 0, saves: 2 });
  assert.equal(row.contributionScore, 0); assert.equal(row.tractionStatus, "unscored");
  assert.equal(isVerifiedNativeTikTokReceipt(row, company), true);
});

async function put(directory, path, value) { await mkdir(dirname(join(directory, path)), { recursive: true }); await writeFile(join(directory, path), typeof value === "string" ? value : JSON.stringify(value)); }
async function fixture(t, caption = "Exact original TikTok caption. 🦷", kind = "video") {
  const directory = await mkdtemp(join(tmpdir(), "fall-tiktok-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const anchorHtml = `<a href="${profileUrl}">TikTok</a>`, html = `<nav>${anchorHtml}</nav>`;
  await put(directory, "home.html", html); await put(directory, "src/lib/yc/fall-2026-companies.json", { companies: [company] });
  await put(directory, "inventory.json", { ownedTargets: [{ companySlug: company.slug, companyName: company.name, officialWebsite: company.websiteUrl, platform: "tiktok", sourceUrl: profileUrl, discoveredOn: `${company.websiteUrl}/`, ownershipStatus: "official_company_account_or_community_link", sourceHtmlArchivePath: "home.html", sourceHtmlSha256: sha(html), anchorHtml }] });
  const url = `${profileUrl}/${kind}/${postId}`, displayName = kind === "photo" ? "Kairos Health" : "kairosdental_";
  const post = { platform: "tiktok", companySlug: company.slug, nativePostId: postId, url, authorHandle: "kairosdental_", authorDisplayName: displayName, authorProfileUrl: profileUrl, caption, captionElementPresent: true, nativeText: caption, nativeDateLabel: `${displayName}\n·\n10-11`, publicationPrecision: "unknown_year_month_day_label_only", publishedAt: null, times: [], observedAt, media: [{ src: "blob:https://www.tiktok.com/local-only" }], metricLabels: [{ nativeField: "browse-like-count", text: "3" }, { nativeField: "browse-comment-count", text: "0" }, { nativeField: "browse-favorite-count", text: "2" }], controls: [{ label: "3 Likes", text: "3" }] };
  await put(directory, "input.json", { source: { batchSlug: "F26" }, profiles: [{ platform: "tiktok", companySlug: company.slug, url: profileUrl, nativeText: "kairosdental_\nkairosdental_", postLinks: [{ url, imageAlt: `${caption} created by ${displayName} with original sound` }] }], nativePosts: [post] });
  return { directory };
}
function runConverter(f) { return spawnSync(process.execPath, [join(root, "scripts/convert-fall-2026-tiktok-observations.mjs"), "--input=input.json", "--inventory=inventory.json", "--output=converted.json"], { cwd: f.directory, encoding: "utf8" }); }
