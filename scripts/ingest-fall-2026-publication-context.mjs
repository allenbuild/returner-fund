import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { load } from "cheerio";
import { officialPublicationArticleContextReasons, officialPublicationNativeFields, officialPublicationReceipt, isVerifiedOfficialPublicationArticleContext, publicationContextSha256 as sha, OFFICIAL_PUBLICATION_CONTEXT_SOURCE, OFFICIAL_PUBLICATION_CONTEXT_VALIDATION } from "../src/lib/graph/official-publication-context-receipt.mjs";
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function nativePublicationBodyText(bodyHtml) {
  const $ = load(bodyHtml, null, false); $("script,style,noscript").remove(); $("br").replaceWith("\n");
  $("p,div,section,h1,h2,h3,h4,h5,h6,li,blockquote,figure,figcaption,table,tr").each((_, element) => { $(element).prepend("\n"); $(element).append("\n"); });
  return $.root().text().replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
export async function ingestFallPublicationContext(options) {
  const root = await realpath(resolve(options.root ?? process.cwd())), path = (value) => resolve(root, value);
  if (!["dry-run", "write"].includes(options.mode)) throw new Error("Pass exactly one of --dry-run or --write.");
  if (options.mode === "write" && !/^[a-f0-9]{64}$/.test(options.expectedTargetSha256 ?? "")) throw new Error("Write requires --expected-target-sha256.");
  const inputPath = options.input ?? "outputs/source-hunt/2026-11-15-fall-2026-particularity-substack-context.json", targetPath = options.target ?? "src/lib/social/targeted-evidence-current.json", outputPath = options.output ?? `outputs/fall-2026/collection/publication-context-${Date.now()}`;
  const [inputText, beforeText, catalogText] = await Promise.all([inputPath, targetPath, options.catalog ?? "src/lib/yc/fall-2026-companies.json"].map((p) => readFile(path(p), "utf8")));
  if (options.expectedTargetSha256 && options.expectedTargetSha256 !== sha(beforeText)) throw new Error("target_compare_and_swap_hash_conflict");
  if (options.expectedInputSha256 && options.expectedInputSha256 !== sha(inputText)) throw new Error("input_frozen_hash_conflict");
  const input = JSON.parse(inputText), before = JSON.parse(beforeText), catalog = JSON.parse(catalogText), companies = new Map(catalog.companies.map((company) => [company.slug, company]));
  if (!Array.isArray(input.context) || !Array.isArray(before.evidence)) throw new Error("invalid_publication_context_envelope");
  await mkdir(path(outputPath), { recursive: false }); await writeFile(path(`${outputPath}/source-context-frozen.json`), inputText);
  const archives = new Map(), accepted = [], duplicates = [], rejected = [];
  async function archive(relative, expectedSha, allowed) {
    const absolute = await realpath(path(relative));
    if (!allowed.some((prefix) => absolute.startsWith(`${path(prefix)}${sep}`) || absolute === path(prefix))) throw new Error("publication_archive_outside_allowed_path");
    if (!archives.has(absolute)) { const bytes = await readFile(absolute); archives.set(absolute, { bytes, sha256: sha(bytes) }); }
    const result = archives.get(absolute);
    if (result.sha256 !== expectedSha) throw new Error("publication_archive_hash_conflict");
    return result.bytes.toString("utf8");
  }
  const nativeRoot = "outputs/fall-2026/particularity-substack-cache", officialRoot = "outputs/fall-2026/public-history-cache", inventoryPath = "outputs/source-hunt/2026-11-15-fall-2026-other-platform-official-outbound-inventory.json";
  async function verifyNative(row, raw) {
    const owner = row.officialPublicationOwnership;
    if (owner.ownershipInventoryPath !== inventoryPath) throw new Error("unknown_publication_ownership_inventory");
    const inventory = JSON.parse(await archive(inventoryPath, owner.ownershipInventorySha256, [inventoryPath]));
    const anchors = inventory.ownedTargets?.filter((target) => target.companySlug === row.companySlug && target.sourceUrl === owner.publicationUrl && target.ownershipStatus === "official_company_publication_link" && target.sourceHtmlSha256 === owner.officialHomepageSha256 && target.sourceHtmlArchivePath === owner.officialHomepageArchivePath && target.anchorHtml === owner.anchorHtml && target.anchorText === owner.anchorText && target.discoveredOn === owner.discoveredOn);
    if (anchors?.length !== 1) throw new Error("explicit_official_publication_anchor_not_unique_in_inventory");
    const homepage = load(await archive(owner.officialHomepageArchivePath, owner.officialHomepageSha256, [officialRoot]));
    const exactFooterLinks = homepage("footer a[href]").toArray().filter((element) => {
      const anchor = homepage(element);
      try { return new URL(anchor.attr("href"), owner.discoveredOn).href === owner.publicationUrl && anchor.text().trim() === "Substack" && homepage.html(element) === owner.anchorHtml; } catch { return false; }
    });
    if (exactFooterLinks.length !== 1) throw new Error("publication_link_is_not_exact_official_footer_anchor");
    const html = await archive(row.fullOriginalHtmlArchivePath, row.sourceHtmlSha256, [nativeRoot]), $ = load(html), preload = JSON.parse($("#preloads-json").text()), post = preload.post;
    const native = JSON.parse(await archive(row.nativePostArchivePath, row.nativePostArchiveSha256, [nativeRoot]));
    if (!post || !equal(post, native.nativePost) || native.requestedUrl !== row.sourceUrl || native.observedAt !== row.observedAt || native.sourceHtmlArchivePath !== row.fullOriginalHtmlArchivePath || native.sourceHtmlSha256 !== row.sourceHtmlSha256) throw new Error("native_publication_html_preload_json_conflict");
    if (String(post.id) !== row.nativePostId || post.publication_id !== row.nativePublicationId || post.canonical_url !== row.sourceUrl || post.title !== row.title || post.body_html !== row.originalBodyHtml || post.post_date !== row.postedAt || !equal(post.publishedBylines, row.nativePublishedBylines) || post.audience !== "everyone" || post.is_published !== true || post.is_geoblocked || row.text !== nativePublicationBodyText(post.body_html)) throw new Error("native_publication_article_fields_or_body_conflict");
    const xml = load(await archive(raw.nativeFeedArchivePath, raw.nativeFeedArchiveSha256, [nativeRoot]), { xmlMode: true }), items = xml("item").toArray().filter((item) => xml(item).find("link").text() === row.sourceUrl);
    if (items.length !== 1 || xml(items[0]).find("title").text() !== row.title || xml(items[0]).find("pubDate").text() !== row.nativeFeedPublishedAtLiteral || Math.floor(Date.parse(xml(items[0]).find("pubDate").text()) / 1000) !== Math.floor(Date.parse(row.postedAt) / 1000)) throw new Error("native_publication_rss_entry_conflict");
  }
  const key = (row) => `${row.batchSlug}:${row.entityId}:${row.sourceUrl}`;
  const existing = new Map(before.evidence.map((row) => [key(row), row]));
  for (const row of input.context) {
    const company = companies.get(row.companySlug), raw = officialPublicationReceipt(row), reasons = officialPublicationArticleContextReasons(row, company);
    if (!reasons.length) { try { await verifyNative(row, raw); } catch (error) { reasons.push(error.code === "ENOENT" ? "publication_archive_missing" : error.message); } }
    if (reasons.length) { rejected.push({ sourceUrl: row.sourceUrl, nativePostId: row.nativePostId, reasons }); continue; }
    const prior = existing.get(key(row));
    if (prior) {
      if (isVerifiedOfficialPublicationArticleContext(prior, company) && equal(officialPublicationNativeFields(prior), officialPublicationNativeFields(row))) duplicates.push({ sourceUrl: row.sourceUrl, existingId: prior.id });
      else rejected.push({ sourceUrl: row.sourceUrl, reasons: ["existing_publication_original_conflict"] });
      continue;
    }
    const checkedAt = new Date(row.observedAt).toISOString(), evidence = { ...row, id: `web-f26-publication-${sha(`${row.entityId}:${row.nativePublicationId}:${row.nativePostId}`).slice(0, 24)}`,
      originalText: row.text, publishedAtPrecision: "exact", metrics: {}, contributionScore: 0, tractionStatus: "unscored", tractionLimitations: ["Official company publication original; native social engagement counts are not assigned a traction score."],
      review_state: "verified", attributionVersion: 3, attributionStatus: "verified", attributionMode: "publisher", attributionProvenance: OFFICIAL_PUBLICATION_CONTEXT_SOURCE,
      attributionSignals: ["exact_official_homepage_publication_footer_anchor", "native_publication_html_and_rss_sha256_verified"],
      accountUrl: row.officialPublicationOwnership.publicationUrl, mediaType: "text", authorHandle: null, linkStatus: "verified", linkCheckedAt: checkedAt,
      first_seen_at: checkedAt, last_checked_at: checkedAt, last_updated_at: row.postedAt,
      why: "Exact original company-owned publication article preserved with native byline and publication clock; zero score.",
      matchReason: "Exact Particularity publication is explicitly linked in its official homepage footer. Native publication ID, article ID, full public body, bylines and publication date match hashed source HTML/preload JSON and RSS.",
      rawVisibleText: JSON.stringify({ ...raw, validation: { source: OFFICIAL_PUBLICATION_CONTEXT_VALIDATION, archiveHashesVerified: true, nativePostFieldsVerified: true, nativeFeedEntryVerified: true, exactOfficialFooterAnchorVerified: true,
        originalBodySha256: sha(row.text), nativeFieldsSha256: sha(JSON.stringify(officialPublicationNativeFields(row))), nativePostArchiveSha256: row.nativePostArchiveSha256, sourceHtmlSha256: row.sourceHtmlSha256,
        officialHomepageSha256: row.officialPublicationOwnership.officialHomepageSha256, ownershipInventorySha256: row.officialPublicationOwnership.ownershipInventorySha256, nativeFeedArchiveSha256: raw.nativeFeedArchiveSha256 } }) };
    if (!isVerifiedOfficialPublicationArticleContext(evidence, company)) throw new Error("runtime_publication_receipt_self_check_failed");
    accepted.push(evidence); existing.set(key(row), evidence);
  }
  const older = JSON.stringify(before.evidence.filter((row) => row.batchSlug !== "F26")), latest = Math.max(Date.parse(before.source?.fetchedAt ?? "") || 0, ...accepted.map((row) => Date.parse(row.observedAt)));
  const next = { ...before, source: { ...before.source, ...(latest ? { fetchedAt: new Date(latest).toISOString() } : {}), evidenceCount: before.evidence.length + accepted.length }, evidence: [...before.evidence, ...accepted] };
  if (older !== JSON.stringify(next.evidence.filter((row) => row.batchSlug !== "F26"))) throw new Error("earlier_cohort_rows_changed");
  const audit = { status: rejected.length ? "rejected" : options.mode === "write" ? "written" : "dry_run", received: input.context.length, accepted: accepted.length, duplicates: duplicates.length, rejected: rejected.length, before: before.evidence.length, after: next.evidence.length,
    source: inputPath, sourceSha256: sha(inputText), beforeTargetSha256: sha(beforeText), earlierCohortRowsSha256: sha(older), archiveFilesVerified: archives.size, canonicalWritten: false, rejectedRows: rejected, duplicateRows: duplicates };
  await writeFile(path(`${outputPath}/accepted-context.json`), `${JSON.stringify({ context: accepted }, null, 2)}\n`);
  if (options.mode === "write" && !rejected.length) {
    if (sha(await readFile(path(targetPath))) !== options.expectedTargetSha256 || await readFile(path(targetPath), "utf8") !== beforeText) throw new Error("target_compare_and_swap_changed_during_publication_preflight");
    const temp = `${path(targetPath)}.publication-${process.pid}.tmp`; await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`); await rename(temp, path(targetPath)); audit.canonicalWritten = true;
    await writeFile(path(`${outputPath}/targeted-after.json`), `${JSON.stringify(next, null, 2)}\n`);
  }
  await writeFile(path(`${outputPath}/audit.json`), `${JSON.stringify(audit, null, 2)}\n`); return audit;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), arg = (name) => args.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
  if (args.includes("--write") === args.includes("--dry-run")) throw new Error("Pass exactly one of --write or --dry-run.");
  const audit = await ingestFallPublicationContext({ mode: args.includes("--write") ? "write" : "dry-run", input: arg("--input"), target: arg("--target"), output: arg("--output"), catalog: arg("--catalog"), expectedTargetSha256: arg("--expected-target-sha256"), expectedInputSha256: arg("--expected-input-sha256") });
  console.log(JSON.stringify(audit)); if (audit.rejected) process.exitCode = 1;
}
