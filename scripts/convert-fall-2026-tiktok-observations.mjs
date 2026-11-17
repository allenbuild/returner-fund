import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { load } from "cheerio";
import { NATIVE_TIKTOK_SOURCE, NATIVE_TIKTOK_VALIDATION, nativeTikTokMetrics, tiktokNativeIdentity, verifiedNativeTikTokReasons } from "../src/lib/graph/tiktok-native-receipt.mjs";

const value = (key, fallback) => process.argv.slice(2).find((arg) => arg.startsWith(`${key}=`))?.slice(key.length + 1) ?? fallback;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const objectHash = (value) => hash(JSON.stringify(value));
const inputPath = value("--input", "outputs/fall-2026/browser-checkpoints/other-platform-ui-current.json");
const inventoryPath = value("--inventory", "outputs/source-hunt/2026-11-15-fall-2026-other-platform-official-outbound-inventory.json");
const output = value("--output", "outputs/fall-2026/tiktok-browser-importable.json");
const include = new Set(value("--include-companies", "kairos-health,quippy,trepo,yam").split(",").filter(Boolean));
const inputBytes = await readFile(inputPath), input = JSON.parse(inputBytes);
const inventoryBytes = await readFile(inventoryPath), inventory = JSON.parse(inventoryBytes);
const catalog = JSON.parse(await readFile("src/lib/yc/fall-2026-companies.json", "utf8"));
const evidence = [], needsReview = [], identities = new Map(), archiveFiles = new Set();
for (const native of input.nativePosts ?? []) {
  if (native.platform !== "tiktok") continue;
  const company = catalog.companies.find((entry) => entry.slug === native.companySlug);
  const identity = tiktokNativeIdentity(native.url);
  const pending = (reasons) => needsReview.push({ platform: "tiktok", companySlug: native.companySlug, platformPostId: identity?.postId ?? native.nativePostId, sourceUrl: native.url, reasons });
  if (!company || !include.has(company.slug) || !identity?.postId) { pending(["native_company_attribution_or_post_not_in_explicit_approved_scope"]); continue; }
  const profile = input.profiles?.find((entry) => entry.platform === "tiktok" && entry.companySlug === company.slug && tiktokNativeIdentity(entry.url)?.handle === identity?.handle);
  const outbound = inventory.ownedTargets?.find((entry) => entry.platform === "tiktok" && entry.companySlug === company.slug && tiktokNativeIdentity(entry.sourceUrl)?.handle === identity?.handle);
  if (!profile || !outbound) { pending(["official_company_account_or_native_profile_receipt_missing"]); continue; }
  let proof = identities.get(company.slug);
  if (!proof) {
    const html = await readFile(outbound.sourceHtmlArchivePath);
    const companyHost = new URL(company.websiteUrl).hostname.replace(/^www\./, "");
    const $ = load(html), expected = load(outbound.anchorHtml);
    const anchorVerified = $("a[href]").toArray().some((anchor) => tiktokNativeIdentity($(anchor).attr("href"))?.handle === identity.handle && $.html(anchor) === expected.html(expected("a")[0]) && $(anchor).closest("footer,nav,[class*=footer],[class*=contact]").length > 0);
    if (hash(html) !== outbound.sourceHtmlSha256 || !anchorVerified || new URL(outbound.discoveredOn).hostname.replace(/^www\./, "") !== companyHost || new URL(outbound.officialWebsite).hostname.replace(/^www\./, "") !== companyHost) throw new Error(`Official TikTok ownership archive failed: ${company.slug}`);
    archiveFiles.add(outbound.sourceHtmlArchivePath);
    proof = {
      source: "official_company_website_tiktok_account_v1", companySlug: company.slug, companyName: company.name,
      entityId: `company-${company.slug}`, review_state: "verified", officialWebsite: company.websiteUrl,
      officialYcCompanyUrl: company.ycProfileUrl, profileUrl: identity.profileUrl,
      inventoryPath, inventorySha256: hash(inventoryBytes), officialOutboundReceipt: outbound
    };
    identities.set(company.slug, proof);
  }
  const metrics = nativeTikTokMetrics(native), captionAbsent = native.caption === "";
  const post = { id: identity.postId, url: native.url, text: native.caption, authorHandle: native.authorHandle, authorName: native.authorDisplayName ?? company.name, captionAbsent, publishedAt: null, metrics, kind: `original_company_${identity.kind}`, nativeObservation: native };
  const raw = {
    source: NATIVE_TIKTOK_SOURCE, observedAt: native.observedAt, identityProof: proof, nativeProfile: profile, post,
    observationSource: inputPath, observationSourceSha256: hash(inputBytes),
    validation: {
      source: NATIVE_TIKTOK_VALIDATION, archiveHashesVerified: true, literalOfficialAnchorVerified: true, nativeProfileMatched: true,
      inventorySha256: proof.inventorySha256, sourceHtmlSha256: outbound.sourceHtmlSha256,
      identityProofSha256: objectHash(proof), nativeObservationSha256: objectHash(native)
    }
  };
  const row = {
    id: `tiktok-f26-${identity.postId}`, batchSlug: "F26", companySlug: company.slug, companyName: company.name,
    entityType: "company", entityId: `company-${company.slug}`, platform: "tiktok", platformPostId: identity.postId,
    accountUrl: identity.profileUrl, sourceUrl: native.url, authorName: company.name, authorHandle: native.authorHandle,
    title: `${company.name} TikTok ${identity.kind}`, text: native.caption, originalText: native.caption, captionAbsent,
    postedAt: null, publishedAtPrecision: "unknown", nativePublishedAtLiteral: native.nativeDateLabel,
    mediaType: identity.kind === "photo" ? "image" : "video", mediaUrls: [...new Set((native.media ?? []).map((entry) => entry.src).filter((entry) => /^https?:\/\//.test(entry ?? "")))],
    metrics, contributionScore: 0, tractionStatus: "unscored",
    tractionLimitations: ["No calibrated TikTok traction model is configured; native history contributes zero traction while observed engagement remains available.", "Native publication UI supplies a month/day label without a year or datetime. Publication time remains unknown; the video ID is not decoded.", ...(captionAbsent ? ["Native description element is present and empty. Retain the original video metadata unscored with no invented caption."] : [])],
    review_state: "verified", linkStatus: "verified", linkCheckedAt: native.observedAt,
    attributionVersion: 3, attributionStatus: "verified", attributionMode: "author", attributionProvenance: NATIVE_TIKTOK_SOURCE,
    attributionSignals: ["official_website_exact_tiktok_account", "native_tiktok_post_author", "visible_native_tiktok_video"],
    matchReason: "Exact TikTok target is linked by the official company homepage contact/social navigation. Its archived literal anchor and native profile listing bind the visible native author, video ID, description and own labeled engagement controls.",
    rawVisibleText: JSON.stringify(raw), first_seen_at: native.observedAt, last_checked_at: native.observedAt, last_updated_at: native.observedAt
  };
  const reasons = verifiedNativeTikTokReasons(row, company);
  if (reasons.length) pending(reasons); else evidence.push(row);
}
const source = { batchSlug: "F26", kind: NATIVE_TIKTOK_SOURCE, inputPath, inputSha256: hash(inputBytes), inventoryPath, inventorySha256: hash(inventoryBytes), verifiedPhysicalArchiveFiles: archiveFiles.size, received: input.nativePosts?.filter((entry) => entry.platform === "tiktok").length ?? 0, accepted: evidence.length, needsReview: needsReview.length, fullHistoryComplete: false };
await writeFile(output, `${JSON.stringify({ source, evidence, needsReview }, null, 2)}\n`);
console.log(JSON.stringify(source));
