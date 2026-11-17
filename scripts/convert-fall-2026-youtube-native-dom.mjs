import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as nativeYouTube from "../src/lib/graph/youtube-native-dom-receipt.mjs";
import { nativeYouTubeUnknownDateSummary, verifiedNativeYouTubeUnknownDateReasons, NATIVE_YOUTUBE_UNKNOWN_DATE_SOURCE, NATIVE_YOUTUBE_UNKNOWN_DATE_VALIDATION } from "../src/lib/graph/youtube-native-unknown-date-receipt.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const objectHash = (value) => sha(JSON.stringify(value));
const pointer = (object, path) => {
  if (typeof path !== "string" || !/^\/(?:[^/~]|~[01])+(?:\/(?:[^/~]|~[01])+)*$/.test(path)) throw new Error("An explicit native archive JSON pointer is required.");
  return path.slice(1).split("/").reduce((value, part) => value?.[part.replaceAll("~1", "/").replaceAll("~0", "~")], object);
};
const host = (value) => { try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; } };

/** All input objects come from physically rehashed archives. No browser fetch,
 * name search, channel-name inference, or hidden YouTube data is used. */
export async function buildNativeYouTubeDomReceipts(config, { rootDir = process.cwd() } = {}) {
  const root = resolve(rootDir), archives = [];
  const load = async (archive, kind, json = true) => {
    if (!archive?.path || !/^[a-f0-9]{64}$/.test(archive.sha256 ?? "")) throw new Error("Native YouTube archives require an exact path and SHA256.");
    const bytes = await readFile(resolve(root, archive.path));
    if (sha(bytes) !== archive.sha256) throw new Error(`Native YouTube archive SHA mismatch: ${archive.path}`);
    archives.push({ kind, path: archive.path, sha256: archive.sha256 });
    return json ? JSON.parse(bytes) : bytes.toString("utf8");
  };
  const ownershipArchive = await load(config.ownershipArchive, "official_channel_ownership_inventory");
  const proof = pointer(ownershipArchive, config.ownershipPointer ?? "/ownershipProof");
  if (proof?.sourceOwnershipArchive) {
    const inventory = await load(proof.sourceOwnershipArchive, "official_owned_channel_inventory");
    const target = pointer(inventory, proof.sourceOwnershipPointer);
    if (target?.companySlug !== config.companySlug || target.observedUrl !== config.channelUrl || target.literalAnchorHtml !== proof.literalAnchorHtml || target.containingFooterHtml !== proof.containingAncestorHtml || ["path", "sha256", "requestedUrl", "finalUrl"].some((key) => target.physicalSource?.[key] !== proof.homepageReceipt?.[key])) throw new Error("The exact physical owned-channel inventory must agree with its official footer proof.");
  }
  const rosterSource = proof?.officialRosterSource;
  const roster = await load(rosterSource, "official_roster");
  const company = pointer(roster, rosterSource.jsonPointer);
  if (!company || company.slug !== config.companySlug || company.ycProfileUrl !== `https://www.ycombinator.com/companies/${company.slug}` || company.name !== config.companyName || !host(company.websiteUrl) || host(proof.officialWebsite) !== host(company.websiteUrl)) throw new Error("The exact archived official roster company must own this channel proof.");
  const homepage = proof.homepageReceipt;
  const html = await load(homepage, "official_website", false);
  if (host(homepage.requestedUrl) !== host(company.websiteUrl) || host(homepage.finalUrl) !== host(company.websiteUrl) || typeof proof.literalAnchorHtml !== "string" || !proof.literalAnchorHtml || !html.includes(proof.literalAnchorHtml) || typeof proof.containingAncestorHtml !== "string" || !html.includes(proof.containingAncestorHtml) || !proof.containingAncestorHtml.includes(proof.literalAnchorHtml)) throw new Error("The physical official company website must contain the exact channel anchor and its owner ancestor.");
  const channelArchive = await load(config.channelArchive, "native_channel");
  if (proof.sourceOwnershipArchive && channelArchive.ownershipProofSource && ["path", "sha256"].some((key) => channelArchive.ownershipProofSource[key] !== proof.sourceOwnershipArchive[key])) throw new Error("Native channel must reference the same physically verified owned-channel inventory.");
  const channelObservation = pointer(channelArchive, config.channelObservationPointer);
  const nativeArchive = await load(config.nativeArchive, config.mode === "short" ? "native_short" : "native_watch");
  if (nativeArchive.channelSource && ["path", "sha256"].some((key) => nativeArchive.channelSource[key] !== config.channelArchive[key])) throw new Error("Native video must reference the same physical channel observation.");
  for (const archive of config.additionalArchives ?? []) await load(archive, "supplemental_native_ownership_or_coverage");
  const observationsPointer = config.nativeObservationsPointer ?? "/nativePosts";
  const nativeObservations = pointer(nativeArchive, observationsPointer);
  if (!channelObservation || !Array.isArray(nativeObservations)) throw new Error("Native YouTube observation pointers must resolve to the exact channel and post records.");
  let selected = nativeObservations.map((nativeObservation, index) => ({ nativeObservation, sourceRecordPointer: `${observationsPointer}/${index}` }));
  if (config.nativeObservationPointers !== undefined) {
    const selections = config.nativeObservationPointers;
    if (!Array.isArray(selections) || selections.length === 0 || new Set(selections).size !== selections.length) throw new Error("Native YouTube record selections must be a nonempty unique pointer list.");
    selected = selections.map((sourceRecordPointer) => {
      const prefix = `${observationsPointer}/`;
      const indexText = typeof sourceRecordPointer === "string" && sourceRecordPointer.startsWith(prefix) ? sourceRecordPointer.slice(prefix.length) : "";
      const index = /^(?:0|[1-9][0-9]*)$/.test(indexText) ? Number(indexText) : -1;
      if (!Number.isSafeInteger(index) || index < 0 || index >= nativeObservations.length) throw new Error("Native YouTube record selection must name an existing direct observation under the declared array pointer.");
      return { nativeObservation: nativeObservations[index], sourceRecordPointer };
    });
  }
  const channelUrl = config.channelUrl;
  const identityProof = { source: "official_company_website_youtube_channel_v1", companySlug: company.slug, companyName: company.name, entityId: `company-${company.slug}`, officialYcCompanyUrl: company.ycProfileUrl, officialWebsite: company.websiteUrl, channelUrl, homepage: { requestedUrl: homepage.requestedUrl, finalUrl: homepage.finalUrl, htmlSha256: homepage.sha256, literalAnchorHtml: proof.literalAnchorHtml, containingAncestorHtml: proof.containingAncestorHtml } };
  return { company, archives, receipts: selected.map(({ nativeObservation, sourceRecordPointer }) => ({ mechanism: nativeYouTube.nativeYouTubeDomSource?.(nativeObservation) ?? nativeYouTube.NATIVE_YOUTUBE_DOM_SOURCE, companySlug: company.slug, channelUrl, identityProof, channelObservation, nativeObservation, sourceRecordPointer })) };
}

export async function convertNativeYouTubeDom(configs, options = {}) {
  const evidence = [], needsReview = [], sources = [];
  for (const config of configs) {
    const { company, archives, receipts } = await buildNativeYouTubeDomReceipts(config, options);
    for (const receipt of receipts) {
      let summary = nativeYouTube.nativeYouTubeDomSummary(receipt, company), unknownPublication = false;
      if (!summary.ok && config.retainUnknownPublication === true) {
        const unscored = nativeYouTubeUnknownDateSummary(receipt, company);
        if (unscored.ok) { summary = unscored; unknownPublication = true; }
      }
      if (!summary.ok) { needsReview.push({ companySlug: company.slug, sourceUrl: receipt.nativeObservation.url, reasons: summary.reasons }); continue; }
      if (summary.descriptionNormalization) receipt.descriptionNormalization = summary.descriptionNormalization;
      if (unknownPublication) receipt.unknownDatePublicationReceipt = summary.relativePublicationReceipt;
      const source = unknownPublication ? NATIVE_YOUTUBE_UNKNOWN_DATE_SOURCE : receipt.mechanism;
      const validationSource = unknownPublication ? NATIVE_YOUTUBE_UNKNOWN_DATE_VALIDATION : nativeYouTube.nativeYouTubeDomValidation?.(receipt.nativeObservation) ?? nativeYouTube.NATIVE_YOUTUBE_DOM_VALIDATION;
      const raw = { source, nativeYouTubeDomReceipt: receipt, validation: { source: validationSource, archiveHashesVerified: true, literalOfficialAnchorVerified: true, parentDomSegmentsVerified: true, nativeReceiptSha256: objectHash(receipt), archives } };
      const row = { id: `youtube-native-f26-${summary.videoId}`, batchSlug: "F26", companySlug: company.slug, companyName: company.name, entityType: "company", entityId: `company-${company.slug}`, platform: "youtube", platformPostId: summary.videoId, accountUrl: receipt.channelUrl, sourceUrl: summary.sourceUrl, authorName: summary.channelName, authorHandle: summary.channelHandle, title: summary.title, text: summary.text, originalText: summary.text, postedAt: summary.publishedDay, publishedAtPrecision: "day", observedAt: receipt.nativeObservation.observedAt, metrics: summary.metrics, contributionScore: 1, mediaType: "video", bodyTruncated: false, review_state: "verified", linkStatus: "verified", attributionVersion: 3, attributionStatus: "verified", attributionMode: "author", attributionProvenance: source, attributionSignals: ["literal_official_company_website_channel", "native_channel_listing", "exact_native_video_owner", "full_native_description_dom"], matchReason: "The exact official company website links this channel. Its native listing, watch owner, full expanded description, native day label and labeled counters agree; every physical archive is SHA-verified.", rawVisibleText: JSON.stringify(raw), first_seen_at: receipt.nativeObservation.observedAt, last_checked_at: receipt.nativeObservation.observedAt, last_updated_at: receipt.nativeObservation.observedAt };
      if (unknownPublication) Object.assign(row, { postedAt: null, publishedAtPrecision: "unknown", contributionScore: 0, tractionStatus: "unscored", tractionLimitations: ["The native publication factoid supplies only a relative label. No calendar date or UTC timestamp is inferred, and this original contributes zero traction."] });
      const reasons = unknownPublication ? verifiedNativeYouTubeUnknownDateReasons(row, company) : nativeYouTube.verifiedNativeYouTubeDomReasons(row, company);
      if (reasons.length) needsReview.push({ companySlug: company.slug, sourceUrl: row.sourceUrl, reasons });
      else evidence.push(row);
    }
    sources.push({ companySlug: company.slug, archives, received: receipts.length });
  }
  return { source: { kind: "fall_2026_physically_verified_native_youtube_dom_v1", batchSlug: "F26", configurations: configs, sources, canonicalWritten: false, fullHistoryComplete: false }, evidence, needsReview };
}

export async function verifyNativeYouTubeDomInput(input, options = {}) {
  if (input?.source?.kind !== "fall_2026_physically_verified_native_youtube_dom_v1" || input.source.batchSlug !== "F26" || !Array.isArray(input.source.configurations)) throw new Error("A physically reproducible native YouTube input is required.");
  const rebuilt = await convertNativeYouTubeDom(input.source.configurations, options);
  if (JSON.stringify(rebuilt) !== JSON.stringify(input)) throw new Error("Native YouTube input differs from its physically archived observations.");
  return { ok: true, archives: [...new Map(rebuilt.source.sources.flatMap((source) => source.archives).map((archive) => [archive.path, archive])).values()], accepted: rebuilt.evidence.length, held: rebuilt.needsReview.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), value = (flag) => args.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);
  const configPath = value("--config"), output = value("--output");
  if (!configPath || !output) throw new Error("Pass --config=<explicit physical source list> --output=<candidate JSON>.");
  const configs = JSON.parse(await readFile(configPath));
  const result = await convertNativeYouTubeDom(configs);
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ output, received: result.source.sources.reduce((sum, source) => sum + source.received, 0), accepted: result.evidence.length, held: result.needsReview.length, canonicalWritten: false }));
}
