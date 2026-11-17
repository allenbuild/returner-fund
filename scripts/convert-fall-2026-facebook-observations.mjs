import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { load } from "cheerio";
import { NATIVE_FACEBOOK_SOURCE, NATIVE_FACEBOOK_VALIDATION, facebookNativeIdentity, nativeFacebookCaption, nativeFacebookPublicationLabel, verifiedNativeFacebookReasons } from "../src/lib/graph/facebook-native-receipt.mjs";
const value = (key, fallback) => process.argv.slice(2).find((arg) => arg.startsWith(`${key}=`))?.slice(key.length + 1) ?? fallback;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const objectHash = (value) => sha(JSON.stringify(value));
const inputPath = value("--input", "outputs/fall-2026/browser-checkpoints/facebook-ui-current.json");
const output = value("--output", "outputs/fall-2026/facebook-browser-importable.json");
const inventoryPath = value("--inventory", "outputs/source-hunt/2026-11-15-fall-2026-other-platform-official-outbound-inventory.json");
const bytes = await readFile(inputPath), input = JSON.parse(bytes), inventoryBytes = await readFile(inventoryPath), inventory = JSON.parse(inventoryBytes);
const catalog = JSON.parse(await readFile("src/lib/yc/fall-2026-companies.json", "utf8"));
const evidence = [], needsReview = [], ownership = new Map(), seen = new Set();
const candidates = input.nativePosts ?? input.profiles?.flatMap((profile) => (profile.articles ?? []).map((article) => ({ ...article, platform: profile.platform, companySlug: profile.companySlug, profileUrl: profile.url, observedAt: profile.observedAt }))) ?? [];
for (const article of candidates) {
  if (article.platform !== "facebook") continue;
  const company = catalog.companies.find((entry) => entry.slug === article.companySlug);
  const account = facebookNativeIdentity(article.profileUrl);
  const identity = facebookNativeIdentity(article.sourceUrl) ?? (article.links ?? []).map((entry) => facebookNativeIdentity(entry.url)).find((entry) => entry?.postId && entry.accountKey === account?.accountKey);
  const pending = (reasons) => needsReview.push({ platform: "facebook", companySlug: article.companySlug, platformPostId: identity?.postId, sourceUrl: identity?.sourceUrl ?? article.sourceUrl, reasons });
  if (!company || !account?.profileUrl || !account.accountKey || account.postId || !identity?.postId || seen.has(identity.postId)) { if (!seen.has(identity?.postId)) pending(["missing_native_company_account_or_post_permalink"]); continue; }
  seen.add(identity.postId);
  const profile = input.profiles?.find((entry) => (!entry.platform || entry.platform === "facebook") && entry.companySlug === company.slug && facebookNativeIdentity(entry.url)?.accountKey === account.accountKey && String(entry.identity ?? "").trim());
  const outbound = inventory.ownedTargets?.find((entry) => entry.platform === "facebook" && entry.companySlug === company.slug && facebookNativeIdentity(entry.sourceUrl)?.accountKey === account.accountKey);
  if (!profile || !outbound) { pending(["official_company_account_or_native_profile_receipt_missing"]); continue; }
  const authorName = String(profile.identity ?? "").trim(), caption = nativeFacebookCaption(article, authorName);
  if (!caption.ok) { pending([caption.reason]); continue; }
  let proof = ownership.get(company.slug);
  if (!proof) {
    const html = await readFile(outbound.sourceHtmlArchivePath), companyHost = new URL(company.websiteUrl).hostname.replace(/^www\./, "");
    const $ = load(html), expected = load(outbound.anchorHtml);
    const anchorVerified = $("a[href]").toArray().some((anchor) =>
      facebookNativeIdentity($(anchor).attr("href"))?.accountKey === account.accountKey &&
      $.html(anchor) === expected.html(expected("a")[0]) &&
      $(anchor).closest("footer,nav,[class*=footer],[class*=contact]").length > 0
    );
    if (sha(html) !== outbound.sourceHtmlSha256 || !anchorVerified || new URL(outbound.discoveredOn).hostname.replace(/^www\./, "") !== companyHost || new URL(outbound.officialWebsite).hostname.replace(/^www\./, "") !== companyHost) throw new Error(`Official Facebook ownership archive failed: ${company.slug}`);
    proof = { source: "official_company_website_facebook_account_v1", companySlug: company.slug, companyName: company.name, entityId: `company-${company.slug}`, review_state: "verified", officialWebsite: company.websiteUrl, officialYcCompanyUrl: company.ycProfileUrl, profileUrl: account.profileUrl, inventoryPath, inventorySha256: sha(inventoryBytes), officialOutboundReceipt: outbound };
    ownership.set(company.slug, proof);
  }
  const post = { id: identity.postId, url: identity.sourceUrl, text: caption.text, captionAbsent: caption.text === "", authorName, kind: caption.kind, publishedAt: null, metrics: {}, nativeObservation: article };
  const raw = { source: NATIVE_FACEBOOK_SOURCE, observedAt: article.observedAt, identityProof: proof, nativeProfile: { url: profile.url, identity: profile.identity, observedAt: profile.observedAt }, post, observationSource: inputPath, observationSourceSha256: sha(bytes), captionExtraction: caption, validation: { source: NATIVE_FACEBOOK_VALIDATION, archiveHashesVerified: true, literalOfficialAnchorVerified: true, inventorySha256: proof.inventorySha256, sourceHtmlSha256: outbound.sourceHtmlSha256, identityProofSha256: objectHash(proof), nativeObservationSha256: objectHash(article) } };
  const row = {
    id: `facebook-f26-${identity.postId}`, batchSlug: "F26", companySlug: company.slug, companyName: company.name, entityType: "company", entityId: `company-${company.slug}`,
    platform: "facebook", platformPostId: identity.postId, sourceUrl: identity.sourceUrl, accountUrl: account.profileUrl, authorName, authorHandle: account.accountKey.slice(1),
    title: `${company.name} Facebook ${caption.countsAsAuthoredPost ? "post" : "photo update"}`, text: caption.text, originalText: caption.text, captionAbsent: caption.text === "", nativeContentKind: caption.kind, countsAsAuthoredPost: caption.countsAsAuthoredPost,
    postedAt: null, publishedAtPrecision: "unknown", nativePublishedAtLiteral: nativeFacebookPublicationLabel(article),
    mediaType: article.media?.length ? "image" : "text", mediaUrls: [...new Set((article.media ?? []).map((entry) => entry.src).filter((entry) => /^https?:\/\//.test(entry ?? "")))],
    metrics: {}, contributionScore: 0, tractionStatus: "unscored", tractionLimitations: ["Facebook native history is retained without a calibrated traction model. Unobserved engagement remains unknown.", "Native calendar and clock labels do not identify a timezone. Publication timestamp remains unknown.", ...(!caption.countsAsAuthoredPost ? ["This is a native profile/cover photo update with no authored caption; retain typed metadata without creating original prose."] : [])],
    review_state: "verified", linkStatus: "verified", linkCheckedAt: article.observedAt, attributionVersion: 3, attributionStatus: "verified", attributionMode: "author", attributionProvenance: NATIVE_FACEBOOK_SOURCE,
    attributionSignals: ["official_website_exact_facebook_account", "native_facebook_post_author", "visible_native_facebook_article"],
    matchReason: "The official company homepage links this exact native Facebook page. Its native article supplies the same own author, post permalink, full expanded caption or explicit profile-photo update, and original media.",
    rawVisibleText: JSON.stringify(raw), first_seen_at: article.observedAt, last_checked_at: article.observedAt, last_updated_at: article.observedAt
  };
  const reasons = verifiedNativeFacebookReasons(row, company);
  if (reasons.length) pending(reasons); else evidence.push(row);
}
const source = { batchSlug: "F26", kind: NATIVE_FACEBOOK_SOURCE, inputPath, inputSha256: sha(bytes), inventoryPath, inventorySha256: sha(inventoryBytes), received: candidates.filter((entry) => entry.platform === "facebook").length, accepted: evidence.length, needsReview: needsReview.length, authoredCaptions: evidence.filter((entry) => entry.countsAsAuthoredPost).length, typedPhotoUpdates: evidence.filter((entry) => !entry.countsAsAuthoredPost).length, verifiedOwnershipArchives: ownership.size, fullHistoryComplete: false };
await writeFile(output, `${JSON.stringify({ source, evidence, needsReview }, null, 2)}\n`); console.log(JSON.stringify(source));
