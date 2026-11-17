import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkedinReconciliationSha256 as sha, planFallLinkedInAttributionReconciliation } from "../scripts/lib/fall-linkedin-attribution-reconciliation.mjs";
import { reconcileFallLinkedInAttribution } from "../scripts/reconcile-fall-2026-linkedin-attribution.mjs";

function fixture() {
  const id = "7513282637898137600", text = "Our native collaboration.";
  const company = { slug: "vexo", name: "Vexo", ycProfileUrl: "https://www.ycombinator.com/companies/vexo", socialLinks: { linkedin: "https://www.linkedin.com/company/tryvexoai" }, founders: [{ id: "4000265", name: "Farqaleet Kiani", ycProfileUrl: "https://www.ycombinator.com/people/farqaleet-kiani", socialLinks: { linkedin: "https://www.linkedin.com/in/kianif/" } }] };
  const sourceUrl = `https://www.linkedin.com/feed/update/urn:li:activity:${id}/`;
  const primary = { href: "https://www.linkedin.com/in/kianif?trk=public_post_embed_feed-actor-name", text: "Farqaleet Kiani" };
  const nativePostLinks = [{ href: `${sourceUrl}?trk=public_post_embed_social-actions-reactions`, text: "71" }];
  const path = "outputs/fall-2026/browser-checkpoints/test.json", observedAt = "2026-11-16T12:00:00.000Z";
  const raw = { post: { id, text, metrics: { reactions: 71 }, author: { profileUrl: company.founders[0].socialLinks.linkedin } }, nativePrimaryAuthor: primary };
  const row = { platformPostId: id, batchSlug: "F26", platform: "linkedin", companySlug: "vexo", sourceUrl, text, originalText: text, entityType: "founder", entityId: "founder-vexo-farqaleet-kiani-4000265", authorName: "Farqaleet Kiani", identitySourceUrl: company.founders[0].ycProfileUrl, metrics: { reactions: 71 }, accountUrl: company.founders[0].socialLinks.linkedin, rawVisibleText: JSON.stringify(raw), kind: "coauthored_founder_post" };
  const entry = { platformPostId: id, sourceUrl, companySlug: "vexo", previousEntityType: "company", previousEntityId: "company-vexo", entityType: "founder", entityId: row.entityId, authorName: row.authorName, accountUrl: row.accountUrl, nativePrimaryAuthor: primary, browserObservationPath: path, sourceTextSha256: sha(text), nativeReceipt: { nativePostLinks, primaryAuthor: primary, observedAt, officialFounderIdentitySourceUrl: company.founders[0].ycProfileUrl } };
  return { before: { evidence: [{ ...row, entityType: "company", entityId: "company-vexo" }, { ...row, id: "previous-batch-copy", batchSlug: "S26" }, { ...row, platformPostId: "7513705323585695744", entityType: "company", entityId: "company-vexo" }] }, audit: { corrections: [entry], needsReview: [], correctedFounderRows: 1, needsReviewRows: 0, importableRows: 1 }, candidates: { evidence: [row], needsReview: [] }, roster: { companies: [company] }, observations: new Map([[path, { profiles: [{ companySlug: "vexo", rows: [{ sourceUrl, text, observedAt, preview: { links: [primary, ...nativePostLinks] } }] }] }]]) };
}

test("reconciliation scopes removal to the audited Fall physical ID, retaining earlier cohorts and same-body other IDs", () => {
  const input = fixture(), plan = planFallLinkedInAttributionReconciliation(input);
  assert.equal(plan.removed.length, 1);
  assert.deepEqual(plan.staging.evidence, input.before.evidence.slice(1));
  assert.equal(plan.correctedInput[0].entityId, "founder-vexo-farqaleet-kiani-4000265");
});

test("forged source text, wrong native primary author, and wrong physical post links fail closed", () => {
  for (const mutation of [
    (input) => { input.audit.corrections[0].sourceTextSha256 = sha("different"); },
    (input) => { input.observations.values().next().value.profiles[0].rows[0].preview.links[0].href = "https://www.linkedin.com/in/unknown?trk=public_post_embed_feed-actor-name"; },
    (input) => { input.audit.corrections[0].nativeReceipt.nativePostLinks = []; },
    (input) => { input.before.evidence[0].entityId = "company-unrelated"; }
  ]) {
    const input = fixture(); mutation(input);
    assert.throws(() => planFallLinkedInAttributionReconciliation(input), /mismatch|outside reviewed/);
  }
});

test("missing primary-author collaborations are quarantined, with full removed originals preserved", () => {
  const input = fixture(), row = input.candidates.evidence.pop(), entry = input.audit.corrections.pop();
  row.kind = "coauthored_company_post"; row.reason = "collaboration_primary_author_receipt_missing";
  entry.reason = row.reason;
  delete entry.browserObservationPath;
  input.audit.needsReview = [entry]; input.audit.correctedFounderRows = 0; input.audit.needsReviewRows = 1; input.audit.importableRows = 0;
  input.candidates.needsReview = [row]; input.observations.clear();
  const plan = planFallLinkedInAttributionReconciliation(input);
  assert.equal(plan.correctedInput.length, 0);
  assert.deepEqual(plan.removed[0].original, input.before.evidence[0]);
  assert.deepEqual(plan.held[0], row);
});

test("explicit target CAS rejects a stale expected SHA before any output or mutation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "fall-linkedin-cas-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = join(directory, "target.json"), auditPath = join(directory, "audit.json"), candidatePath = join(directory, "candidates.json");
  const before = JSON.stringify({ evidence: [] });
  await Promise.all([writeFile(target, before), writeFile(auditPath, "{}"), writeFile(candidatePath, "{}")]);
  await assert.rejects(reconcileFallLinkedInAttribution({ target, auditPath, candidatePath, expectedTargetSha256: "0".repeat(64), write: true }), /target SHA256/);
  assert.equal(await readFile(target, "utf8"), before);
});
