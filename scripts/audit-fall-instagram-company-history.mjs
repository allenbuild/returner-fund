import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { StringDecoder } from "node:string_decoder";

// Offline only: this audit reads sealed observations and the approved evidence file.
const root = process.cwd();
const base = "outputs/fall-2026";
const manifest = new Map();
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const load = (file) => {
  const bytes = fs.readFileSync(path.join(root, file));
  manifest.set(file, { path: file, bytes: bytes.length, sha256: sha(bytes) });
  return JSON.parse(bytes);
};
const sourceHash = (file) => {
  if (!file || !fs.existsSync(path.join(root, file))) return null;
  if (!manifest.has(file)) {
    const bytes = fs.readFileSync(path.join(root, file));
    manifest.set(file, { path: file, bytes: bytes.length, sha256: sha(bytes) });
  }
  return manifest.get(file).sha256;
};
const handleOf = (url) => {
  try {
    const u = new URL(url);
    return /(^|\.)instagram\.com$/.test(u.hostname) ? u.pathname.split("/").filter(Boolean)[0]?.toLowerCase() : null;
  } catch { return null; }
};
const nativeId = (url) => url?.match(/\/(?:p|reel|reels)\/([^/?#]+)/)?.[1] ?? null;
const rawOf = (row) => {
  try { return typeof row.rawVisibleText === "string" ? JSON.parse(row.rawVisibleText) : row.rawVisibleText ?? {}; }
  catch { return {}; }
};
const args = process.argv.slice(2);
const argument = (flag, fallback) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
const proofPath = argument("--identity-proofs", `${base}/collection/checkpoint-26/instagram-identity-proofs.json`);
const identity = load(proofPath);
const uiPath = `${base}/browser-checkpoints/instagram-all-ui-current.json`;
const ui = load(uiPath);
const canonicalPath = argument("--canonical-snapshot", `${base}/collection/checkpoint-26/targeted-after.json`);
// Stream the immutable pretty-printed evidence array. Large native DOM strings
// are not expanded for unrelated platforms or cohorts.
const canonicalHash = crypto.createHash("sha256");
const canonicalStream = fs.createReadStream(path.join(root, canonicalPath));
canonicalStream.on("data", (chunk) => canonicalHash.update(chunk));
async function* literalJsonLines(stream) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  for await (const chunk of stream) {
    pending += decoder.write(chunk);
    let newline;
    while ((newline = pending.indexOf("\n")) !== -1) {
      yield pending.slice(0, newline);
      pending = pending.slice(newline + 1);
    }
  }
  pending += decoder.end();
  if (pending) yield pending;
}
const approved = [];
let inEvidence = false, currentRow = [];
for await (const line of literalJsonLines(canonicalStream)) {
  if (line === '  "evidence": [') { inEvidence = true; continue; }
  if (!inEvidence) continue;
  if (line.startsWith("  ],")) { inEvidence = false; continue; }
  if (line === "    {") { currentRow = [line]; continue; }
  if (!currentRow.length) continue;
  currentRow.push(line);
  if (line !== "    }," && line !== "    }") continue;
  const text = currentRow.join("\n").replace(/,$/, "");
  currentRow = [];
  if (!text.includes('"platform": "instagram"') || !text.includes('"batchSlug": "F26"')) continue;
  const row = JSON.parse(text);
  if (row.review_state === "verified") approved.push(row);
}
manifest.set(canonicalPath, { path: canonicalPath, bytes: fs.statSync(path.join(root, canonicalPath)).size, sha256: canonicalHash.digest("hex"), scope: "Immutable evidence snapshot; streamed only F26 verified Instagram rows" });
const websitePath = `${base}/instagram-official-website-outbound-links.json`;
const websites = load(websitePath);
const coverage = [];
for (const name of fs.readdirSync(path.join(root, base, "browser-checkpoints")).filter((f) => /^instagram-.*-history-coverage\.json$/.test(f))) {
  const file = `${base}/browser-checkpoints/${name}`;
  const d = load(file);
  coverage.push({ file, data: d, handle: handleOf(d.profileUrl ?? d.source?.profileUrl) });
}
const queue = [];
for (const company of identity.companies) {
  for (const account of company.accounts.filter((a) => a.entityType === "company" && a.review_state === "verified")) {
    const handle = account.handle.toLowerCase();
    const profile = ui.verifiedProfiles.find((p) => handleOf(p.url) === handle);
    const own = approved.filter((r) => r.entityType === "company" && r.companySlug === company.companySlug && r.authorHandle?.replace(/^@/, "").toLowerCase() === handle);
    const linkedCoverage = coverage.filter((c) => c.handle === handle);
    const latest = linkedCoverage.at(-1)?.data;
    const parsedHeader = profile?.identity?.match(/(?:^|\n)([\d,]+) posts?(?:\n|$)/)?.[1];
    const header = latest?.nativeHeaderPosts ?? latest?.headerPostCount ?? (parsedHeader ? Number(parsedHeader.replaceAll(",", "")) : null);
    const privateProfile = /This profile is private/.test(profile?.identity ?? "");
    const bothTabsKnown = Boolean(latest && (Array.isArray(latest.reelsChecks) || Array.isArray(latest.reelsSnapshots) || latest.postsAndReelsNativeBottomsObserved || latest.availablePostsAndReelsUnionComplete || latest.availablePostsAndReelsCaptured));
    const surfaceEnd = latest?.nativeFrontiersExhausted === true || latest?.postsAndReelsNativeBottomsObserved === true || latest?.availablePostsAndReelsUnionComplete === true || latest?.availablePostsAndReelsCaptured === true || latest?.availableHistoryComplete === true;
    const headerGap = latest?.unreconciledHeaderCountDifference ?? latest?.unreconciledHeaderGap ?? latest?.headerDifference ?? null;
    const missing = latest?.missingNativeDetailIds ?? latest?.missingVisibleIds ?? latest?.missingIds ?? [];
    const missingCount = Array.isArray(missing) ? missing.length : Number(missing ?? 0);
    const status = privateProfile ? "private_profile_no_collection" : missingCount ? "posts_and_reels_inventory_pending_details" : surfaceEnd && headerGap ? "posts_and_reels_frontiers_exhausted_with_header_gap" : latest?.availableHistoryComplete === true ? "available_history_complete_in_source_scope" : surfaceEnd ? "posts_and_reels_visible_union_captured_full_history_uncertain" : bothTabsKnown ? "posts_and_reels_inventory_pending_details" : "reels_coverage_unknown";
    const listedIds = [...new Set((profile?.posts ?? []).map((p) => nativeId(p.url)).filter(Boolean))];
    const receipts = own.map((r) => {
      const raw = rawOf(r), post = raw.post ?? {};
      return {
        platformPostId: r.platformPostId, sourceUrl: r.sourceUrl, authorHandle: r.authorHandle,
        canonicalEvidenceId: r.id, canonicalRowSha256: sha(JSON.stringify(r)),
        rawVisibleTextSha256: sha(typeof r.rawVisibleText === "string" ? r.rawVisibleText : JSON.stringify(r.rawVisibleText)),
        observationSource: raw.observationSource ?? null, observationSourceSha256: sourceHash(raw.observationSource),
        captionSha256: sha(r.originalText ?? r.text ?? ""), captionAbsent: post.captionAbsent === true,
        parentReceipt: {
          nativeAuthorHeaderPresent: Boolean(post.nativeAuthorHeader),
          nativeCaptionReceiptSha256: post.nativeCaptionReceipt ? sha(JSON.stringify(post.nativeCaptionReceipt)) : null,
          nativeMetricReceiptSha256: post.nativeMetricReceipt ? sha(JSON.stringify(post.nativeMetricReceipt)) : null,
          publicationTimeReceiptSha256: post.publicationTimeReceipt ? sha(JSON.stringify(post.publicationTimeReceipt)) : null,
          nativeControlsPresent: Array.isArray(post.controls) && post.controls.length > 0,
          nativeParentTextPresent: typeof post.nativeText === "string" && post.nativeText.length > 0,
          publicationFooterPresent: Boolean(post.publicationFooter),
        },
      };
    });
    queue.push({
      companySlug: company.companySlug, handle, profileUrl: account.profileUrl,
      identityProof: { path: proofPath, sha256: manifest.get(proofPath).sha256, account },
      status, requiresNativeReelsAudit: status === "reels_coverage_unknown", headerPostCount: header,
      visiblePostsAndReelsSurfaceEndObserved: surfaceEnd, fullAccountHistoryComplete: false,
      unreconciledHeaderDifference: headerGap, missingNativeDetailCount: missingCount,
      coverageScope: "Available rendered Posts/Reels union only; account-wide historical/deleted/private gaps remain unknown",
      postsSnapshot: profile ? { path: uiPath, observedAt: profile.observedAt, listedUniqueIds: listedIds, listedUniqueCount: listedIds.length, identityText: profile.identity } : null,
      approvedOwnPhysicalIds: receipts.map((r) => r.platformPostId), approvedOwnCount: receipts.length,
      approvedOwnedReceipts: receipts,
      knownTabCoverage: linkedCoverage.map(({ file, data: d }) => ({ path: file, sha256: manifest.get(file).sha256, source: d.source, postsListed: d.postsGridCount ?? d.postsGridIds?.length ?? d.postsIds?.length ?? d.postsListed ?? d.counts?.postsListed ?? d.summary?.posts ?? null, reelsListed: d.reelsGridCount ?? d.reelsGridIds?.length ?? d.reelsIds?.length ?? d.reelsListed ?? d.counts?.reelsListed ?? d.summary?.reels ?? null, physicalUnion: d.visibleUnionCount ?? d.unionUnique ?? d.currentVisibleUnique ?? d.counts?.physicalUnion ?? d.summary?.physicalUnion ?? null, availableHistoryComplete: d.availableHistoryComplete ?? null, nativeFrontiersExhausted: d.nativeFrontiersExhausted ?? d.postsAndReelsNativeBottomsObserved ?? d.availablePostsAndReelsUnionComplete ?? d.availablePostsAndReelsCaptured ?? null, allVisibleIdsHaveSavedNativeDetail: d.allVisibleIdsHaveSavedNativeDetail ?? null, unreconciledHeaderCountDifference: d.unreconciledHeaderCountDifference ?? d.unreconciledHeaderGap ?? d.headerDifference ?? null, missingVisibleIds: d.missingNativeDetailIds ?? d.missingVisibleIds ?? d.missingIds ?? null, freshNativeDetails: d.freshNativeDetails ?? null, newNativeIdsVersusBaseline: d.newNativeIdsVersusBaseline ?? null, attributionRule: d.attributionRule ?? d.attributionNote ?? null })),
      note: "Posts header/grid counts and /reel/ permalinks do not prove that the separate Reels tab was exhausted. Collaboration listing membership does not establish company authorship; approvedOwnPhysicalIds use exact approved primary owner only.",
    });
  }
}
queue.sort((a, b) => Number(b.requiresNativeReelsAudit) - Number(a.requiresNativeReelsAudit) || (b.headerPostCount ?? -1) - (a.headerPostCount ?? -1) || a.companySlug.localeCompare(b.companySlug));
queue.forEach((q, i) => { q.order = i + 1; });
const knownHandles = new Set(identity.companies.flatMap((c) => c.accounts.map((a) => a.handle.toLowerCase())));
const excludedWebsiteLinks = websites.links.filter((l) => {
  const h = handleOf(l.instagramUrl);
  return !h || !knownHandles.has(h);
}).map((l) => ({ companySlug: l.companySlug, observedUrl: l.instagramUrl, anchorText: l.anchorText, reason: !handleOf(l.instagramUrl) ? "generic_platform_link_not_an_identity" : l.companySlug === "vyra" ? "customer_testimonial_not_company_or_roster_founder_ownership" : "native_identity_pending_no_founder_inference" }));
const founderCandidatePath = `${base}/instagram-deepmark-formal-team-founder-candidates.json`;
const founderCandidates = fs.existsSync(path.join(root, founderCandidatePath)) ? load(founderCandidatePath).candidates : [];
const output = {
  schemaVersion: 1, generatedAt: new Date().toISOString(), batchSlug: "F26",
  source: "offline_saved_native_dom_and_approved_evidence_audit", networkRequestsMade: 0,
  counts: { companyAccounts: queue.length, companies: new Set(queue.map((q) => q.companySlug)).size, unknownReelsCoverage: queue.filter((q) => q.requiresNativeReelsAudit).length, scopedCompletionClaim: queue.filter((q) => q.status === "available_history_complete_in_source_scope").length, visibleFrontiersObserved: queue.filter((q) => q.visiblePostsAndReelsSurfaceEndObserved).length, visibleUnionCapturedFullHistoryUncertain: queue.filter((q) => q.status === "posts_and_reels_visible_union_captured_full_history_uncertain").length, frontiersExhaustedWithHeaderGap: queue.filter((q) => q.status === "posts_and_reels_frontiers_exhausted_with_header_gap").length, inventoryPendingDetails: queue.filter((q) => q.status === "posts_and_reels_inventory_pending_details").length, private: queue.filter((q) => q.status === "private_profile_no_collection").length, approvedOwnPhysicalIds: queue.reduce((n, q) => n + q.approvedOwnCount, 0), fullAccountHistoriesComplete: 0 },
  queue, additionalVerifiedFounderLeads: [],
  pendingFounderOwnershipCandidates: founderCandidates.filter((c) => !knownHandles.has(c.handle)).map((c) => ({ path: founderCandidatePath, sha256: manifest.get(founderCandidatePath).sha256, companySlug: c.companySlug, founderId: c.founderId, founderName: c.name, handle: c.handle, nativePostId: c.nativePostId, nativePostUrl: c.nativePostUrl, status: c.status, promoted: false })),
  resolvedFounderOwnershipCandidates: founderCandidates.filter((c) => knownHandles.has(c.handle)).map((c) => ({ companySlug: c.companySlug, founderId: c.founderId, handle: c.handle, resolution: "Verified in the pinned native identity registry; no promotion performed by this offline audit", identityProofSource: { path: proofPath, sha256: manifest.get(proofPath).sha256 } })),
  canonicalSnapshot: { path: canonicalPath, sha256: manifest.get(canonicalPath).sha256, usedOnlyForApprovedEvidenceCounts: true },
  excludedWebsiteLinks,
  founderLeadNote: "Cached official-site links only add already verified Sulan Zhang; other new Vyra personal links are explicitly customer testimonials. No additional founder ownership identity was inferred from names, comments or coauthor membership.",
  inputManifest: [...manifest.values()].sort((a, b) => a.path.localeCompare(b.path)),
};
const outputPath = `${base}/instagram-company-posts-reels-coverage-queue.json`;
fs.writeFileSync(path.join(root, outputPath), `${JSON.stringify(output, null, 2)}\n`);
const bytes = fs.readFileSync(path.join(root, outputPath));
console.log(JSON.stringify({ outputPath, bytes: bytes.length, sha256: sha(bytes), counts: output.counts, next: queue.filter((q) => q.requiresNativeReelsAudit).map((q) => ({ order: q.order, handle: q.handle, header: q.headerPostCount, approved: q.approvedOwnCount })) }));
