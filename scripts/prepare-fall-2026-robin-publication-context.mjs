import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import {
  ROBIN_FOUNDER_PUBLICATION_SOURCE, ROBIN_FOUNDER_PUBLICATION_VALIDATION,
  robinPublicationSha256 as sha, robinPublicationNativeFields, isVerifiedRobinFounderPublicationContext
} from "../src/lib/graph/robin-founder-publication-context-receipt.mjs";

const INPUT_PATH = "outputs/fall-2026/founder-robin-choy-publication-context.json";
const INPUT_SHA = "4001465082af61e8aff971a3f1e8afd048a79804c54beae0edfabfe98a394c80";
const PREFIX = "outputs/fall-2026/founder-personal-site-discovery/robin-substack/";
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const compact = (value) => value.replace(/\s+/gu, "");
const pointer = (value, at) => at.split("/").slice(1).reduce((object, key) => object?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], value);
const assert = (condition, message) => { if (!condition) throw new Error(message); };

/** Physical, read-only conversion of the two already-fetched exact owned originals. */
export async function prepareRobinFounderPublicationContexts({ rootDir = process.cwd(), inputPath = INPUT_PATH, expectedInputSha256 = INPUT_SHA, readArchive } = {}) {
  const archives = new Map();
  const read = async (relativePath, expectedSha256) => {
    expectedSha256 ??= archives.get(relativePath)?.sha256;
    const absolute = path.resolve(rootDir, relativePath), relative = path.relative(path.resolve(rootDir), absolute);
    assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "Publication archive escapes its root.");
    const bytes = Buffer.from(readArchive ? await readArchive(relativePath, expectedSha256) : await readFile(absolute));
    const sha256 = sha(bytes);
    assert(!expectedSha256 || sha256 === expectedSha256, `Changed physical publication source: ${relativePath}`);
    const prior = archives.get(relativePath);
    assert(!prior || prior.sha256 === sha256, "Conflicting source versions in publication review.");
    archives.set(relativePath, { path: relativePath, sha256 });
    return bytes;
  };
  const json = async (relativePath, expected) => JSON.parse(await read(relativePath, expected));
  const input = await json(inputPath, expectedInputSha256);
  assert(input.source === "literal_owned_founder_publication_public_rss_article_context_v1" && input.companySlug === "adsideai" && input.founderId === "406206" && input.articles?.length === 2 && input.fullHistoryComplete === false, "Unexpected frozen founder publication scope.");
  for (const ref of input.sourceManifest) await read(ref.path, ref.sha256);
  const ownerRef = input.articles[0].proof.ownershipSource;
  const inventory = await json(ownerRef.path, ownerRef.sha256);
  const founder = inventory.founders.find((entry) => entry.companySlug === "adsideai" && entry.founderId === "406206" && entry.founderName === "Robin Choy");
  const target = inventory.ownedOutboundCandidates.find((entry) => entry.companySlug === "adsideai" && entry.founderId === "406206" && entry.platform === "substack" && entry.observedUrl === "https://robinchoy.substack.com/");
  assert(founder && target, "Missing exact native personal-site publication ownership.");
  const roster = await json(founder.officialRosterSource.path, founder.officialRosterSource.sha256);
  const nativeFounder = pointer(roster, founder.officialRosterSource.jsonPointer);
  const company = roster.companies.find((entry) => entry.slug === "adsideai");
  assert(nativeFounder?.id === "406206" && nativeFounder.name === "Robin Choy" && company?.founders.includes(nativeFounder) && /^https:\/\/(?:www\.)?x\.com\/ChoyRb\/?$/i.test(nativeFounder.socialLinks.x), "Official company payload founder identity changed.");
  const entity = { entityId: "founder-adsideai-robin-choy-406206", companySlug: company.slug, companyName: company.name, founderName: nativeFounder.name, socialAccounts: { x: nativeFounder.socialLinks.x } };
  const nativeProfile = pointer(await json(founder.nativeOfficialProfileSource.path, founder.nativeOfficialProfileSource.sha256), founder.nativeOfficialProfileSource.jsonPointer);
  const nativeAnchor = founder.nativeOfficialProfileWebsiteAnchor;
  assert(nativeProfile?.handle?.toLowerCase() === "choyrb" && /^https:\/\/x\.com\/ChoyRb(?:\/articles|\/reposts|\/with_replies)?$/i.test(nativeProfile.sourceUrl)
    && nativeProfile.nativeProfileLinks.some((anchor) => equal(anchor, nativeAnchor)), "Native own-profile website anchor is not physically present.");
  const homepageBytes = await read(founder.homepageSource.path, founder.homepageSource.sha256), homepage = cheerio.load(homepageBytes.toString("utf8"));
  const h1 = homepage("h1").filter((_, entry) => homepage(entry).text() === "Robin Choy");
  const biography = homepage("main > p").filter((_, entry) => homepage(entry).text().includes("I'm a repeat founder") && homepage(entry).text().includes("Adside")).first();
  const reciprocal = homepage('footer a[href="https://x.com/ChoyRb"]');
  const publication = homepage('footer a[href="https://robinchoy.substack.com/"]');
  assert(founder.personalWebsiteUrl === "https://robinchoy.com/" && h1.length === 1 && biography.length === 1 && reciprocal.length === 1 && publication.length === 1
    && homepageBytes.toString("utf8").includes(target.literalAnchorHtml), "Personal site exact self biography/reciprocal X/publication anchor is missing.");
  const discovery = pointer(await json(target.ownerProofSource.path, target.ownerProofSource.sha256), target.ownerProofSource.jsonPointer);
  assert(discovery.founderId === "406206" && discovery.requestedUrl === founder.personalWebsiteUrl && discovery.finalUrl === founder.personalWebsiteUrl
    && discovery.requests.length === 1 && discovery.requests[0].status === 200 && equal(discovery.literalWebsiteProfileAnchor, nativeAnchor)
    && discovery.physicalHomepage.sha256 === founder.homepageSource.sha256, "Public personal-site request lineage conflict.");
  const homepageReceipt = await json(PREFIX + "homepage-receipt.json");
  const publicationHomepage = cheerio.load((await read(homepageReceipt.physicalSource.path, homepageReceipt.physicalSource.sha256)).toString("utf8"));
  assert(homepageReceipt.status === 200 && homepageReceipt.url === "https://robinchoy.substack.com/" && homepageReceipt.authenticated === false
    && publicationHomepage('link[rel="alternate"][type="application/rss+xml"]').attr("href") === "/feed", "Missing literal owned publication RSS discovery.");
  const feedReceipt = await json(PREFIX + "feed-receipt.json");
  const feed = cheerio.load((await read(feedReceipt.physicalSource.path, feedReceipt.physicalSource.sha256)).toString("utf8"), { xmlMode: true });
  assert(feedReceipt.status === 200 && feedReceipt.url === "https://robinchoy.substack.com/feed" && feedReceipt.authenticated === false
    && feed("channel > title").first().text() === "Robin Choy" && feed("channel > link").first().text() === "https://robinchoy.substack.com", "Exact owned native feed identity conflict.");
  const articleReceipts = await json(PREFIX + "article-receipts.json");
  const ownership = {
    source: "official_founder_native_profile_personal_site_publication_chain_v1", companySlug: company.slug, founderId: "406206", founderName: "Robin Choy", entityId: entity.entityId,
    officialYcCompanyUrl: company.ycProfileUrl, officialXProfileUrl: nativeFounder.socialLinks.x,
    nativeXProfileArchivePath: founder.nativeOfficialProfileSource.path, nativeXProfileArchiveSha256: founder.nativeOfficialProfileSource.sha256, nativeXProfilePointer: founder.nativeOfficialProfileSource.jsonPointer,
    nativeXProfileWebsiteAnchor: nativeAnchor, personalWebsiteUrl: founder.personalWebsiteUrl,
    personalHomepagePath: founder.homepageSource.path, personalHomepageSha256: founder.homepageSource.sha256,
    personalHomepageFounderHeadingHtml: homepage.html(h1), personalHomepageSelfBiographyHtml: homepage.html(biography), personalHomepageReciprocalXAnchorHtml: homepage.html(reciprocal), publicationAnchorHtml: homepage.html(publication),
    publicationUrl: "https://robinchoy.substack.com/", nativePublicationId: 2319101,
    rosterPath: founder.officialRosterSource.path, rosterSha256: founder.officialRosterSource.sha256, rosterFounderPointer: founder.officialRosterSource.jsonPointer,
    ownershipInventoryPath: ownerRef.path, ownershipInventorySha256: ownerRef.sha256
  };
  const evidence = [];
  for (const article of input.articles) {
    const request = articleReceipts.requests.find((entry) => entry.url === article.sourceUrl);
    assert(request?.status === 200 && request.authenticated === false, "Missing original public article request.");
    const html = (await read(request.physicalSource.path, request.physicalSource.sha256)).toString("utf8"), $ = cheerio.load(html);
    const preloadElements = $('script#preloads-json[type="application/json"]');
    assert(preloadElements.length === 1, "Missing one exact native article preload.");
    const native = JSON.parse(preloadElements.text()).post;
    const body = $(".body.markup"), time = $("time"), byline = $('a[href="https://substack.com/@robinchoy1"]').filter((_, entry) => $(entry).text() === "Robin Choy");
    const item = feed("item").filter((_, element) => feed(element).children("link").text() === article.sourceUrl);
    const rssBody = item.children().filter((_, element) => element.tagName === "content:encoded").text();
    const creator = item.children().filter((_, element) => element.tagName === "dc:creator").text();
    const rssDate = item.children("pubDate").text();
    assert(native && Number.isSafeInteger(native.id) && native.publication_id === 2319101 && native.canonical_url === article.sourceUrl && native.title === article.title && native.post_date === article.postedAt
      && native.audience === "everyone" && native.is_published === true && native.publishedBylines?.length === 1 && native.publishedBylines[0].id === 224124204
      && native.publishedBylines[0].name === "Robin Choy" && native.publishedBylines[0].handle === "robinchoy1" && native.publishedBylines[0].is_guest === false
      && $('link[rel="canonical"]').attr("href") === article.sourceUrl && $("h1").toArray().some((element) => $(element).text() === article.title)
      && body.length === 1 && time.length === 1 && time.attr("datetime") === native.post_date && byline.length === 1 && !$(".paywall,.paywall-title,.paywall-content").length
      && item.length === 1 && creator === "Robin Choy" && item.children("title").text() === article.title
      && compact(body.text()) === compact(cheerio.load(native.body_html).root().text()) && compact(body.text()) === compact(cheerio.load(rssBody).root().text())
      && compact(body.text()) === compact(article.text) && Math.floor(Date.parse(native.post_date) / 1000) === Math.floor(Date.parse(rssDate) / 1000)
      && Date.parse(native.post_date) <= Date.parse(request.observedAt), "Native full article body/title/byline/preload/RSS/date conflict.");
    const row = { batchSlug: "F26", companySlug: company.slug, companyName: company.name, entityType: "founder", entityId: entity.entityId, founderId: "406206", authorName: "Robin Choy", authorUrl: "https://substack.com/@robinchoy1",
      platform: "web", publisherPlatform: "substack", platformPostId: article.sourceUrl, nativePostId: String(native.id), nativePublicationId: native.publication_id, sourceUrl: article.sourceUrl, accountUrl: "https://robinchoy.substack.com/",
      title: native.title, text: article.text, originalText: article.text, originalBodyHtml: native.body_html, originalBodyHtmlSha256: sha(native.body_html), postedAt: native.post_date, nativePublishedAtLiteral: native.post_date,
      nativeFeedPublishedAtLiteral: rssDate, observedAt: request.observedAt, collectionObservedAt: request.observedAt, nativePublishedBylines: native.publishedBylines, nativeAudience: native.audience, nativeIsPublished: native.is_published,
      bodyTruncated: false, bodyPaywalled: false, metrics: {}, contributionScore: 0, tractionStatus: "unscored", nativeSocialPostAdmission: false, historyComplete: false,
      review_state: "verified", attributionStatus: "verified", attributionMode: "author", attributionProvenance: ROBIN_FOUNDER_PUBLICATION_SOURCE, identitySourceUrl: company.ycProfileUrl, officialFounderPublicationOwnership: ownership };
    evidence.push(row);
  }
  const archiveList = [...archives.values()];
  for (const row of evidence) {
    const raw = { source: ROBIN_FOUNDER_PUBLICATION_SOURCE, ownership, nativePost: robinPublicationNativeFields(row), text: row.text, nativeFeedPublishedAtLiteral: row.nativeFeedPublishedAtLiteral, observedAt: row.observedAt, archives: archiveList,
      validation: { source: ROBIN_FOUNDER_PUBLICATION_VALIDATION, archiveHashesVerified: true, exactRosterFounderVerified: true, nativeOwnProfileAnchorVerified: true, personalSiteSelfBiographyAndReciprocalXVerified: true,
        literalOwnedPublicationAnchorVerified: true, fullNativePostPreloadAndHtmlVerified: true, fullRssBodyAndNativeClockVerified: true, originalTextSha256: sha(row.originalText), originalBodyHtmlSha256: row.originalBodyHtmlSha256,
        nativeFieldsSha256: sha(JSON.stringify(robinPublicationNativeFields(row))), ownershipSha256: sha(JSON.stringify(ownership)), archivesSha256: sha(JSON.stringify(archiveList)) } };
    row.rawVisibleText = JSON.stringify(raw);
    assert(isVerifiedRobinFounderPublicationContext(row, entity), "Prepared native founder-publication receipt failed its pure verifier.");
  }
  return { source: { kind: ROBIN_FOUNDER_PUBLICATION_SOURCE, batchSlug: "F26", fetchedAt: input.generatedAt, fullAvailableAccountHistoryRequested: true, historyComplete: false, nativeSocialPostsAdded: 0 }, evidence, archives: archiveList,
    audit: { status: "physically_verified_prepared_context_only", contexts: evidence.length, nativeRequestsMade: 0, canonicalWritesMade: 0, exactOwner: entity, archives: archiveList, independentNativeClocksPreserved: true, fullPublicationHistoryEndProven: false } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = "outputs/fall-2026/collection/robin-founder-publication-preflight";
  const result = await prepareRobinFounderPublicationContexts();
  await mkdir(output, { recursive: true });
  const evidenceBytes = JSON.stringify({ source: result.source, evidence: result.evidence }, null, 2) + "\n";
  await writeFile(path.join(output, "prepared-contexts.json"), evidenceBytes);
  await writeFile(path.join(output, "audit.json"), JSON.stringify(result.audit, null, 2) + "\n");
  console.log(JSON.stringify({ path: path.join(output, "prepared-contexts.json"), sha256: sha(evidenceBytes), contexts: result.evidence.length, archives: result.archives.length, canonicalWrites: 0 }));
}
