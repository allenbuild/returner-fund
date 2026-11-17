import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { isVerifiedNativeLinkedInCompanyDetailReceipt } from "../src/lib/graph/linkedin-company-detail-receipt.mjs";

const root = resolve(import.meta.dirname, "..");
const importer = resolve(root, "scripts/import-source-hunt-evidence.mjs");
const observedAt = "2026-07-19T03:00:00.000Z";
const canonicalEvidenceFiles = [
  "a16z-speedrun-006-social-evidence.json",
  "public-evidence-current.json",
  "logged-in-evidence-current.json",
  "targeted-evidence-current.json"
];
const danielaBody = "I have never been this excited about anything. Last year, it took me using OpenClaw for all of 5 minutes to realize that the world is fundamentally changing. Technology is moving fast enough to completely rewrite how people work, what a small team can pull off, and who gets to build at all. And it’s only accelerating. I immediately turned to Jordan and I told him I want to be a part of this. It was simply too exciting not to. We dropped everything. We started talking to everyone we knew about how they were using AI. What did they know? What did they wish they could do? What was holding them back? A pattern showed up immediately. The people building and using these tools live in a bubble. Step outside it, and the businesses that stand to gain the most from this technology are the ones that have the least access and understanding of it. Today we’re taking LemonLime out of stealth to close ";

test("positive YouTube DOM claims require their complete native and official-owner receipt", async () => {
  const row = { batchSlug: "F26", companySlug: "aucert", companyName: "Aucert", entityType: "company", entityId: "company-aucert", platform: "youtube", platformPostId: "abcdefghijk", sourceUrl: "https://www.youtube.com/watch?v=abcdefghijk", text: "A claimed native company video description.", postedAt: "2026-11-11", publishedAtPrecision: "day", metrics: { views: 1234, likes: 7 }, review_state: "verified", attributionVersion: 3, attributionStatus: "verified", attributionMode: "author", attributionProvenance: "authorized_native_youtube_watch_dom_v1", rawVisibleText: JSON.stringify({ source: "authorized_native_youtube_watch_dom_v1" }) };
  const fixture = await fixtureFiles({ evidence: [] }, { evidence: [row] });
  const result = runImporter(fixture, "--include-batches=F26", "--scope-batch-dedupe", "--strict", "--dry-run");
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /missing_native_youtube_dom_receipt/);
  assert.deepEqual(JSON.parse(await readFile(fixture.target, "utf8")).evidence, []);
});

test("relative-date YouTube claims cannot bypass strict native owner and body proof", async () => {
  const row = { batchSlug: "F26", companySlug: "native", companyName: "Native", entityType: "company", entityId: "company-native", platform: "youtube", platformPostId: "abcdefghijk", sourceUrl: "https://www.youtube.com/shorts/abcdefghijk", text: "An unproved claimed company video.", postedAt: null, publishedAtPrecision: "unknown", metrics: { views: 1, likes: 0 }, contributionScore: 0, tractionStatus: "unscored", review_state: "verified", attributionVersion: 3, attributionStatus: "verified", attributionMode: "author", attributionProvenance: "authorized_native_youtube_short_unknown_date_dom_v1", rawVisibleText: JSON.stringify({ source: "authorized_native_youtube_short_unknown_date_dom_v1" }) };
  const fixture = await fixtureFiles({ evidence: [] }, { evidence: [row] });
  const result = runImporter(fixture, "--include-batches=F26", "--scope-batch-dedupe", "--retain-zero-engagement", "--strict", "--dry-run");
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /youtube_unknown_date_native_receipt_required/);
  assert.deepEqual(JSON.parse(await readFile(fixture.target, "utf8")).evidence, []);
});

test("preserves exact whitespace in proved native LinkedIn originals after canonical normalization", async () => {
  const profile = "https://www.linkedin.com/company/wondersearch", id = "7513974843927707648", url = `https://www.linkedin.com/feed/update/urn:li:activity:${id}/`, text = "\nExact native buyer caption. \n";
  const menu = "Open control menu for post by Wondersearch", captionHtml = `<span>${text}</span>`;
  const reaction = { tag: "BUTTON", ariaLabel: "Reaction button state: no reaction", text: "2", html: '<button aria-label="Reaction button state: no reaction">2</button>' };
  const redirect = { href: `https://www.linkedin.com/signup/cold-join?session_redirect=${encodeURIComponent(url)}`, text: "Join" };
  const detail = { url, observedRedirectTarget: url, observedRedirectLink: redirect, observedAt, menuLabel: menu, primaryActorLinks: [{ href: profile, text: "Wondersearch" }], captionHtml, captionText: text, fullnessControls: [], nativeControls: [reaction], cardHtml: `<div><a href="${profile}">Wondersearch</a><button aria-label="${menu}"></button>${captionHtml}${reaction.html}</div>` };
  const receipt = { mechanism: "native_linkedin_company_detail_redirect_v1", companySlug: "wondersearch", profileUrl: profile, observedAt, review: { card: { key: "exact-native-card", menu, body: text }, nativeEmbedLinks: [redirect], signedInNativeDetail: detail } };
  const row = { batchSlug: "F26", companySlug: "wondersearch", companyName: "Wondersearch", entityId: "company-wondersearch", entityType: "company", platform: "linkedin", platformPostId: id, sourceUrl: url, accountUrl: profile, authorName: "Wondersearch", title: "Native caption", text, originalText: text, metrics: { reactions: 2 }, postedAt: null, publishedAtPrecision: "unknown", review_state: "verified", attributionVersion: 3, attributionStatus: "verified", attributionMode: "author", attributionProvenance: "native_linkedin_company_detail_v1", attributionSignals: ["official_yc_linked_company_account", "visible_native_linkedin_post"], rawVisibleText: JSON.stringify({ source: "authorized_linkedin_browser_dom_v1", observedAt, post: { id, url, text, metrics: { reactions: 2 }, bodyTruncated: false, publishedAt: null, nativeCompanyDetailReceipt: receipt }, validation: { source: "fall_2026_native_linkedin_company_detail_ingestion_v1", archiveHashesVerified: true, nativeCompanyDetailReceiptSha256: createHash("sha256").update(JSON.stringify(receipt)).digest("hex") } }) };
  const fixture = await fixtureFiles({ evidence: [] }, { evidence: [row] });
  const result = runImporter(fixture, "--include-batches=F26", "--scope-batch-dedupe", "--strict", "--write");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const saved = JSON.parse(await readFile(fixture.target, "utf8")).evidence[0];
  assert.equal(saved.text, text); assert.equal(saved.originalText, text);
  assert.equal(isVerifiedNativeLinkedInCompanyDetailReceipt(saved, { entityId: row.entityId, companySlug: row.companySlug, companyName: row.companyName, socialAccounts: { linkedin: [profile] } }), true);
});

test("imports explicit Fall 2026 company and founder identities", async () => {
  const rows = [
    { entityType: "company", entityId: "company-acyclic", platformPostId: "2100000000000000001" },
    { entityType: "founder", entityId: "founder-acyclic-ram-vinjamuri-3653810", platformPostId: "2100000000000000002" }
  ].map((identity) => ({
    ...identity,
    batchSlug: "F26",
    companyName: "Acyclic Labs",
    companySlug: "acyclic",
    platform: "x",
    sourceUrl: `https://x.com/fallfixture/status/${identity.platformPostId}`,
    postedAt: null,
    text: "Acyclic Labs product launch from the verified company and founder accounts.",
    metrics: { likes: 1 },
    review_state: "verified",
    matchReason: "Verified native post on the exact official account."
  }));
  const fixture = await fixtureFiles({ evidence: [] }, { evidence: rows });
  const result = runImporter(fixture, "--include-batches=F26", "--strict", "--write");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const target = JSON.parse(await readFile(fixture.target, "utf8"));
  assert.deepEqual(target.evidence.map((row) => row.entityId).sort(), rows.map((row) => row.entityId).sort());
  assert.equal(target.evidence.every((row) => row.batchSlug === "F26"), true);
});

test("explicit batch dedupe preserves prior rows and remains idempotent within Fall", async () => {
  const original = {
    id: "existing-summer-attribution",
    batchSlug: "S26",
    entityType: "company",
    entityId: "company-acyclic",
    companyName: "Acyclic Labs",
    platform: "x",
    sourceUrl: "https://x.com/fallfixture/status/2100000000000000003",
    platformPostId: "2100000000000000003",
    authorHandle: "fallfixture",
    text: "Acyclic Labs ships a native production system with a complete demonstration and verified customer workflow, shared directly from the official company account.",
    postedAt: null,
    metrics: { likes: 2 },
    review_state: "verified"
  };
  const incoming = { ...original, batchSlug: "F26", metrics: { likes: 4 } };
  const fixture = await fixtureFiles({ evidence: [original] }, { evidence: [incoming] });
  const defaults = runImporter(fixture, "--include-batches=F26", "--strict", "--dry-run");
  assert.equal(defaults.status, 0, defaults.stderr || defaults.stdout);
  assert.equal(JSON.parse(defaults.stdout).duplicates, 1);

  const flags = ["--include-batches=F26", "--scope-batch-dedupe", "--strict", "--write"];
  const first = runImporter(fixture, ...flags);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  assert.equal(JSON.parse(first.stdout).accepted, 1);
  let target = JSON.parse(await readFile(fixture.target, "utf8"));
  assert.equal(target.evidence.length, 2);
  assert.deepEqual(target.evidence.find((row) => row.batchSlug === "S26"), original);
  assert.notEqual(target.evidence.find((row) => row.batchSlug === "F26").id, original.id);

  const replay = runImporter(fixture, ...flags);
  assert.equal(replay.status, 0, replay.stderr || replay.stdout);
  assert.equal(JSON.parse(replay.stdout).accepted, 0);
  assert.equal(JSON.parse(replay.stdout).duplicates, 1);
  target = JSON.parse(await readFile(fixture.target, "utf8"));
  assert.equal(target.evidence.length, 2);
  assert.deepEqual(target.evidence.find((row) => row.batchSlug === "S26"), original);

  await writeJson(fixture.input, { evidence: [{
    ...incoming,
    sourceUrl: "https://x.com/fallfixture/status/2100000000000000004",
    platformPostId: "2100000000000000004"
  }] });
  const contentReplay = runImporter(fixture, ...flags);
  assert.equal(contentReplay.status, 0, contentReplay.stderr || contentReplay.stdout);
  const audit = JSON.parse(contentReplay.stdout);
  assert.equal(audit.accepted, 0);
  assert.equal(audit.duplicateRows[0].duplicateReason, "same_platform_author_substantive_body");
  assert.match(audit.duplicateRows[0].existingId, /^source-hunt-/);
});

test("batch dedupe requires one explicit included batch", async () => {
  const fixture = await fixtureFiles({ evidence: [] }, { evidence: [] });
  for (const batches of [[], ["--include-batches=F26,S26"]]) {
    const result = runImporter(fixture, "--scope-batch-dedupe", "--dry-run", ...batches);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /requires exactly one explicit --include-batches/);
  }
});

test("imports verified native evidence and preserves case-sensitive post ids", async () => {
  const fixture = await fixtureFiles({ evidence: [] }, {
    evidence: [{
      entityType: "company",
      entityId: "company-heyclicky",
      companyName: "HeyClicky",
      platform: "instagram",
      sourceUrl: "https://www.instagram.com/reel/DayUBNASjcO/",
      platformPostId: "DayUBNASjcO",
      postedAt: "2026-07-14",
      title: "Screen-aware dictation demo",
      metrics: { views: 50384, likes: 2477, comments: 97 },
      review_state: "verified",
      matchReason: "Native founder reel."
    }]
  });

  const result = runImporter(fixture, "--strict", "--write");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const target = JSON.parse(await readFile(fixture.target, "utf8"));
  assert.equal(target.evidence[0].platformPostId, "DayUBNASjcO");
  assert.equal(target.evidence[0].contributionScore, 1);
  assert.equal(target.source.evidenceCount, 1);
});

test("retains receipt-bound zero and unknown engagement originals unscored only with explicit opt-in", async () => {
  for (const metrics of [{ reactions: 0 }, {}]) {
    const row = verifiedZeroLinkedInRow(metrics);
    const fixture = await fixtureFiles({ evidence: [] }, { evidence: [row] });
    const flags = ["--include-batches=F26", "--scope-batch-dedupe", "--strict"];
    const defaults = runImporter(fixture, ...flags, "--dry-run");
    assert.notEqual(defaults.status, 0);
    assert.match(defaults.stdout, /no_visible_positive_scoring_metrics/);
    const optedIn = runImporter(fixture, ...flags, "--retain-zero-engagement", "--write");
    assert.equal(optedIn.status, 0, optedIn.stderr || optedIn.stdout);
    const saved = JSON.parse(await readFile(fixture.target, "utf8")).evidence[0];
    assert.deepEqual(saved.metrics, metrics);
    assert.equal(saved.contributionScore, 0);
    assert.equal(saved.tractionStatus, "unscored");
    assert.match(saved.tractionLimitations.join(" "), /Missing metrics remain unknown/);
    assert.equal(saved.postedAt, null);
    assert.equal(saved.publishedAtPrecision, "unknown");
  }
});

test("retains a proved captionless X original with case-insensitive canonical ownership and no invented body", async () => {
  const platformPostId = "2105361550546735299", accountUrl = "https://x.com/RamV2003", sourceUrl = `${accountUrl}/status/${platformPostId}`;
  const metrics = { replies: 0, reposts: 0, likes: 1, views: 27 }, publishedAt = "2026-07-18T12:00:00.000Z";
  const raw = {
    source: "authenticated_native_x_ui_v1", observedAt, exportedAt: observedAt, accountUrl,
    identitySourceUrl: "https://www.ycombinator.com/companies/acyclic",
    post: { platformPostId, authorHandle: "RamV2003", publishedAt, nativeDateLink: sourceUrl, url: sourceUrl, text: "", bodyTruncated: false, captionAbsent: true,
      ownTweetTextElementCount: 0, ownVisibleTextAbsent: true, ownNativeArticleLinks: [],
      ownMediaPermalinks: [{ href: `${sourceUrl}/photo/1`, nativePostId: platformPostId, kind: "photo", mediaIndex: "1", visibleMediaUrls: ["https://pbs.twimg.com/media/ExactOwnImage.jpg"] }] },
    metrics, renderedArticleTextIncludingQuotedContent: "Ram Vinjamuri\n@RamV2003\nJul 18\n27",
    metricObservations: [{ observedAt, metrics, nativeVisibleLabels: ["0 Replies. Reply", "0 reposts. Repost", "1 Like. Like", "27 views. View post analytics"] }]
  };
  const row = { entityType: "founder", entityId: "founder-acyclic-ram-vinjamuri-3653810", batchSlug: "F26", companySlug: "acyclic", companyName: "Acyclic Labs",
    platform: "x", platformPostId, sourceUrl, accountUrl, authorHandle: "RamV2003", authorName: "Ram Vinjamuri", text: "", originalText: "", captionAbsent: true, bodyTruncated: false,
    postedAt: publishedAt, metrics, contributionScore: 0, tractionStatus: "unscored", review_state: "verified", attributionVersion: 3, attributionStatus: "verified",
    attributionSignals: ["official_yc_roster_account", "native_post_author"], rawVisibleText: JSON.stringify(raw) };
  const fixture = await fixtureFiles({ evidence: [] }, { evidence: [row] });
  const flags = ["--include-batches=F26", "--scope-batch-dedupe", "--strict"];
  assert.notEqual(runImporter(fixture, ...flags, "--dry-run").status, 0);
  const result = runImporter(fixture, ...flags, "--retain-zero-engagement", "--write");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const [saved] = JSON.parse(await readFile(fixture.target, "utf8")).evidence;
  assert.equal(saved.text, ""); assert.equal(saved.originalText, ""); assert.equal(saved.captionAbsent, true);
  assert.equal(saved.contributionScore, 0); assert.equal(saved.tractionStatus, "unscored"); assert.deepEqual(saved.metrics, metrics);
  const wrong = structuredClone(row), wrongRaw = JSON.parse(wrong.rawVisibleText); wrongRaw.post.ownMediaPermalinks[0].nativePostId = "another"; wrong.rawVisibleText = JSON.stringify(wrongRaw);
  await writeFile(fixture.input, JSON.stringify({ evidence: [wrong] }));
  const rejected = runImporter(fixture, ...flags, "--retain-zero-engagement", "--dry-run");
  assert.notEqual(rejected.status, 0); assert.match(rejected.stdout, /x_captionless_exact_own_media_required/);
});

test("zero engagement opt-in keeps native identity, owner, body, cohort and metric validation", async () => {
  const original = verifiedZeroLinkedInRow({ reactions: 0 });
  const mutations = [
    { entityId: "company-does-not-exist" },
    { entityId: "company-heyclicky" },
    { platformPostId: "7518380931548606465" },
    { accountUrl: "https://www.linkedin.com/company/other-owner" },
    { text: "A different body than the observed native caption." },
    { metrics: { reactions: -1 } },
    { metrics: { reactions: "0" } },
    { attributionSignals: [] },
    { rawVisibleText: JSON.stringify({ source: "public_search_snippet" }) }
  ];
  for (const mutation of mutations) {
    const fixture = await fixtureFiles({ evidence: [] }, { evidence: [{ ...original, ...mutation }] });
    const result = runImporter(fixture, "--include-batches=F26", "--scope-batch-dedupe", "--retain-zero-engagement", "--strict", "--dry-run");
    assert.notEqual(result.status, 0, JSON.stringify(mutation));
    assert.equal(JSON.parse(result.stdout).accepted, 0);
  }
  const fixture = await fixtureFiles({ evidence: [] }, { evidence: [original] });
  const unscoped = runImporter(fixture, "--retain-zero-engagement", "--dry-run");
  assert.notEqual(unscoped.status, 0);
  assert.match(unscoped.stderr, /requires --scope-batch-dedupe/);
});

test("zero engagement founder captions require the exact roster founder account", async () => {
  const row = verifiedZeroLinkedInRow({ reactions: 0 });
  const accountUrl = "https://www.linkedin.com/in/dale-everett";
  row.entityId = "founder-wondersearch-dale-ng-3185776";
  row.entityType = "founder";
  row.accountUrl = accountUrl;
  row.attributionSignals = ["official_yc_linked_founder_account", "visible_native_linkedin_post", "visible_author_matches_official_founder"];
  const raw = JSON.parse(row.rawVisibleText);
  raw.post.author.profileUrl = accountUrl;
  row.rawVisibleText = JSON.stringify(raw);
  const fixture = await fixtureFiles({ evidence: [] }, { evidence: [row] });
  const result = runImporter(fixture, "--include-batches=F26", "--scope-batch-dedupe", "--retain-zero-engagement", "--strict", "--write");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const saved = JSON.parse(await readFile(fixture.target, "utf8")).evidence[0];
  assert.equal(saved.entityType, "founder");
  assert.equal(saved.contributionScore, 0);
  assert.equal(saved.tractionStatus, "unscored");
  raw.post.author.profileUrl = "https://www.linkedin.com/in/someone-else";
  await writeJson(fixture.input, { evidence: [{ ...row, accountUrl: raw.post.author.profileUrl, rawVisibleText: JSON.stringify(raw) }] });
  const invalid = runImporter(fixture, "--include-batches=F26", "--scope-batch-dedupe", "--retain-zero-engagement", "--strict", "--dry-run");
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stdout, /zero_engagement_author_not_canonical_account/);
});

test("captionless native media keeps an empty body and real metrics while remaining unscored", async () => {
  const nativeObservedAt = "2026-11-16T03:00:00.000Z";
  const sourceUrl = "https://www.instagram.com/reel/Dd2nucIjTDp/";
  const accountUrl = "https://www.instagram.com/kairosdental_/";
  const nativeText = "1\nkairosdental_\nOriginal audio\nkairosdental_\n15\n2\nSeptember 28";
  const captionAbsenceProof = {
    source: "authorized_native_instagram_caption_absence_review_v1", review_state: "verified",
    platformPostId: "Dd2nucIjTDp", authorHandle: "kairosdental_", observedAt: nativeObservedAt,
    nativeTextSha256: createHash("sha256").update(nativeText).digest("hex")
  };
  const metrics = { likes: 15, comments: 2 };
  const row = {
    entityType: "company", entityId: "company-kairos-health", companyName: "Kairos Health", batchSlug: "F26",
    platform: "instagram", platformPostId: "Dd2nucIjTDp", sourceUrl, accountUrl, authorHandle: "kairosdental_",
    text: "", originalText: "", captionAbsent: true, title: "Kairos Health Instagram media post", metrics,
    postedAt: "2026-09-29T01:51:50.000Z", review_state: "verified", attributionVersion: 3, attributionStatus: "verified",
    attributionSignals: ["mapped_official_account", "exact_native_author"],
    rawVisibleText: JSON.stringify({
      source: "authorized_native_instagram_dom_v1",
      identityProof: { entityId: "company-kairos-health", profileUrl: accountUrl, review_state: "verified", visibleWebsite: "kairoshealthai.com" },
      post: { shortcode: "Dd2nucIjTDp", url: sourceUrl, text: "", nativeText, authorHandle: "kairosdental_", captionAbsent: true, captionAbsenceProof, controls: [{ icons: ["Like"] }, { icons: ["Comment"] }], media: { images: [], videos: [{ src: "blob:https://www.instagram.com/native-session-only" }] }, metrics }
    })
  };
  const fixture = await fixtureFiles({ evidence: [] }, { evidence: [row] });
  fixture.observedAt = nativeObservedAt;
  const flags = ["--include-batches=F26", "--scope-batch-dedupe", "--strict"];
  const defaultResult = runImporter(fixture, ...flags, "--dry-run");
  assert.notEqual(defaultResult.status, 0);
  assert.match(defaultResult.stdout, /captionless_native_history_requires_retention_opt_in/);
  const result = runImporter(fixture, ...flags, "--retain-zero-engagement", "--write");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const saved = JSON.parse(await readFile(fixture.target, "utf8")).evidence[0];
  assert.equal(saved.text, "");
  assert.equal(saved.originalText, "");
  assert.equal(saved.captionAbsent, true);
  assert.deepEqual(saved.metrics, metrics);
  assert.equal(saved.contributionScore, 0);
  assert.equal(saved.tractionStatus, "unscored");
  const raw = JSON.parse(row.rawVisibleText);
  raw.post.captionAbsenceProof.nativeTextSha256 = "0".repeat(64);
  await writeJson(fixture.input, { evidence: [{ ...row, rawVisibleText: JSON.stringify(raw) }] });
  const tampered = runImporter(fixture, ...flags, "--retain-zero-engagement", "--dry-run");
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.stdout, /caption_absence_requires_exact_native_review_receipt/);
});

test("LinkedIn image-only history preserves an empty caption under an exact native media receipt", async () => {
  const row = verifiedZeroLinkedInRow({ reactions: 8, comments: 6 });
  row.entityId = "company-redoubt-insurance";
  row.companySlug = "redoubt-insurance";
  row.companyName = "Redoubt Insurance";
  row.authorName = "Redoubt Insurance";
  row.accountUrl = "https://www.linkedin.com/company/redoubt-insurance/";
  row.platformPostId = "7527442953485766656";
  row.sourceUrl = `https://www.linkedin.com/feed/update/urn:li:activity:${row.platformPostId}/`;
  row.text = ""; row.originalText = ""; row.captionAbsent = true;
  const nativeObservation = {
    cardText: "Feed post\nRedoubt Insurance\n1d\nFollow\n8\n6",
    nativeEmbedPreview: {
      activityUrn: `urn:li:activity:${row.platformPostId}`,
      text: "Redoubt Insurance\n252 followers\n1d\nLinkedIn\n8\n6 Comments\nLike\nComment\nShare",
      links: [{ href: row.accountUrl, text: row.authorName }]
    },
    media: { images: [{ src: "https://media.licdn.com/native-image.jpg", alt: "View image" }] }
  };
  const post = {
    id: row.platformPostId, url: row.sourceUrl, text: "", captionAbsent: true,
    author: { name: row.authorName, profileUrl: row.accountUrl }, metrics: row.metrics,
    nativeObservation,
    captionAbsenceProof: {
      source: "authorized_native_linkedin_caption_absence_review_v1", review_state: "verified",
      platformPostId: row.platformPostId, observedAt: "2026-11-16T03:00:00.000Z",
      nativeObservationSha256: createHash("sha256").update(JSON.stringify(nativeObservation)).digest("hex")
    }
  };
  const raw = { source: "authorized_linkedin_browser_dom_v1", officialIdentitySourceUrl: "https://www.ycombinator.com/companies/redoubt-insurance", post };
  row.rawVisibleText = JSON.stringify(raw);
  const fixture = await fixtureFiles({ evidence: [] }, { evidence: [row] });
  const flags = ["--include-batches=F26", "--scope-batch-dedupe", "--strict"];
  const ordinary = runImporter(fixture, ...flags, "--dry-run");
  assert.notEqual(ordinary.status, 0);
  assert.match(ordinary.stdout, /captionless_native_history_requires_retention_opt_in/);
  const kept = runImporter(fixture, ...flags, "--retain-zero-engagement", "--write");
  assert.equal(kept.status, 0, kept.stderr || kept.stdout);
  const saved = JSON.parse(await readFile(fixture.target, "utf8")).evidence[0];
  assert.equal(saved.text, ""); assert.equal(saved.originalText, "");
  assert.deepEqual(saved.metrics, row.metrics); assert.equal(saved.contributionScore, 0);
  assert.equal(saved.tractionStatus, "unscored");
  nativeObservation.nativeEmbedPreview.text += "\nA caption that must not disappear.";
  post.captionAbsenceProof.nativeObservationSha256 = createHash("sha256").update(JSON.stringify(nativeObservation)).digest("hex");
  await writeJson(fixture.input, { evidence: [{ ...row, rawVisibleText: JSON.stringify(raw) }] });
  const caption = runImporter(fixture, ...flags, "--retain-zero-engagement", "--dry-run");
  assert.notEqual(caption.status, 0);
  assert.match(caption.stdout, /caption_absence_requires_exact_native_review_receipt/);
});

function verifiedZeroLinkedInRow(metrics) {
  const sourceUrl = "https://www.linkedin.com/feed/update/urn:li:activity:7518380931548606464/";
  const accountUrl = "https://www.linkedin.com/company/wondersearch";
  const text = "This is quite possibly the greatest age of exploration.";
  return {
    entityType: "company", entityId: "company-wondersearch", batchSlug: "F26",
    companySlug: "wondersearch", companyName: "Wondersearch", platform: "linkedin",
    platformPostId: "7518380931548606464", sourceUrl, accountUrl, authorName: "FlashDrive (YC F26)",
    text, originalText: text, postedAt: null, publishedAtPrecision: "unknown", metrics,
    review_state: "verified", attributionVersion: 3, attributionStatus: "verified",
    attributionSignals: ["official_yc_linked_company_account", "visible_native_linkedin_post", "visible_author_matches_official_company"],
    rawVisibleText: JSON.stringify({
      source: "authorized_linkedin_browser_dom_v1",
      officialIdentitySourceUrl: "https://www.ycombinator.com/companies/wondersearch",
      post: { id: "7518380931548606464", url: sourceUrl, text, author: { profileUrl: accountUrl }, metrics }
    })
  };
}

test("uses GitHub repository creation as publication and keeps pushes as activity metadata", async () => {
  const createdAt = "2024-10-05T21:50:44.000Z";
  const pushedAt = "2026-07-31T23:35:40.000Z";
  const updatedAt = "2026-08-01T00:35:40.000Z";
  const fixture = await fixtureFiles({ source: {}, evidence: [] }, {
    evidence: [{
      entityType: "company",
      entityId: "company-heyclicky",
      companyName: "HeyClicky",
      platform: "github",
      sourceUrl: "https://github.com/heyclicky/example",
      platformPostId: "heyclicky/example",
      postedAt: pushedAt,
      title: "heyclicky/example",
      metrics: { stars: 3, watchers: 3, forks: 0, issues: 0 },
      rawVisibleText: JSON.stringify({
        repository: { createdAt, pushedAt, updatedAt }
      }),
      review_state: "verified",
      matchReason: "Native repository on the verified company account."
    }]
  });

  const result = runImporter(fixture, "--strict", "--write");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const target = JSON.parse(await readFile(fixture.target, "utf8"));
  assert.equal(target.evidence[0].postedAt, createdAt);
  assert.equal(target.evidence[0].last_updated_at, updatedAt);
});

test("fails GitHub repository publication closed when native creation is unavailable", async () => {
  const pushedAt = "2026-07-31T23:35:40.000Z";
  const fixture = await fixtureFiles({ source: {}, evidence: [] }, {
    evidence: [{
      entityType: "company",
      entityId: "company-heyclicky",
      companyName: "HeyClicky",
      platform: "github",
      sourceUrl: "https://github.com/heyclicky/undated",
      platformPostId: "heyclicky/undated",
      postedAt: pushedAt,
      last_updated_at: pushedAt,
      title: "heyclicky/undated",
      metrics: { stars: 2, watchers: 2, forks: 0, issues: 0 },
      rawVisibleText: JSON.stringify({
        repository: { pushedAt }
      }),
      review_state: "verified",
      matchReason: "Native repository on the verified company account."
    }]
  });

  const result = runImporter(fixture, "--strict", "--write");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const target = JSON.parse(await readFile(fixture.target, "utf8"));
  assert.equal(target.evidence[0].postedAt, null);
  assert.equal(target.evidence[0].last_updated_at, pushedAt);
});

test("supports canonical GitHub creation provenance shapes and snake_case fields", async () => {
  const fixtures = [
    {
      repo: "direct-timestamps",
      createdAt: "2024-01-01T00:00:00.000Z",
      raw: { repositoryTimestamps: { created_at: "2024-01-01T00:00:00.000Z" } }
    },
    {
      repo: "nested-repo-timestamps",
      createdAt: "2024-02-01T00:00:00.000Z",
      raw: {
        repo: {
          full_name: "heyclicky/nested-repo-timestamps",
          repositoryTimestamps: { repository_created_at: "2024-02-01T00:00:00.000Z" }
        }
      }
    },
    {
      repo: "canonical-repository",
      createdAt: "2024-03-01T00:00:00.000Z",
      raw: {
        canonicalRepository: {
          fullName: "heyclicky/canonical-repository",
          repositoryCreatedAt: "2024-03-01T00:00:00.000Z"
        }
      }
    },
    {
      repo: "top-level-created",
      createdAt: "2024-04-01T00:00:00.000Z",
      raw: { repository_created_at: "2024-04-01T00:00:00.000Z" }
    },
    {
      repo: "post-activity",
      createdAt: "2024-05-01T00:00:00.000Z",
      raw: {
        post: {
          fullName: "heyclicky/post-activity",
          url: "https://github.com/heyclicky/post-activity",
          repositoryCreatedAt: "2024-05-01T00:00:00.000Z",
          pushed_at: "2026-07-30T00:00:00.000Z",
          updated_at: "2026-07-31T00:00:00.000Z"
        }
      }
    }
  ];
  const fixture = await fixtureFiles({ source: {}, evidence: [] }, {
    evidence: fixtures.map(({ repo, raw }) => ({
      entityType: "company",
      entityId: "company-heyclicky",
      companyName: "HeyClicky",
      platform: "github",
      sourceUrl: `https://github.com/heyclicky/${repo}`,
      platformPostId: `heyclicky/${repo}`,
      postedAt: "2026-07-31T23:35:40.000Z",
      title: `heyclicky/${repo}`,
      metrics: { stars: 2, watchers: 2, forks: 0, issues: 0 },
      rawVisibleText: JSON.stringify(raw),
      review_state: "verified",
      matchReason: "Native repository on the verified company account."
    }))
  });

  const result = runImporter(fixture, "--strict", "--write");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const target = JSON.parse(await readFile(fixture.target, "utf8"));
  assert.deepEqual(
    target.evidence.map((row) => [row.platformPostId, row.postedAt]).sort(),
    fixtures.map(({ repo, createdAt }) => [`heyclicky/${repo}`, createdAt]).sort()
  );
  const postActivity = target.evidence.find((row) => row.platformPostId === "heyclicky/post-activity");
  assert.equal(postActivity.last_updated_at, "2026-07-31T00:00:00.000Z");
});

test("does not treat a GitHub commit timestamp as repository publication", async () => {
  const commitAt = "2026-07-31T23:35:40.000Z";
  const cases = [
    {
      repo: "commit-kind",
      raw: {
        sourceProvenance: { kind: "github_commit" },
        post: {
          id: "heyclicky/commit-kind",
          url: "https://github.com/heyclicky/commit-kind",
          created_at: commitAt
        }
      }
    },
    {
      repo: "commit-url",
      raw: {
        sourceProvenance: {
          sourceUrl: "https://github.com/heyclicky/commit-url/commit/abcdef123456"
        },
        post: {
          fullName: "heyclicky/commit-url",
          url: "https://github.com/heyclicky/commit-url/commit/abcdef123456",
          created_at: commitAt
        }
      }
    }
  ];
  const fixture = await fixtureFiles({ source: {}, evidence: [] }, {
    evidence: cases.map(({ repo, raw }) => ({
      entityType: "company",
      entityId: "company-heyclicky",
      companyName: "HeyClicky",
      platform: "github",
      sourceUrl: `https://github.com/heyclicky/${repo}`,
      platformPostId: `heyclicky/${repo}`,
      postedAt: commitAt,
      title: `heyclicky/${repo}`,
      metrics: { stars: 2, watchers: 2, forks: 0, issues: 0 },
      rawVisibleText: JSON.stringify(raw),
      review_state: "verified",
      matchReason: "Commit-derived repository evidence."
    }))
  });

  const result = runImporter(fixture, "--strict", "--write");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const target = JSON.parse(await readFile(fixture.target, "utf8"));
  assert.equal(target.evidence.length, cases.length);
  assert.ok(target.evidence.every((row) => row.postedAt === null));
});

test("strict mode rejects profile pages and leaves the target untouched", async () => {
  const initial = { source: { label: "fixture" }, evidence: [] };
  const fixture = await fixtureFiles(initial, {
    evidence: [{
      entityType: "company",
      entityId: "company-heyclicky",
      companyName: "HeyClicky",
      platform: "product_hunt",
      sourceUrl: "https://www.producthunt.com/products/heyclicky",
      platformPostId: "heyclicky",
      title: "Product profile",
      metrics: { upvotes: 100 },
      review_state: "verified"
    }]
  });

  const result = runImporter(fixture, "--strict", "--write");
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /not_native_activity_url/);
  assert.deepEqual(JSON.parse(await readFile(fixture.target, "utf8")), initial);
});

test("duplicate refreshes replace a complete observation instead of merging metric maxima", async () => {
  const existing = evidenceRow({
    metrics: { views: 100, likes: 10 },
    last_checked_at: "2026-07-18T00:00:00.000Z"
  });
  const fixture = await fixtureFiles({ source: {}, evidence: [existing] }, {
    evidence: [evidenceRow({
      metrics: { likes: 12 },
      last_checked_at: observedAt
    })]
  });

  const result = runImporter(fixture, "--strict", "--write");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const target = JSON.parse(await readFile(fixture.target, "utf8"));
  assert.deepEqual(target.evidence[0].metrics, { views: 100, likes: 10 });
});

test("normalizes X metric aliases and preserves the native top-voice author", async () => {
  const fixture = await fixtureFiles({ source: {}, evidence: [] }, {
    evidence: [{
      id: "top-voice",
      entityType: "company",
      entityId: "company-heyclicky",
      companyName: "HeyClicky",
      platform: "x",
      sourceUrl: "https://x.com/snowmaker/status/2078326722500681788",
      platformPostId: "2078326722500681788",
      title: "Jared replies to a founder",
      rawVisibleText: JSON.stringify({
        profile: { name: "Jared Friedman", username: "snowmaker" },
        post: { authorName: "Jared Friedman", authorHandle: "snowmaker" }
      }),
      metrics: {
        views: 3193,
        likes: 8,
        comments: 3,
        replies: 3,
        retweets: 0,
        reposts: 0,
        saves: 1
      },
      review_state: "verified"
    }]
  });

  const result = runImporter(fixture, "--strict", "--write");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const target = JSON.parse(await readFile(fixture.target, "utf8"));
  assert.equal(target.evidence[0].authorName, "Jared Friedman");
  assert.equal(target.evidence[0].authorHandle, "snowmaker");
  assert.deepEqual(target.evidence[0].metrics, {
    views: 3193,
    likes: 8,
    replies: 3,
    reposts: 0,
    bookmarks: 1
  });
});

test("rejects evidence attached only to an obsolete roster slug", async () => {
  const stale = evidenceRow({
    entityId: "founder-blueprints-bence-redmond-2614746",
    companyName: "Blueprints",
    sourceUrl: "https://x.com/bence/status/2077807978280083612"
  });
  const fixture = await fixtureFiles({ source: {}, evidence: [stale] }, { evidence: [stale] });

  const result = runImporter(fixture, "--strict", "--write");
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /unknown_entity/);
});

test("imports only explicitly included batches from a mixed source-hunt artifact", async () => {
  const ycRow = {
    ...evidenceRow(),
    batchSlug: "S2026"
  };
  const a16zRow = {
    ...evidenceRow({
      id: "a16z-youtube-post",
      entityId: "a16z-speedrun-006-oasis",
      companyName: "Oasis",
      platform: "youtube",
      sourceUrl: "https://www.youtube.com/watch?v=AbCdEf12345",
      platformPostId: "AbCdEf12345",
      metrics: { views: 42 }
    }),
    batchSlug: "A16ZSR006"
  };
  const fixture = await fixtureFiles({ source: {}, evidence: [] }, { evidence: [ycRow, a16zRow] });

  const result = runImporter(fixture, "--include-batches=S2026,S26", "--strict", "--write");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const target = JSON.parse(await readFile(fixture.target, "utf8"));
  assert.equal(target.evidence.length, 1);
  assert.equal(target.evidence[0].entityId, "company-heyclicky");
  assert.match(result.stdout, /"skipped": 1/);
});

test("target=a16z writes seeded-social company and founder rows atomically", async () => {
  const fixture = await a16zFixture({ source: { generatedAt: "2026-07-18T00:00:00Z" }, evidence: [] }, {
    evidence: [
      a16zEvidenceRow(),
      a16zEvidenceRow({
        id: "oasis-founder-x-post",
        entityType: "founder",
        entityId: "a16z-speedrun-006-oasis-founder-stefano-fantini-delmanto",
        founderName: "Stefano Fantini Delmanto",
        platform: "x",
        sourceUrl: "https://x.com/stedelmanto/status/2078180286441955781",
        platformPostId: "2078180286441955781",
        authorName: "Stefano Fantini Delmanto",
        authorHandle: "stedelmanto",
        accountUrl: "https://x.com/stedelmanto",
        metrics: { views: 80, likes: 3 },
        mediaType: "text"
      })
    ]
  });

  const result = runA16zImporter(fixture, "--strict", "--write");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const target = JSON.parse(await readFile(fixture.target, "utf8"));
  assert.equal(target.source.generatedAt, observedAt);
  assert.equal(target.source.evidenceCount, 2);
  assert.deepEqual(target.evidence.map((row) => row.entityType).sort(), ["company", "founder"]);
  const founder = target.evidence.find((row) => row.entityType === "founder");
  assert.equal(founder.companySlug, "oasis");
  assert.equal(founder.companyName, "Oasis");
  assert.equal(founder.founderName, "Stefano Fantini Delmanto");
  assert.equal(founder.platformPostId, "2078180286441955781");
  assert.ok(target.evidence.every((row) => !("entityId" in row) && !("id" in row)));
  assert.deepEqual((await readdir(dirname(fixture.target))).filter((name) => name.endsWith(".tmp")), []);
});

test("target=a16z preserves mixed-batch filtering before entity validation", async () => {
  const fixture = await a16zFixture({ source: {}, evidence: [] }, {
    evidence: [
      a16zEvidenceRow(),
      {
        ...evidenceRow({ entityId: "company-not-in-a16z" }),
        batchSlug: "S2026"
      }
    ]
  });

  const result = runA16zImporter(fixture, "--include-batches=A16ZSR006", "--strict", "--write");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const target = JSON.parse(await readFile(fixture.target, "utf8"));
  assert.equal(target.evidence.length, 1);
  assert.equal(target.evidence[0].companySlug, "oasis");
  assert.match(result.stdout, /"skipped": 1/);
  assert.match(result.stdout, /"rejected": 0/);
});

test("target=a16z rejects unknown and conflicting current entity attribution", async () => {
  const initial = { source: { label: "fixture" }, evidence: [] };
  const fixture = await a16zFixture(initial, {
    evidence: [
      a16zEvidenceRow({ entityId: "a16z-speedrun-006-unknown-company" }),
      a16zEvidenceRow({
        entityType: "founder",
        entityId: "a16z-speedrun-006-oasis-founder-stefano-fantini-delmanto",
        founderName: "Someone Else"
      })
    ]
  });

  const result = runA16zImporter(fixture, "--strict", "--write");
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /unknown_entity/);
  assert.match(result.stdout, /founder_name_conflict/);
  assert.deepEqual(JSON.parse(await readFile(fixture.target, "utf8")), initial);
});

test("target=a16z rejects profiles, conflicting native IDs, and unsupported metrics without writing", async () => {
  const initial = { source: { label: "fixture" }, evidence: [] };
  const fixture = await a16zFixture(initial, {
    evidence: [
      a16zEvidenceRow({
        sourceUrl: "https://www.youtube.com/@oasis",
        platformPostId: "oasis"
      }),
      a16zEvidenceRow({ platformPostId: "WrongVideoId" }),
      a16zEvidenceRow({
        sourceUrl: "https://www.youtube.com/watch?v=ZeroMetric1",
        platformPostId: "ZeroMetric1",
        metrics: { views: 0, followers: 100 }
      })
    ]
  });

  const result = runA16zImporter(fixture, "--strict", "--write");
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /not_native_activity_url/);
  assert.match(result.stdout, /native_id_conflict/);
  assert.match(result.stdout, /no_visible_positive_scoring_metrics/);
  assert.match(result.stdout, /unsupported_metrics:followers/);
  assert.deepEqual(JSON.parse(await readFile(fixture.target, "utf8")), initial);
});

test("target=a16z treats an existing seeded item as a duplicate", async () => {
  const existing = a16zSeededRow();
  const fixture = await a16zFixture({ source: {}, evidence: [existing] }, {
    evidence: [a16zEvidenceRow()]
  });

  const result = runA16zImporter(fixture, "--strict", "--write");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const target = JSON.parse(await readFile(fixture.target, "utf8"));
  assert.equal(target.evidence.length, 1);
  assert.equal(target.evidence[0].sourceUrl, existing.sourceUrl);
  assert.match(result.stdout, /"accepted": 0/);
  assert.match(result.stdout, /"duplicates": 1/);
});

test("target=a16z dedupes repositories from every canonical GitHub snapshot", async () => {
  for (const githubFile of [
    "github-traction.json",
    "github-traction-summer-2026.json",
    "github-traction-a16z-speedrun-006.json"
  ]) {
    const repositoryUrl = `https://github.com/withoasis/${githubFile.replace(/\.json$/, "")}`;
    const fixture = await a16zFixture({ source: {}, evidence: [] }, {
      evidence: [a16zEvidenceRow({
        id: `repo-${githubFile}`,
        platform: "github",
        sourceUrl: repositoryUrl,
        platformPostId: `withoasis/${githubFile.replace(/\.json$/, "")}`,
        accountUrl: "https://github.com/withoasis",
        metrics: { stars: 12, forks: 2 },
        mediaType: "repo",
        rawVisibleText: JSON.stringify({
          repository: {
            fullName: `withoasis/${githubFile.replace(/\.json$/, "")}`,
            createdAt: "2026-07-18T10:17:43Z"
          }
        })
      })]
    }, {
      [githubFile]: {
        source: {},
        accounts: [{
          entityType: "company",
          entityId: "a16z-speedrun-006-oasis",
          repos: [{
            htmlUrl: repositoryUrl,
            fullName: `withoasis/${githubFile.replace(/\.json$/, "")}`
          }]
        }]
      }
    });

    const result = runA16zImporter(fixture, "--strict", "--write");
    assert.equal(result.status, 0, `${githubFile}: ${result.stderr || result.stdout}`);
    const target = JSON.parse(await readFile(fixture.target, "utf8"));
    assert.equal(target.evidence.length, 0, githubFile);
    assert.match(result.stdout, /"accepted": 0/);
    assert.match(result.stdout, /"duplicates": 1/);
  }
});

test("dedupes Daniela's exact legacy profile-fragment body from every canonical evidence snapshot", async () => {
  for (const evidenceFile of canonicalEvidenceFiles) {
    const fixture = await fixtureFiles(
      { source: {}, evidence: [] },
      { evidence: [danielaNativeRow()] },
      {
        [evidenceFile]: {
          source: {},
          evidence: [danielaLegacyRow()]
        }
      }
    );

    const result = runImporter(fixture, "--strict", "--dry-run");
    assert.equal(result.status, 0, `${evidenceFile}: ${result.stderr || result.stdout}`);
    const audit = JSON.parse(result.stdout);
    assert.equal(audit.accepted, 0, evidenceFile);
    assert.equal(audit.duplicates, 1, evidenceFile);
    assert.equal(audit.duplicateRows[0].duplicateReason, "same_platform_author_substantive_body");
    assert.equal(
      audit.duplicateRows[0].existingSource,
      `src/lib/social/${evidenceFile}#evidence[0]`
    );
    assert.equal(audit.duplicateRows[0].existingId, danielaLegacyRow().id);
    assert.equal(audit.duplicateRows[0].incomingPublishedAt, "2026-06-29T21:01:51.402Z");
    assert.equal(audit.duplicateRows[0].incomingPublicationPrecision, "instant");
    assert.equal(audit.duplicateRows[0].existingPublishedAt, null);
    assert.equal(audit.duplicateRows[0].existingPublicationPrecision, null);
    assert.match(audit.duplicateRows[0].contentBodySha256, /^[0-9a-f]{64}$/);
  }
});

test("exact-content guard rejects fuzzy author, body, and publication-time matches", async (t) => {
  const cases = [
    {
      name: "same body with a different author",
      existing: danielaLegacyRow({ authorName: "Daniela Muñoz" }),
      incoming: danielaNativeRow({ authorName: "Daniela Muñoz Jr." })
    },
    {
      name: "same author with a near-miss body",
      existing: danielaLegacyRow({ authorName: "Daniela Muñoz" }),
      incoming: danielaNativeRow({ text: `${danielaBody}Materially different ending.` })
    },
    {
      name: "same author and body published at a different known time",
      existing: danielaLegacyRow({ authorName: "Daniela Muñoz", postedAt: "2026-06-29T20:01:51.402Z" }),
      incoming: danielaNativeRow({ postedAt: "2026-06-29T21:01:51.402Z" })
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const fixture = await fixtureFiles(
        { source: {}, evidence: [] },
        { evidence: [testCase.incoming] },
        {
          "logged-in-evidence-current.json": {
            source: {},
            evidence: [testCase.existing]
          }
        }
      );

      const result = runImporter(fixture, "--strict", "--dry-run");
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const audit = JSON.parse(result.stdout);
      assert.equal(audit.accepted, 1);
      assert.equal(audit.duplicates, 0);
    });
  }
});

test("exact-content guard preserves valid multi-entity attribution", async () => {
  const shared = {
    platform: "linkedin",
    sourceUrl: "https://www.linkedin.com/posts/activity-7999999999999999901-fixture",
    platformPostId: "7999999999999999901",
    authorName: "Verified Shared Author",
    postedAt: "2026-06-12T16:00:21.775Z",
    metrics: { reactions: 37, comments: 2, reposts: 4 },
    review_state: "verified",
    title: "Two-company fixture",
    text: "This exact native post explicitly and substantively names two separate companies, so each verified entity attribution must remain independently importable.",
    matchReason: "Native LinkedIn post explicitly names the attributed company."
  };
  const fixture = await fixtureFiles({ source: {}, evidence: [] }, {
    evidence: [
      {
        ...shared,
        entityType: "company",
        entityId: "company-eden-robotics",
        companyName: "Eden Robotics"
      },
      {
        ...shared,
        entityType: "company",
        entityId: "company-9-mothers-corporation",
        companyName: "9 Mothers"
      }
    ]
  });

  const result = runImporter(fixture, "--strict", "--dry-run");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const audit = JSON.parse(result.stdout);
  assert.equal(audit.accepted, 2);
  assert.equal(audit.duplicates, 0);
});

function evidenceRow(overrides = {}) {
  return {
    id: "existing-x-post",
    entityType: "company",
    entityId: "company-heyclicky",
    companyName: "HeyClicky",
    platform: "x",
    sourceUrl: "https://x.com/heyclicky/status/2077807978280083612",
    platformPostId: "2077807978280083612",
    title: "HeyClicky feature going viral",
    text: "HeyClicky feature going viral",
    rawVisibleText: "{}",
    postedAt: "2026-07-16",
    metrics: { views: 100, likes: 10 },
    contributionScore: 1,
    review_state: "verified",
    matchReason: "Native company post.",
    first_seen_at: "2026-07-18T00:00:00.000Z",
    last_checked_at: "2026-07-18T00:00:00.000Z",
    last_updated_at: "2026-07-16",
    ...overrides
  };
}

function a16zEvidenceRow(overrides = {}) {
  return {
    id: "youtube-a16zsr006-oasis-video",
    entityType: "company",
    entityId: "a16z-speedrun-006-oasis",
    companyName: "Oasis",
    companySlug: "oasis",
    batchSlug: "A16ZSR006",
    platform: "youtube",
    sourceUrl: "https://www.youtube.com/watch?v=Oasis123456",
    platformPostId: "Oasis123456",
    authorName: "Oasis",
    authorHandle: "oasis",
    accountUrl: "https://www.youtube.com/@oasis",
    postedAt: "2026-07-18T10:17:43Z",
    title: "Oasis product demo",
    text: "Oasis published a native product demo.",
    metrics: { views: 42, likes: 3 },
    contributionScore: 1,
    review_state: "verified",
    matchReason: "The native item belongs to the verified Oasis company account.",
    first_seen_at: observedAt,
    last_checked_at: observedAt,
    last_updated_at: "2026-07-18T10:17:43Z",
    ...overrides
  };
}

function a16zSeededRow(overrides = {}) {
  const source = a16zEvidenceRow();
  return {
    companySlug: source.companySlug,
    companyName: source.companyName,
    entityType: source.entityType,
    platform: source.platform,
    sourceUrl: source.sourceUrl,
    platformPostId: source.platformPostId,
    accountUrl: source.accountUrl,
    authorName: source.authorName,
    authorHandle: source.authorHandle,
    postedAt: source.postedAt,
    title: source.title,
    text: source.text,
    mediaType: "video",
    metrics: source.metrics,
    matchReason: source.matchReason,
    why: "Existing verified seed row.",
    review_state: "verified",
    ...overrides
  };
}

function danielaLegacyRow(overrides = {}) {
  return {
    id: "linkedin-founder-lemonlime-daniela-profile-post-3",
    entityType: "founder",
    entityId: "founder-lemonlime-daniela-mu-oz-3671976",
    companySlug: "lemonlime",
    companyName: "LemonLime",
    platform: "linkedin",
    title: "Daniela Muñoz LinkedIn post",
    sourceUrl: "https://www.linkedin.com/in/danielamunoz12/recent-activity/all/#post-3",
    platformPostId: null,
    text: danielaBody,
    rawVisibleText: `Feed post number 3 Daniela Muñoz Daniela Muñoz Follow ${danielaBody}`,
    postedAt: null,
    metrics: { likes: 62, comments: 13, reposts: 2 },
    review_state: "verified",
    matchReason: "Opt-in logged-in LinkedIn activity-page original post scrape from founder URL.",
    ...overrides
  };
}

function danielaNativeRow(overrides = {}) {
  return {
    entityType: "founder",
    entityId: "founder-lemonlime-daniela-mu-oz-3671976",
    companyName: "LemonLime",
    platform: "linkedin",
    sourceUrl: "https://www.linkedin.com/posts/activity-7477466387674816515-885Q",
    platformPostId: "7477466387674816515",
    authorName: "Daniela Muñoz",
    postedAt: "2026-06-29T21:01:51.402Z",
    title: "I have never been this excited about anything.",
    text: danielaBody,
    metrics: { reactions: 70, comments: 14 },
    review_state: "verified",
    matchReason: "Native LinkedIn JSON-LD exposes the exact founder, body, date, and visible metrics.",
    ...overrides
  };
}

async function fixtureFiles(targetValue, inputValue, evidenceOverrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "returner-source-import-"));
  const socialDirectory = join(directory, "src/lib/social");
  await mkdir(socialDirectory, { recursive: true });

  const target = join(directory, "target.json");
  const input = join(directory, "input.json");
  await writeJson(target, targetValue);
  await writeJson(input, inputValue);
  for (const file of [
    "a16z-speedrun-006-social-evidence.json",
    "public-evidence-current.json",
    "logged-in-evidence-current.json",
    "targeted-evidence-current.json"
  ]) {
    await writeJson(
      join(socialDirectory, file),
      evidenceOverrides[file] ?? { source: {}, evidence: [] }
    );
  }
  for (const file of [
    "github-traction.json",
    "github-traction-summer-2026.json",
    "github-traction-a16z-speedrun-006.json"
  ]) {
    await writeJson(join(socialDirectory, file), { source: {}, accounts: [] });
  }
  return { directory, target, input };
}

async function a16zFixture(targetValue, inputValue, githubOverrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "returner-a16z-source-import-"));
  const socialDirectory = join(directory, "src/lib/social");
  await mkdir(socialDirectory, { recursive: true });

  const target = join(socialDirectory, "a16z-speedrun-006-social-evidence.json");
  const input = join(directory, "input.json");
  const accountSnapshot = await readFile(
    resolve(root, "src/lib/social/a16z-speedrun-006-social-accounts.json"),
    "utf8"
  );
  await writeFile(join(socialDirectory, "a16z-speedrun-006-social-accounts.json"), accountSnapshot);
  await writeJson(target, targetValue);
  await writeJson(input, inputValue);

  for (const file of [
    "public-evidence-current.json",
    "logged-in-evidence-current.json",
    "targeted-evidence-current.json"
  ]) {
    await writeJson(join(socialDirectory, file), { source: {}, evidence: [] });
  }
  for (const file of [
    "github-traction.json",
    "github-traction-summer-2026.json",
    "github-traction-a16z-speedrun-006.json"
  ]) {
    await writeJson(join(socialDirectory, file), githubOverrides[file] ?? { source: {}, accounts: [] });
  }

  return { directory, target, input };
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function runImporter(fixture, ...mode) {
  return spawnSync(process.execPath, [
    importer,
    `--input=${fixture.input}`,
    `--target=${fixture.target}`,
    `--observed-at=${fixture.observedAt ?? observedAt}`,
    `--external-evidence-root=${fixture.directory}`,
    ...mode
  ], { cwd: root, encoding: "utf8" });
}

function runA16zImporter(fixture, ...mode) {
  return spawnSync(process.execPath, [
    importer,
    `--input=${fixture.input}`,
    "--target=a16z",
    `--observed-at=${observedAt}`,
    `--external-evidence-root=${fixture.directory}`,
    ...mode
  ], { cwd: fixture.directory, encoding: "utf8" });
}
