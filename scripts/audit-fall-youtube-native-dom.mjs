import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { nativeYouTubeDomSource, nativeYouTubeDomValidation, nativeYouTubeDomSummary, verifiedNativeYouTubeDomReasons } from "../src/lib/graph/youtube-native-dom-receipt.mjs";

// Offline only. This audits immutable native browser archives, never canonical data.
const digest = (value) => createHash("sha256").update(value).digest("hex");
const sources = new Map();
async function read(path, expectedSha256) {
  if (!sources.has(path)) {
    const bytes = await readFile(path);
    sources.set(path, { path, sha256: digest(bytes), bytes, data: null });
  }
  const source = sources.get(path);
  if (expectedSha256 && source.sha256 !== expectedSha256) throw new Error(`Physical source hash mismatch: ${path}`);
  return source;
}
async function json(path, expectedSha256) {
  const source = await read(path, expectedSha256);
  if (!source.data) source.data = JSON.parse(source.bytes.toString("utf8"));
  return source;
}
const pointer = (value, path) => path.split("/").slice(1).reduce((current, key) => current?.[key.replaceAll("~1", "/").replaceAll("~0", "~")], value);
const roster = (await json("src/lib/yc/fall-2026-companies.json")).data.companies;
const queue = (await json("outputs/fall-2026/youtube-owned-site-channel-queue.json")).data.targets;
const rows = [], coverageAudits = [];
for (const slug of ["aucert", "rhem-labs"]) {
  const coveragePath = `outputs/fall-2026/browser-checkpoints/youtube-${slug === "rhem-labs" ? "rhem" : slug}-history-coverage.json`;
  const coverageSource = await json(coveragePath), coverage = coverageSource.data;
  const company = roster.find((entry) => entry.slug === slug), target = queue.find((entry) => entry.companySlug === slug);
  if (!company || !target) throw new Error(`Missing authoritative company or owned footer: ${slug}`);
  const homepage = await read(target.physicalSource.path, target.physicalSource.sha256);
  const homepageHtml = homepage.bytes.toString("utf8");
  if (!homepageHtml.includes(target.literalAnchorHtml) || !homepageHtml.includes(target.containingFooterHtml)) throw new Error(`Owned anchor or ancestor absent: ${slug}`);
  const physical = new Map();
  for (const source of coverage.physicalSources) physical.set(source.path, await json(source.path, source.sha256));
  const channelPath = coverage.nativeChannelSource?.path ?? coverage.physicalSources.find((source) => source.path.includes("channel-ui-current"))?.path;
  const channelSource = await json(channelPath, coverage.nativeChannelSource?.sha256);
  const details = Array.isArray(coverage.details) ? coverage.details : Object.entries(coverage.details).map(([url, detail]) => ({ url, ...detail }));
  const companyRows = [];
  for (const detail of details) {
    const detailSource = physical.get(detail.sourcePath);
    if (!detailSource) throw new Error(`Unlisted native detail source: ${detail.sourcePath}`);
    const native = pointer(detailSource.data, detail.jsonPointer);
    if (!native || native.url !== detail.url) throw new Error(`Native pointer/url mismatch: ${detail.url}`);
    const short = native.source === "native_youtube_short_description_dom_v1";
    const channelIndex = channelSource.data.observations.findIndex((entry) => entry.tabs?.some((tab) => tab.text === (short ? "Shorts" : "Videos") && tab.ariaSelected === "true"));
    if (channelIndex === -1) throw new Error(`No physical native ${short ? "Shorts" : "Videos"} channel observation`);
    const receipt = {
      mechanism: nativeYouTubeDomSource(native), companySlug: slug, channelUrl: coverage.channelUrl,
      identityProof: {
        source: "official_company_website_youtube_channel_v1", companySlug: slug, companyName: company.name,
        entityId: `company-${slug}`, officialYcCompanyUrl: company.ycProfileUrl, officialWebsite: company.websiteUrl,
        channelUrl: coverage.channelUrl,
        homepage: { requestedUrl: target.physicalSource.requestedUrl, finalUrl: target.physicalSource.finalUrl, htmlSha256: homepage.sha256, literalAnchorHtml: target.literalAnchorHtml, containingAncestorHtml: target.containingFooterHtml },
      },
      channelObservation: channelSource.data.observations[channelIndex], nativeObservation: native,
    };
    const summary = nativeYouTubeDomSummary(receipt, company);
    if (summary.descriptionNormalization) receipt.descriptionNormalization = summary.descriptionNormalization;
    const validation = { source: nativeYouTubeDomValidation(native), archiveHashesVerified: true, literalOfficialAnchorVerified: true, parentDomSegmentsVerified: true, nativeReceiptSha256: digest(JSON.stringify(receipt)), archives: [{ kind: short ? "native_short" : "native_watch", path: detailSource.path, sha256: detailSource.sha256 }, { kind: "native_channel", path: channelSource.path, sha256: channelSource.sha256 }, { kind: "official_website", path: homepage.path, sha256: homepage.sha256 }] };
    const candidate = { batchSlug: "F26", platform: "youtube", companySlug: slug, companyName: company.name, entityType: "company", entityId: `company-${slug}`, review_state: "verified", attributionVersion: 3, attributionStatus: "verified", attributionMode: "author", attributionProvenance: nativeYouTubeDomSource(native), platformPostId: summary.videoId, sourceUrl: summary.sourceUrl, accountUrl: coverage.channelUrl, authorHandle: summary.channelHandle, authorName: summary.channelName, title: summary.title, text: summary.text, originalText: summary.text, postedAt: summary.publishedDay, publishedAtPrecision: "day", metrics: summary.metrics, rawVisibleText: JSON.stringify({ source: nativeYouTubeDomSource(native), nativeYouTubeDomReceipt: receipt, validation }) };
    const runtimeReasons = verifiedNativeYouTubeDomReasons(candidate, company);
    const row = { companySlug: slug, source: { path: detailSource.path, sha256: detailSource.sha256, jsonPointer: detail.jsonPointer }, channelSource: { path: channelSource.path, sha256: channelSource.sha256, jsonPointer: `/observations/${channelIndex}` }, ok: summary.ok && runtimeReasons.length === 0, reasons: [...new Set([...summary.reasons, ...runtimeReasons])], videoId: summary.videoId, title: summary.title, textLengthUtf16: summary.text?.length ?? 0, textLengthCodePoints: [...(summary.text ?? "")].length, textSha256: summary.text ? digest(summary.text) : null, publishedDay: summary.publishedDay, metrics: summary.metrics, descriptionNormalization: summary.descriptionNormalization ?? null };
    rows.push(row); companyRows.push(row);
  }
  const listedIds = new Set(channelSource.data.observations.flatMap((entry) => (entry.links ?? []).map((link) => {
    try { const url = new URL(link.href); return url.pathname === "/watch" ? url.searchParams.get("v") : url.pathname.match(/^\/shorts\/([A-Za-z0-9_-]{11})$/)?.[1]; } catch { return null; }
  }).filter(Boolean)));
  const auditedIds = new Set(companyRows.map((row) => row.videoId));
  coverageAudits.push({ companySlug: slug, source: { path: coveragePath, sha256: coverageSource.sha256 }, declaredVisibleListingUnion: coverage.visibleListingUnion, listedIds: [...listedIds].sort(), auditedIds: [...auditedIds].sort(), allListedIdsAudited: listedIds.size === auditedIds.size && [...listedIds].every((id) => auditedIds.has(id)), allNativeReceiptsAccepted: companyRows.every((row) => row.ok), globalFullHistoryComplete: false, nativeHistoryEndScope: coverage.nativeHistoryEndScope });
}
const output = { source: "offline_youtube_native_dom_full_visible_receipt_audit_v1", generatedAt: new Date().toISOString(), networkRequestsMade: 0, canonicalWritesMade: 0, rows, coverageAudits, sourceManifest: [...sources.values()].map(({ path, sha256 }) => ({ path, sha256 })) };
const outputPath = "outputs/fall-2026/youtube-native-dom-full-visible-audit.json";
await writeFile(outputPath, JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify({ path: outputPath, sha256: digest(await readFile(outputPath)), rows: rows.length, accepted: rows.filter((row) => row.ok).length, rejected: rows.filter((row) => !row.ok), coverageAudits, physicalSources: sources.size }, null, 2));
if (rows.some((row) => !row.ok) || coverageAudits.some((audit) => !audit.allListedIdsAudited)) process.exitCode = 1;
