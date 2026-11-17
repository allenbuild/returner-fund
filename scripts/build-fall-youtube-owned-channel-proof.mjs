import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { nativeYouTubeChannelIdentity } from "../src/lib/graph/youtube-native-dom-receipt.mjs";

const companySlug = process.argv[2];
const channelPath = process.argv[3];
if (!/^[a-z0-9-]+$/.test(companySlug ?? "") || !channelPath) throw new Error("Usage: node scripts/build-fall-youtube-owned-channel-proof.mjs COMPANY_SLUG NATIVE_CHANNEL_JSON");
const hash = (value) => createHash("sha256").update(value).digest("hex");
async function read(path) { const bytes = await readFile(path); return { path, sha256: hash(bytes), bytes }; }
const rosterSource = await read("src/lib/yc/fall-2026-companies.json"), roster = JSON.parse(rosterSource.bytes).companies;
const companyIndex = roster.findIndex((entry) => entry.slug === companySlug), company = roster[companyIndex];
const queueSource = await read("outputs/fall-2026/youtube-owned-site-channel-queue.json");
const targets = JSON.parse(queueSource.bytes).targets, targetIndex = targets.findIndex((entry) => entry.companySlug === companySlug), target = targets[targetIndex];
if (!company || !target) throw new Error("No exact official roster and owned-site channel target");
const homepage = await read(target.physicalSource.path), homepageHtml = homepage.bytes.toString("utf8");
if (homepage.sha256 !== target.physicalSource.sha256 || !homepageHtml.includes(target.literalAnchorHtml) || !homepageHtml.includes(target.containingFooterHtml)) throw new Error("Physical owned homepage anchor/ancestor mismatch");
const channelSource = await read(channelPath), channel = JSON.parse(channelSource.bytes);
const expected = nativeYouTubeChannelIdentity(target.observedUrl);
if (channel.companySlug !== companySlug || nativeYouTubeChannelIdentity(channel.channelUrl)?.url !== expected?.url) throw new Error("Native channel company/URL conflict");
const observations = channel.observations ?? [], nativeHeaders = [];
for (const [index, observation] of observations.entries()) {
  if (observation.alerts?.length || observation.loading?.length || nativeYouTubeChannelIdentity(observation.url)?.url !== expected.url) throw new Error("Native channel warning/loading/identity conflict");
  const header = observation.mainHtml?.match(/<ytd-tabbed-page-header\b[\s\S]*?<\/ytd-tabbed-page-header>/i)?.[0];
  const lines = observation.mainText?.split("\n").map((line) => line.trim()).filter(Boolean), handle = lines?.[1]?.match(/^@([A-Za-z0-9._-]+)$/)?.[1];
  if (!header || !handle || expected.handle && handle.toLowerCase() !== expected.handle) throw new Error("Exact native header absent");
  const websiteAnchors = [...header.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>[\s\S]*?<\/a>/gi)].flatMap((match) => {
    const literalHref = match[1].replaceAll("&amp;", "&");
    try {
      const href = new URL(literalHref), targetValue = href.hostname === "www.youtube.com" && href.pathname === "/redirect" ? href.searchParams.get("q") : href.href;
      if (!targetValue) return [];
      const website = new URL(targetValue.includes("://") ? targetValue : `https://${targetValue}`);
      if (website.hostname.replace(/^www\./, "") !== new URL(company.websiteUrl).hostname.replace(/^www\./, "")) return [];
      return [{ literalHref, literalAnchorHtml: match[0], literalNativeTarget: targetValue, followed: false }];
    } catch { return []; }
  });
  if (!websiteAnchors.length) throw new Error("Native header has no exact official website outbound target");
  nativeHeaders.push({ jsonPointer: `/observations/${index}`, brand: lines[0], handle, headerHtmlSha256: hash(header), literalOfficialWebsiteAnchors: websiteAnchors, observedAt: observation.observedAt });
}
const path = `outputs/fall-2026/youtube-${companySlug}-ownership-proof.json`;
const proof = { source: "literal_official_roster_owned_footer_native_channel_chain_v1", companySlug, entityId: `company-${companySlug}`, officialRosterSource: { path: rosterSource.path, sha256: rosterSource.sha256, jsonPointer: `/companies/${companyIndex}` }, officialWebsite: company.websiteUrl, officialYcProfileUrl: company.ycProfileUrl, ownedSiteYoutubeAnchor: target, ownedSiteQueueSource: { path: queueSource.path, sha256: queueSource.sha256, jsonPointer: `/targets/${targetIndex}` }, nativeChannelSource: { path: channelSource.path, sha256: channelSource.sha256 }, nativeChannelUrl: expected.url, nativeHandle: nativeHeaders[0].handle, nativeVisibleBrand: nativeHeaders[0].brand, nativeHeaders, networkRequestsMade: 0, historyScope: "Only the observed available native channel tabs/listings; this identity proof does not establish account-history completion", fullHistoryComplete: false };
await writeFile(path, JSON.stringify(proof, null, 2) + "\n");
const converterPath = `outputs/fall-2026/youtube-${companySlug}-owned-channel-proof.json`;
const converterProof = { source: "physical_official_website_native_youtube_owner_v1", ownershipProof: { officialRosterSource: proof.officialRosterSource, officialWebsite: company.websiteUrl, homepageReceipt: target.physicalSource, literalAnchorHtml: target.literalAnchorHtml, containingAncestorHtml: target.containingFooterHtml, sourceOwnershipArchive: { path: queueSource.path, sha256: queueSource.sha256 }, sourceOwnershipPointer: `/targets/${targetIndex}` } };
await writeFile(converterPath, JSON.stringify(converterProof, null, 2) + "\n");
console.log(JSON.stringify({ path, sha256: hash(await readFile(path)), converterPath, converterSha256: hash(await readFile(converterPath)), observedNativeHeaders: nativeHeaders.length, nativeChannelSourceSha256: channelSource.sha256 }));
