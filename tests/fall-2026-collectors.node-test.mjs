import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  AUTONOMOUS_BATCHES,
  AUTONOMOUS_PLATFORMS,
  YC_FALL_2026_BATCH,
  buildAutonomousTaskPlan,
  loadAutonomousCatalogs,
  normalizeVerifiedSocialOverrideLinks
} from "../scripts/lib/autonomous-ingestion-plan.mjs";
import {
  conflictingOrganizationBatchMarker,
  containsControlledCompanyBrandVariant,
  isListOrRoundupAttributionContext,
  organizationQualifiedBatchMarker,
  organizationQualifiedBatchMarkerCount,
  assessYouTubeSearchAttribution,
  publicEvidenceAttributionText
} from "../scripts/lib/public-evidence-attribution.mjs";

const snapshot = {
  source: {
    label: "YC Fall 2026 (F26)",
    directoryUrl: "https://www.ycombinator.com/companies?batch=Fall%202026",
    expectedCompanyCount: 1,
    observedCompanyCount: 1
  },
  companies: [{
    id: 123,
    slug: "fall-fixture",
    name: "Fall Fixture",
    batch: "Fall 2026",
    ycProfileUrl: "https://www.ycombinator.com/companies/fall-fixture",
    websiteUrl: "https://fall-fixture.example",
    socialLinks: { github: "https://github.com/fall-fixture", x: "https://x.com/fallfixture" },
    founders: [{ id: 456, name: "Fall Founder", socialLinks: { x: "https://x.com/fallfounder" } }]
  }]
};

test("Fall markers retain cohort context without accepting other batches or roundup lists", () => {
  for (const marker of ["YC F26", "YC F2026", "Y Combinator Fall 2026"]) {
    assert.equal(organizationQualifiedBatchMarker("F26", marker), true);
    assert.equal(organizationQualifiedBatchMarkerCount("F26", `${marker} and ${marker}`), 2);
    assert.equal(conflictingOrganizationBatchMarker("S26", marker), true);
    assert.equal(conflictingOrganizationBatchMarker("S2026", marker), true);
  }
  assert.equal(organizationQualifiedBatchMarker("F26", "YC S26"), false);
  assert.equal(conflictingOrganizationBatchMarker("F26", "YC Spring 2026"), true);
  assert.equal(containsControlledCompanyBrandVariant("Fixture (YC F26)", "Fixture AI"), true);
  assert.equal(isListOrRoundupAttributionContext("F26", "Example (YC F26) ".repeat(8)), true);
  assert.match(publicEvidenceAttributionText({
    title: "Fixture launch | YC Fall 2026 | LinkedIn",
    text: ""
  }), /YC Fall 2026/);
});

test("generic YouTube channel names cannot independently verify a company", () => {
  for (const [companyName, text] of [
    ["River", "The River Church - Sunday Morning 10/25/2026"],
    ["Caveman", "2026 - 5th Caveman Invite Video"],
    ["Spine", "Spinefest 2026 Full Event"],
    ["Quippy", "Keeping Quippy alive until demo day"]
  ]) {
    const result = assessYouTubeSearchAttribution({
      batchSlug: "F26", companyName, text, signals: ["native_channel_brand"]
    });
    assert.equal(result.verified, false, companyName);
  }
  assert.equal(assessYouTubeSearchAttribution({
    batchSlug: "F26", companyName: "River", text: "River YC F26 launch", signals: ["native_channel_brand"]
  }).verified, true);
});

test("generic YouTube search requires an exact watch receipt with native publication date", async (t) => {
  const root = await fixture(t);
  const catalogPath = join(root, YC_FALL_2026_BATCH.catalogFile);
  await writeFile(catalogPath, JSON.stringify({
    ...snapshot,
    companies: [{ ...snapshot.companies[0], name: "River", socialLinks: {}, founders: [] }]
  }));
  for (const caseData of [
    { name: "church", title: "The River Church Sunday Morning", channel: "The River Church", date: "2026-10-25", accepted: false },
    { name: "undated", title: "River YC F26 launch", channel: "River", date: null, accepted: false },
    { name: "wrong-id", title: "River YC F26 launch", channel: "River", date: "2026-10-25", nativeVideoId: "differentvideo", accepted: false },
    { name: "native", title: "River YC F26 launch", channel: "River", date: "2026-10-25", accepted: true }
  ]) {
    const preload = join(root, `${caseData.name}-mock.mjs`);
    const output = join(root, `${caseData.name}-output.json`);
    await writeFile(preload, `import dns from "node:dns";
dns.lookup = (_host, options, callback) => {
  if(typeof options === "function") {callback=options;options={};}
  if(options?.all) callback(null,[{address:"93.184.216.34",family:4}]);
  else callback(null,"93.184.216.34",4);
};
const fixture=${JSON.stringify(caseData)};
globalThis.fetch = async (url) => {
  if(String(url).includes("youtube.com/results?")) return new Response(JSON.stringify({videoId:"nativevideo",title:{runs:[{text:fixture.title}]},viewCountText:{simpleText:"100 views"},ownerText:{runs:[{text:fixture.channel}]},browseEndpoint:{browseId:"UCfixture"}}));
  if(String(url).includes("youtube.com/watch?")) return new Response(JSON.stringify({videoDetails:{videoId:fixture.nativeVideoId??"nativevideo",title:fixture.title,shortDescription:fixture.title,channelId:"UCfixture",author:fixture.channel,viewCount:"100"},...(fixture.date?{publishDate:fixture.date}:{})}));
  return new Response("<html></html>");
};`);
    const result = spawnSync(process.execPath, [
      resolve("scripts/fetch-public-traction.mjs"), `--catalog-root=${root}`, "--batch=F26", "--platforms=youtube", "--social=none", "--delay-ms=0", "--workers=1",
      `--output=${output}`, `--checkpoint=${join(root, `${caseData.name}-checkpoint.json`)}`,
      `--discovery-attempts=${join(root, `${caseData.name}-discovery.json`)}`,
      `--source-discovery-paths=${join(root, `${caseData.name}-paths.json`)}`
    ], { cwd: root, encoding: "utf8", timeout: 15_000, env: { ...process.env, NODE_OPTIONS: `--import=${preload}` } });
    assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(await readFile(output, "utf8"));
    assert.equal(data.evidence.length, caseData.accepted ? 1 : 0, caseData.name);
    if (caseData.accepted) assert.equal(data.evidence[0].postedAt, "2026-10-25");
    else assert.ok(data.needsReview.some((row) => row.platformPostId === "nativevideo"));
  }
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "fall-collector-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {
    "package.json": { private: true },
    "src/lib/yc/fall-2026-companies.json": snapshot,
    "src/lib/yc/summer-2026-company-aliases.json": { version: 2, aliases: [] },
    "src/lib/social/verified-social-overrides.json": {},
    "src/lib/social/public-evidence-current.json": { evidence: [], needsReview: [], failures: [] }
  };
  await Promise.all(Object.entries(files).map(async ([name, value]) => {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(value)}\n`);
  }));
  return root;
}

test("Fall catalog can be explicitly loaded with exact owner IDs", async (t) => {
  const root = await fixture(t);
  const catalogs = await loadAutonomousCatalogs(root, { batches: [YC_FALL_2026_BATCH] });
  assert.deepEqual(AUTONOMOUS_BATCHES.map((batch) => batch.slug), ["S2026", "S26", "A16ZSR006"]);
  assert.equal(catalogs[0].slug, "F26");
  assert.equal(catalogs[0].expectedCompanyCount, 1);
  assert.equal(catalogs[0].expectedFounderCount, 1);
  assert.equal(catalogs[0].companies[0].sourceKey, "company-fall-fixture");
  assert.equal(catalogs[0].companies[0].founders[0].sourceKey, "founder-fall-fixture-fall-founder-456");
});

test("Fall catalog refuses a company from another cohort", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, YC_FALL_2026_BATCH.catalogFile), JSON.stringify({
    ...snapshot,
    companies: [{ ...snapshot.companies[0], batch: "Summer 2026" }]
  }));
  await assert.rejects(loadAutonomousCatalogs(root, { batches: [YC_FALL_2026_BATCH] }), /expected Fall 2026/);
});

test("Fall publication-only owner identities remain metadata without enabling collectors", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "src/lib/social/verified-social-overrides.json"), JSON.stringify({
    "fall-fixture": {
      companySocialLinks: {
        facebook: "https://www.facebook.com/people/Rhem-Labs/61589516291255",
        tiktok: "https://www.tiktok.com/@trepozach"
      },
      founders: [{ id: 456, name: "Fall Founder", socialLinks: { threads: "https://www.threads.com/@sirsho29" } }]
    }
  }));
  const catalogs = await loadAutonomousCatalogs(root, { batches: [YC_FALL_2026_BATCH] });
  const company = catalogs[0].companies[0];
  assert.ok(company.accounts.some((account) => account.platform === "facebook" && account.url.endsWith("/61589516291255")));
  assert.ok(company.accounts.some((account) => account.platform === "tiktok" && account.url.endsWith("/@trepozach")));
  assert.ok(company.founders[0].accounts.some((account) => account.platform === "threads" && account.url.endsWith("/@sirsho29")));
  const tasks = buildAutonomousTaskPlan(catalogs, { runKey: "fixture" });
  assert.equal(AUTONOMOUS_PLATFORMS.includes("threads"), false);
  assert.equal(AUTONOMOUS_PLATFORMS.includes("facebook"), false);
  assert.equal(tasks.some((task) => ["threads", "facebook"].includes(task.platform)), false);
  assert.ok(tasks.filter((task) => task.platform === "tiktok").every((task) => task.status === "skipped" && task.terminalReason === "collector_not_available"));
  for (const links of [
    { threads: "https://www.threads.com/@sirsho29/post/AbCd" },
    { threads: "https://www.threads.com.evil.example/@sirsho29" },
    { facebook: "https://www.facebook.com/covera.agents/posts/123" },
    { facebook: "https://user:secret@www.facebook.com/covera.agents" },
    { tiktok: "https://www.tiktok.com/@trepozach/video/123" },
    { unsupported: "https://example.com/account" }
  ]) assert.throws(() => normalizeVerifiedSocialOverrideLinks(links), /unsupported platform|does not match/);
});

test("public and GitHub plans accept Fall aliases without writing or collecting", async (t) => {
  const root = await fixture(t);
  const evidencePath = join(root, "src/lib/social/public-evidence-current.json");
  const before = await readFile(evidencePath, "utf8");
  for (const alias of ["F26", "F2026", "YC Fall 2026"]) {
    for (const script of ["fetch-public-traction.mjs", "fetch-github-traction.mjs"]) {
      const result = spawnSync(process.execPath, [
        resolve("scripts", script), `--catalog-root=${root}`, `--batch=${alias}`, "--plan", "--social=all"
      ], { cwd: root, encoding: "utf8", timeout: 15_000 });
      assert.equal(result.status, 0, result.stderr);
      const plan = JSON.parse(result.stdout);
      assert.equal(plan.batchSlug, "F26");
      assert.equal(plan.companyCount, 1);
      if (script === "fetch-github-traction.mjs") {
        assert.equal(plan.targets[0].entityId, "company-fall-fixture");
      } else {
        assert.equal(plan.founderCount, 1);
        assert.equal(plan.socialTargets.filter((target) => target.platform === "x").length, 2);
      }
    }
  }
  assert.equal(await readFile(evidencePath, "utf8"), before);
});
