import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildNativeYouTubeDomReceipts, convertNativeYouTubeDom } from "../scripts/convert-fall-2026-youtube-native-dom.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
async function fixture(fn) {
  const rootDir = await mkdtemp(join(tmpdir(), "native-youtube-physical-"));
  const save = async (path, value, json = true) => { const bytes = json ? JSON.stringify(value) : value; await writeFile(join(rootDir, path), bytes); return { path, sha256: sha(bytes) }; };
  try {
    const company = { slug: "example", name: "Example", websiteUrl: "https://example.com", ycProfileUrl: "https://www.ycombinator.com/companies/example" };
    const channelUrl = "https://www.youtube.com/@example";
    const literalAnchorHtml = `<a href="${channelUrl}">YouTube</a>`, containingAncestorHtml = `<footer>Example ${literalAnchorHtml}</footer>`;
    const homepage = await save("website.html", `<html>${containingAncestorHtml}</html>`, false);
    const roster = await save("roster.json", { companies: [company] });
    const ownershipProof = { officialRosterSource: { ...roster, jsonPointer: "/companies/0" }, officialWebsite: company.websiteUrl, homepageReceipt: { ...homepage, requestedUrl: company.websiteUrl, finalUrl: company.websiteUrl }, literalAnchorHtml, containingAncestorHtml };
    const config = { companySlug: company.slug, companyName: company.name, channelUrl, ownershipArchive: await save("ownership.json", { ownershipProof }), channelArchive: await save("channel.json", { observations: [{ url: channelUrl, exact: "native header" }] }), channelObservationPointer: "/observations/0", nativeArchive: await save("watch.json", { nativePosts: [{ source: "native_youtube_watch_dom_v1", url: "https://www.youtube.com/watch?v=abcdefghijk", description: "Exact native description." }] }) };
    await fn({ rootDir, config, save, ownershipProof });
  } finally { await rm(rootDir, { recursive: true, force: true }); }
}

test("physical converter preserves exact native objects and three independent source archives", async () => fixture(async ({ rootDir, config }) => {
  const result = await buildNativeYouTubeDomReceipts(config, { rootDir });
  assert.equal(result.company.slug, "example");
  assert.equal(result.receipts[0].nativeObservation.description, "Exact native description.");
  assert.equal(result.receipts[0].sourceRecordPointer, "/nativePosts/0");
  for (const kind of ["official_roster", "official_website", "native_channel", "native_watch"]) assert.ok(result.archives.some((row) => row.kind === kind));
}));

test("physical native, channel, official HTML and roster tampering reject before a candidate exists", async () => {
  for (const path of ["watch.json", "channel.json", "website.html", "roster.json"]) await fixture(async ({ rootDir, config }) => {
    await writeFile(join(rootDir, path), "tampered");
    await assert.rejects(buildNativeYouTubeDomReceipts(config, { rootDir }), /SHA mismatch/);
  });
});

test("rehashing an ownership claim cannot substitute an external publisher or invented footer", async () => {
  for (const mutate of [
    (proof) => { proof.homepageReceipt.finalUrl = "https://publisher.example"; },
    (proof) => { proof.containingAncestorHtml += "invented ancestor"; },
    (proof) => { proof.literalAnchorHtml = '<a href="https://youtube.com/@other">YouTube</a>'; },
    (proof) => { proof.officialWebsite = "https://publisher.example"; }
  ]) await fixture(async ({ rootDir, config, save, ownershipProof }) => {
    mutate(ownershipProof);
    config.ownershipArchive = await save("ownership.json", { ownershipProof });
    await assert.rejects(buildNativeYouTubeDomReceipts(config, { rootDir }), /official|roster/);
  });
});

test("wrong company or native record pointers cannot silently select another receipt", async () => fixture(async ({ rootDir, config }) => {
  await assert.rejects(buildNativeYouTubeDomReceipts({ ...config, companySlug: "other" }, { rootDir }), /roster company/);
  await assert.rejects(buildNativeYouTubeDomReceipts({ ...config, channelObservationPointer: "/observations/9" }, { rootDir }), /pointers/);
  await assert.rejects(buildNativeYouTubeDomReceipts({ ...config, nativeObservationsPointer: "/absent" }, { rootDir }), /pointers/);
  assert.ok((await readFile(join(rootDir, config.nativeArchive.path))).length > 0);
}));

test("unknown-date opt-in cannot bypass native body, owner or channel validation", async () => fixture(async ({ rootDir, config }) => {
  const result = await convertNativeYouTubeDom([{ ...config, retainUnknownPublication: true }], { rootDir });
  assert.equal(result.evidence.length, 0);
  assert.equal(result.needsReview.length, 1);
  assert.ok(result.needsReview[0].reasons.some((reason) => /native|owner|channel/.test(reason)));
}));

test("explicit selections preserve physical source indices and reject aliases or missing records", async () => fixture(async ({ rootDir, config, save }) => {
  config.nativeArchive = await save("watch.json", { nativePosts: [{ marker: "first" }, { marker: "held original" }, { marker: "third" }] });
  const selected = await buildNativeYouTubeDomReceipts({ ...config, nativeObservationPointers: ["/nativePosts/0", "/nativePosts/2"] }, { rootDir });
  assert.deepEqual(selected.receipts.map((row) => [row.sourceRecordPointer, row.nativeObservation.marker]), [["/nativePosts/0", "first"], ["/nativePosts/2", "third"]]);
  for (const pointers of [[], ["/nativePosts/0", "/nativePosts/0"], ["/nativePosts/3"], ["/nativePosts/01"], ["/other/0"], ["/nativePosts/0/nested"], ["/nativePosts/-1"]]) {
    await assert.rejects(buildNativeYouTubeDomReceipts({ ...config, nativeObservationPointers: pointers }, { rootDir }), /selection|pointer list/);
  }
}));
