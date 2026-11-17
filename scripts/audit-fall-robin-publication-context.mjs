import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import * as cheerio from "cheerio";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const prefix = "outputs/fall-2026/founder-personal-site-discovery/robin-substack/";
const manifest = new Map();
async function read(path, expected) {
  const bytes = await readFile(path), sha256 = hash(bytes);
  if (expected && sha256 !== expected) throw new Error(`Changed physical source: ${path}`);
  manifest.set(path, { path, sha256 });
  return bytes;
}
async function json(path) { return JSON.parse(await read(path)); }
const normalize = (value) => value.replace(/\s+/gu, " ").trim();
const ownershipPath = "outputs/fall-2026/founder-personal-site-owned-targets.json";
const ownership = await json(ownershipPath);
const founder = ownership.founders.find((entry) => entry.founderName === "Robin Choy");
const target = ownership.ownedOutboundCandidates.find((entry) => entry.founderName === "Robin Choy" && entry.platform === "substack");
if (!founder || !target || founder.identityStatus !== "official_native_profile_label_and_matching_self_biography") throw new Error("Missing exact owned-founder publication proof");
const homepageReceiptPath = prefix + "homepage-receipt.json", homepageReceipt = await json(homepageReceiptPath);
const homepage = cheerio.load(await read(homepageReceipt.physicalSource.path, homepageReceipt.physicalSource.sha256));
if (homepageReceipt.status !== 200 || homepage('link[rel="alternate"][type="application/rss+xml"]').attr("href") !== "/feed") throw new Error("No literal public RSS discovery link");
const feedReceiptPath = prefix + "feed-receipt.json", feedReceipt = await json(feedReceiptPath);
if (feedReceipt.status !== 200) throw new Error("Public RSS unavailable");
const feed = cheerio.load(await read(feedReceipt.physicalSource.path, feedReceipt.physicalSource.sha256), { xmlMode: true });
if (feed("channel > title").first().text() !== "Robin Choy" || feed("channel > link").first().text() !== "https://robinchoy.substack.com") throw new Error("Feed publication identity conflict");
const articleReceiptsPath = prefix + "article-receipts.json", articleReceipts = await json(articleReceiptsPath);
const articles = [];
for (const [index, item] of feed("item").toArray().entries()) {
  const element = feed(item), url = element.children("link").text(), title = element.children("title").text();
  const creator = element.children().filter((_, entry) => entry.tagName === "dc:creator").text();
  const rssBodyHtml = element.children().filter((_, entry) => entry.tagName === "content:encoded").text();
  const request = articleReceipts.requests.find((entry) => entry.url === url);
  if (!request || request.status !== 200 || creator !== founder.founderName || !url.startsWith(target.observedUrl + "p/") || !rssBodyHtml) throw new Error("Literal full RSS item/author or public page conflict");
  const html = (await read(request.physicalSource.path, request.physicalSource.sha256)).toString("utf8"), $ = cheerio.load(html);
  const body = $(".body.markup"), nativeTitle = $("h1").toArray().find((entry) => $(entry).text() === title);
  const bylines = $("a").toArray().filter((entry) => $(entry).attr("href") === "https://substack.com/@robinchoy1" && $(entry).text() === founder.founderName);
  const time = $("time"), postedAt = time.attr("datetime"), rssDate = element.children("pubDate").text();
  if (body.length !== 1 || !nativeTitle || bylines.length !== 1 || time.length !== 1 || $("link[rel=canonical]").attr("href") !== url || $(".paywall,.paywall-title,.paywall-content").length || normalize(body.text()) !== normalize(cheerio.load(rssBodyHtml).root().text()) || !postedAt || !Number.isFinite(Date.parse(postedAt)) || Math.floor(Date.parse(postedAt) / 1000) !== Date.parse(rssDate) / 1000) throw new Error("Public article parent body/title/byline/date mismatch or truncation");
  const textBody = body.clone();
  textBody.find("br").replaceWith("\n");
  textBody.find("p,h1,h2,h3,h4,li,blockquote,pre").each((_, entry) => { $(entry).prepend("\n").append("\n"); });
  const text = textBody.text().replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  articles.push({ companySlug: founder.companySlug, founderId: founder.founderId, founderName: founder.founderName, entityType: "founder", entityId: "founder-adsideai-robin-choy-406206", platform: "substack", sourceType: "owned_founder_publication", sourceUrl: url, title, authorName: creator, authorUrl: "https://substack.com/@robinchoy1", postedAt, publishedAtPrecision: "exact", dateReceipt: { nativeTimeHtml: $.html(time), nativeVisibleDay: time.text(), nativeDatetime: postedAt, rssPubDate: rssDate }, text, originalText: text, metrics: {}, nativeSocialPostAdmission: false, contextAdmissionPending: true, proof: { ownershipSource: { path: ownershipPath, sha256: manifest.get(ownershipPath).sha256 }, articleSource: request.physicalSource, rssSource: { ...feedReceipt.physicalSource, itemIndex: index }, literalBylineHtml: $.html(bylines[0]), fullPublicArticleBodyHtml: $.html(body), rawBodyTextSha256: hash(body.text()), rssRawBodyTextSha256: hash(cheerio.load(rssBodyHtml).root().text()), normalizedRssBodyEqualsPublicArticleBody: true, nativePaywallObserved: false, requestsAuthenticated: false } });
}
const output = { source: "literal_owned_founder_publication_public_rss_article_context_v1", generatedAt: new Date().toISOString(), companySlug: founder.companySlug, founderId: founder.founderId, fullHistoryComplete: false, contextArticleCount: articles.length, coverage: { publicRequests: 4, normalHttp200: 4, literalFeedItems: articles.length, publicArticlePagesWithMatchingFullRssBodies: articles.length, historyEndProven: false, gaps: ["Two available public RSS entries captured; RSS item count and welcome homepage do not establish complete publication archive history.", "No private or paid content, authentication, archive guesses, invented engagement counters or native social-post admission."] }, articles, sourceManifest: [...manifest.values()] };
const path = "outputs/fall-2026/founder-robin-choy-publication-context.json";
await writeFile(path, JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify({ path, sha256: hash(await readFile(path)), articles: articles.map((article) => ({ url: article.sourceUrl, title: article.title, postedAt: article.postedAt, textLength: article.text.length, rssAndPublicBodyMatch: article.proof.normalizedRssBodyEqualsPublicArticleBody })) }, null, 2));
