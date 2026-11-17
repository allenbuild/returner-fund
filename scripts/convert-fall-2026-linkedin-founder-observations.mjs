import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { nativeLinkedInFounderCardSummary, verifiedNativeLinkedInFounderHistoryReasons } from "../src/lib/graph/linkedin-founder-history-receipt.mjs";
import { verifiedFallLinkedInFounderAccounts } from "../src/lib/graph/linkedin-founder-aliases.mjs";

const args = process.argv.slice(2);
const values = (flag) => args.filter((arg) => arg.startsWith(`${flag}=`)).map((arg) => arg.slice(flag.length + 1));
const inputPaths = values("--input");
if (!inputPaths.length) inputPaths.push("outputs/fall-2026/browser-checkpoints/linkedin-founder-jay-carousel-ui-current.json", "outputs/fall-2026/browser-checkpoints/linkedin-founder-jay-native-receipts-ui-current.json", "outputs/fall-2026/browser-checkpoints/linkedin-founder-jay-native-detail-receipts-ui-current.json");
const output = values("--output")[0] ?? "outputs/fall-2026/linkedin-founder-browser-importable.json";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const objectHash = (value) => sha(JSON.stringify(value));
const slugify = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const account = (value) => { try { const url = new URL(value); return url.protocol === "https:" && ["linkedin.com", "www.linkedin.com"].includes(url.hostname) ? url.pathname.replace(/\/+$/, "").toLowerCase() : null; } catch { return null; } };
const roster = JSON.parse(await readFile("src/lib/yc/fall-2026-companies.json", "utf8"));
const aliasRegistry = JSON.parse(await readFile(values("--alias-proofs")[0] ?? "src/lib/social/linkedin-founder-aliases-fall-2026.json", "utf8"));
for (const proof of aliasRegistry.proofs ?? []) for (const archive of proof.archives ?? []) {
  const path = values("--alias-archives-directory")[0] ? `${values("--alias-archives-directory")[0]}/${archive.sha256}` : archive.path;
  if (sha(await readFile(path)) !== archive.sha256) throw new Error("Founder alias identity archive SHA changed.");
}
const evidence = new Map(), needsReview = [], sources = [];
for (const path of inputPaths) {
  const bytes = await readFile(path), input = JSON.parse(bytes);
  const company = roster.companies.find((row) => row.slug === input.companySlug);
  const founder = company?.founders.find((row) => String(row.id) === String(input.founderId) && row.name === input.founderName);
  const profileUrl = input.profileUrl ?? input.observation?.url;
  const knownAccounts = founder ? verifiedFallLinkedInFounderAccounts(company, founder, aliasRegistry) : [];
  if (!founder || !knownAccounts.some((known) => account(known) === account(profileUrl))
    || !["authorized_linkedin_founder_native_dom_v1", "authorized_linkedin_founder_native_embed_dom_v1", "authorized_linkedin_founder_native_detail_dom_v1"].includes(input.source)) throw new Error(`Unverified exact roster LinkedIn founder identity: ${path}`);
  if (input.officialIdentitySourceUrl && input.officialIdentitySourceUrl !== company.ycProfileUrl || input.officialFounderIdentitySourceUrl && input.officialFounderIdentitySourceUrl !== founder.ycProfileUrl) throw new Error("Native founder source identity URL conflicts with the roster.");
  const entity = { entityType: "founder", entityId: `founder-${company.slug}-${slugify(founder.name)}-${founder.id}`, companySlug: company.slug, companyName: company.name, founderName: founder.name, socialAccounts: { linkedin: knownAccounts } };
  let cards = input.observation?.cards ?? input.cards ?? [], history = null;
  if (input.sourceHistory) {
    const historyBytes = await readFile(input.sourceHistory.path);
    if (sha(historyBytes) !== input.sourceHistory.sha256) throw new Error("Frozen founder source history SHA changed.");
    history = JSON.parse(historyBytes);
    if (history.companySlug !== company.slug || String(history.founderId) !== String(founder.id) || account(history.profileUrl) !== account(profileUrl)) throw new Error("Native founder receipt refers to a different source history owner.");
    cards = history.cards ?? history.observation?.cards ?? [];
  }
  const observations = input.receipts ? input.receipts.map((nativeReceipt) => {
    const card = cards.find((entry) => entry.componentKey === nativeReceipt.sourceCardKey);
    if (!card || nativeReceipt.sourceCardMenuLabel !== card.menuLabel || !card.captionNodes?.some((node) => node.text === nativeReceipt.sourceCaption?.text && node.html === nativeReceipt.sourceCaption?.html)) throw new Error("Native founder Embed receipt is not bound to its exact frozen source card and caption.");
    // Namespace selection only chooses the verifier. The selected verifier must
    // independently prove the actual copied/resolved URL, DOM author/body and
    // native object references; a share ID is never an activity ID.
    const shareDetail = input.source === "authorized_linkedin_founder_native_detail_dom_v1" && nativeReceipt.detail?.nativeObjectType === null && /-share-\d+-[^/]+\/?$/.test(new URL(nativeReceipt.resolvedUrl).pathname);
    const mechanism = input.source === "authorized_linkedin_founder_native_detail_dom_v1"
      ? shareDetail ? "native_linkedin_founder_copy_link_share_activity_detail_v1" : "native_linkedin_founder_copy_link_ugc_detail_v1"
      : "native_linkedin_founder_embed_article_v1";
    return { card, observedAt: nativeReceipt.observedAt, detailProof: { mechanism, nativeReceipt } };
  }) : cards.map((card) => ({ card, observedAt: card.observedAt ?? input.observation?.observedAt }));
  sources.push({ path, sha256: sha(bytes), companySlug: company.slug, founderId: String(founder.id), sourceHistory: input.sourceHistory ?? null, observations: observations.length, historyListingComplete: input.historyListingComplete ?? input.historyComplete ?? false, nativeReceiptCoverageComplete: input.nativeReceiptCoverageComplete ?? false });
  for (const observation of observations) {
    const receipt = { mechanism: "native_linkedin_founder_activity_card_v1", profileUrl, founderId: String(founder.id), founderName: founder.name, companySlug: company.slug, ...observation };
    const summary = nativeLinkedInFounderCardSummary(receipt, entity);
    if (!summary.ok) { needsReview.push({ sourcePath: path, componentKey: observation.card.componentKey ?? null, menuLabel: observation.card.menuLabel, reasons: summary.reasons }); continue; }
    const post = { id: summary.platformPostId, url: summary.sourceUrl, text: summary.text, author: { name: founder.name, profileUrl }, publishedAt: summary.postedAt, kind: "original_founder_post", metrics: summary.metrics, bodyTruncated: false, nativeFounderHistoryReceipt: receipt };
    const raw = { source: "authorized_linkedin_browser_dom_v1", observedAt: observation.observedAt, officialIdentitySourceUrl: company.ycProfileUrl, officialFounderIdentitySourceUrl: founder.ycProfileUrl, profile: { name: founder.name, url: profileUrl }, post,
      founderAccountIdentityProof: aliasRegistry.proofs.find((proof) => proof.founderId === String(founder.id) && account(proof.profileUrl) === account(profileUrl)) ?? null,
      observationSource: path, observationSourceSha256: sha(bytes), sourceHistory: input.sourceHistory ?? null,
      ...(observation.detailProof?.mechanism === "native_linkedin_founder_copy_link_share_activity_detail_v1" ? {
        observedSourceUrl: observation.detailProof.nativeReceipt.resolvedUrl,
        canonicalSourceUrlDerivation: "The activity permalink is derived from unanimously observed literal native comment-component activity URNs on the exact copied post detail. The actual resolved share URL is retained independently; the share ID supplies no activity identity."
      } : {}),
      validation: { source: "fall_2026_native_linkedin_founder_history_ingestion_v1", archiveHashesVerified: true, nativeFounderHistoryReceiptSha256: objectHash(receipt), nativeCardSha256: objectHash(observation.card) } };
    const positive = Object.values(summary.metrics).some((value) => value > 0);
    const row = { id: `linkedin-f26-founder-${summary.platformPostId}`, batchSlug: "F26", companySlug: company.slug, companyName: company.name, entityType: "founder", entityId: entity.entityId, entityName: founder.name, founderName: founder.name, platform: "linkedin", platformPostId: summary.platformPostId, sourceUrl: summary.sourceUrl, accountUrl: profileUrl, authorName: founder.name, authorHandle: null,
      title: summary.text.split("\n")[0], text: summary.text, originalText: summary.text, postedAt: summary.postedAt, publishedAtPrecision: summary.publishedAtPrecision, observedAt: observation.observedAt, metrics: summary.metrics, contributionScore: positive ? 1 : 0, ...(!positive ? { tractionStatus: "unscored" } : {}), mediaType: "link", bodyTruncated: false,
      review_state: "verified", linkStatus: "verified", attributionVersion: 3, attributionStatus: "verified", attributionMode: "author", attributionProvenance: "native_linkedin_founder_history_v1", attributionSignals: ["official_yc_linked_founder_account", "visible_native_linkedin_post", "visible_author_matches_official_founder", "native_founder_card_exact_activity_identity"],
      matchReason: "Exact roster founder profile and own native menu/header agree with the bounded own caption. Native identity comes from the own caption link, same-card Embed article, or physically bound copied-post detail with independently observed native object references. Quoted authors, share IDs and opaque component keys do not supply an outer activity identity.", rawVisibleText: JSON.stringify(raw), first_seen_at: observation.observedAt, last_checked_at: observation.observedAt, last_updated_at: summary.postedAt ?? observation.observedAt };
    const reasons = verifiedNativeLinkedInFounderHistoryReasons(row, entity);
    if (reasons.length) needsReview.push({ sourcePath: path, sourceUrl: row.sourceUrl, reasons });
    else { const previous = evidence.get(row.platformPostId); if (!previous || Date.parse(row.observedAt) > Date.parse(previous.observedAt)) evidence.set(row.platformPostId, row); }
  }
}
const source = { batchSlug: "F26", mechanism: "native_linkedin_founder_history_v1", sources, accepted: evidence.size, needsReview: needsReview.length, fullHistoryComplete: false };
await writeFile(output, `${JSON.stringify({ source, evidence: [...evidence.values()], needsReview }, null, 2)}\n`);
console.log(JSON.stringify(source));
