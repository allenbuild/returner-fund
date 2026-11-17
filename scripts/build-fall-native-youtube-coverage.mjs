import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const digest = (value) => createHash("sha256").update(value).digest("hex");
async function read(path) { const bytes = await readFile(path); return { data: JSON.parse(bytes), source: { path, sha256: digest(bytes) } }; }
const audit = await read("outputs/fall-2026/youtube-native-available-35-audit.json");
const configs = await read(audit.data.configSource.path);
if (configs.source.sha256 !== audit.data.configSource.sha256 || audit.data.held.length || audit.data.duplicatedIncomingIds.length || audit.data.capturedIdsOutsideListing.length) throw new Error("Native detail audit/config is not consistent");
const error = await read("outputs/fall-2026/browser-checkpoints/youtube-native-error-frontier-001.json");
if (error.source.sha256 !== "0aedaa93708172addc9b141784fb521d6679abda0e0d0ae41c5991096c7826ad" || error.data.observation.title !== "Oops" || !error.data.observation.text.includes("Something went wrong")) throw new Error("Exact native generic error frontier missing");
const channel = await read(configs.data[0].channelArchive.path);
if (channel.source.sha256 !== configs.data[0].channelArchive.sha256) throw new Error("Native channel physical archive changed");
const details = audit.data.rows.map((row) => ({ url: row.sourceUrl, videoId: row.videoId, sourcePath: row.nativeArchive.path, sourceSha256: row.nativeArchive.sha256, jsonPointer: row.nativeArchive.jsonPointer, title: row.title, descriptionLengthCodePoints: row.textLengthCodePoints, descriptionLengthUtf16: row.textLengthUtf16, descriptionSha256: row.textSha256, publishedAtPrecision: row.publishedAtPrecision, publishedDay: row.postedAt, unknownDateUnscored: row.postedAt === null }));
const pending = new Set(error.data.remainingTargets.map((url) => url.split("/").at(-1)));
if (pending.size !== 7 || pending.size !== audit.data.missingNativeListingIds.length || audit.data.missingNativeListingIds.some((id) => !pending.has(id))) throw new Error("Error frontier must exactly match unaudited native listing IDs");
const physicalSources = [];
for (const config of configs.data) {
  const source = await read(config.nativeArchive.path);
  if (source.source.sha256 !== config.nativeArchive.sha256) throw new Error("Raw native detail archive changed");
  physicalSources.push({ ...source.source, rawNativeObservations: source.data.nativePosts.length, selectedNativeObservations: config.nativeObservationPointers?.length ?? source.data.nativePosts.length, nativeObservationPointers: config.nativeObservationPointers ?? source.data.nativePosts.map((_, index) => `/nativePosts/${index}`) });
}
const headerCounts = [...new Set(channel.data.observations.flatMap((observation) => [...observation.mainText.matchAll(/(?:^|\n)([\d,]+) videos(?:\n|$)/g)].map((match) => Number(match[1].replaceAll(",", "")))))].sort((a, b) => a - b);
const ownership = await read("outputs/fall-2026/youtube-native-ownership-proof.json");
const output = {
  source: "physically_hashed_native_youtube_visible_history_coverage_v1", companySlug: "native", channelUrl: "https://www.youtube.com/@trynative",
  ownershipProof: ownership.source, nativeChannelSource: channel.source, strictNativeReceiptAudit: audit.source, configSource: configs.source,
  nativeHeaderVideos: 42, nativeHeaderVideoCountsObserved: headerCounts, headerCountSemanticsUnknown: headerCounts.length > 1,
  videos: 14, shorts: 28, visibleListingUnion: 42, nativeDetails: details.length,
  allListedIdsHaveSavedNativeDetail: false, allSavedSelectedNativeDetailsPassStrictGate: details.length === 35,
  nativeDetailsMissing: audit.data.missingNativeListingIds, pendingTargets: error.data.remainingTargets,
  nativeListingFrontiersExhausted: channel.data.coverage.allObservedVisibleListingEnds === true,
  sourceClaimsScopedHistoryComplete: false, availableNativeDescriptionHistoryComplete: false, fullHistoryComplete: false,
  nativeHistoryEndScope: "The available Videos14 and Shorts28 native listing frontiers were exhausted.35 selected native video/Short descriptions are physically verified;7 listed Shorts remain pending after a generic native error page. Private, deleted, unlisted and unobserved surfaces remain unknown.",
  pause: { state: "native_generic_error_pause_cause_unspecified", nativeErrorSource: error.source, nativeErrorObservationPointer: "/observation", nativeErrorObservedAt: error.data.observation.observedAt, nativeErrorTitle: error.data.observation.title, nativeErrorText: error.data.observation.text, nativeErrorUrl: error.data.observation.url, confirmedRateLimit: false, authOrSecurityCauseConfirmed: false, retryOrReloadAttempted: false, quietWindowMinutesRequestedByParent: 30, requiresParentReviewBeforeFurtherRequests: true },
  physicalSources, supersededSourceRows: audit.data.supersededSourceRows,
  physicalNativeObservationCount: physicalSources.reduce((sum, source) => sum + source.rawNativeObservations, 0),
  selectedVerifiedOriginals: details.length, exactExistingCanonicalNativeIdDuplicates: audit.data.existingCanonicalNativeIdMatches,
  canonicalBodyConflicts: audit.data.canonicalBodyConflicts.length, unknownDateUnscoredOriginals: audit.data.unknownDatesUnscored,
  details, networkRequestsMade: 0, canonicalWritesMade: 0,
};
if (details.length !== 35 || new Set(details.map((detail) => detail.videoId)).size !== 35) throw new Error("Expected35 unique physically verified originals");
const path = "outputs/fall-2026/browser-checkpoints/youtube-native-history-coverage.json";
await writeFile(path, JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify({ path, sha256: digest(await readFile(path)), visibleListingUnion: output.visibleListingUnion, nativeDetails: details.length, missing: output.nativeDetailsMissing.length, fullHistoryComplete: false, nativeHeaderVideoCountsObserved: headerCounts }));
