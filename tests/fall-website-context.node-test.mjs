import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import { officialWebsiteArticleContextReasons } from "../src/lib/graph/official-website-context-receipt.mjs";

const root = resolve(import.meta.dirname, "..");
const sha = (value) => createHash("sha256").update(value).digest("hex");

test("official article context verifies archive bytes and preserves exact prose with no score", async (t) => {
  const fixture = await createFixture(t);
  const before = await readFile(fixture.target, "utf8");
  const dryRun = run(fixture, "--dry-run", "preview");
  assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout);
  assert.equal(JSON.parse(dryRun.stdout).accepted, 1);
  assert.equal(await readFile(fixture.target, "utf8"), before);
  const written = run(fixture, "--write", "written");
  assert.equal(written.status, 0, written.stderr || written.stdout);
  const row = JSON.parse(await readFile(fixture.target, "utf8")).evidence[0];
  assert.equal(row.originalText, fixture.row.text);
  assert.equal(row.text, fixture.row.text);
  assert.equal(row.contributionScore, 0);
  assert.equal(row.tractionStatus, "unscored");
  assert.deepEqual(row.metrics, {});
  assert.equal(row.postedAt, null);
  assert.equal(row.publishedAtPrecision, "unknown");
  assert.equal(JSON.parse(row.rawVisibleText).validation.originalBodySha256, sha(fixture.row.text));
  const replay = run(fixture, "--dry-run", "replay");
  assert.equal(replay.status, 0, replay.stderr || replay.stdout);
  assert.equal(JSON.parse(replay.stdout).duplicates, 1);
});

test("article context rejects fabricated bodies and changed archive bytes before canonical write", async (t) => {
  const fixture = await createFixture(t);
  const before = await readFile(fixture.target, "utf8");
  const altered = structuredClone(fixture.row);
  altered.text = "A fabricated paragraph never present in the original company's HTML.";
  const raw = JSON.parse(altered.rawVisibleText); raw.post.text = altered.text; altered.rawVisibleText = JSON.stringify(raw);
  await writeFile(fixture.input, JSON.stringify({ context: [altered] }));
  const body = run(fixture, "--write", "body-reject");
  assert.notEqual(body.status, 0);
  assert.match(body.stdout, /original_body_fragment_not_present_in_archived_html/);
  assert.equal(await readFile(fixture.target, "utf8"), before);
  await writeFile(fixture.input, JSON.stringify({ context: [fixture.row] }));
  await writeFile(fixture.archive, "Modified HTML after collection.");
  const hash = run(fixture, "--write", "hash-reject");
  assert.notEqual(hash.status, 0);
  assert.match(hash.stdout, /original_html_hash_conflict/);
  assert.equal(await readFile(fixture.target, "utf8"), before);
});

test("article receipt gates keep company, batch, publication and context-score ownership strict", async (t) => {
  const fixture = await createFixture(t);
  for (const mutation of [
    { batchSlug: "S26" }, { entityId: "company-gatherhq" }, { metrics: { views: 1 } },
    { contributionScore: 1 }, { sourceUrl: "https://foreign.example/blog/original" },
    { postedAt: "2027-01-01T00:00:00.000Z" }, { originalText: "Altered original prose." }
  ]) {
    assert.ok(officialWebsiteArticleContextReasons({ ...fixture.row, ...mutation }, fixture.company).length, JSON.stringify(mutation));
  }
});

test("article receipt rejects reused homepage shells and monthly archive indexes", async (t) => {
  const fixture = await createFixture(t);
  const raw = JSON.parse(fixture.row.rawVisibleText);
  const last = raw.officialDomainLineage.chain[0];
  raw.officialDomainLineage.chain.unshift({ ...last, requestedUrl: fixture.company.websiteUrl, finalUrl: fixture.company.websiteUrl });
  raw.officialDomainLineage.chain[1].discoveredOn = fixture.company.websiteUrl;
  assert.ok(officialWebsiteArticleContextReasons({ ...fixture.row, rawVisibleText: JSON.stringify(raw) }, fixture.company).includes("article_body_is_identical_to_homepage_shell"));
  const monthly = { ...fixture.row, sourceUrl: "https://0.security/updates/2026-11", text: "Update archive\nRead update\nNovember" };
  assert.ok(officialWebsiteArticleContextReasons(monthly, fixture.company).includes("monthly_update_archive_is_not_an_authored_release"));
  assert.equal(officialWebsiteArticleContextReasons({ ...monthly, sourceUrl: "https://0.security/updates/releases/2026-11-new-release" }, fixture.company).includes("monthly_update_archive_is_not_an_authored_release"), false);
});

test("official homepage redirects preserve ownership while outbound publisher links do not", async (t) => {
  const fixture = await createFixture(t);
  const sourceUrl = "https://new-company.example/blog/original-company-research/";
  const row = { ...fixture.row, sourceUrl, platformPostId: sourceUrl, fetchedUrl: sourceUrl };
  const raw = JSON.parse(row.rawVisibleText);
  const last = raw.officialDomainLineage.chain[0];
  Object.assign(last, { requestedUrl: sourceUrl, finalUrl: sourceUrl, discoveredOn: "https://new-company.example/" });
  raw.officialDomainLineage.chain.unshift({ ...last, requestedUrl: fixture.company.websiteUrl, finalUrl: "https://new-company.example/", discoveredOn: null, sha256: "b".repeat(64) });
  raw.officialDomainLineage.canonicalUrl = sourceUrl;
  Object.assign(raw.post, { sourceUrl, fetchedUrl: sourceUrl });
  row.rawVisibleText = JSON.stringify(raw);
  assert.deepEqual(officialWebsiteArticleContextReasons(row, fixture.company), []);
  raw.officialDomainLineage.chain[0].finalUrl = fixture.company.websiteUrl;
  raw.officialDomainLineage.chain[1].discoveredOn = fixture.company.websiteUrl;
  row.rawVisibleText = JSON.stringify(raw);
  assert.ok(officialWebsiteArticleContextReasons(row, fixture.company).includes("outbound_publisher_link_does_not_prove_company_authorship"));
  assert.ok(officialWebsiteArticleContextReasons({ ...fixture.row, sourceUrl: "https://0.security/changelog/versions", text: "Every Native release on one page, newest first. Open any of them to read what changed." }, fixture.company).includes("release_directory_is_not_an_authored_release"));
  assert.ok(officialWebsiteArticleContextReasons({ ...fixture.row, sourceUrl: "https://0.security/threat-intel/resource", text: "Resource summary\nFirst Seen Aug 2026\nLast Reviewed Sep 2026\nPublisher External\nSource Type Article" }, fixture.company).includes("structured_resource_catalog_is_not_an_authored_post"));
});

async function createFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "fall-web-context-"));
  const cacheRoot = resolve(root, "outputs/fall-2026/public-history-cache");
  await mkdir(cacheRoot, { recursive: true });
  const cache = await mkdtemp(join(cacheRoot, "unit-context-"));
  t.after(() => Promise.all([rm(directory, { recursive: true, force: true }), rm(cache, { recursive: true, force: true })]));
  const text = "Original company research\n\nShared research can begin with a phrase that ordinary prose filters mistake for an editorial summary. Exact source words remain intact.";
  const html = `<html><article><h1>Original company research</h1><p>${text.split("\n\n")[1]}</p></article></html>`;
  const archive = join(cache, `${sha(html)}.html`);
  await writeFile(archive, html);
  const archivePath = relative(root, archive);
  const sourceUrl = "https://0.security/blog/original-company-research/";
  const company = { slug: "0security", name: "0.security", websiteUrl: "https://0.security", ycProfileUrl: "https://www.ycombinator.com/companies/0security" };
  const lineage = {
    officialYcProfileUrl: company.ycProfileUrl, officialWebsite: company.websiteUrl, canonicalUrl: sourceUrl,
    chain: [{ requestedUrl: sourceUrl, finalUrl: sourceUrl, kind: "feed_linked_article", discoveredOn: null, status: 200, sha256: sha(html), bodyArchivePath: archivePath }]
  };
  const row = {
    batchSlug: "F26", platform: "web", platformPostId: sourceUrl, sourceUrl, fetchedUrl: sourceUrl,
    companySlug: company.slug, companyName: company.name, entityId: "company-0security", entityType: "company",
    title: "Original company research", text, metrics: {}, contributionScore: 0,
    postedAt: "unknown", observedAt: "2026-11-16T03:00:00.000Z", publicationPrecision: "unknown",
    sourceHtmlSha256: sha(html), fullOriginalHtmlArchivePath: archivePath,
    rawVisibleText: JSON.stringify({
      source: "official_company_website_article_v1", company: { slug: company.slug, name: company.name, entityId: "company-0security" },
      post: { sourceUrl, fetchedUrl: sourceUrl, title: "Original company research", text, nativePublishedAtLiteral: "unknown" },
      originalHtml: { sha256: sha(html), archivePath }, officialDomainLineage: lineage,
      observedAt: "2026-11-16T03:00:00.000Z"
    })
  };
  const input = join(directory, "input.json"), target = join(directory, "target.json");
  await writeFile(input, JSON.stringify({ context: [row] }));
  await writeFile(target, JSON.stringify({ source: {}, evidence: [] }));
  return { directory, input, target, archive, row, company };
}
function run(fixture, mode, output) {
  return spawnSync(process.execPath, ["scripts/ingest-fall-2026-website-context.mjs", mode, `--input=${fixture.input}`, `--target=${fixture.target}`, `--output=${join(fixture.directory, output)}`], { cwd: root, encoding: "utf8" });
}
