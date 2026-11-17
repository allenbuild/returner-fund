import { createHash } from "node:crypto";
import { linkedinIdentity, resolveLinkedInNativeAuthor } from "./fall-linkedin-attribution.mjs";

export const linkedinReconciliationSha256 = (value) => createHash("sha256").update(value).digest("hex");
const nativeId = (value) => String(value ?? "").match(/urn:li:(?:activity|ugcPost):(\d+)/)?.[1];
const bodyHash = (row) => linkedinReconciliationSha256(row.originalText ?? row.text ?? "");
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

// This planner only authorizes the explicit physical posts in the reviewed audit.
// Normal ingestion retains its attribution-conflict rejection policy.
export function planFallLinkedInAttributionReconciliation({ before, audit, candidates, roster, observations }) {
  const companies = new Map(roster.companies.map((company) => [company.slug, company]));
  const accepted = new Map(candidates.evidence.map((row) => [row.platformPostId, row]));
  const held = new Map(candidates.needsReview.map((row) => [row.platformPostId, row]));
  const decisions = new Map();
  const correctedInput = [];
  for (const [kind, entries] of [["correct", audit.corrections], ["hold", audit.needsReview]]) {
    for (const entry of entries) {
      const id = entry.platformPostId;
      if (!/^\d+$/.test(id) || nativeId(entry.sourceUrl) !== id || decisions.has(id)) throw new Error(`Invalid or duplicate audited native ID: ${id}`);
      const company = companies.get(entry.companySlug);
      const row = (kind === "correct" ? accepted : held).get(id);
      if (!company || !row || row.batchSlug !== "F26" || row.platform !== "linkedin" || row.companySlug !== company.slug
        || nativeId(row.sourceUrl) !== id || bodyHash(row) !== entry.sourceTextSha256) throw new Error(`Audited source identity/body mismatch: ${id}`);
      if (entry.previousEntityType !== "company" || entry.previousEntityId !== `company-${company.slug}`) throw new Error(`Invalid previous audited attribution: ${id}`);
      const path = entry.browserObservationPath ?? row.browserObservationPath;
      const document = path ? observations.get(path) : null;
      let receipt;
      for (const profile of document?.profiles ?? []) {
        for (const captured of profile.rows ?? []) {
          if (nativeId(captured.sourceUrl) === id) receipt = { profile, captured, path };
        }
      }
      if (receipt && (receipt.profile.companySlug !== company.slug || bodyHash({ text: receipt.captured.text }) !== entry.sourceTextSha256)) throw new Error(`Native observation body/company mismatch: ${id}`);
      const resolved = resolveLinkedInNativeAuthor(company, row, receipt);
      if (kind === "correct") {
        const raw = JSON.parse(row.rawVisibleText);
        const proof = entry.nativeReceipt;
        const primary = receipt?.captured?.preview?.links?.find((link) => {
          try { return new URL(link.href).searchParams.get("trk") === "public_post_embed_feed-actor-name"; } catch { return false; }
        });
        const outerLinks = (receipt?.captured?.preview?.links ?? []).filter((link) => nativeId(link.href) === id);
        if (!receipt || resolved.status !== "verified" || resolved.entityType !== "founder"
          || resolved.entityId !== entry.entityId || row.entityId !== entry.entityId || row.entityType !== "founder"
          || row.authorName !== resolved.authorName || entry.authorName !== resolved.authorName
          || row.identitySourceUrl !== resolved.identitySourceUrl
          || linkedinIdentity(row.accountUrl) !== linkedinIdentity(resolved.accountUrl)
          || linkedinIdentity(entry.accountUrl) !== linkedinIdentity(resolved.accountUrl)
          || !equal(primary, entry.nativePrimaryAuthor) || !equal(primary, proof?.primaryAuthor)
          || !outerLinks.length || !equal(outerLinks, proof.nativePostLinks)
          || proof.observedAt !== receipt.captured.observedAt
          || proof.officialFounderIdentitySourceUrl !== resolved.identitySourceUrl
          || raw.post?.id !== id || raw.post?.text !== row.originalText
          || !equal(raw.post?.metrics, row.metrics)
          || linkedinIdentity(raw.post?.author?.profileUrl) !== linkedinIdentity(resolved.accountUrl)
          || linkedinIdentity(raw.nativePrimaryAuthor?.href) !== linkedinIdentity(resolved.accountUrl)) throw new Error(`Native founder ownership proof mismatch: ${id}`);
        correctedInput.push(row);
      } else if (resolved.status !== "needs_review" || resolved.reason !== entry.reason || row.reason !== entry.reason || accepted.has(id)) {
        throw new Error(`Native quarantine decision mismatch: ${id}`);
      }
      decisions.set(id, { kind, entry });
    }
  }
  if (audit.correctedFounderRows !== correctedInput.length || audit.needsReviewRows !== held.size || audit.importableRows !== accepted.size) throw new Error("Audit counts do not match frozen candidates.");
  const removed = [];
  const evidence = before.evidence.filter((row) => {
    if (row.batchSlug !== "F26" || row.platform !== "linkedin" || !decisions.has(row.platformPostId)) return true;
    const { entry, kind } = decisions.get(row.platformPostId);
    if (row.companySlug !== entry.companySlug || bodyHash(row) !== entry.sourceTextSha256
      || (row.entityId !== entry.previousEntityId && !(kind === "correct" && row.entityId === entry.entityId))) throw new Error(`Existing canonical row is outside reviewed correction: ${row.platformPostId}`);
    removed.push({ decision: kind, reason: kind === "hold" ? entry.reason : "native_primary_author_corrected_to_exact_roster_founder", original: row });
    return false;
  });
  return { staging: { ...before, evidence }, correctedInput, removed, held: [...held.values()], decisions };
}
