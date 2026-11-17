import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { resolveLinkedInNativeAuthor } from "./lib/fall-linkedin-attribution.mjs";

const root = process.cwd();
const checkpointPath = resolve(root, "outputs/fall-2026/linkedin-browser-checkpoint.json");
const outputPath = resolve(root, "outputs/fall-2026/linkedin-browser-importable.json");
const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
const roster = JSON.parse(await readFile(resolve(root, "src/lib/yc/fall-2026-companies.json"), "utf8"));
const companies = new Map(roster.companies.map((company) => [company.slug, company]));
const receipts = new Map();
for (const path of new Set(checkpoint.evidence.map((row) => row.browserObservationPath).filter(Boolean))) {
  const observation = JSON.parse(await readFile(resolve(root, path), "utf8"));
  for (const profile of observation.profiles ?? []) {
    for (const captured of profile.rows ?? []) {
      const id = captured.sourceUrl?.match(/urn:li:(?:activity|ugcPost):(\d+)/)?.[1];
      if (id) receipts.set(id, { profile, captured, path });
    }
  }
}
const seen = new Set();
const needsReview = [];
const corrections = [];
const evidence = checkpoint.evidence.flatMap((row) => {
  const company = companies.get(row.companySlug);
  const postId = row.sourceUrl.match(/^https:\/\/www\.linkedin\.com\/feed\/update\/urn:li:(?:activity|ugcPost):(\d+)\/$/)?.[1];
  if (!company || !postId || postId !== row.platformPostId || !row.text?.trim()) {
    throw new Error(`Invalid observed LinkedIn company post: ${row.companySlug}/${row.platformPostId}`);
  }
  if (seen.has(postId)) throw new Error(`Duplicate observed LinkedIn native post: ${postId}`);
  seen.add(postId);
  const nativeReceipt = receipts.get(postId);
  const author = resolveLinkedInNativeAuthor(company, row, nativeReceipt);
  if (author.status !== "verified") {
    needsReview.push({ ...row, review_state: "needs_review", reason: author.reason,
      nativePrimaryAuthor: author.primary ?? null, browserObservationPath: nativeReceipt?.path ?? row.browserObservationPath });
    return [];
  }
  const accountUrl = author.accountUrl;
  if (!accountUrl) throw new Error(`No official LinkedIn identity for ${row.companySlug}`);
  const metrics = Object.fromEntries(Object.entries(row.metrics ?? {}).filter(([key, value]) =>
    ["reactions", "comments", "reposts", "views"].includes(key) && Number.isFinite(value) && value >= 0
  ));
  const post = {
    id: postId, url: row.sourceUrl, text: row.originalText,
    author: { name: author.authorName, profileUrl: accountUrl },
    dateLabel: row.dateLabel, publishedAt: null,
    kind: author.kind, metrics
  };
  if (author.entityType !== row.entityType || author.entityId !== row.entityId) {
    corrections.push({ platformPostId: postId, sourceUrl: row.sourceUrl, companySlug: company.slug,
      previousEntityType: row.entityType, previousEntityId: row.entityId,
      entityType: author.entityType, entityId: author.entityId, authorName: author.authorName,
      accountUrl, nativePrimaryAuthor: author.primary, browserObservationPath: nativeReceipt?.path,
      sourceTextSha256: createHash("sha256").update(row.originalText).digest("hex"),
      nativeReceipt: {
        outerActivityUrn: nativeReceipt?.captured?.preview?.activityUrn ?? null,
        nativePostLinks: nativeReceipt?.captured?.preview?.links?.filter((link) =>
          link.href?.includes(`urn:li:activity:${postId}`) && /social-actions-(reactions|comments)/.test(link.href)) ?? [],
        primaryAuthor: author.primary, observedAt: nativeReceipt?.captured?.observedAt,
        officialFounderIdentitySourceUrl: author.identitySourceUrl,
        companyCollaboration: author.companyContext
      }
    });
  }
  return [{
    ...row,
    id: `linkedin-f26-browser-${postId}`,
    batchSlug: "F26",
    entityType: author.entityType,
    entityId: author.entityId,
    authorName: author.authorName,
    identitySourceUrl: author.identitySourceUrl,
    kind: author.kind,
    collaborationCompany: author.entityType === "founder" ? author.companyContext : undefined,
    accountUrl,
    authorHandle: new URL(accountUrl.replace(/^http:/, "https:")).pathname.replace(/\/$/, ""),
    postedAt: null,
    publishedAtPrecision: "unknown",
    metrics,
    rawVisibleText: JSON.stringify({
      source: "authorized_linkedin_browser_dom_v1",
      collectionSurface: row.collectionSurface ?? (row.collectionMethod === "signed_in_browser_dom_embed_preview"
        ? "public_company_posts_history" : "public_company_home_posts"),
      officialIdentitySourceUrl: company.ycProfileUrl,
      officialFounderIdentitySourceUrl: author.entityType === "founder" ? author.identitySourceUrl : undefined,
      observedAt: row.observedAt,
      profile: { name: author.authorName, url: accountUrl },
      post,
      companyCollaboration: author.entityType === "founder" ? author.companyContext : undefined,
      nativePrimaryAuthor: author.primary ?? null,
      nativeActivityUrn: nativeReceipt?.captured?.preview?.activityUrn ?? null,
      nativeObservationPath: nativeReceipt?.path ?? row.browserObservationPath ?? null
    }),
    review_state: "verified",
    linkStatus: "verified",
    linkCheckedAt: row.observedAt,
    attributionVersion: 3,
    nativeAuthorNormalizationVersion: 1,
    attributionStatus: "verified",
    attributionMode: "author",
    attributionProvenance: "authorized_linkedin_browser_dom_v1",
    attributionSignals: author.entityType === "founder"
      ? ["official_yc_linked_founder_account", "visible_native_linkedin_post", "visible_author_matches_official_founder", author.signal]
      : ["official_yc_linked_company_account", "visible_native_linkedin_post", "visible_author_matches_official_company", author.signal],
    matchReason: author.entityType === "founder"
      ? "Native embed primary author exactly matches the official YC-linked founder account. Company collaboration is retained as context; metrics belong to this outer native activity."
      : "Company author and native post permalink observed through the authorized signed-in browser. Quoted third-party bodies and plain reposts are excluded.",
    first_seen_at: row.observedAt,
    last_checked_at: row.observedAt,
    last_updated_at: row.observedAt
  }];
});
const visited = new Set(checkpoint.profiles.map((profile) => profile.companySlug));
const unvisitedCompanyProfiles = roster.companies
  .filter((company) => company.socialLinks.linkedin && !visited.has(company.slug))
  .map((company) => ({ companySlug: company.slug, companyName: company.name, accountUrl: company.socialLinks.linkedin }));
const output = {
  source: {
    label: "Authorized signed-in LinkedIn browser DOM observations",
    batchSlug: "F26", fetchedAt: new Date().toISOString(),
    checkpointPath: "outputs/fall-2026/linkedin-browser-checkpoint.json",
    officialCompanyProfileCount: roster.companies.filter((company) => company.socialLinks.linkedin).length,
    profilesChecked: checkpoint.profiles.length,
    unvisitedCompanyProfileCount: unvisitedCompanyProfiles.length,
    officialFounderProfileCount: roster.companies.reduce((count, company) =>
      count + company.founders.filter((founder) => founder.socialLinks.linkedin).length, 0),
    founderProfilesChecked: 0,
    historyComplete: false,
    notes: ["Only visible native text, author, permalink, and engagement metrics were recorded.", "Relative publication labels remain unknown precision with no invented publication timestamp."]
  },
  evidence,
  profileOutcomes: checkpoint.profiles,
  unvisitedCompanyProfiles,
  needsReview
};
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
await writeFile(resolve(root, "outputs/fall-2026/linkedin-attribution-correction-audit.json"), `${JSON.stringify({
  generatedAt: new Date().toISOString(), checkpointRows: checkpoint.evidence.length,
  importableRows: evidence.length, correctedFounderRows: corrections.length,
  needsReviewRows: needsReview.length, corrections,
  needsReview: needsReview.map(({ platformPostId, sourceUrl, entityType, entityId, companySlug, originalText, reason, nativePrimaryAuthor, browserObservationPath }) =>
    ({ platformPostId, sourceUrl, previousEntityType: entityType, previousEntityId: entityId,
      companySlug, reason, nativePrimaryAuthor, browserObservationPath,
      sourceTextSha256: createHash("sha256").update(originalText).digest("hex") }))
}, null, 2)}\n`);
console.log(JSON.stringify({ outputPath, evidenceRows: evidence.length, correctedFounderRows: corrections.length, needsReviewRows: needsReview.length, profilesChecked: checkpoint.profiles.length, unvisitedCompanyProfiles: unvisitedCompanyProfiles.length }));
