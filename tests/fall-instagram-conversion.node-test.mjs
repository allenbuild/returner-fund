import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { instagramNativeAuthorHandle, instagramPublicationFooter, isVerifiedInstagramNativeCaption, normalizeInstagramNativeObservation } from "../scripts/lib/instagram-native-observation.mjs";
import { isOfficialInstagramOutboundReceipt } from "../scripts/lib/instagram-official-outbound-proof.mjs";

const publicFixture = (name) => `tests/fixtures/fall-2026/${name}`;
const vexoProof = `--identity-proofs=${publicFixture("instagram-vexo-identity-proofs.json")}`;
const noCaptionDecisions = `--caption-decisions=${publicFixture("instagram-empty-caption-decisions.json")}`;

test("official-site Instagram proof excludes creator testimonials and mismatched native accounts", () => {
  const company = { slug: "roma", websiteUrl: "https://roma.app/" };
  const profile = "https://www.instagram.com/romaromahq/";
  const receipt = {
    companySlug: "roma", officialWebsite: "https://roma.app", finalWebsiteUrl: "https://roma.app/",
    instagramUrl: profile, anchorText: "Instagram", anchorHtml: `<a href="${profile}">Instagram</a>`,
    htmlSha256: "a".repeat(64), observedAt: "2026-11-16T03:00:00.000Z"
  };
  assert.equal(isOfficialInstagramOutboundReceipt(receipt, company, profile), true);
  assert.equal(isOfficialInstagramOutboundReceipt({ ...receipt, anchorText: "Happy customer testimonial" }, company, profile), false);
  assert.equal(isOfficialInstagramOutboundReceipt(receipt, company, "https://www.instagram.com/unrelated/"), false);
  assert.equal(isOfficialInstagramOutboundReceipt({ ...receipt, officialWebsite: "https://roma.app.evil.example/" }, company, profile), false);
  assert.equal(isOfficialInstagramOutboundReceipt({ ...receipt, anchorHtml: '<a href="https://www.instagram.com/unrelated/">Instagram</a>' }, company, profile), false);
  assert.equal(isOfficialInstagramOutboundReceipt({ ...receipt, htmlSha256: null }, company, profile), false);
});

test("saved Instagram detail normalization separates comment controls and keeps hidden counts unknown", () => {
  const original = {
    url: "https://www.instagram.com/getspacesheep/reel/DfxoSoHqKIT/", observedAt: "2026-11-16T03:00:00.000Z",
    caption: "Original caption.", captionConfirmedVisible: true, nativeText: "Original caption.\nA comment.\n6 hours ago",
    times: [{ datetime: "2026-11-15T20:59:59.000Z", text: "6h" }, { datetime: "2026-11-15T22:00:00.000Z", text: "5h" }, { datetime: "2026-11-15T21:00:00.000Z", text: "6 hours ago" }],
    controls: [
      { icons: [], text: "9 likes" }, { icons: ["Like"], text: "" },
      { icons: ["Like"], text: "" }, { icons: [], text: "1.2K" },
      { icons: ["Comment"], text: "" }, { icons: [], text: "4" },
      { icons: ["Repost"], text: "" }, { icons: [], text: "5" },
      { icons: ["Share"], text: "" }, { icons: [], text: "6" }, { icons: ["Save"], text: "" }
    ]
  };
  const row = normalizeInstagramNativeObservation(original);
  assert.equal(row.authorHandle, "getspacesheep");
  assert.equal(row.postedAt, "2026-11-15T21:00:00.000Z");
  assert.deepEqual(row.metrics, { comments: 4, shares: 6 });
  assert.equal(row.captionConfirmedVisible, true);
  const hidden = normalizeInstagramNativeObservation({ ...original, controls: original.controls.filter((control) => !control.text) });
  assert.deepEqual(hidden.metrics, {});
  assert.equal(normalizeInstagramNativeObservation({ ...original, caption: "Unobserved caption." }).captionConfirmedVisible, false);
  assert.equal(normalizeInstagramNativeObservation({ ...original, caption: "Original\ncaption." }).captionConfirmedVisible, true);
  assert.equal(normalizeInstagramNativeObservation({ ...original, caption: "" }).captionConfirmedVisible, false);
});

test("native Instagram conversion keeps founder ownership and omitted metrics intact", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "fall-instagram-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "candidate.json");
  execFileSync(process.execPath, [
    "scripts/convert-fall-2026-instagram-observations.mjs",
    `--input=${publicFixture("instagram-vexo-native-observations.json")}`,
    `--input=${publicFixture("instagram-vexo-additional-native-observations.json")}`,
    `--input=${publicFixture("instagram-vexo-native-observations.json")}`,
    vexoProof, noCaptionDecisions,
    `--output=${output}`
  ], { stdio: "pipe" });
  const candidate = JSON.parse(await readFile(output, "utf8"));
  assert.equal(candidate.evidence.length, 36);
  assert.equal(candidate.evidence.filter((row) => row.entityType === "company").length, 1);
  assert.equal(candidate.needsReview.length, 1);
  assert.equal(candidate.needsReview[0].authorHandle, "viraj.ala");
  for (const row of candidate.evidence) {
    if (row.authorHandle === "realharismalik") assert.equal(row.entityId, "founder-vexo-haris-malik-1123245");
    if (row.authorHandle === "kiani_build") assert.equal(row.entityId, "founder-vexo-farqaleet-kiani-4000265");
    assert.equal(row.originalText, row.text);
    assert.ok(Date.parse(row.postedAt) <= Date.parse(row.observedAt));
  }
  assert.equal(Object.hasOwn(candidate.evidence.find((row) => row.platformPostId === "Deuw-A7SlHr").metrics, "likes"), false);
  assert.equal(Object.hasOwn(candidate.evidence.find((row) => row.platformPostId === "DfBCj-vs8RX").metrics, "likes"), false);
});

test("accented Instagram founder names extend the existing canonical YC founder entity", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "fall-instagram-founder-id-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, "native.json"), proofs = join(directory, "proofs.json"), output = join(directory, "candidate.json");
  await writeFile(input, JSON.stringify({ observations: [{
    id: "NativeFixtureID", kind: "p", authorHandle: "fixturefounder", url: "https://www.instagram.com/fixturefounder/p/NativeFixtureID/",
    text: "Exact original fixture.", postedAt: "2026-11-15T12:00:00Z", observedAt: "2026-11-16T12:00:00Z", metrics: { likes: 1 }
  }] }));
  await writeFile(proofs, JSON.stringify({ companies: [{ batchSlug: "F26", companySlug: "deepmark", companyHandle: "fixturecompany", accounts: [{
    review_state: "verified", entityType: "founder", founderId: "2023960", founderName: "Slavko Kovačević", companyAccountMention: "fixturecompany",
    handle: "fixturefounder", profileUrl: "https://www.instagram.com/fixturefounder/", visibleWebsite: "deepmark.me"
  }] }] }));
  execFileSync(process.execPath, ["scripts/convert-fall-2026-instagram-observations.mjs", `--input=${input}`, `--identity-proofs=${proofs}`, noCaptionDecisions, `--output=${output}`], { stdio: "pipe" });
  const candidate = JSON.parse(await readFile(output, "utf8"));
  assert.equal(candidate.evidence.length, 1);
  assert.equal(candidate.evidence[0].entityId, "founder-deepmark-slavko-kova-evi-2023960");
});

test("Instagram publication uses the native footer rather than edited captions or comments", () => {
  const original = {
    url: "https://www.instagram.com/sulansart/p/ClZ5MmzsPlq/",
    times: [
      { datetime: "2025-01-30T05:37:40.000Z", text: "93w" },
      { datetime: "2022-11-26T13:24:47.000Z", text: "207w" },
      { datetime: "2022-11-26T00:47:52.000Z", text: "November 25, 2022" }
    ]
  };
  assert.equal(instagramPublicationFooter(original).datetime, "2022-11-26T00:47:52.000Z");
  const explicit = { datetime: "2022-11-26T00:47:52.000Z", text: "November 25, 2022", href: "/p/ClZ5MmzsPlq/" };
  assert.equal(instagramPublicationFooter({ ...original, publicationFooter: explicit }).selection, "explicit_native_post_footer");
  assert.equal(instagramPublicationFooter({ ...original, publicationFooter: { ...explicit, href: "/p/another-post/" } }), null);
  assert.equal(instagramPublicationFooter({ ...original, publicationFooter: { ...explicit, href: "/p/ClZ5MmzsPlq/c/123/" } }), null);
  assert.equal(instagramPublicationFooter({ ...original, times: original.times.slice(0, 2) }), null);
});

test("generic Instagram dialog URLs require an exact native header and matching publication footer", () => {
  const post = {
    url: "https://www.instagram.com/p/Dfug-0XTwSx/", nativeText: "jansenderek\n2026\nNovember 14", text: "2026",
    caption: "2026", captionConfirmedVisible: true, controls: [], times: [],
    nativeAuthorHeader: { mechanism: "native_post_dialog_header_v1", profileUrl: "https://www.instagram.com/jansenderek/", handle: "jansenderek", visibleText: "jansenderek" },
    publicationFooter: { datetime: "2026-11-14T02:00:00.000Z", text: "November 14", href: "https://www.instagram.com/p/Dfug-0XTwSx/" },
    nativeCaptionReceipt: { mechanism: "native_caption_dialog_h1_v1", authorLink: "https://www.instagram.com/jansenderek/", authorName: "jansenderek", caption: "2026", blockVisibleText: "2026" }
  };
  assert.equal(instagramNativeAuthorHandle(post), "jansenderek");
  const carousel = { ...post, url: `${post.url}?img_index=1` };
  assert.equal(instagramNativeAuthorHandle(carousel), "jansenderek");
  assert.equal(normalizeInstagramNativeObservation(carousel).url, carousel.url);
  assert.equal(instagramNativeAuthorHandle({ ...carousel, publicationFooter: { ...post.publicationFooter, href: "/p/another-post/?img_index=1" } }), null);
  assert.equal(instagramNativeAuthorHandle({ ...carousel, nativeAuthorHeader: { ...post.nativeAuthorHeader, handle: "unrelated" } }), null);
  assert.equal(instagramNativeAuthorHandle({ ...post, url: `${post.url}?post_id=another-post` }), null);
  assert.equal(instagramNativeAuthorHandle({ ...post, url: `${post.url}?img_index=1&img_index=2` }), null);
  assert.equal(instagramNativeAuthorHandle({ ...post, url: `https://instagram.com.example.com/p/Dfug-0XTwSx/?img_index=1` }), null);
  assert.equal(normalizeInstagramNativeObservation(post).id, "Dfug-0XTwSx");
  assert.equal(normalizeInstagramNativeObservation(post).postedAt, "2026-11-14T02:00:00.000Z");
  assert.equal(isVerifiedInstagramNativeCaption(post, "jansenderek"), true);
  assert.equal(instagramNativeAuthorHandle({ ...post, nativeAuthorHeader: undefined }), null);
  assert.equal(instagramNativeAuthorHandle({ ...post, nativeAuthorHeader: { ...post.nativeAuthorHeader, profileUrl: "https://www.instagram.com/unrelated/" } }), null);
  assert.equal(instagramNativeAuthorHandle({ ...post, publicationFooter: { ...post.publicationFooter, href: "/p/another-post/" } }), null);
  assert.equal(instagramNativeAuthorHandle({ ...post, nativeText: "unrelated\n2026" }), null);
  assert.equal(instagramNativeAuthorHandle({ ...post, nativeText: "gucciyama\njansenderek\n2026" }), "jansenderek");
  const prefix = "gucciyama\njansenderek\n707 likes\njansenderek\n";
  const withLikes = { ...post, nativeText: `${prefix}2026\nNovember 14`, nativeMetricReceipt: { mechanism: "native_dialog_pre_caption_like_label_v1", prefixVisibleText: prefix, captionStartIndex: prefix.length, likesLabel: "707 likes", likes: 707 } };
  assert.deepEqual(normalizeInstagramNativeObservation(withLikes).metrics, { likes: 707 });
  assert.deepEqual(normalizeInstagramNativeObservation({ ...withLikes, nativeMetricReceipt: { ...withLikes.nativeMetricReceipt, likes: 800 } }).metrics, {});
  assert.deepEqual(normalizeInstagramNativeObservation({ ...withLikes, nativeMetricReceipt: { ...withLikes.nativeMetricReceipt, prefixVisibleText: `${prefix}2026\nA comment has 707 likes` } }).metrics, {});
  const headerOnly = { ...post, caption: "", text: "", captionConfirmedVisible: false,
    nativeAuthorHeader: { ...post.nativeAuthorHeader, selection: "native_dialog_header_element", visibleText: "jansenderek\nFollow\nSomewhere" },
    nativeText: "gucciyama\njansenderek\nFollow\nSomewhere\n842 likes\nA comment has 1 like\nNovember 14",
    nativeMetricReceipt: { mechanism: "native_post_liked_by_link_v1", href: "https://www.instagram.com/p/Dfug-0XTwSx/liked_by/", likesLabel: "842 likes", likes: 842 }
  };
  assert.equal(instagramNativeAuthorHandle(headerOnly), "jansenderek");
  assert.deepEqual(normalizeInstagramNativeObservation(headerOnly).metrics, { likes: 842 });
  assert.deepEqual(normalizeInstagramNativeObservation({ ...headerOnly, nativeMetricReceipt: { ...headerOnly.nativeMetricReceipt, href: "https://www.instagram.com/p/other/liked_by/" } }).metrics, {});
});

test("Instagram footer correction updates only Fall publication metadata and preserves prior cohorts", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "fall-instagram-dates-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, "native.json"), target = join(directory, "target.json");
  const earlier = { id: "earlier", batchSlug: "S26", platform: "instagram", postedAt: "2025-01-30T05:37:40.000Z", metrics: { likes: 3 } };
  const oldDate = "2025-01-30T05:37:40.000Z", nativeDate = "2022-11-26T00:47:52.000Z";
  const fall = { id: "fall", batchSlug: "F26", platform: "instagram", platformPostId: "ClZ5MmzsPlq", postedAt: oldDate, last_updated_at: oldDate, text: "Original caption.", metrics: { likes: 7 }, rawVisibleText: JSON.stringify({ post: { text: "Original caption.", metrics: { likes: 7 }, postedAt: oldDate } }) };
  const source = { nativePosts: [{ url: "https://www.instagram.com/sulansart/p/ClZ5MmzsPlq/", observedAt: "2026-11-16T03:00:00.000Z", times: [{ datetime: oldDate, text: "93w" }, { datetime: nativeDate, text: "November 25, 2022" }] }] };
  await writeFile(input, JSON.stringify(source));
  await writeFile(target, JSON.stringify({ source: {}, evidence: [earlier, fall] }));
  const before = await readFile(target, "utf8");
  const run = (mode, output) => execFileSync(process.execPath, ["scripts/correct-fall-2026-instagram-publication-dates.mjs", mode, `--input=${input}`, `--target=${target}`, `--output=${join(directory, output)}`], { stdio: "pipe" });
  assert.equal(JSON.parse(run("--dry-run", "preview")).corrected, 1);
  assert.equal(await readFile(target, "utf8"), before);
  assert.equal(JSON.parse(run("--write", "written")).corrected, 1);
  const saved = JSON.parse(await readFile(target, "utf8"));
  assert.deepEqual(saved.evidence[0], earlier);
  assert.equal(saved.evidence[1].postedAt, nativeDate);
  assert.equal(saved.evidence[1].last_updated_at, nativeDate);
  assert.equal(saved.evidence[1].text, fall.text);
  assert.deepEqual(saved.evidence[1].metrics, fall.metrics);
  assert.equal(JSON.parse(saved.evidence[1].rawVisibleText).post.publicationTimeReceipt.nativeFooter.datetime, nativeDate);
});

test("a visible Reels view counter cannot replace the native caption", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "fall-instagram-counter-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, "counter.json");
  const output = join(directory, "candidate.json");
  const original = JSON.parse(await readFile(publicFixture("instagram-vexo-native-observations.json"), "utf8"));
  await writeFile(input, JSON.stringify({ observations: [{ ...original.observations[0], text: "1.2K", captionConfirmedVisible: true }] }));
  execFileSync(process.execPath, ["scripts/convert-fall-2026-instagram-observations.mjs", `--input=${input}`, vexoProof, noCaptionDecisions, `--output=${output}`], { stdio: "pipe" });
  const result = JSON.parse(await readFile(output, "utf8"));
  assert.equal(result.evidence.length, 0);
  assert.ok(result.needsReview[0].reasons.includes("numeric_only_listing_counter_is_not_a_verified_caption"));
  const row = original.observations[0];
  const caption = "2026";
  const nativeCaptionReceipt = {
    mechanism: "native_caption_block_v1", authorLink: `https://www.instagram.com/${row.authorHandle}/`, authorName: row.authorHandle,
    caption, captionTime: { datetime: row.postedAt, text: "3w" }, blockVisibleText: `${row.authorHandle}\n3w\n${caption}`
  };
  const native = { ...row, text: caption, nativeCaptionReceipt, captionConfirmedVisible: true };
  assert.equal(isVerifiedInstagramNativeCaption(native, row.authorHandle), true);
  assert.equal(isVerifiedInstagramNativeCaption({ ...native, nativeCaptionReceipt: { ...nativeCaptionReceipt, authorLink: "https://www.instagram.com/unrelated/" } }, row.authorHandle), false);
  await writeFile(input, JSON.stringify({ observations: [native] }));
  execFileSync(process.execPath, ["scripts/convert-fall-2026-instagram-observations.mjs", `--input=${input}`, vexoProof, noCaptionDecisions, `--output=${output}`], { stdio: "pipe" });
  const verified = JSON.parse(await readFile(output, "utf8"));
  assert.equal(verified.evidence.length, 1);
  assert.equal(verified.evidence[0].originalText, caption);
});

test("multi-company Instagram proof builder requires an exact unique official domain", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "fall-instagram-proof-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, "native.json");
  const output = join(directory, "proofs.json");
  const websiteLinks = join(directory, "website-links.json");
  await writeFile(websiteLinks, JSON.stringify({ links: [{
    companySlug: "roma", officialWebsite: "https://roma.app", instagramUrl: "https://www.instagram.com/romaromahq/",
    anchorText: "Instagram", anchorHtml: '<a href="https://www.instagram.com/romaromahq/">Instagram</a>',
    htmlSha256: "a".repeat(64), observedAt: "2026-11-16T03:00:00.000Z"
  }] }));
  await writeFile(input, JSON.stringify({
    source: { batchSlug: "F26" },
    verifiedProfiles: [
      { url: "https://www.instagram.com/getspacesheep/", identity: "1\ngetspacesheep\nSpacesheep\n1 posts\n1 followers\n1 following\nspacesheep.dev/?utm_source=instagram", observedAt: "2026-11-16T03:00:00.000Z" },
      { url: "https://www.instagram.com/unconfirmedowner/", identity: "1\nunconfirmedowner\n1 posts\n1 followers\n1 following\nspacesheep.dev.evil.example", observedAt: "2026-11-16T03:00:00.000Z" },
      { url: "https://www.instagram.com/native.no/", identity: "1\nnative.no\nNative\n1 posts\n1 followers\n1 following\nNo website visible", observedAt: "2026-11-16T03:00:00.000Z" },
      { url: "https://www.instagram.com/romaromahq/", identity: "1\nromaromahq\nRoma.app\n1 posts\n1 followers\n1 following\napps.apple.com/app/example", observedAt: "2026-11-16T03:00:00.000Z" }
    ]
  }));
  execFileSync(process.execPath, ["scripts/build-fall-2026-instagram-identity-proofs.mjs", `--input=${input}`, `--output=${output}`, `--website-links=${websiteLinks}`, `--seed=${publicFixture("instagram-empty-identity-seed.json")}`], { stdio: "pipe" });
  const proofs = JSON.parse(await readFile(output, "utf8"));
  assert.equal(proofs.companies.find((company) => company.companySlug === "spacesheep").accounts[0].handle, "getspacesheep");
  assert.equal(proofs.needsReview.length, 2);
  assert.equal(proofs.needsReview[0].profileUrl, "https://www.instagram.com/unconfirmedowner/");
  assert.equal(proofs.companies.some((company) => company.companySlug === "native"), false);
  const roma = proofs.companies.find((company) => company.companySlug === "roma");
  assert.equal(roma.accounts[0].visibleWebsite, null);
  assert.ok(roma.accounts[0].officialWebsiteOutboundReceipt);
});
