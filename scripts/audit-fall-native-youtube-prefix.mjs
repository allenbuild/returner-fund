import fs from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { convertNativeYouTubeDom } from "./convert-fall-2026-youtube-native-dom.mjs";
import { nativeYouTubePostId } from "../src/lib/graph/youtube-native-dom-receipt.mjs";

const args = process.argv.slice(2), argument = (flag, fallback) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
const maxWatchPart = Number(argument("--max-watch-part", "5")), maxShortPart = Number(argument("--max-short-part", "5"));
const outputPrefix = argument("--output-prefix", "outputs/fall-2026/youtube-native-prefix-27");
const canonicalPath = argument("--canonical", "outputs/fall-2026/collection/checkpoint-28/targeted-after.json");
const selectionPath = argument("--selection-manifest", null);
if (![maxWatchPart, maxShortPart].every((number) => Number.isInteger(number) && number >= 1 && number <= 100)) throw new Error("Explicit bounded native part limits required");
const sha = (value) => createHash("sha256").update(value).digest("hex"), manifest = new Map();
async function archive(path) {
  const bytes = await readFile(path), entry = { path, sha256: sha(bytes) };
  manifest.set(path, entry);
  return entry;
}
const channelArchive = await archive("outputs/fall-2026/browser-checkpoints/youtube-native-channel-ui-current.json");
const channel = JSON.parse(await readFile(channelArchive.path));
const ownershipArchive = await archive("outputs/fall-2026/youtube-native-owned-channel-proof.json");
const selections = selectionPath ? JSON.parse(await readFile((await archive(selectionPath)).path)) : null;
const configs = [];
for (const [mode, maximum] of [["watch", maxWatchPart], ["short", maxShortPart]]) {
  const tab = mode === "watch" ? "Videos" : "Shorts";
  const observationIndex = channel.observations.findIndex((entry) => entry.tabs?.some((item) => item.text === tab && item.ariaSelected === "true"));
  if (observationIndex === -1) throw new Error(`No native ${tab} channel observation`);
  for (let part = 1; part <= maximum; part++) {
    const nativeArchive = await archive(`outputs/fall-2026/browser-checkpoints/youtube-native-${mode}-part-${String(part).padStart(3, "0")}.json`);
    const config = { companySlug: "native", companyName: "Native", channelUrl: "https://www.youtube.com/@trynative", ownershipArchive, ownershipPointer: "/ownershipProof", channelArchive, channelObservationPointer: `/observations/${observationIndex}`, nativeArchive, nativeObservationsPointer: "/nativePosts", mode, retainUnknownPublication: true };
    const selection = selections?.selections?.find((entry) => entry.source.path === nativeArchive.path);
    if (selection) {
      if (selection.source.sha256 !== nativeArchive.sha256) throw new Error("Selection manifest raw archive SHA mismatch");
      config.nativeObservationPointers = selection.nativeObservationPointers;
    }
    configs.push(config);
  }
}
for (const supplemental of selections?.supplementalNativeArchives ?? []) {
  const nativeArchive = await archive(supplemental.source.path);
  if (nativeArchive.sha256 !== supplemental.source.sha256) throw new Error("Supplemental native raw archive SHA mismatch");
  const template = configs.find((config) => config.mode === supplemental.mode);
  if (!template) throw new Error("Supplemental archive mode must have an existing physically observed channel tab");
  configs.push({ ...template, nativeArchive, nativeObservationPointers: supplemental.nativeObservationPointers });
}
const configPath = `${outputPrefix}-configs.json`;
await writeFile(configPath, JSON.stringify(configs, null, 2) + "\n");
manifest.set(configPath, await archive(configPath));
const converted = await convertNativeYouTubeDom(configs);
for (const source of converted.source.sources) for (const item of source.archives) manifest.set(item.path, { path: item.path, sha256: item.sha256 });
const accepted = converted.evidence, canonical = [];
const canonicalHash = createHash("sha256"), stream = fs.createReadStream(canonicalPath);
stream.on("data", (chunk) => canonicalHash.update(chunk));
async function* literalLines(input) {
  const decoder = new StringDecoder("utf8"); let pending = "";
  for await (const chunk of input) {
    pending += decoder.write(chunk); let newline;
    while ((newline = pending.indexOf("\n")) !== -1) { yield pending.slice(0, newline); pending = pending.slice(newline + 1); }
  }
  pending += decoder.end(); if (pending) yield pending;
}
let inEvidence = false, current = [], canonicalRowsScanned = 0;
for await (const line of literalLines(stream)) {
  if (line === '  "evidence": [') { inEvidence = true; continue; }
  if (!inEvidence) continue;
  if (line.startsWith("  ],")) { inEvidence = false; continue; }
  if (line === "    {") { current = [line]; continue; }
  if (!current.length) continue;
  current.push(line);
  if (line !== "    }," && line !== "    }") continue;
  const text = current.join("\n").replace(/,$/, ""); current = []; canonicalRowsScanned++;
  if (text.includes('"platform": "youtube"')) canonical.push(JSON.parse(text));
}
manifest.set(canonicalPath, { path: canonicalPath, sha256: canonicalHash.digest("hex") });
const normalize = (text) => String(text ?? "").replace(/\s+/gu, " ").trim();
const byId = new Map();
for (const row of canonical) {
  const id = row.platformPostId ?? nativeYouTubePostId(row.sourceUrl);
  if (!byId.has(id)) byId.set(id, []);
  byId.get(id).push(row);
}
const rows = accepted.map((row) => {
  const raw = JSON.parse(row.rawVisibleText), receipt = raw.nativeYouTubeDomReceipt;
  const matches = byId.get(row.platformPostId) ?? [];
  return { videoId: row.platformPostId, sourceUrl: row.sourceUrl, nativeSource: raw.source, title: row.title, textLengthUtf16: row.text.length, textLengthCodePoints: [...row.text].length, textSha256: sha(row.text), postedAt: row.postedAt, publishedAtPrecision: row.publishedAtPrecision, metrics: row.metrics, contributionScore: row.contributionScore, tractionStatus: row.tractionStatus ?? null, nativeArchive: { ...configs.find((config) => raw.validation.archives.some((item) => item.kind === (config.mode === "short" ? "native_short" : "native_watch") && item.path === config.nativeArchive.path))?.nativeArchive, jsonPointer: receipt.sourceRecordPointer }, descriptionNormalization: receipt.descriptionNormalization ?? null, relativePublicationReceipt: receipt.unknownDatePublicationReceipt ?? null, canonicalMatches: matches.map((prior) => ({ id: prior.id, batchSlug: prior.batchSlug, companySlug: prior.companySlug, entityId: prior.entityId, sourceUrl: prior.sourceUrl, title: prior.title, postedAt: prior.postedAt, metrics: prior.metrics, textLengthUtf16: prior.text?.length ?? 0, textSha256: sha(prior.text ?? ""), bodyByteEqual: prior.text === row.text, bodyWhitespaceNormalizedEqual: normalize(prior.text) === normalize(row.text), originalTextPresent: Object.hasOwn(prior, "originalText"), originalTextByteEqual: prior.originalText === row.originalText, sameCompanyOwner: prior.companySlug === row.companySlug && prior.entityId === row.entityId })) };
});
const listed = [...new Set(channel.observations.flatMap((observation) => (observation.links ?? []).map((link) => nativeYouTubePostId(link.href)).filter(Boolean)))].sort();
const ids = rows.map((row) => row.videoId), duplicatedIncomingIds = ids.filter((id, index) => ids.indexOf(id) !== index);
const output = { source: "offline_native_youtube_sealed_prefix_receipt_and_duplicate_audit_v1", generatedAt: new Date().toISOString(), companySlug: "native", maxWatchPart, maxShortPart, configSource: manifest.get(configPath), selectionManifest: selectionPath ? manifest.get(selectionPath) : null, supersededSourceRows: selections?.supersededSourceRows ?? [], nativeListingUnion: listed.length, nativeDetailsAudited: rows.length, accepted: rows.length, held: converted.needsReview, watchAccepted: rows.filter((row) => row.sourceUrl.includes("/watch?")).length, shortsAccepted: rows.filter((row) => row.sourceUrl.includes("/shorts/")).length, unknownDatesUnscored: rows.filter((row) => row.postedAt === null).length, missingNativeListingIds: listed.filter((id) => !ids.includes(id)), capturedIdsOutsideListing: ids.filter((id) => !listed.includes(id)), duplicatedIncomingIds, canonicalRowsScanned, canonicalYouTubeRows: canonical.length, canonicalSnapshot: manifest.get(canonicalPath), existingCanonicalNativeIdMatches: rows.filter((row) => row.canonicalMatches.length).length, canonicalBodyConflicts: rows.filter((row) => row.canonicalMatches.some((match) => !match.bodyByteEqual)), rows, networkRequestsMade: 0, canonicalWritesMade: 0, fullHistoryComplete: false, sourceManifest: [...manifest.values()] };
const path = `${outputPrefix}-audit.json`;
await writeFile(path, JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify({ path, sha256: sha(await readFile(path)), configPath, configSha256: manifest.get(configPath).sha256, accepted: rows.length, held: converted.needsReview, missingListingIds: output.missingNativeListingIds.length, duplicatedIncomingIds, existingCanonicalNativeIdMatches: output.existingCanonicalNativeIdMatches, canonicalBodyConflicts: output.canonicalBodyConflicts.map((row) => ({ videoId: row.videoId, title: row.title, incomingTextLength: row.textLengthUtf16, matches: row.canonicalMatches })) }, null, 2));
if (converted.needsReview.length || duplicatedIncomingIds.length || output.capturedIdsOutsideListing.length) process.exitCode = 1;
