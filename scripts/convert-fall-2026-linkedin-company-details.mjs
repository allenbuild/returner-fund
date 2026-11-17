import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { nativeLinkedInCompanyDetailSummary, verifiedNativeLinkedInCompanyDetailReasons } from "../src/lib/graph/linkedin-company-detail-receipt.mjs";

const value = (flag, fallback) => process.argv.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1) ?? fallback;
const inputPath = value("--input", "outputs/fall-2026/browser-checkpoints/linkedin-ui-lane2.json");
const output = value("--output", "outputs/fall-2026/linkedin-company-detail-importable.json");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const bytes = await readFile(inputPath), input = JSON.parse(bytes), catalog = JSON.parse(await readFile("src/lib/yc/fall-2026-companies.json", "utf8"));
const evidence = [], needsReview = [];
for (const profile of input.profiles ?? []) {
  const company = catalog.companies.find((row) => row.slug === profile.companySlug);
  if (!company) continue;
  const entity = { entityId: `company-${company.slug}`, entityType: "company", companySlug: company.slug, companyName: company.name, socialAccounts: { linkedin: [company.socialLinks.linkedin] } };
  for (const review of [...(profile.nativeReceiptUnavailable ?? []), ...(profile.nativeEmbedReview ?? [])].filter((row) => row.signedInNativeDetail)) {
    const receipt = { mechanism: "native_linkedin_company_detail_redirect_v1", companySlug: company.slug, profileUrl: profile.officialProfileUrl, observedAt: review.signedInNativeDetail.observedAt, review };
    const result = nativeLinkedInCompanyDetailSummary(receipt, entity);
    if (!result.ok) { needsReview.push({ companySlug: company.slug, componentKey: review.card?.key, reasons: result.reasons }); continue; }
    const post = { id: result.platformPostId, url: result.sourceUrl, text: result.text, author: { name: result.authorName, profileUrl: company.socialLinks.linkedin }, publishedAt: null, kind: "original_company_post", metrics: result.metrics, bodyTruncated: false, nativeCompanyDetailReceipt: receipt };
    const raw = { source: "authorized_linkedin_browser_dom_v1", observedAt: receipt.observedAt, officialIdentitySourceUrl: company.ycProfileUrl, profile: { name: result.authorName, url: company.socialLinks.linkedin }, post, observationSource: inputPath, observationSourceSha256: hash(bytes), validation: { source: "fall_2026_native_linkedin_company_detail_ingestion_v1", archiveHashesVerified: true, nativeCompanyDetailReceiptSha256: hash(JSON.stringify(receipt)) } };
    const positive = Object.values(result.metrics).some((value) => value > 0);
    const row = { id: `linkedin-f26-company-detail-${result.platformPostId}`, batchSlug: "F26", companySlug: company.slug, companyName: company.name, entityType: "company", entityId: entity.entityId, entityName: company.name, platform: "linkedin", platformPostId: result.platformPostId, sourceUrl: result.sourceUrl, accountUrl: company.socialLinks.linkedin, authorName: result.authorName, title: result.text.split("\n")[0], text: result.text, originalText: result.text, postedAt: null, publishedAtPrecision: "unknown", observedAt: receipt.observedAt, metrics: result.metrics, contributionScore: positive ? 1 : 0, ...(!positive ? { tractionStatus: "unscored" } : {}), mediaType: "link", bodyTruncated: false,
      review_state: "verified", linkStatus: "verified", attributionVersion: 3, attributionStatus: "verified", attributionMode: "author", attributionProvenance: "native_linkedin_company_detail_v1", attributionSignals: ["official_yc_linked_company_account", "visible_native_linkedin_post", "visible_author_matches_official_company", "actual_native_redirect_activity_detail"],
      matchReason: "Literal native Embed sign-in redirect identifies the actual activity detail. Its own company actor/menu and full caption agree with the exact original company card; unavailable Embed messages and event IDs are never used as post bodies or inferred activity aliases.", rawVisibleText: JSON.stringify(raw), first_seen_at: receipt.observedAt, last_checked_at: receipt.observedAt, last_updated_at: receipt.observedAt };
    const reasons = verifiedNativeLinkedInCompanyDetailReasons(row, entity);
    if (reasons.length) needsReview.push({ companySlug: company.slug, sourceUrl: row.sourceUrl, reasons }); else evidence.push(row);
  }
}
const source = { batchSlug: "F26", mechanism: "native_linkedin_company_detail_v1", inputPath, inputSha256: hash(bytes), received: evidence.length + needsReview.length, accepted: evidence.length, needsReview: needsReview.length, fullHistoryComplete: false };
await writeFile(output, `${JSON.stringify({ source, evidence, needsReview }, null, 2)}\n`);
console.log(JSON.stringify(source));
