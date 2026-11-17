import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { normalizeInstagramNativeObservation, isVerifiedInstagramNativeCaption } from './lib/instagram-native-observation.mjs';
import { isVerifiedInstagramCaptionAbsence } from './lib/instagram-caption-absence-proof.mjs';

const base = 'outputs/fall-2026';
const outputPath = `${base}/instagram-ignition-independent-coverage-audit.json`;
const manifest = new Map();
const cache = new Map();
const sha = (value) => createHash('sha256').update(value).digest('hex');
async function load(path, expected) {
  if (cache.has(path)) return cache.get(path);
  const bytes = await fs.readFile(path);
  const hash = sha(bytes);
  if (expected && hash !== expected) throw new Error(`Physical source SHA mismatch: ${path}`);
  manifest.set(path, { path, sha256: hash, bytes: bytes.length });
  const data = JSON.parse(bytes);
  cache.set(path, data);
  return data;
}
const source = (path, jsonPointer = '') => ({ ...manifest.get(path), jsonPointer });
const idOf = (value) => String(value ?? '').match(/\/(?:p|reel)\/([A-Za-z0-9_-]+)(?:\/|\?|$)/)?.[1];
const issues = [];
const coveragePath = `${base}/browser-checkpoints/instagram-ignition-history-coverage.json`;
const coverage = await load(coveragePath, '690eba735f74e35274f1bb1dd69f813b0dab115f0411e08c6886a1ab32130eb6');
const inventory = await load(coverage.inventorySource.path, coverage.inventorySource.sha256);
const frozenInputPath = `${base}/ignition-frozen-26-evidence-audit-input.json`;
const frozen = await load(frozenInputPath);
const frozenHash = createHash('sha256');
let frozenBytes = 0;
for await (const chunk of createReadStream(frozen.sourcePath)) {
  frozenHash.update(chunk);
  frozenBytes += chunk.length;
}
if (frozenHash.digest('hex') !== frozen.sha256) throw new Error('Frozen canonical snapshot SHA mismatch');
manifest.set(frozen.sourcePath, { path: frozen.sourcePath, sha256: frozen.sha256, bytes: frozenBytes, parseScope: 'All evidence rows scanned by offline extraction; only 15 Ignition Instagram rows retained' });
const canonical = new Map(frozen.rows.map((row) => [row.platformPostId, row]));
if (canonical.size !== frozen.rows.length) issues.push('Duplicate physical native ID in frozen canonical company scope');

const fresh = new Map();
const rows = [];
for (const physical of coverage.physicalSources) {
  const data = await load(physical.path, physical.sha256);
  if (!physical.path.includes('instagram-ignition-dialog-part-')) continue;
  for (const [index, original] of data.nativePosts.entries()) {
    const post = normalizeInstagramNativeObservation(original);
    const id = post.id;
    if (fresh.has(id)) issues.push(`Duplicate fresh capture ID: ${id}`);
    fresh.set(id, original);
    const header = original.nativeAuthorHeader;
    const owner = post.authorHandle === 'ignitionbenefits' && header.profileUrl === 'https://www.instagram.com/ignitionbenefits/' && header.links.some((link) => link.href === header.profileUrl && link.text === 'ignitionbenefits');
    const footer = post.publicationTimeReceipt;
    const footerValid = idOf(footer?.href) === id && Number.isFinite(Date.parse(footer?.datetime)) && Date.parse(footer.datetime) <= Date.parse(original.observedAt);
    const captionValid = isVerifiedInstagramNativeCaption(post, 'ignitionbenefits');
    const h1Count = [...String(original.dialogHtml ?? '').matchAll(/<h1(?:\s|>)/g)].length;
    const absenceProof = { source: 'authorized_native_instagram_caption_absence_review_v1', review_state: 'verified', platformPostId: id, authorHandle: 'ignitionbenefits', observedAt: original.observedAt, nativeTextSha256: sha(original.nativeText) };
    const captionAbsent = original.captionAbsent === true && post.text === '' && original.nativeCaptionReceipt?.h1Count === 0 && original.nativeCaptionReceipt?.caption === null && h1Count === 0 && isVerifiedInstagramCaptionAbsence(post, absenceProof, 'ignitionbenefits', id);
    const old = canonical.get(id);
    const sameBody = old ? old.originalText === post.text : null;
    const sameDate = old ? old.postedAt === post.postedAt : null;
    if (!owner || !footerValid || !(captionValid || captionAbsent)) issues.push(`Native owner/footer/caption invariant failed for ${id}`);
    if (old && !sameBody) issues.push(`Previously admitted ID has a changed native caption: ${id}`);
    if (old && !sameDate) issues.push(`Previously admitted ID has a changed publication date: ${id}`);
    rows.push({ platformPostId: id, source: source(physical.path, `/nativePosts/${index}`), nativeUrl: original.url, nativePrimaryAuthor: post.authorHandle, nativeHeaderProfileUrl: header.profileUrl, nativeHeaderHtmlSha256: sha(header.html), nativeHeaderOwnerProof: owner, captionLength: post.text.length, captionSha256: sha(post.text), nativeCaptionGate: captionValid, nativeCaptionAbsenceGate: captionAbsent, captionAbsent: captionAbsent, captionAbsenceRequiresUnscoredRetention: captionAbsent, actualDialogH1Count: h1Count, nativeFooter: footer, nativeFooterIdentityAndClockValid: footerValid, mediaImageCount: post.media?.images?.length ?? 0, mediaVideoCount: post.media?.videos?.length ?? 0, strictlyObservedMetrics: post.metrics, unknownMetricsNotImputedAsZero: true, alreadyInFrozen26: Boolean(old), frozenOriginalTextSha256: old ? sha(old.originalText) : null, sameFrozenOriginalText: sameBody, sameFrozenPublicationDate: sameDate, bodyUpdateRequired: old ? !sameBody : false, dateUpdateRequired: old ? !sameDate : false });
  }
}

const posts = new Set(inventory.posts.map((row) => row.id));
const reels = new Set(inventory.reels.map((row) => row.id));
const union = new Set([...posts, ...reels]);
const details = [];
for (const receipt of coverage.detailReuseReceipts) {
  const raw = await load(receipt.sourcePath, receipt.sourceSha256);
  const matches = raw.nativePosts.filter((post) => idOf(post.url) === receipt.id);
  if (matches.length !== 1) issues.push(`Visible ID lacks exactly one physical native detail: ${receipt.id}`);
  const post = matches[0];
  const normalized = post ? normalizeInstagramNativeObservation(post) : null;
  const owner = normalized?.authorHandle;
  if (owner !== 'ignitionbenefits') issues.push(`Visible ID primary owner differs: ${receipt.id} -> ${owner}`);
  if (receipt.id !== idOf(receipt.listedHref) || receipt.id !== idOf(post?.url)) issues.push(`Listing/detail immutable native ID mismatch: ${receipt.id}`);
  details.push({ platformPostId: receipt.id, listingUrl: receipt.listedHref, source: source(receipt.sourcePath), sourceMatches: matches.length, actualNativeUrl: post?.url, nativePrimaryAuthor: owner, freshCapture: fresh.has(receipt.id), inFrozen26: canonical.has(receipt.id) });
}
if (union.size !== 36 || posts.size !== 14 || reels.size !== 22) issues.push('Expected Posts14/Reels22/union36 differs');
if ([...posts].some((id) => reels.has(id))) issues.push('Posts and Reels were expected disjoint in the sealed native inventory');
if (fresh.size !== 23) issues.push('Expected 23 unique fresh detail observations');
if (details.length !== union.size || details.some((row) => !union.has(row.platformPostId))) issues.push('Visible union and physical detail references differ');
const newIds = [...fresh.keys()].filter((id) => !canonical.has(id));
const duplicates = [...fresh.keys()].filter((id) => canonical.has(id));
if (newIds.length !== 21 || duplicates.length !== 2) issues.push('Fresh capture versus frozen26 overlap differs from 21 new / 2 duplicate');
const reused = details.filter((row) => !row.freshCapture);
if (reused.length !== 13 || reused.some((row) => !row.inFrozen26)) issues.push('Expected all 13 reused visible details already present in frozen26');
const result = {
  schemaVersion: 1, batchSlug: 'F26', generatedAt: new Date().toISOString(), source: 'independent_offline_ignition_native_coverage_and_frozen26_audit_v1', networkRequestsMade: 0, canonicalWritesMade: 0,
  coverageSource: source(coveragePath), inventorySource: source(coverage.inventorySource.path), frozenCanonicalSource: source(frozen.sourcePath),
  counts: { visiblePosts: posts.size, visibleReels: reels.size, visibleUnion: union.size, freshPhysicalCaptures: fresh.size, existingVisibleBaseDetailsReused: reused.length, newNativeIdsVersusFrozen26: newIds.length, duplicateExistingNativeIds: duplicates.length, freshCaptionedNativeProofs: rows.filter((row) => row.nativeCaptionGate).length, freshCaptionlessNativeProofs: rows.filter((row) => row.nativeCaptionAbsenceGate).length, changedExistingBodies: rows.filter((row) => row.bodyUpdateRequired).length, changedExistingDates: rows.filter((row) => row.dateUpdateRequired).length, issues: issues.length },
  newIds, duplicateIds: duplicates, captionlessIds: rows.filter((row) => row.nativeCaptionAbsenceGate).map((row) => row.platformPostId),
  nativeReelsEndProof: coverage.reelsNativeNextTraversal, allVisibleNativeDetailsProven: issues.length === 0, fullHistoryGuarantee: false,
  unreconciledHeaderDifference: coverage.headerDifference, headerDifferenceReason: coverage.headerDifferenceReason,
  caveats: ['Native header14 and visible union36 have unproven differing semantics; prior unavailable observations remain preserved.', 'Captionless own originals require real media retention and score0; missing metric values stay unknown.', 'Two new physical captures duplicate existing frozen IDs with identical full body/date; no content correction is needed. Newer receipts/metrics are independent from body updates.'],
  issues, freshCaptureAudit: rows, visibleDetailAudit: details, sourceManifest: [...manifest.values()]
};
await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ path: outputPath, sha256: sha(await fs.readFile(outputPath)), counts: result.counts, duplicateIds: duplicates, captionlessIds: result.captionlessIds, issues }, null, 2));
if (issues.length) process.exitCode = 1;
