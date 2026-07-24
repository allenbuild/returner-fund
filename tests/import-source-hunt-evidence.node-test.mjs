import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

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
        mediaType: "repo"
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
    `--observed-at=${observedAt}`,
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
