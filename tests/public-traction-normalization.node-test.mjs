import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadAutonomousCatalogs } from "../scripts/lib/autonomous-ingestion-plan.mjs";
import {
  PUBLIC_EVIDENCE_ARTIFACT_MAX_BYTES,
  PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_MAX_BYTES,
  PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_PATH,
  assertPublicEvidenceArtifactSize,
  serializeCompactPublicEvidenceArtifact
} from "../scripts/lib/public-evidence-artifact.mjs";
import { canonicalSocialAccountUrl } from "../scripts/lib/social-account-url.mjs";

const root = process.cwd();

test("public lane pools share one process-wide task concurrency guard", async () => {
  const collector = await readFile(join(root, "scripts", "fetch-public-traction.mjs"), "utf8");
  assert.match(collector, /const MAX_PUBLIC_TASK_WORKERS = 16/);
  assert.match(collector, /const publicTaskConcurrencyGuard = createConcurrencyGuard\(workerCount\)/);
  assert.match(collector, /await publicTaskConcurrencyGuard\(async \(\) =>/);
  assert.match(collector, /taskConcurrencyCap: workerCount/);
});

function assertWellFormedStrings(value, path = "$") {
  if (typeof value === "string") {
    for (let index = 0; index < value.length; index += 1) {
      const codeUnit = value.charCodeAt(index);
      if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
        const next = value.charCodeAt(index + 1);
        assert.ok(
          next >= 0xDC00 && next <= 0xDFFF,
          `${path} contains an unpaired high surrogate at code-unit offset ${index}`
        );
        index += 1;
      } else {
        assert.ok(
          codeUnit < 0xDC00 || codeUnit > 0xDFFF,
          `${path} contains an unpaired low surrogate at code-unit offset ${index}`
        );
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertWellFormedStrings(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    assertWellFormedStrings(key, `${path}.<key>`);
    assertWellFormedStrings(item, `${path}.${key}`);
  }
}

function assertJqParsesIfAvailable(path) {
  try {
    execFileSync("jq", ["empty", path], { stdio: "pipe" });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}

test("compact public evidence serialization is deterministic and preserves every semantic field", () => {
  const fixture = {
    source: { evidenceCount: 1, failureCount: 1 },
    evidence: [{
      id: "evidence-1",
      entityId: "company-example",
      text: "Whitespace inside evidence text stays exact:  a  b\nline two",
      rawVisibleText: JSON.stringify({ post: { id: "native-1", text: "raw  body" } }),
      postedAt: "2026-08-02T12:00:00.000Z",
      metrics: { views: 12, comments: 3 },
      attribution: { entityType: "company", entityId: "company-example" }
    }],
    needsReview: [],
    failures: [{ id: "failure-1", message: "blocked", checkedAt: "2026-08-02T12:01:00.000Z" }]
  };

  const first = serializeCompactPublicEvidenceArtifact(fixture);
  const second = serializeCompactPublicEvidenceArtifact(fixture);
  assert.equal(first, second);
  assert.deepEqual(JSON.parse(first), fixture);
  assert.equal(first.indexOf("\n"), first.length - 1);
  assert.equal(assertPublicEvidenceArtifactSize(first), Buffer.byteLength(first));
  assert.throws(
    () => serializeCompactPublicEvidenceArtifact(fixture, { maxBytes: Buffer.byteLength(first) }),
    /must remain below/
  );
});

test("canonical public evidence and its operational ledger stay below 75 MiB", async () => {
  const artifactPath = join(root, "src", "lib", "social", "public-evidence-current.json");
  const ledgerPath = join(root, PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_PATH);
  const [artifact, ledger] = await Promise.all([stat(artifactPath), stat(ledgerPath)]);
  assert.ok(
    artifact.size < PUBLIC_EVIDENCE_ARTIFACT_MAX_BYTES,
    `public evidence is ${artifact.size} bytes; expected less than ${PUBLIC_EVIDENCE_ARTIFACT_MAX_BYTES}`
  );
  assert.ok(
    ledger.size < PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_MAX_BYTES,
    `public evidence ledger is ${ledger.size} bytes; expected less than ${PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_MAX_BYTES}`
  );
  assertJqParsesIfAvailable(artifactPath);
  assertJqParsesIfAvailable(ledgerPath);

  const [runner, collector, batchPromotion, candidatePromotion, thumbnailBackfill] = await Promise.all([
    readFile(join(root, "scripts", "run-autonomous-ingestion.mjs"), "utf8"),
    readFile(join(root, "scripts", "fetch-public-traction.mjs"), "utf8"),
    readFile(join(root, "scripts", "promote-public-evidence-batch.mjs"), "utf8"),
    readFile(join(root, "scripts", "promote-public-evidence-candidate.mjs"), "utf8"),
    readFile(join(root, "scripts", "backfill-evidence-thumbnails.mjs"), "utf8")
  ]);
  assert.match(runner, /writePublicEvidenceArtifactPairAtomic\(\{/);
  assert.match(runner, /"outputs\/public-ingestion-operational-ledger-current\.json"/);
  assert.match(collector, /writePublicEvidenceArtifactPairAtomic\(\{/);
  assert.match(collector, /expectedLedgerSha256:/);
  assert.match(batchPromotion, /writePublicEvidenceArtifactPairAtomic\(\{/);
  assert.match(candidatePromotion, /writePublicEvidenceArtifactPairAtomic\(\{/);
  assert.match(thumbnailBackfill, /readPublicEvidenceArtifact\(absolutePath/);
  assert.match(thumbnailBackfill, /writePublicEvidenceCanonicalArtifactAtomic\(\{/);
  assert.match(thumbnailBackfill, /expectedCanonicalSha256:/);
  assert.match(thumbnailBackfill, /expectedLedgerSha256:/);
});

test("public collection globally bounds tasks and safely clamps lane overrides", () => {
  const runPlan = (...args) => JSON.parse(execFileSync(process.execPath, [
    "scripts/fetch-public-traction.mjs",
    "--batch=S2026",
    "--company=eden-robotics",
    "--platforms=linkedin",
    "--social=all",
    "--plan",
    ...args
  ], { cwd: root, encoding: "utf8" }));

  assert.equal(runPlan().taskConcurrencyCap, 8);
  assert.equal(runPlan().laneConcurrency.linkedin, 1);
  assert.equal(runPlan().laneConcurrency.instagram, 2);
  assert.equal(runPlan("--workers=999").taskConcurrencyCap, 16);
  assert.equal(runPlan("--workers=0").taskConcurrencyCap, 1);
  assert.equal(runPlan("--workers=16", "--linkedin-workers=99").laneConcurrency.linkedin, 4);
  assert.equal(runPlan("--workers=16", "--instagram-workers=99").laneConcurrency.instagram, 8);
  assert.equal(runPlan("--workers=2", "--linkedin-workers=4").laneConcurrency.linkedin, 2);
  assert.equal(runPlan("--workers=4", "--instagram-workers=8").laneConcurrency.instagram, 4);
});

test("public collection independently plans every active verified Eden account", () => {
  const plan = JSON.parse(execFileSync(process.execPath, [
    "scripts/fetch-public-traction.mjs",
    "--batch=S2026",
    "--company=eden-robotics",
    "--platforms=x,linkedin",
    "--social=all",
    "--plan"
  ], { cwd: root, encoding: "utf8" }));

  const targets = plan.socialTargets.map((target) => `${target.entityType}:${target.platform}:${target.accountUrl}`);
  assert.ok(targets.includes("company:linkedin:https://linkedin.com/company/eden-ai-robotics"));
  assert.ok(targets.includes("company:x:https://x.com/thefinalcompany"));
  assert.ok(targets.includes("founder:linkedin:https://linkedin.com/in/stamatis-floratos-535b19244"));
  assert.ok(targets.includes("founder:x:https://x.com/cybermetheus"));
  assert.ok(targets.includes("founder:x:https://x.com/stamatistwiy"));
  assert.equal(targets.filter((target) => target.startsWith("founder:x:")).length, 2);
});

test("public collection independently plans every active a16z account alias", () => {
  const cases = [
    ["antihero-studios", "linkedin", ["antihero-studios", "antiherostudios-games"]],
    ["quinn", "linkedin", ["meetquinn", "meetquinnai"]],
    ["smart-bricks", "instagram", ["smartbricks_invest", "smartbricks.invest"]]
  ];
  for (const [company, platform, handles] of cases) {
    const plan = JSON.parse(execFileSync(process.execPath, [
      "scripts/fetch-public-traction.mjs",
      "--batch=A16ZSR006",
      `--company=${company}`,
      `--platforms=${platform}`,
      "--social=all",
      "--plan"
    ], { cwd: root, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }));
    const targets = plan.socialTargets.filter(
      (target) => target.entityType === "company" && target.platform === platform
    );
    assert.equal(targets.length, 2);
    assert.deepEqual(
      targets.map((target) => new URL(target.accountUrl).pathname.split("/").filter(Boolean).at(-1)).sort(),
      handles.sort()
    );
  }
});

test("public collector plans every canonical public account mapping across all cohorts", async () => {
  const publicPlatforms = new Set(["x", "instagram", "linkedin", "youtube", "product_hunt"]);
  for (const catalog of await loadAutonomousCatalogs(root)) {
    const plan = JSON.parse(execFileSync(process.execPath, [
      "scripts/fetch-public-traction.mjs",
      `--batch=${catalog.slug}`,
      "--social=all",
      "--plan"
    ], { cwd: root, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }));
    const expected = catalog.companies.flatMap((company) =>
      [company, ...company.founders].flatMap((entity) =>
        entity.accounts
          .filter((account) => publicPlatforms.has(account.platform))
          .flatMap((account) => {
            const canonicalUrl = canonicalSocialAccountUrl(account.platform, account.url);
            return canonicalUrl ? [`${entity.sourceKey}:${account.platform}:${canonicalUrl}`] : [];
          })
      )
    ).sort();
    const actual = plan.socialTargets.map(
      (target) => `${target.entityId}:${target.platform}:${target.accountUrl.toLowerCase().replace(/\/$/, "")}`
    ).sort();
    assert.deepEqual(actual, expected, `${catalog.slug} public collector plan drifted from canonical mappings`);
  }
});

test("public collection checkpoints each same-owner account independently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "returner-public-multi-account-"));
  const output = join(directory, "public-evidence.json");
  const checkpoint = join(directory, "checkpoint.json");
  const discoveryAttempts = join(directory, "discovery-attempts.json");
  const sourceDiscoveryPaths = join(directory, "source-discovery-paths.json");
  const preload = join(directory, "mock-fetch.mjs");
  await Promise.all([
    writeFile(discoveryAttempts, "[]\n"),
    writeFile(sourceDiscoveryPaths, "[]\n"),
    writeFile(preload, `
globalThis.fetch = async () => new Response("Title: Log in / X\\nLog in to X to continue.", {
  status: 200,
  headers: { "content-type": "text/plain" }
});
`)
  ]);

  execFileSync(process.execPath, [
    "scripts/fetch-public-traction.mjs",
    "--batch=S2026",
    "--company=eden-robotics",
    "--platforms=x",
    "--social=all",
    "--workers=1",
    "--delay-ms=0",
    "--force",
    `--output=${output}`,
    `--checkpoint=${checkpoint}`,
    `--discovery-attempts=${discoveryAttempts}`,
    `--source-discovery-paths=${sourceDiscoveryPaths}`
  ], {
    cwd: root,
    env: {
      ...process.env,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${preload}`].filter(Boolean).join(" ")
    },
    stdio: "pipe"
  });

  const snapshot = JSON.parse(await readFile(output, "utf8"));
  const founderId = "founder-eden-robotics-stamatios-floratos-1956825";
  const attempts = Object.values(snapshot.attempts).filter(
    (attempt) => attempt.entityId === founderId && attempt.platform === "x" && attempt.accountUrl
  );
  assert.equal(attempts.length, 2);
  assert.deepEqual(
    attempts.map((attempt) => attempt.accountUrl).sort(),
    ["https://x.com/stamatistwiy", "https://x.com/cybermetheus"].sort()
  );
  assert.ok(attempts.every(
    (attempt) => ["completed", "needs_review", "blocked_or_empty", "failed"].includes(attempt.outcomeStatus)
  ));
});

test("legacy fresh generic checkpoints are rerun into explicit RSS receipts and then skip idempotently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "returner-public-legacy-rss-receipt-"));
  const output = join(directory, "public-evidence.json");
  const checkpoint = join(directory, "checkpoint.json");
  const discoveryAttempts = join(directory, "discovery-attempts.json");
  const sourceDiscoveryPaths = join(directory, "source-discovery-paths.json");
  const preload = join(directory, "mock-fetch.mjs");
  const noFetchPreload = join(directory, "no-fetch.mjs");
  await Promise.all([
    writeFile(discoveryAttempts, "[]\n"),
    writeFile(sourceDiscoveryPaths, "[]\n"),
    writeFile(checkpoint, `${JSON.stringify({
      attempts: {
        "rss:eden-robotics": { status: "done", checkedAt: new Date().toISOString() }
      },
      evidence: [],
      needsReview: [],
      failures: [],
      discoveryAttempts: [],
      sourceDiscoveryPaths: []
    }, null, 2)}\n`),
    writeFile(preload, `
globalThis.fetch = async (url) => new Response(
  String(url).includes("feed")
    ? "<?xml version=\\"1.0\\"?><rss><channel></channel></rss>"
    : "<html><head><link rel=\\"alternate\\" type=\\"application/rss+xml\\" href=\\"/feed.xml\\"></head><body>Eden Robotics</body></html>",
  { status: 200 }
);
`),
    writeFile(noFetchPreload, `globalThis.fetch = async () => { throw new Error("structured fresh RSS receipt must skip network"); };\n`)
  ]);

  const args = [
    "scripts/fetch-public-traction.mjs",
    "--batch=S2026",
    "--company=eden-robotics",
    "--platforms=rss",
    "--social=none",
    "--workers=1",
    "--delay-ms=0",
    `--output=${output}`,
    `--checkpoint=${checkpoint}`,
    `--discovery-attempts=${discoveryAttempts}`,
    `--source-discovery-paths=${sourceDiscoveryPaths}`
  ];
  execFileSync(process.execPath, args, {
    cwd: root,
    env: { ...process.env, NODE_OPTIONS: `--import=${preload}` },
    stdio: "pipe"
  });

  const first = JSON.parse(await readFile(output, "utf8"));
  const receipt = first.attempts["rss:eden-robotics"];
  assert.deepEqual({
    batchSlug: receipt.batchSlug,
    companySlug: receipt.companySlug,
    platform: receipt.platform,
    entityType: receipt.entityType,
    entityId: receipt.entityId,
    entityName: receipt.entityName,
    accountUrl: receipt.accountUrl,
    status: receipt.status,
    outcomeStatus: receipt.outcomeStatus,
    outcomeReason: receipt.outcomeReason
  }, {
    batchSlug: "S2026",
    companySlug: "eden-robotics",
    platform: "rss",
    entityType: "company",
    entityId: "company-eden-robotics",
    entityName: "Eden Robotics",
    accountUrl: null,
    status: "done",
    outcomeStatus: "blocked_or_empty",
    outcomeReason: "collector_checked_blocked_or_empty"
  });

  execFileSync(process.execPath, args, {
    cwd: root,
    env: { ...process.env, NODE_OPTIONS: `--import=${noFetchPreload}` },
    stdio: "pipe"
  });
  const second = JSON.parse(await readFile(output, "utf8"));
  assert.deepEqual(second.attempts["rss:eden-robotics"], receipt);
});

test("RSS feed collection keeps every unique entry in each bounded response", async () => {
  const directory = await mkdtemp(join(tmpdir(), "returner-public-rss-depth-"));
  const output = join(directory, "public-evidence.json");
  const checkpoint = join(directory, "checkpoint.json");
  const discoveryAttempts = join(directory, "discovery-attempts.json");
  const sourceDiscoveryPaths = join(directory, "source-discovery-paths.json");
  const preload = join(directory, "mock-fetch.mjs");
  await Promise.all([
    writeFile(discoveryAttempts, "[]\n"),
    writeFile(sourceDiscoveryPaths, "[]\n"),
    writeFile(preload, `
const entries = Array.from({ length: 7 }, (_, index) => {
  const number = index + 1;
  return "<item><title>Post " + number + "</title><link>https://www.edenrobotics.ai/blog/post-" + number + "</link><description>Eden Robotics update " + number + "</description><pubDate>Mon, " + String(number).padStart(2, "0") + " Jun 2026 12:00:00 GMT</pubDate></item>";
}).join("");
const duplicate = "<item><title>Duplicate title for post 3</title><link>https://www.edenrobotics.ai/blog/post-3</link><description>Duplicate feed entry</description><pubDate>Mon, 03 Jun 2026 12:00:00 GMT</pubDate></item>";
const feed = '<?xml version="1.0"?><rss><channel>' + entries + duplicate + '</channel></rss>';
globalThis.fetch = async (url) => {
  const value = String(url);
  if (/\\/(?:feed(?:\\.xml)?|rss(?:\\.xml)?)$/.test(value)) {
    return new Response(feed, { status: 200, headers: { "content-type": "application/rss+xml" } });
  }
  return new Response('<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head><body>Eden Robotics</body></html>', { status: 200 });
};
`)
  ]);

  execFileSync(process.execPath, [
    "scripts/fetch-public-traction.mjs",
    "--batch=S2026",
    "--company=eden-robotics",
    "--platforms=rss",
    "--social=none",
    "--workers=1",
    "--delay-ms=0",
    "--force",
    `--output=${output}`,
    `--checkpoint=${checkpoint}`,
    `--discovery-attempts=${discoveryAttempts}`,
    `--source-discovery-paths=${sourceDiscoveryPaths}`
  ], {
    cwd: root,
    env: { ...process.env, NODE_OPTIONS: `--import=${preload}` },
    stdio: "pipe"
  });

  const snapshot = JSON.parse(await readFile(output, "utf8"));
  const rssRows = [...snapshot.evidence, ...snapshot.needsReview]
    .filter((row) => row.platform === "rss");
  assert.equal(rssRows.length, 7);
  assert.ok(rssRows.some((row) => row.sourceUrl.endsWith("/blog/post-7")));
  assert.equal(
    rssRows.filter((row) => row.sourceUrl.endsWith("/blog/post-3")).length,
    1,
    "cross-feed and same-feed duplicates must still collapse by physical URL"
  );
});

test("RSS feed collection rejects a response above the byte guard", async () => {
  const directory = await mkdtemp(join(tmpdir(), "returner-public-rss-size-"));
  const output = join(directory, "public-evidence.json");
  const checkpoint = join(directory, "checkpoint.json");
  const discoveryAttempts = join(directory, "discovery-attempts.json");
  const sourceDiscoveryPaths = join(directory, "source-discovery-paths.json");
  const preload = join(directory, "mock-fetch.mjs");
  await Promise.all([
    writeFile(discoveryAttempts, "[]\n"),
    writeFile(sourceDiscoveryPaths, "[]\n"),
    writeFile(preload, `
globalThis.fetch = async (url) => {
  const value = String(url);
  if (/\\/(?:feed(?:\\.xml)?|rss(?:\\.xml)?)$/.test(value)) {
    return new Response("<rss><channel></channel></rss>", {
      status: 200,
      headers: { "content-type": "application/rss+xml", "content-length": String(2 * 1024 * 1024 + 1) }
    });
  }
  return new Response('<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head><body>Eden Robotics</body></html>', { status: 200 });
};
`)
  ]);

  execFileSync(process.execPath, [
    "scripts/fetch-public-traction.mjs",
    "--batch=S2026",
    "--company=eden-robotics",
    "--platforms=rss",
    "--social=none",
    "--workers=1",
    "--delay-ms=0",
    "--force",
    `--output=${output}`,
    `--checkpoint=${checkpoint}`,
    `--discovery-attempts=${discoveryAttempts}`,
    `--source-discovery-paths=${sourceDiscoveryPaths}`
  ], {
    cwd: root,
    env: { ...process.env, NODE_OPTIONS: `--import=${preload}` },
    stdio: "pipe"
  });

  const snapshot = JSON.parse(await readFile(output, "utf8"));
  const rssRows = [...snapshot.evidence, ...snapshot.needsReview]
    .filter((row) => row.platform === "rss");
  assert.equal(rssRows.length, 0);
  assert.ok(snapshot.failures.some(
    (row) => row.platform === "rss" && /above the 2097152-byte limit/.test(row.message)
  ));
});

test("legacy fresh Hacker News rows rerun once into instrumented recent-window state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "returner-public-legacy-hn-proof-"));
  const output = join(directory, "public-evidence.json");
  const checkpoint = join(directory, "checkpoint.json");
  const discoveryAttempts = join(directory, "discovery-attempts.json");
  const sourceDiscoveryPaths = join(directory, "source-discovery-paths.json");
  const journals = join(directory, "recent-window-journals");
  const preload = join(directory, "mock-fetch.mjs");
  const noFetchPreload = join(directory, "no-fetch.mjs");
  const attemptKey = "hacker_news:9-mothers-corporation";
  const legacyCheckedAt = new Date().toISOString();
  const recentCoverageCutoff = new Date().toISOString();
  await Promise.all([
    writeFile(output, `${JSON.stringify({
      source: {}, evidence: [], needsReview: [], failures: []
    })}\n`),
    writeFile(discoveryAttempts, "[]\n"),
    writeFile(sourceDiscoveryPaths, "[]\n"),
    writeFile(checkpoint, `${JSON.stringify({
      attempts: {
        [attemptKey]: {
          attemptKey,
          batchSlug: "S2026",
          companySlug: "9-mothers-corporation",
          platform: "hacker_news",
          entityType: "company",
          entityId: "company-9-mothers-corporation",
          entityName: "9 Mothers",
          accountUrl: null,
          status: "done",
          checkedAt: legacyCheckedAt,
          retryable: false,
          outcomeStatus: "completed",
          outcomeReason: "collector_evidence_collected"
        }
      },
      evidence: [], needsReview: [], failures: [], discoveryAttempts: [], sourceDiscoveryPaths: []
    }, null, 2)}\n`),
    writeFile(preload, `
globalThis.fetch = async (url) => {
  if (!String(url).startsWith("https://hn.algolia.com/api/v1/search_by_date")) {
    throw new Error("unexpected URL: " + url);
  }
  return new Response(JSON.stringify({ page: 0, nbHits: 0, nbPages: 0, hits: [] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
};
`),
    writeFile(noFetchPreload, `globalThis.fetch = async () => { throw new Error("instrumented terminal HN receipt must skip network"); };\n`)
  ]);
  const args = [
    "scripts/fetch-public-traction.mjs",
    "--batch=S2026",
    "--company=9-mothers-corporation",
    "--platforms=hacker_news",
    "--social=none",
    "--workers=1",
    "--delay-ms=0",
    `--recent-proof-journal-dir=${journals}`,
    `--recent-coverage-cutoff=${recentCoverageCutoff}`,
    `--output=${output}`,
    `--checkpoint=${checkpoint}`,
    `--discovery-attempts=${discoveryAttempts}`,
    `--source-discovery-paths=${sourceDiscoveryPaths}`
  ];
  execFileSync(process.execPath, args, {
    cwd: root,
    env: { ...process.env, NODE_OPTIONS: `--import=${preload}` },
    stdio: "pipe"
  });
  const first = JSON.parse(await readFile(output, "utf8"));
  const instrumented = first.attempts[attemptKey];
  assert.notEqual(instrumented.checkedAt, legacyCheckedAt);
  assert.equal(instrumented.recentWindowCoverageCutoff, recentCoverageCutoff);
  assert.equal(instrumented.recentWindowProof.coveredThrough, recentCoverageCutoff);
  assert.equal(instrumented.recentWindowProof.status, "complete");

  execFileSync(process.execPath, args, {
    cwd: root,
    env: { ...process.env, NODE_OPTIONS: `--import=${noFetchPreload}` },
    stdio: "pipe"
  });
  const second = JSON.parse(await readFile(output, "utf8"));
  assert.deepEqual(second.attempts[attemptKey], instrumented);

  const nextCoverageCutoff = new Date().toISOString();
  const refreshedArgs = args.map((argument) =>
    argument.startsWith("--recent-coverage-cutoff=")
      ? `--recent-coverage-cutoff=${nextCoverageCutoff}`
      : argument
  );
  execFileSync(process.execPath, refreshedArgs, {
    cwd: root,
    env: { ...process.env, NODE_OPTIONS: `--import=${preload}` },
    stdio: "pipe"
  });
  const refreshed = JSON.parse(await readFile(output, "utf8"));
  assert.equal(
    refreshed.attempts[attemptKey].recentWindowCoverageCutoff,
    nextCoverageCutoff
  );
  assert.notDeepEqual(refreshed.attempts[attemptKey], instrumented);
});

test("fresh deterministic failed receipts are terminal and do not repeat network work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "returner-public-deterministic-terminal-"));
  const output = join(directory, "public-evidence.json");
  const checkpoint = join(directory, "checkpoint.json");
  const discoveryAttempts = join(directory, "discovery-attempts.json");
  const sourceDiscoveryPaths = join(directory, "source-discovery-paths.json");
  const noFetchPreload = join(directory, "no-fetch.mjs");
  const attemptKey = "rss:eden-robotics";
  const attempt = {
    attemptKey,
    batchSlug: "S2026",
    companySlug: "eden-robotics",
    platform: "rss",
    entityType: "company",
    entityId: "company-eden-robotics",
    entityName: "Eden Robotics",
    accountUrl: null,
    status: "failed",
    error: "HTTP 404 Not Found",
    outcomeStatus: "blocked_or_empty",
    outcomeReason: "collector_checked_blocked_or_empty",
    checkedAt: new Date(Date.now() - 60_000).toISOString()
  };
  await Promise.all([
    writeFile(discoveryAttempts, "[]\n"),
    writeFile(sourceDiscoveryPaths, "[]\n"),
    writeFile(checkpoint, `${JSON.stringify({
      attempts: { [attemptKey]: attempt },
      evidence: [],
      needsReview: [],
      failures: [],
      discoveryAttempts: [],
      sourceDiscoveryPaths: []
    }, null, 2)}\n`),
    writeFile(noFetchPreload, `globalThis.fetch = async () => { throw new Error("deterministic terminal receipt must skip network"); };\n`)
  ]);

  execFileSync(process.execPath, [
    "scripts/fetch-public-traction.mjs",
    "--batch=S2026",
    "--company=eden-robotics",
    "--platforms=rss",
    "--social=none",
    "--workers=1",
    "--delay-ms=0",
    `--output=${output}`,
    `--checkpoint=${checkpoint}`,
    `--discovery-attempts=${discoveryAttempts}`,
    `--source-discovery-paths=${sourceDiscoveryPaths}`
  ], {
    cwd: root,
    env: { ...process.env, NODE_OPTIONS: `--import=${noFetchPreload}` },
    stdio: "pipe"
  });

  const snapshot = JSON.parse(await readFile(output, "utf8"));
  assert.deepEqual(snapshot.attempts[attemptKey], attempt);
});

test("retryable receipts rerun once and a shared campaign checkpoint skips the next cycle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "returner-public-campaign-checkpoint-"));
  const firstOutput = join(directory, "cycle-one.json");
  const secondOutput = join(directory, "cycle-two.json");
  const checkpoint = join(directory, "shared-checkpoint.json");
  const discoveryAttempts = join(directory, "discovery-attempts.json");
  const sourceDiscoveryPaths = join(directory, "source-discovery-paths.json");
  const preload = join(directory, "mock-fetch.mjs");
  const noFetchPreload = join(directory, "no-fetch.mjs");
  const attemptKey = "rss:eden-robotics";
  const previousCheckedAt = new Date(Date.now() - 60_000).toISOString();
  await Promise.all([
    writeFile(discoveryAttempts, "[]\n"),
    writeFile(sourceDiscoveryPaths, "[]\n"),
    writeFile(checkpoint, `${JSON.stringify({
      attempts: {
        [attemptKey]: {
          attemptKey,
          batchSlug: "S2026",
          companySlug: "eden-robotics",
          platform: "rss",
          entityType: "company",
          entityId: "company-eden-robotics",
          entityName: "Eden Robotics",
          accountUrl: null,
          status: "failed",
          error: "HTTP 429 rate limit",
          retryable: true,
          outcomeStatus: "failed",
          outcomeReason: "collector_reported_failure",
          checkedAt: previousCheckedAt
        }
      },
      evidence: [],
      needsReview: [],
      failures: [],
      discoveryAttempts: [],
      sourceDiscoveryPaths: []
    }, null, 2)}\n`),
    writeFile(preload, `
globalThis.fetch = async (url) => new Response(
  String(url).includes("feed")
    ? "<?xml version=\\"1.0\\"?><rss><channel></channel></rss>"
    : "<html><head><link rel=\\"alternate\\" type=\\"application/rss+xml\\" href=\\"/feed.xml\\"></head><body>Eden Robotics</body></html>",
  { status: 200 }
);
`),
    writeFile(noFetchPreload, `globalThis.fetch = async () => { throw new Error("shared campaign checkpoint must skip completed work"); };\n`)
  ]);
  const args = (output) => [
    "scripts/fetch-public-traction.mjs",
    "--batch=S2026",
    "--company=eden-robotics",
    "--platforms=rss",
    "--social=none",
    "--workers=1",
    "--delay-ms=0",
    `--output=${output}`,
    `--checkpoint=${checkpoint}`,
    `--discovery-attempts=${discoveryAttempts}`,
    `--source-discovery-paths=${sourceDiscoveryPaths}`
  ];

  execFileSync(process.execPath, args(firstOutput), {
    cwd: root,
    env: { ...process.env, NODE_OPTIONS: `--import=${preload}` },
    stdio: "pipe"
  });
  const first = JSON.parse(await readFile(firstOutput, "utf8"));
  const terminal = first.attempts[attemptKey];
  assert.notEqual(terminal.checkedAt, previousCheckedAt);
  assert.equal(terminal.retryable, false);
  assert.equal(terminal.outcomeStatus, "blocked_or_empty");

  execFileSync(process.execPath, args(secondOutput), {
    cwd: root,
    env: { ...process.env, NODE_OPTIONS: `--import=${noFetchPreload}` },
    stdio: "pipe"
  });
  const second = JSON.parse(await readFile(secondOutput, "utf8"));
  assert.deepEqual(second.attempts[attemptKey], terminal);
});

test("fresh mapped LinkedIn receipts below the attribution contract version rerun once and then skip", async () => {
  const directory = await mkdtemp(join(tmpdir(), "returner-public-linkedin-v3-receipt-"));
  const output = join(directory, "public-evidence.json");
  const checkpoint = join(directory, "checkpoint.json");
  const discoveryAttempts = join(directory, "discovery-attempts.json");
  const sourceDiscoveryPaths = join(directory, "source-discovery-paths.json");
  const preload = join(directory, "blocked-linkedin.mjs");
  const noFetchPreload = join(directory, "no-fetch.mjs");
  const accountUrl = "https://linkedin.com/company/eden-ai-robotics";
  const attemptKey = `linkedin:company:company-eden-robotics:${accountUrl}`;
  const legacyCheckedAt = new Date().toISOString();
  const legacyAttempt = {
    attributionVersion: 2,
    batchSlug: "S2026",
    companySlug: "eden-robotics",
    platform: "linkedin",
    entityType: "company",
    entityId: "company-eden-robotics",
    entityName: "Eden Robotics",
    accountUrl,
    status: "done",
    outcomeStatus: "blocked_or_empty",
    outcomeReason: "collector_checked_blocked_or_empty",
    checkedAt: legacyCheckedAt
  };
  await Promise.all([
    writeFile(output, `${JSON.stringify({ source: {}, attempts: {}, evidence: [], needsReview: [], failures: [] }, null, 2)}\n`),
    writeFile(checkpoint, `${JSON.stringify({
      attempts: { [attemptKey]: legacyAttempt },
      evidence: [],
      needsReview: [],
      failures: [],
      discoveryAttempts: [],
      sourceDiscoveryPaths: []
    }, null, 2)}\n`),
    writeFile(discoveryAttempts, "[]\n"),
    writeFile(sourceDiscoveryPaths, "[]\n"),
    writeFile(preload, `globalThis.fetch = async () => new Response("Target URL returned error 403: Access denied. To continue, log in.", { status: 200 });\n`),
    writeFile(noFetchPreload, `globalThis.fetch = async () => { throw new Error("fresh v3 LinkedIn receipt must skip network"); };\n`)
  ]);

  const args = [
    "scripts/fetch-public-traction.mjs",
    "--batch=S2026",
    "--company=eden-robotics",
    "--platforms=linkedin",
    "--social=company",
    "--no-discover-missing-social",
    "--workers=1",
    "--delay-ms=0",
    `--output=${output}`,
    `--checkpoint=${checkpoint}`,
    `--discovery-attempts=${discoveryAttempts}`,
    `--source-discovery-paths=${sourceDiscoveryPaths}`
  ];
  execFileSync(process.execPath, args, {
    cwd: root,
    env: { ...process.env, NODE_OPTIONS: `--import=${preload}` },
    stdio: "pipe"
  });

  const first = JSON.parse(await readFile(output, "utf8"));
  const refreshed = first.attempts[attemptKey];
  assert.equal(refreshed.attributionVersion, 3);
  assert.notEqual(refreshed.checkedAt, legacyCheckedAt);
  assert.equal(refreshed.batchSlug, "S2026");
  assert.equal(refreshed.accountUrl, accountUrl);

  execFileSync(process.execPath, args, {
    cwd: root,
    env: { ...process.env, NODE_OPTIONS: `--import=${noFetchPreload}` },
    stdio: "pipe"
  });
  const second = JSON.parse(await readFile(output, "utf8"));
  assert.deepEqual(second.attempts[attemptKey], refreshed);
});

test("fresh failed YouTube receipts retry into blocked-or-empty and then skip idempotently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "returner-public-failed-youtube-retry-"));
  const output = join(directory, "public-evidence.json");
  const checkpoint = join(directory, "checkpoint.json");
  const discoveryAttempts = join(directory, "discovery-attempts.json");
  const sourceDiscoveryPaths = join(directory, "source-discovery-paths.json");
  const preload = join(directory, "empty-youtube.mjs");
  const noFetchPreload = join(directory, "no-fetch.mjs");
  const entityId = "a16z-speedrun-006-antihero-studios";
  const accountUrl = "https://youtube.com/@antihero_studios";
  const attemptKey = `youtube:company:${entityId}:${accountUrl}`;
  await Promise.all([
    writeFile(discoveryAttempts, "[]\n"),
    writeFile(sourceDiscoveryPaths, "[]\n"),
    writeFile(preload, `globalThis.fetch = async () => new Response("<html><body>No videos</body></html>", { status: 200 });\n`),
    writeFile(noFetchPreload, `globalThis.fetch = async () => { throw new Error("blocked-or-empty receipt must skip network"); };\n`),
    writeFile(checkpoint, `${JSON.stringify({
      attempts: {
        [attemptKey]: {
          status: "done",
          checkedAt: new Date().toISOString(),
          batchSlug: "A16ZSR006",
          companySlug: "antihero-studios",
          platform: "youtube",
          entityType: "company",
          entityId,
          entityName: "Antihero Studios",
          accountUrl,
          outcomeStatus: "failed",
          outcomeReason: "collector_reported_failure"
        }
      },
      evidence: [],
      needsReview: [],
      failures: [],
      discoveryAttempts: [],
      sourceDiscoveryPaths: []
    }, null, 2)}\n`)
  ]);

  const args = [
    "scripts/fetch-public-traction.mjs",
    "--batch=A16ZSR006",
    "--company=antihero-studios",
    "--platforms=youtube",
    "--social=all",
    "--workers=1",
    "--delay-ms=0",
    `--output=${output}`,
    `--checkpoint=${checkpoint}`,
    `--discovery-attempts=${discoveryAttempts}`,
    `--source-discovery-paths=${sourceDiscoveryPaths}`
  ];
  execFileSync(process.execPath, args, {
    cwd: root,
    env: { ...process.env, NODE_OPTIONS: `--import=${preload}` },
    stdio: "pipe"
  });

  const first = JSON.parse(await readFile(output, "utf8"));
  const receipt = first.attempts[attemptKey];
  assert.equal(receipt.status, "done");
  assert.equal(receipt.outcomeStatus, "blocked_or_empty");
  assert.equal(receipt.outcomeReason, "collector_checked_blocked_or_empty");
  assert.equal(receipt.companySlug, "antihero-studios");
  assert.ok(first.failures.some(
    (failure) =>
      failure.entityId === entityId &&
      failure.accountUrl === accountUrl &&
      failure.message === "No visible native YouTube videos were exposed on the mapped account."
  ));

  execFileSync(process.execPath, args, {
    cwd: root,
    env: { ...process.env, NODE_OPTIONS: `--import=${noFetchPreload}` },
    stdio: "pipe"
  });
  const second = JSON.parse(await readFile(output, "utf8"));
  assert.deepEqual(second.attempts[attemptKey], receipt);
});

test("generic Hacker News company lanes emit exact terminal owner receipts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "returner-public-generic-hn-receipt-"));
  const output = join(directory, "public-evidence.json");
  const checkpoint = join(directory, "checkpoint.json");
  const discoveryAttempts = join(directory, "discovery-attempts.json");
  const sourceDiscoveryPaths = join(directory, "source-discovery-paths.json");
  const preload = join(directory, "mock-fetch.mjs");
  await Promise.all([
    writeFile(discoveryAttempts, "[]\n"),
    writeFile(sourceDiscoveryPaths, "[]\n"),
    writeFile(preload, `globalThis.fetch = async () => new Response(JSON.stringify({ hits: [] }), { status: 200 });\n`)
  ]);

  execFileSync(process.execPath, [
    "scripts/fetch-public-traction.mjs",
    "--batch=S2026",
    "--company=eden-robotics",
    "--platforms=hacker_news",
    "--social=none",
    "--workers=1",
    "--delay-ms=0",
    "--force",
    `--output=${output}`,
    `--checkpoint=${checkpoint}`,
    `--discovery-attempts=${discoveryAttempts}`,
    `--source-discovery-paths=${sourceDiscoveryPaths}`
  ], {
    cwd: root,
    env: { ...process.env, NODE_OPTIONS: `--import=${preload}` },
    stdio: "pipe"
  });

  const snapshot = JSON.parse(await readFile(output, "utf8"));
  const receipt = snapshot.attempts["hacker_news:eden-robotics"];
  assert.equal(receipt.batchSlug, "S2026");
  assert.equal(receipt.companySlug, "eden-robotics");
  assert.equal(receipt.platform, "hacker_news");
  assert.equal(receipt.entityType, "company");
  assert.equal(receipt.entityId, "company-eden-robotics");
  assert.equal(receipt.accountUrl, null);
  assert.equal(receipt.outcomeStatus, "blocked_or_empty");
  assert.equal(receipt.outcomeReason, "collector_checked_blocked_or_empty");
});

test("Reddit access errors with JSON bodies are explicit blocked outcomes rather than empty searches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "returner-public-reddit-blocked-"));
  const output = join(directory, "public-evidence.json");
  const checkpoint = join(directory, "checkpoint.json");
  const discoveryAttempts = join(directory, "discovery-attempts.json");
  const sourceDiscoveryPaths = join(directory, "source-discovery-paths.json");
  const preload = join(directory, "mock-fetch.mjs");
  await Promise.all([
    writeFile(discoveryAttempts, "[]\n"),
    writeFile(sourceDiscoveryPaths, "[]\n"),
    writeFile(preload, `
globalThis.fetch = async (url) => {
  if (String(url).startsWith("https://www.reddit.com/search.json")) {
    return Response.json({ message: "Forbidden" }, { status: 403 });
  }
  if (String(url).startsWith("https://r.jina.ai/http")) {
    return new Response("Title: Reddit Search", { status: 200 });
  }
  throw new Error("unexpected request");
};
`)
  ]);

  execFileSync(process.execPath, [
    "scripts/fetch-public-traction.mjs",
    "--batch=S2026",
    "--company=eden-robotics",
    "--platforms=reddit",
    "--social=none",
    "--workers=1",
    "--delay-ms=0",
    "--force",
    `--output=${output}`,
    `--checkpoint=${checkpoint}`,
    `--discovery-attempts=${discoveryAttempts}`,
    `--source-discovery-paths=${sourceDiscoveryPaths}`
  ], {
    cwd: root,
    env: { ...process.env, NODE_OPTIONS: `--import=${preload}` },
    stdio: "pipe"
  });

  const snapshot = JSON.parse(await readFile(output, "utf8"));
  const receipt = snapshot.attempts["reddit:eden-robotics"];
  assert.equal(receipt.outcomeStatus, "blocked_or_empty");
  assert.equal(receipt.outcomeReason, "collector_checked_blocked_or_empty");
  assert.equal(snapshot.evidence.length, 0);
  assert.ok(snapshot.failures.some(
    (failure) =>
      failure.platform === "reddit" &&
      failure.message === "Reddit public access blocked: HTTP 403."
  ));
});

test("platform cooldown skips still write exact terminal receipts for every skipped task", async () => {
  const directory = await mkdtemp(join(tmpdir(), "returner-public-cooldown-receipt-"));
  const output = join(directory, "public-evidence.json");
  const checkpoint = join(directory, "checkpoint.json");
  const discoveryAttempts = join(directory, "discovery-attempts.json");
  const sourceDiscoveryPaths = join(directory, "source-discovery-paths.json");
  const preload = join(directory, "mock-fetch.mjs");
  await Promise.all([
    writeFile(discoveryAttempts, "[]\n"),
    writeFile(sourceDiscoveryPaths, "[]\n"),
    writeFile(preload, `
globalThis.fetch = async (url) => {
  if (String(url).startsWith("https://r.jina.ai/http")) {
    return new Response("SecurityCompromiseError", { status: 451 });
  }
  throw new Error("force reader fallback");
};
`)
  ]);

  execFileSync(process.execPath, [
    "scripts/fetch-public-traction.mjs",
    "--batch=S2026",
    "--company=eden-robotics",
    "--platforms=web",
    "--social=none",
    "--workers=1",
    "--delay-ms=0",
    "--force",
    `--output=${output}`,
    `--checkpoint=${checkpoint}`,
    `--discovery-attempts=${discoveryAttempts}`,
    `--source-discovery-paths=${sourceDiscoveryPaths}`
  ], {
    cwd: root,
    env: { ...process.env, NODE_OPTIONS: `--import=${preload}` },
    stdio: "pipe"
  });

  const snapshot = JSON.parse(await readFile(output, "utf8"));
  for (const key of ["website:eden-robotics", "news_web:eden-robotics"]) {
    const receipt = snapshot.attempts[key];
    assert.ok(receipt, `${key} did not receive a cooldown terminal receipt`);
    assert.equal(receipt.batchSlug, "S2026");
    assert.equal(receipt.companySlug, "eden-robotics");
    assert.equal(receipt.platform, "web");
    assert.equal(receipt.entityType, "company");
    assert.equal(receipt.entityId, "company-eden-robotics");
    assert.equal(receipt.accountUrl, null);
    assert.equal(receipt.outcomeStatus, "blocked_or_empty");
    assert.equal(receipt.outcomeReason, "collector_checked_blocked_or_empty");
  }
});

test("A16Z cooldown retains distinct terminal failures for same-company founders without URLs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "returner-public-a16z-cofounder-cooldown-"));
  const output = join(directory, "public-evidence.json");
  const checkpoint = join(directory, "checkpoint.json");
  const discoveryAttempts = join(directory, "discovery-attempts.json");
  const sourceDiscoveryPaths = join(directory, "source-discovery-paths.json");
  const preload = join(directory, "mock-fetch.mjs");
  await Promise.all([
    writeFile(discoveryAttempts, "[]\n"),
    writeFile(sourceDiscoveryPaths, "[]\n"),
    writeFile(preload, `
globalThis.fetch = async (url) => {
  if (String(url).startsWith("https://r.jina.ai/http")) {
    return new Response("SecurityCompromiseError", { status: 451 });
  }
  throw new Error("unexpected non-reader request");
};
`)
  ]);

  execFileSync(process.execPath, [
    "scripts/fetch-public-traction.mjs",
    "--batch=A16ZSR006",
    "--company=amdahl",
    "--platforms=x",
    "--social=all",
    "--workers=1",
    "--delay-ms=0",
    "--force",
    `--output=${output}`,
    `--checkpoint=${checkpoint}`,
    `--discovery-attempts=${discoveryAttempts}`,
    `--source-discovery-paths=${sourceDiscoveryPaths}`
  ], {
    cwd: root,
    env: { ...process.env, NODE_OPTIONS: `--import=${preload}` },
    stdio: "pipe"
  });

  const snapshot = JSON.parse(await readFile(output, "utf8"));
  const founderIds = [
    "a16z-speedrun-006-amdahl-founder-annette-sung",
    "a16z-speedrun-006-amdahl-founder-robert-khoury"
  ];
  const founderFailures = snapshot.failures.filter(
    (failure) => founderIds.includes(failure.entityId) && failure.platform === "x"
  );
  assert.equal(founderFailures.length, 2);
  assert.equal(new Set(founderFailures.map((failure) => failure.id)).size, 2);
  assert.deepEqual(founderFailures.map((failure) => failure.entityId).sort(), founderIds.sort());
  assert.ok(founderFailures.every((failure) => failure.companySlug === "amdahl"));
  assert.ok(founderFailures.every((failure) => failure.accountUrl === null));

  for (const entityId of founderIds) {
    const key = `x:founder:${entityId}:missing-url`;
    const receipt = snapshot.attempts[key];
    assert.ok(receipt, `${key} did not receive a terminal cooldown receipt`);
    assert.equal(receipt.batchSlug, "A16ZSR006");
    assert.equal(receipt.companySlug, "amdahl");
    assert.equal(receipt.entityId, entityId);
    assert.equal(receipt.accountUrl, null);
    assert.equal(receipt.outcomeStatus, "blocked_or_empty");
    assert.equal(receipt.outcomeReason, "collector_checked_blocked_or_empty");
  }
});

test("public JSON writes repair a legacy lone high surrogate without changing valid emoji pairs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "returner-public-surrogate-repair-"));
  const output = join(directory, "public-evidence.json");
  const checkpoint = join(directory, "checkpoint.json");
  const discoveryAttempts = join(directory, "discovery-attempts.json");
  const sourceDiscoveryPaths = join(directory, "source-discovery-paths.json");
  const preload = join(directory, "no-fetch.mjs");
  const exactLiveShape = `${"x".repeat(5_999)}\uD83C`;
  await Promise.all([
    writeFile(discoveryAttempts, "[]\n"),
    writeFile(sourceDiscoveryPaths, "[]\n"),
    writeFile(preload, `globalThis.fetch = async () => { throw new Error("fresh structured receipt must skip network"); };\n`),
    writeFile(checkpoint, `${JSON.stringify({
      attempts: {
        "rss:eden-robotics": {
          status: "done",
          checkedAt: new Date().toISOString(),
          batchSlug: "S2026",
          platform: "rss",
          entityType: "company",
          entityId: "company-eden-robotics",
          entityName: "Eden Robotics",
          accountUrl: null,
          outcomeStatus: "blocked_or_empty",
          outcomeReason: "collector_checked_blocked_or_empty"
        }
      },
      evidence: [],
      needsReview: [{
        id: "legacy-lone-high-surrogate",
        platform: "linkedin",
        entityType: "company",
        entityId: "company-eden-robotics",
        companySlug: "eden-robotics",
        companyName: "Eden Robotics",
        candidateUrl: "https://linkedin.com/company/eden-ai-robotics",
        review_state: "needs_review",
        rawVisibleText: exactLiveShape,
        matchReason: "Valid emoji remains byte-for-codepoint: 😀"
      }],
      failures: [],
      discoveryAttempts: [],
      sourceDiscoveryPaths: []
    }, null, 2)}\n`)
  ]);

  execFileSync(process.execPath, [
    "scripts/fetch-public-traction.mjs",
    "--batch=S2026",
    "--company=eden-robotics",
    "--platforms=rss",
    "--social=none",
    "--workers=1",
    "--delay-ms=0",
    `--output=${output}`,
    `--checkpoint=${checkpoint}`,
    `--discovery-attempts=${discoveryAttempts}`,
    `--source-discovery-paths=${sourceDiscoveryPaths}`
  ], {
    cwd: root,
    env: { ...process.env, NODE_OPTIONS: `--import=${preload}` },
    stdio: "pipe"
  });

  for (const path of [output, checkpoint]) {
    const raw = await readFile(path, "utf8");
    const snapshot = JSON.parse(raw);
    const repaired = snapshot.needsReview.find((row) => row.id === "legacy-lone-high-surrogate");
    assert.ok(repaired);
    assert.equal(snapshot.attempts["rss:eden-robotics"].companySlug, "eden-robotics");
    assert.equal(repaired.rawVisibleText, `${"x".repeat(5_999)}\uFFFD`);
    assert.match(repaired.matchReason, /😀$/u);
    assert.doesNotMatch(raw, /\\ud83c(?!\\u[dD][c-fC-F][0-9a-fA-F]{2})/i);
    assertWellFormedStrings(snapshot);
    assertJqParsesIfAvailable(path);
  }
});

test("post text truncation never splits a valid surrogate pair", async () => {
  const directory = await mkdtemp(join(tmpdir(), "returner-public-surrogate-truncation-"));
  const output = join(directory, "public-evidence.json");
  const checkpoint = join(directory, "checkpoint.json");
  const discoveryAttempts = join(directory, "discovery-attempts.json");
  const sourceDiscoveryPaths = join(directory, "source-discovery-paths.json");
  const preload = join(directory, "mock-fetch.mjs");
  await Promise.all([
    writeFile(discoveryAttempts, "[]\n"),
    writeFile(sourceDiscoveryPaths, "[]\n"),
    writeFile(preload, `
globalThis.fetch = async () => {
  const hit = {
    story_text: "MARKER",
    title: "Launch HN: Eden Robotics (YC P26)",
    url: "https://edenrobotics.ai",
    objectID: "123456789",
    points: 10,
    num_comments: 2,
    created_at: "2026-07-20T00:00:00.000Z"
  };
  const markerOffset = JSON.stringify(hit).indexOf("MARKER");
  const preservedEmojiOffset = 5_900;
  const boundaryEmojiOffset = 5_999;
  hit.story_text =
    "a".repeat(preservedEmojiOffset - markerOffset) +
    "😀" +
    "b".repeat(boundaryEmojiOffset - preservedEmojiOffset - 2) +
    "😀";
  return new Response(JSON.stringify({ hits: [hit] }), { status: 200 });
};
`)
  ]);

  execFileSync(process.execPath, [
    "scripts/fetch-public-traction.mjs",
    "--batch=S2026",
    "--company=eden-robotics",
    "--platforms=hacker_news",
    "--social=none",
    "--workers=1",
    "--delay-ms=0",
    "--force",
    `--output=${output}`,
    `--checkpoint=${checkpoint}`,
    `--discovery-attempts=${discoveryAttempts}`,
    `--source-discovery-paths=${sourceDiscoveryPaths}`
  ], {
    cwd: root,
    env: { ...process.env, NODE_OPTIONS: `--import=${preload}` },
    stdio: "pipe"
  });

  const snapshot = JSON.parse(await readFile(output, "utf8"));
  const row = snapshot.evidence.find((item) => item.platform === "hacker_news");
  assert.ok(row);
  assert.equal(row.rawVisibleText.length, 5_999);
  assert.equal([...row.rawVisibleText].filter((character) => character === "😀").length, 1);
  assert.doesNotMatch(row.rawVisibleText, /\uFFFD/u);
  assertWellFormedStrings(snapshot);
});

test("mapped YouTube and Product Hunt URLs get direct account-attributed attempts", async () => {
  const cases = [{
    company: "crebit",
    platform: "youtube",
    expectedEntityId: "a16z-speedrun-006-crebit-founder-jensen-coonradt",
    expectedAccountUrl: "https://youtube.com/@roborebel6031",
    body: `<script>{"videoId":"abcdefghijk","title":{"runs":[{"text":"Crebit founder update"}]},"viewCountText":{"simpleText":"123 views"}}</script>`
  }, {
    company: "quanto",
    platform: "product_hunt",
    expectedEntityId: "a16z-speedrun-006-quanto",
    expectedAccountUrl: "https://producthunt.com/products/quanto",
    body: "Title: Quanto | Product Hunt\nQuanto helps teams move money. 42 upvotes 3 comments"
  }];

  for (const fixture of cases) {
    const directory = await mkdtemp(join(tmpdir(), `returner-public-${fixture.platform}-account-`));
    const output = join(directory, "public-evidence.json");
    const checkpoint = join(directory, "checkpoint.json");
    const discoveryAttempts = join(directory, "discovery-attempts.json");
    const sourceDiscoveryPaths = join(directory, "source-discovery-paths.json");
    const preload = join(directory, "mock-fetch.mjs");
    await Promise.all([
      writeFile(discoveryAttempts, "[]\n"),
      writeFile(sourceDiscoveryPaths, "[]\n"),
      writeFile(preload, `globalThis.fetch = async () => new Response(${JSON.stringify(fixture.body)}, { status: 200 });\n`)
    ]);
    execFileSync(process.execPath, [
      "scripts/fetch-public-traction.mjs",
      "--batch=A16ZSR006",
      `--company=${fixture.company}`,
      `--platforms=${fixture.platform}`,
      "--social=all",
      "--workers=1",
      "--delay-ms=0",
      "--force",
      `--output=${output}`,
      `--checkpoint=${checkpoint}`,
      `--discovery-attempts=${discoveryAttempts}`,
      `--source-discovery-paths=${sourceDiscoveryPaths}`
    ], {
      cwd: root,
      env: {
        ...process.env,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${preload}`].filter(Boolean).join(" ")
      },
      stdio: "pipe"
    });
    const snapshot = JSON.parse(await readFile(output, "utf8"));
    const attempt = Object.values(snapshot.attempts).find(
      (row) => row.entityId === fixture.expectedEntityId && row.accountUrl === fixture.expectedAccountUrl
    );
    assert.ok(attempt, `${fixture.platform} mapped URL did not receive an account attempt`);
    assert.equal(attempt.outcomeStatus, "completed");
    assert.ok(snapshot.evidence.some(
      (row) => row.entityId === fixture.expectedEntityId && row.accountUrl === fixture.expectedAccountUrl
    ));
  }
});

test("official YC embeds and exact Product Hunt launch slugs recover unmapped native sources", async () => {
  const cases = [{
    company: "dayjob",
    batch: "S2026",
    platform: "youtube",
    expectedUrl: "https://www.youtube.com/watch?v=GI2HtwWodpc",
    fetchSource: `
globalThis.fetch = async (url) => {
  const value = String(url);
  if (value.includes("youtube.com/oembed")) {
    return new Response(JSON.stringify({ author_name: "Dayjob", author_url: "https://www.youtube.com/@dayjob" }), { status: 200 });
  }
  if (value === "https://www.youtube.com/watch?v=GI2HtwWodpc") {
    return new Response('<script>{"videoDetails":{"videoId":"GI2HtwWodpc","title":"Dayjob launch","channelId":"UCdayjob123","author":"Dayjob","shortDescription":"Dayjob launch demo","viewCount":"302"},"likeCount":"3","publishDate":"2026-07-01"}</script>', { status: 200 });
  }
  if (value.includes("ycombinator.com/companies/dayjob")) {
    return new Response('<iframe src="https://www.youtube-nocookie.com/embed/GI2HtwWodpc"></iframe>', { status: 200 });
  }
  return new Response('<html></html>', { status: 200 });
};
`
  }, {
    company: "lemonlime",
    batch: "S26",
    platform: "product_hunt",
    expectedUrl: "https://www.producthunt.com/products/lemonlime/launches/lemonlime",
    fetchSource: `
globalThis.fetch = async (url) => {
  const value = String(url);
  if (value.includes("producthunt.com/products/lemonlime/launches/lemonlime")) {
    return new Response('Title: LemonLime | Product Hunt\\nLemonLime automates workflows at lemonlime.ai. 180 upvotes 12 comments', { status: 200 });
  }
  return new Response('<html></html>', { status: 200 });
};
`
  }];

  for (const fixture of cases) {
    const directory = await mkdtemp(join(tmpdir(), `returner-public-official-${fixture.platform}-`));
    const output = join(directory, "public-evidence.json");
    const checkpoint = join(directory, "checkpoint.json");
    const discoveryAttempts = join(directory, "discovery-attempts.json");
    const sourceDiscoveryPaths = join(directory, "source-discovery-paths.json");
    const preload = join(directory, "mock-fetch.mjs");
    await Promise.all([
      writeFile(discoveryAttempts, "[]\n"),
      writeFile(sourceDiscoveryPaths, "[]\n"),
      writeFile(preload, fixture.fetchSource)
    ]);
    execFileSync(process.execPath, [
      "scripts/fetch-public-traction.mjs",
      `--batch=${fixture.batch}`,
      `--company=${fixture.company}`,
      `--platforms=${fixture.platform}`,
      "--social=none",
      "--workers=1",
      "--delay-ms=0",
      "--force",
      `--output=${output}`,
      `--checkpoint=${checkpoint}`,
      `--discovery-attempts=${discoveryAttempts}`,
      `--source-discovery-paths=${sourceDiscoveryPaths}`
    ], {
      cwd: root,
      env: {
        ...process.env,
        X_BEARER_TOKEN: "",
        EXA_API_KEY: "",
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${preload}`].filter(Boolean).join(" ")
      },
      stdio: "pipe"
    });
    const snapshot = JSON.parse(await readFile(output, "utf8"));
    const row = snapshot.evidence.find((candidate) => candidate.sourceUrl === fixture.expectedUrl);
    assert.ok(row, `${fixture.platform} official source was not accepted`);
    assert.ok(Object.values(row.metrics).some((value) => Number(value) > 0));
  }
});

test("generic YouTube discovery rejects embedded short-name channel collisions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "returner-public-youtube-short-name-"));
  const output = join(directory, "public-evidence.json");
  const checkpoint = join(directory, "checkpoint.json");
  const discoveryAttempts = join(directory, "discovery-attempts.json");
  const sourceDiscoveryPaths = join(directory, "source-discovery-paths.json");
  const preload = join(directory, "mock-fetch.mjs");
  const falsePositiveId = "1SwM7Pb8gdQ";
  const strongCompanyId = "KaraStrong1";
  const youtubeResult = ({ videoId, title, channelName, channelId, channelPath, views }) =>
    JSON.stringify({
      videoId,
      title: { runs: [{ text: title }] },
      viewCountText: { simpleText: `${views} views` },
      descriptionSnippet: { runs: [{ text: title }] },
      ownerText: { runs: [{ text: channelName }] },
      browseEndpoint: { browseId: channelId },
      canonicalBaseUrl: channelPath
    });
  const searchBody = [
    youtubeResult({
      videoId: falsePositiveId,
      title: "Kara's Toy Kingdom Experience Summer 2026",
      channelName: "Kaiser & Kara's World",
      channelId: "UCKaiserAndKara",
      channelPath: "/@kaikaraworld",
      views: 108
    }),
    youtubeResult({
      videoId: strongCompanyId,
      title: "Kara (YC S26): Making diamond an engineering material",
      channelName: "Kara Labs",
      channelId: "UCKaraLabsOfficial",
      channelPath: "/@karalabs",
      views: 240
    })
  ].join("");

  await Promise.all([
    writeFile(discoveryAttempts, "[]\n"),
    writeFile(sourceDiscoveryPaths, "[]\n"),
    writeFile(preload, `
const searchBody = ${JSON.stringify(searchBody)};
globalThis.fetch = async (url) => {
  const value = String(url);
  if (value.includes("youtube.com/results")) {
    return new Response(searchBody, { status: 200 });
  }
  return new Response("<html></html>", { status: 200 });
};
`)
  ]);

  execFileSync(process.execPath, [
    "scripts/fetch-public-traction.mjs",
    "--batch=S26",
    "--company=kara",
    "--platforms=youtube",
    "--social=none",
    "--workers=1",
    "--delay-ms=0",
    "--force",
    `--output=${output}`,
    `--checkpoint=${checkpoint}`,
    `--discovery-attempts=${discoveryAttempts}`,
    `--source-discovery-paths=${sourceDiscoveryPaths}`
  ], {
    cwd: root,
    env: {
      ...process.env,
      X_BEARER_TOKEN: "",
      EXA_API_KEY: "",
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${preload}`].filter(Boolean).join(" ")
    },
    stdio: "pipe"
  });

  const snapshot = JSON.parse(await readFile(output, "utf8"));
  assert.equal(
    snapshot.evidence.some((row) => row.platformPostId === falsePositiveId),
    false
  );
  const rejected = snapshot.needsReview.find((row) => row.platformPostId === falsePositiveId);
  assert.ok(rejected);
  assert.equal(rejected.semanticAttributionReason, "collision_prone_name_without_independent_anchor");
  assert.match(rejected.matchReason, /semantic youtube attribution rejected/i);

  const accepted = snapshot.evidence.find((row) => row.platformPostId === strongCompanyId);
  assert.ok(accepted);
  assert.equal(accepted.attributionStatus, "verified");
  assert.match(accepted.matchReason, /independent_identity_anchor|exact_company_and_expected_cohort/);
});

test("official X recent search becomes exact mapped-owner evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "returner-public-x-api-"));
  const output = join(directory, "public-evidence.json");
  const checkpoint = join(directory, "checkpoint.json");
  const discoveryAttempts = join(directory, "discovery-attempts.json");
  const sourceDiscoveryPaths = join(directory, "source-discovery-paths.json");
  const preload = join(directory, "mock-fetch.mjs");
  await Promise.all([
    writeFile(discoveryAttempts, "[]\n"),
    writeFile(sourceDiscoveryPaths, "[]\n"),
    writeFile(preload, `
globalThis.fetch = async (url, options = {}) => {
  const value = String(url);
  if (value.startsWith("https://api.x.com/2/tweets/search/recent")) {
    if (options.headers.Authorization !== "Bearer test-x-token") throw new Error("missing bearer token");
    return new Response(JSON.stringify({
      data: [{
        id: "1234567890123456789",
        author_id: "42",
        text: "Taxnova launch update",
        created_at: "2026-07-22T10:00:00.000Z",
        public_metrics: { impression_count: 500, like_count: 20, reply_count: 2, retweet_count: 3, quote_count: 1 }
      }],
      includes: { users: [{ id: "42", username: "taxnovaai", name: "Taxnova" }] },
      meta: { result_count: 1 }
    }), { status: 200 });
  }
  throw new Error("public-reader fallback should not run when the official X API returns evidence");
};
`)
  ]);
  execFileSync(process.execPath, [
    "scripts/fetch-public-traction.mjs",
    "--batch=A16ZSR006",
    "--company=taxnova",
    "--platforms=x",
    "--social=company",
    "--workers=1",
    "--delay-ms=0",
    "--force",
    `--output=${output}`,
    `--checkpoint=${checkpoint}`,
    `--discovery-attempts=${discoveryAttempts}`,
    `--source-discovery-paths=${sourceDiscoveryPaths}`
  ], {
    cwd: root,
    env: {
      ...process.env,
      X_BEARER_TOKEN: "test-x-token",
      EXA_API_KEY: "",
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${preload}`].filter(Boolean).join(" ")
    },
    stdio: "pipe"
  });

  const snapshot = JSON.parse(await readFile(output, "utf8"));
  const row = snapshot.evidence.find((candidate) => candidate.platformPostId === "1234567890123456789");
  assert.ok(row);
  assert.equal(row.entityId, "a16z-speedrun-006-taxnova");
  assert.equal(row.authorHandle, "taxnovaai");
  assert.equal(row.metrics.likes, 20);
  assert.equal(row.attributionProvenance, "x_recent_search_exact_mapped_author_v1");
  assert.equal(snapshot.source.credentialedDiscovery.x.successfulRequestCount, 1);
});

test("discovery ledgers keep identical cross-batch owner identities distinct", async () => {
  const idsByBatch = new Map();
  for (const batch of ["S2026", "S26"]) {
    const directory = await mkdtemp(join(tmpdir(), `returner-public-${batch.toLowerCase()}-identity-`));
    const output = join(directory, "public-evidence.json");
    const checkpoint = join(directory, "checkpoint.json");
    const discoveryAttempts = join(directory, "discovery-attempts.json");
    const sourceDiscoveryPaths = join(directory, "source-discovery-paths.json");
    const preload = join(directory, "mock-fetch.mjs");
    await Promise.all([
      writeFile(discoveryAttempts, "[]\n"),
      writeFile(sourceDiscoveryPaths, "[]\n"),
      writeFile(preload, "globalThis.fetch = async () => new Response('<html></html>', { status: 200 });\n")
    ]);
    execFileSync(process.execPath, [
      "scripts/fetch-public-traction.mjs",
      `--batch=${batch}`,
      "--company=textsidekick",
      "--platforms=instagram",
      "--social=company",
      "--workers=1",
      "--delay-ms=0",
      "--force",
      `--output=${output}`,
      `--checkpoint=${checkpoint}`,
      `--discovery-attempts=${discoveryAttempts}`,
      `--source-discovery-paths=${sourceDiscoveryPaths}`
    ], {
      cwd: root,
      env: {
        ...process.env,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${preload}`].filter(Boolean).join(" ")
      },
      stdio: "pipe"
    });
    const attempts = JSON.parse(await readFile(discoveryAttempts, "utf8"));
    idsByBatch.set(batch, new Set(attempts.map((row) => row.id)));
    assert.ok(attempts.length > 0);
    assert.ok(attempts.every((row) => row.batch_slug === batch));
  }
  assert.deepEqual(
    [...idsByBatch.get("S2026")].filter((id) => idsByBatch.get("S26").has(id)),
    []
  );
});

test("readable LinkedIn profiles with zero posts fall back to founder-first discovery and require the native author", async () => {
  const directory = await mkdtemp(join(tmpdir(), "returner-public-linkedin-fallback-"));
  const output = join(directory, "public-evidence.json");
  const checkpoint = join(directory, "checkpoint.json");
  const discoveryAttempts = join(directory, "discovery-attempts.json");
  const sourceDiscoveryPaths = join(directory, "source-discovery-paths.json");
  const preload = join(directory, "mock-fetch.mjs");
  const goodPost = "https://www.linkedin.com/posts/russellhowardsmith_counter-drone-activity-7999999999999999991-good";
  const wrongAuthorPost = "https://www.linkedin.com/posts/someone-else_counter-drone-activity-7999999999999999992-bad";
  const snippetOnlyPost = "https://www.linkedin.com/posts/russellhowardsmith_counter-drone-activity-7999999999999999994-snippet";
  const canonicalGoodPost = goodPost.replace("www.linkedin.com", "linkedin.com");
  const canonicalWrongAuthorPost = wrongAuthorPost.replace("www.linkedin.com", "linkedin.com");
  const canonicalSnippetOnlyPost = snippetOnlyPost.replace("www.linkedin.com", "linkedin.com");

  await Promise.all([
    writeFile(output, `${JSON.stringify({ source: {}, evidence: [], needsReview: [], failures: [] }, null, 2)}\n`),
    writeFile(checkpoint, `${JSON.stringify({ attempts: {}, evidence: [], needsReview: [], failures: [], discoveryAttempts: [], sourceDiscoveryPaths: [] }, null, 2)}\n`),
    writeFile(discoveryAttempts, "[]\n"),
    writeFile(sourceDiscoveryPaths, "[]\n"),
    writeFile(preload, `
const goodPost = ${JSON.stringify(goodPost)};
const wrongAuthorPost = ${JSON.stringify(wrongAuthorPost)};
const snippetOnlyPost = ${JSON.stringify(snippetOnlyPost)};
const response = (body) => new Response(body, { status: 200, headers: { "content-type": "text/html" } });
globalThis.fetch = async (input) => {
  const rawUrl = String(input);
  if (rawUrl.startsWith("https://duckduckgo.com/html/")) {
    const query = new URL(rawUrl).searchParams.get("q") ?? "";
    if (!query.includes("Russell Smith")) return response("<html></html>");
    return response(\`<html><body>
      <div class="result"><h2 class="result__title"><a class="result__a" href="\${goodPost}">Russell Smith at 9 Mothers</a></h2><div class="result__snippet">9 Mothers founder startup update with 20 reactions</div></div>
      <div class="result"><h2 class="result__title"><a class="result__a" href="\${wrongAuthorPost}">Russell Smith and 9 Mothers</a></h2><div class="result__snippet">9 Mothers founder startup update with 20 reactions</div></div>
      <div class="result"><h2 class="result__title"><a class="result__a" href="\${snippetOnlyPost}">Russell Smith at 9 Mothers</a></h2><div class="result__snippet">9 Mothers founder startup update with 999 reactions</div></div>
    </body></html>\`);
  }
  if (rawUrl.includes("7999999999999999991")) {
    return response(["Title: Russell Smith update | LinkedIn", "URL Source: " + goodPost, "Markdown Content:", "# Russell Smith's Post", "[Report this post](https://linkedin.com/guest?guestReportContentType=POST)", "Russell Smith at 9 Mothers shares a startup update.", "[![Image 1](https://static.licdn.com/a) 20](https://linkedin.com/signup)[2 Comments](https://linkedin.com/signup)", "[Like](https://linkedin.com/signup)[Comment](https://linkedin.com/signup) Share"].join("\\n"));
  }
  if (rawUrl.includes("7999999999999999992")) {
    return response(["Title: Someone Else mentions 9 Mothers | LinkedIn", "URL Source: " + wrongAuthorPost, "Markdown Content:", "# Someone Else's Post", "[Report this post](https://linkedin.com/guest?guestReportContentType=POST)", "Someone Else shares a 9 Mothers startup update.", "[![Image 1](https://static.licdn.com/a) 20](https://linkedin.com/signup)[2 Comments](https://linkedin.com/signup)", "[Like](https://linkedin.com/signup)[Comment](https://linkedin.com/signup) Share"].join("\\n"));
  }
  if (rawUrl.includes("7999999999999999994")) {
    return response("Target URL returned error 403: Access denied. To continue, log in.");
  }
  if (rawUrl.includes("linkedin.com/in/russellhowardsmith")) {
    return response("Title: Russell Smith | LinkedIn\\nRussell Smith is a founder at 9 Mothers. No native activity links are visible here.");
  }
  return response("Title: Unmatched LinkedIn profile\\nThis readable profile does not match the requested entity.");
};
`)
  ]);

  execFileSync(process.execPath, [
    "scripts/fetch-public-traction.mjs",
    "--batch=S2026",
    "--company=9-mothers-corporation",
    "--platforms=linkedin",
    "--social=all",
    "--workers=1",
    "--delay-ms=0",
    "--force",
    `--output=${output}`,
    `--checkpoint=${checkpoint}`,
    `--discovery-attempts=${discoveryAttempts}`,
    `--source-discovery-paths=${sourceDiscoveryPaths}`
  ], {
    cwd: root,
    env: {
      ...process.env,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${preload}`].filter(Boolean).join(" ")
    },
    stdio: "pipe"
  });

  const [normalized, paths, attempts] = await Promise.all([
    readFile(output, "utf8").then(JSON.parse),
    readFile(sourceDiscoveryPaths, "utf8").then(JSON.parse),
    readFile(discoveryAttempts, "utf8").then(JSON.parse)
  ]);
  const founderId = "founder-9-mothers-corporation-russell-smith-1373";
  const nativeFounderPosts = normalized.evidence.filter(
    (row) => row.entityId === founderId && row.platformPostId
  );
  assert.deepEqual(nativeFounderPosts.map((row) => row.sourceUrl), [canonicalGoodPost]);
  assert.equal(nativeFounderPosts[0].authorHandle, "russellhowardsmith");
  assert.ok(nativeFounderPosts[0].contributionScore > 0);
  const wrongAuthorReviews = normalized.needsReview.filter(
    (row) => row.candidateUrl === canonicalWrongAuthorPost
  );
  assert.ok(wrongAuthorReviews.some((row) => /semantic attribution/i.test(row.matchReason)));
  assert.equal(normalized.evidence.some((row) => row.sourceUrl === canonicalWrongAuthorPost), false);
  assert.equal(normalized.evidence.some((row) => row.sourceUrl === canonicalSnippetOnlyPost), false);
  assert.ok(normalized.needsReview.some((row) => row.candidateUrl === canonicalSnippetOnlyPost));
  assert.ok(
    paths.some(
      (row) =>
        row.discovered_url === canonicalGoodPost &&
        /readable but exposed no verified native posts/i.test(row.match_reason) &&
        /site:linkedin\.com\/posts/i.test(row.match_reason)
    )
  );
  assert.ok(paths.length > 0 && paths.every((row) => row.batch_slug === "S2026"));
  assert.ok(attempts.length > 0 && attempts.every((row) => row.batch_slug === "S2026"));
  assert.ok(normalized.sourceDiscoveryPaths.every((row) => row.batch_slug === "S2026"));
  assert.ok(normalized.discoveryAttempts.every((row) => row.batch_slug === "S2026"));
});

test("public LinkedIn search verifies every native post exposed by a bounded response", async () => {
  const directory = await mkdtemp(join(tmpdir(), "returner-public-linkedin-search-exhaustive-"));
  const output = join(directory, "public-evidence.json");
  const checkpoint = join(directory, "checkpoint.json");
  const discoveryAttempts = join(directory, "discovery-attempts.json");
  const sourceDiscoveryPaths = join(directory, "source-discovery-paths.json");
  const preload = join(directory, "mock-fetch.mjs");
  const postUrls = Array.from({ length: 10 }, (_, index) =>
    `https://www.linkedin.com/posts/russellhowardsmith_nine-mothers-activity-${8000000000000000000n + BigInt(index)}-public-${index}`
  );
  const canonicalPostUrls = postUrls.map((url) => url.replace("www.linkedin.com", "linkedin.com"));

  await Promise.all([
    writeFile(output, `${JSON.stringify({ source: {}, evidence: [], needsReview: [], failures: [] }, null, 2)}\n`),
    writeFile(checkpoint, `${JSON.stringify({ attempts: {}, evidence: [], needsReview: [], failures: [], discoveryAttempts: [], sourceDiscoveryPaths: [] }, null, 2)}\n`),
    writeFile(discoveryAttempts, "[]\n"),
    writeFile(sourceDiscoveryPaths, "[]\n"),
    writeFile(preload, `
const postUrls = ${JSON.stringify(postUrls)};
const response = (body) => new Response(body, { status: 200, headers: { "content-type": "text/html" } });
globalThis.fetch = async (input) => {
  const rawUrl = String(input);
  if (rawUrl.startsWith("https://duckduckgo.com/html/")) {
    const query = new URL(rawUrl).searchParams.get("q") ?? "";
    if (!query.includes("Russell Smith")) return response("<html></html>");
    return response("<html><body>" + postUrls.map((postUrl, index) =>
      '<div class="result"><h2 class="result__title"><a class="result__a" href="' + postUrl + '">Russell Smith at 9 Mothers update ' + index + '</a></h2><div class="result__snippet">9 Mothers founder public startup update</div></div>'
    ).join("") + "</body></html>");
  }
  const postUrl = postUrls.find((candidate) => rawUrl.includes(candidate.match(/activity-(\\d+)/)[1]));
  if (postUrl) {
    return response([
      "Title: Russell Smith update | LinkedIn",
      "URL Source: " + postUrl,
      "Markdown Content:",
      "# Russell Smith's Post",
      "[Report this post](https://linkedin.com/guest?guestReportContentType=POST)",
      "Russell Smith at 9 Mothers shares a public startup update.",
      "[![Image 1](https://static.licdn.com/a) 20](https://linkedin.com/signup)[2 Comments](https://linkedin.com/signup)",
      "[Like](https://linkedin.com/signup)[Comment](https://linkedin.com/signup) Share"
    ].join("\\n"));
  }
  if (rawUrl.includes("linkedin.com/in/russellhowardsmith")) {
    return response("Title: Russell Smith | LinkedIn\\nRussell Smith is a founder at 9 Mothers. No native activity links are visible here.");
  }
  return response("Title: Unmatched LinkedIn profile\\nThis readable profile does not match the requested entity.");
};
`)
  ]);

  execFileSync(process.execPath, [
    "scripts/fetch-public-traction.mjs",
    "--batch=S2026",
    "--company=9-mothers-corporation",
    "--platforms=linkedin",
    "--social=all",
    "--workers=1",
    "--delay-ms=0",
    "--force",
    `--output=${output}`,
    `--checkpoint=${checkpoint}`,
    `--discovery-attempts=${discoveryAttempts}`,
    `--source-discovery-paths=${sourceDiscoveryPaths}`
  ], {
    cwd: root,
    env: {
      ...process.env,
      EXA_API_KEY: "",
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${preload}`].filter(Boolean).join(" ")
    },
    stdio: "pipe"
  });

  const snapshot = JSON.parse(await readFile(output, "utf8"));
  const founderId = "founder-9-mothers-corporation-russell-smith-1373";
  const sourceUrls = snapshot.evidence
    .filter((row) => row.entityId === founderId && row.platformPostId)
    .map((row) => row.sourceUrl)
    .sort();
  assert.deepEqual(sourceUrls, canonicalPostUrls.sort());
});

test("public LinkedIn profiles verify every native post URL exposed in the profile response", async () => {
  const directory = await mkdtemp(join(tmpdir(), "returner-public-linkedin-profile-exhaustive-"));
  const output = join(directory, "public-evidence.json");
  const checkpoint = join(directory, "checkpoint.json");
  const discoveryAttempts = join(directory, "discovery-attempts.json");
  const sourceDiscoveryPaths = join(directory, "source-discovery-paths.json");
  const preload = join(directory, "mock-fetch.mjs");
  const postUrls = Array.from({ length: 6 }, (_, index) =>
    `https://www.linkedin.com/posts/russellhowardsmith_profile-activity-${8100000000000000000n + BigInt(index)}-public-${index}`
  );
  const canonicalPostUrls = postUrls.map((url) => url.replace("www.linkedin.com", "linkedin.com"));

  await Promise.all([
    writeFile(output, `${JSON.stringify({ source: {}, evidence: [], needsReview: [], failures: [] }, null, 2)}\n`),
    writeFile(checkpoint, `${JSON.stringify({ attempts: {}, evidence: [], needsReview: [], failures: [], discoveryAttempts: [], sourceDiscoveryPaths: [] }, null, 2)}\n`),
    writeFile(discoveryAttempts, "[]\n"),
    writeFile(sourceDiscoveryPaths, "[]\n"),
    writeFile(preload, `
const postUrls = ${JSON.stringify(postUrls)};
const response = (body) => new Response(body, { status: 200, headers: { "content-type": "text/html" } });
globalThis.fetch = async (input) => {
  const rawUrl = String(input);
  if (rawUrl.startsWith("https://duckduckgo.com/html/")) return response("<html></html>");
  const postUrl = postUrls.find((candidate) => rawUrl.includes(candidate.match(/activity-(\\d+)/)[1]));
  if (postUrl) {
    return response([
      "Title: Russell Smith update | LinkedIn",
      "URL Source: " + postUrl,
      "Markdown Content:",
      "# Russell Smith's Post",
      "[Report this post](https://linkedin.com/guest?guestReportContentType=POST)",
      "Russell Smith at 9 Mothers shares a public startup update.",
      "[![Image 1](https://static.licdn.com/a) 20](https://linkedin.com/signup)[2 Comments](https://linkedin.com/signup)",
      "[Like](https://linkedin.com/signup)[Comment](https://linkedin.com/signup) Share"
    ].join("\\n"));
  }
  if (rawUrl.includes("linkedin.com/in/russellhowardsmith")) {
    return response([
      "Title: Russell Smith | LinkedIn",
      "Russell Smith is a founder at 9 Mothers.",
      ...postUrls.map((url, index) => "[Public post " + index + "](" + url + ")")
    ].join("\\n"));
  }
  return response("Title: Unmatched LinkedIn profile\\nThis readable profile does not match the requested entity.");
};
`)
  ]);

  execFileSync(process.execPath, [
    "scripts/fetch-public-traction.mjs",
    "--batch=S2026",
    "--company=9-mothers-corporation",
    "--platforms=linkedin",
    "--social=all",
    "--workers=1",
    "--delay-ms=0",
    "--force",
    `--output=${output}`,
    `--checkpoint=${checkpoint}`,
    `--discovery-attempts=${discoveryAttempts}`,
    `--source-discovery-paths=${sourceDiscoveryPaths}`
  ], {
    cwd: root,
    env: {
      ...process.env,
      EXA_API_KEY: "",
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${preload}`].filter(Boolean).join(" ")
    },
    stdio: "pipe"
  });

  const snapshot = JSON.parse(await readFile(output, "utf8"));
  const founderId = "founder-9-mothers-corporation-russell-smith-1373";
  const sourceUrls = snapshot.evidence
    .filter((row) => row.entityId === founderId && row.platformPostId)
    .map((row) => row.sourceUrl)
    .sort();
  assert.deepEqual(sourceUrls, canonicalPostUrls.sort());
});

test("verified LinkedIn vanity aliases keep Eden founder discovery eligible", async () => {
  const directory = await mkdtemp(join(tmpdir(), "returner-public-linkedin-alias-"));
  const output = join(directory, "public-evidence.json");
  const checkpoint = join(directory, "checkpoint.json");
  const discoveryAttempts = join(directory, "discovery-attempts.json");
  const sourceDiscoveryPaths = join(directory, "source-discovery-paths.json");
  const preload = join(directory, "mock-fetch.mjs");
  const postUrl = "https://www.linkedin.com/posts/stamatis-floratos-535b19244_eden-robotics-activity-7999999999999999993-good";
  const canonicalPostUrl = postUrl.replace("www.linkedin.com", "linkedin.com");

  await Promise.all([
    writeFile(output, `${JSON.stringify({ source: {}, evidence: [], needsReview: [], failures: [] }, null, 2)}\n`),
    writeFile(checkpoint, `${JSON.stringify({ attempts: {}, evidence: [], needsReview: [], failures: [], discoveryAttempts: [], sourceDiscoveryPaths: [] }, null, 2)}\n`),
    writeFile(discoveryAttempts, "[]\n"),
    writeFile(sourceDiscoveryPaths, `${JSON.stringify([{
      id: "seed-company-owned-eden-linkedin-post",
      batch_slug: "S2026",
      company_id: "company-eden-robotics",
      company_slug: "eden-robotics",
      company_name: "Eden Robotics",
      source_url: "https://www.linkedin.com/company/eden-ai-robotics",
      discovered_url: canonicalPostUrl,
      discovered_platform: "linkedin",
      discovered_entity_type: "company",
      discovered_entity_id: "company-eden-robotics",
      discovered_entity_name: "Eden Robotics",
      match_reason: "Company fallback exposed a native founder-authored LinkedIn post.",
      review_state: "verified",
      created_at: "2026-07-20T00:00:00.000Z"
    }], null, 2)}\n`),
    writeFile(preload, `
const postUrl = ${JSON.stringify(postUrl)};
const response = (body) => new Response(body, { status: 200, headers: { "content-type": "text/html" } });
globalThis.fetch = async (input) => {
  const rawUrl = String(input);
  if (rawUrl.startsWith("https://duckduckgo.com/html/")) {
    return response("<html></html>");
  }
  if (rawUrl.includes("7999999999999999993")) {
    return response([
      "Title: Stamatis Floratos at Eden Robotics | LinkedIn",
      "URL Source: " + postUrl,
      "Markdown Content:",
      "# Eden Robotics founder update",
      "[Stamatis Floratos](https://www.linkedin.com/in/stamatis-floratos-535b19244)",
      "[Report this post](https://www.linkedin.com/uas/login?guestReportContentType=POST)",
      "Stamatis Floratos shares an Eden Robotics (YC P26) founder update. 20 reactions 2 comments",
      "[![Image 1](https://static.licdn.com/a) 20](https://linkedin.com/signup)[2 Comments](https://linkedin.com/signup)",
      "[Like](https://www.linkedin.com/login)[Comment](https://www.linkedin.com/login) Share",
      "## More Relevant Posts",
      "Unrelated footer content"
    ].join("\\n"));
  }
  if (rawUrl.includes("linkedin.com/in/stamatis-floratos-535b19244")) {
    return response("Target URL returned error 403: Access denied. To continue, log in.");
  }
  return response("Title: Unmatched LinkedIn profile\\nThis readable profile does not match the requested entity.");
};
`)
  ]);

  execFileSync(process.execPath, [
    "scripts/fetch-public-traction.mjs",
    "--batch=S2026",
    "--company=eden-robotics",
    "--platforms=linkedin",
    "--social=all",
    "--workers=1",
    "--delay-ms=0",
    "--force",
    `--output=${output}`,
    `--checkpoint=${checkpoint}`,
    `--discovery-attempts=${discoveryAttempts}`,
    `--source-discovery-paths=${sourceDiscoveryPaths}`
  ], {
    cwd: root,
    env: {
      ...process.env,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${preload}`].filter(Boolean).join(" ")
    },
    stdio: "pipe"
  });

  const normalized = JSON.parse(await readFile(output, "utf8"));
  const founderId = "founder-eden-robotics-stamatios-floratos-1956825";
  const nativeFounderPosts = normalized.evidence.filter(
    (row) => row.entityId === founderId && row.platformPostId
  );
  assert.deepEqual(nativeFounderPosts.map((row) => row.sourceUrl), [canonicalPostUrl]);
  assert.equal(nativeFounderPosts[0].authorHandle, "stamatis-floratos-535b19244");
  assert.ok(nativeFounderPosts[0].contributionScore > 0);
});

test("checkpoint flush canonicalizes native IDs, eligibility, and exact social authors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "returner-public-normalization-"));
  const output = join(directory, "public-evidence.json");
  const checkpoint = join(directory, "checkpoint.json");
  const discoveryAttempts = join(directory, "discovery-attempts.json");
  const sourceDiscoveryPaths = join(directory, "source-discovery-paths.json");
  const base = {
    entityType: "company",
    entityId: "company-9-mothers-corporation",
    companySlug: "9-mothers-corporation",
    companyName: "9 Mothers",
    title: "Fixture",
    text: "Fixture",
    rawVisibleText: "Fixture",
    postedAt: "2026-07-18T12:00:00.000Z",
    review_state: "verified",
    matchReason: "Verified public post candidate from search results.",
    first_seen_at: "2026-07-18T12:00:00.000Z",
    last_checked_at: "2026-07-18T12:00:00.000Z",
    last_updated_at: "2026-07-18T12:00:00.000Z"
  };
  const rows = [
    {
      ...base,
      id: "hn-destination-fixture",
      platform: "hacker_news",
      sourceUrl: "https://9mothers.com/launch",
      platformPostId: null,
      rawVisibleText: JSON.stringify({ objectID: "44770001", url: "https://9mothers.com/launch" }),
      metrics: { upvotes: 12, comments: 3 },
      contributionScore: 99
    },
    {
      ...base,
      id: "linkedin-slug-id-fixture",
      platform: "linkedin",
      sourceUrl: "https://www.linkedin.com/posts/9-mothers_counter-drone-activity-7475266867537039360-QwfJ?utm_source=test",
      platformPostId: "9-mothers_counter-drone-activity-7475266867537039360-QwfJ",
      metrics: { reactions: 20, comments: 4 },
      contributionScore: 99
    },
    {
      ...base,
      id: "hn-unrecoverable-fixture",
      platform: "hacker_news",
      sourceUrl: "https://9mothers.com/no-native-id",
      platformPostId: null,
      rawVisibleText: JSON.stringify({ url: "https://9mothers.com/no-native-id" }),
      metrics: { upvotes: 8 },
      contributionScore: 99
    },
    {
      ...base,
      id: "mapped-founder-x-fixture",
      platform: "x",
      sourceUrl: "https://x.com/rhs/status/2070898557645660388",
      platformPostId: "2070898557645660388",
      metrics: { views: 7_100 },
      contributionScore: 99
    },
    {
      ...base,
      id: "third-party-instagram-fixture",
      platform: "instagram",
      sourceUrl: "https://instagram.com/p/DZvV_fMj2Mw",
      platformPostId: "DZvV_fMj2Mw",
      rawVisibleText: "Never miss a post from brycent [brycent](https://instagram.com/brycent/)",
      metrics: { likes: 2 },
      contributionScore: 99
    },
    {
      ...base,
      id: "empty-youtube-fixture",
      platform: "youtube",
      sourceUrl: "https://www.youtube.com/watch?v=abcdefghijk",
      platformPostId: "abcdefghijk",
      metrics: {},
      contributionScore: 99
    },
    {
      ...base,
      id: "linkedin-hallucinated-comments-fixture",
      platform: "linkedin",
      sourceUrl: "https://www.linkedin.com/posts/arctic-health_activity-7479951057700306944-test",
      platformPostId: "7479951057700306944",
      rawVisibleText: "The native post visibly shows 13 reactions. Like Comment Share",
      metrics: { comments: 47_000 },
      contributionScore: 100
    },
    {
      ...base,
      id: "linkedin-parent-engagement-fixture",
      platform: "linkedin",
      sourceUrl: "https://www.linkedin.com/posts/russellhowardsmith_counter-drone-activity-7475000000000000003-good",
      platformPostId: "7475000000000000003",
      rawVisibleText: [
        "URL Source: https://www.linkedin.com/posts/russellhowardsmith_counter-drone-activity-7475000000000000003-good",
        "# Russell Smith's Post",
        "[Report this post](https://linkedin.com/guest?guestReportContentType=POST)",
        "Counter-drone systems from 9 Mothers (YC P26).",
        "[![Image 1](https://static.licdn.com/reaction-a)![Image 2](https://static.licdn.com/reaction-b) 236](https://linkedin.com/signup)",
        "[24 Comments](https://linkedin.com/signup)",
        "[Like](https://linkedin.com/signup) [Comment](https://linkedin.com/signup) Share",
        "[Report this comment](https://linkedin.com/guest?guestReportContentType=COMMENT)",
        "Helpful reply 1 Reaction",
        "Another reply 1 Reaction"
      ].join(" "),
      metrics: { reactions: 1, comments: 24 },
      contributionScore: 1
    },
    {
      ...base,
      id: "founder-linkedin-author-match",
      entityType: "founder",
      entityId: "founder-9-mothers-corporation-russell-smith-1373",
      platform: "linkedin",
      sourceUrl: "https://www.linkedin.com/posts/russellhowardsmith_counter-drone-activity-7475000000000000001-good",
      platformPostId: "7475000000000000001",
      metrics: { reactions: 18 },
      contributionScore: 99
    },
    {
      ...base,
      id: "founder-linkedin-author-mismatch",
      entityType: "founder",
      entityId: "founder-9-mothers-corporation-russell-smith-1373",
      platform: "linkedin",
      sourceUrl: "https://www.linkedin.com/posts/someone-else_counter-drone-activity-7475000000000000002-bad",
      platformPostId: "7475000000000000002",
      metrics: { reactions: 18 },
      contributionScore: 99
    },
    {
      ...base,
      id: "ambiguous-linkedin-first",
      title: "9 Mothers (YC P26) and Dayjob (YC P26) startup collaboration",
      text: "9 Mothers (YC P26) and Dayjob (YC P26) startup collaboration",
      rawVisibleText: "9 Mothers (YC P26) and Dayjob (YC P26) startup collaboration",
      platform: "linkedin",
      sourceUrl: "https://www.linkedin.com/posts/example_activity-7475000000000000000-test",
      platformPostId: "7475000000000000000",
      metrics: { reactions: 10 },
      contributionScore: 99
    },
    {
      ...base,
      id: "ambiguous-linkedin-second",
      entityId: "company-dayjob",
      companySlug: "dayjob",
      companyName: "Dayjob",
      title: "9 Mothers (YC P26) and Dayjob (YC P26) startup collaboration",
      text: "9 Mothers (YC P26) and Dayjob (YC P26) startup collaboration",
      rawVisibleText: "9 Mothers (YC P26) and Dayjob (YC P26) startup collaboration",
      platform: "linkedin",
      sourceUrl: "https://linkedin.com/posts/example_activity-7475000000000000000-test",
      platformPostId: "7475000000000000000",
      metrics: { reactions: 10 },
      contributionScore: 99
    }
  ];

  await Promise.all([
    writeFile(output, `${JSON.stringify({ source: {}, evidence: rows, needsReview: [], failures: [] }, null, 2)}\n`),
    writeFile(checkpoint, `${JSON.stringify({ attempts: {}, evidence: [], needsReview: [], failures: [], discoveryAttempts: [], sourceDiscoveryPaths: [] }, null, 2)}\n`),
    writeFile(discoveryAttempts, "[]\n"),
    writeFile(sourceDiscoveryPaths, "[]\n")
  ]);

  execFileSync(process.execPath, [
    "scripts/fetch-public-traction.mjs",
    "--batch=S2026",
    "--max-companies=0",
    "--social=none",
    "--workers=1",
    "--delay-ms=0",
    `--output=${output}`,
    `--checkpoint=${checkpoint}`,
    `--discovery-attempts=${discoveryAttempts}`,
    `--source-discovery-paths=${sourceDiscoveryPaths}`
  ], { cwd: root, stdio: "pipe" });

  const normalized = JSON.parse(await readFile(output, "utf8"));
  const byId = new Map(normalized.evidence.map((row) => [row.id, row]));
  const reviewById = new Map(normalized.needsReview.map((row) => [row.id, row]));
  const hackerNews = byId.get("hn-destination-fixture");
  const linkedIn = byId.get("linkedin-slug-id-fixture");
  const mappedFounder = byId.get("mapped-founder-x-fixture");
  const thirdParty = reviewById.get("third-party-instagram-fixture");
  const emptyMetrics = reviewById.get("empty-youtube-fixture");
  const hallucinatedLinkedInComments = reviewById.get("linkedin-hallucinated-comments-fixture");
  const linkedInParentEngagement = byId.get("linkedin-parent-engagement-fixture");
  const matchingFounderLinkedIn = byId.get("founder-linkedin-author-match");
  const mismatchingFounderLinkedIn = reviewById.get("founder-linkedin-author-mismatch");

  assert.equal(hackerNews.sourceUrl, "https://news.ycombinator.com/item?id=44770001");
  assert.equal(hackerNews.submittedUrl, "https://9mothers.com/launch");
  assert.equal(hackerNews.platformPostId, "44770001");
  assert.ok(hackerNews.contributionScore > 0);
  assert.equal(linkedIn.platformPostId, "7475266867537039360");
  assert.equal(linkedIn.sourceUrl.includes("utm_source"), false);
  assert.ok(linkedIn.contributionScore > 0);
  assert.equal(mappedFounder.authorHandle, "rhs");
  assert.ok(mappedFounder.contributionScore > 0);
  assert.equal(mappedFounder.review_state, "verified");
  assert.equal(thirdParty.authorHandle, "brycent");
  assert.equal(thirdParty.contributionScore, 0);
  assert.equal(thirdParty.review_state, "needs_review");
  assert.match(thirdParty.matchReason, /semantic company attribution/i);
  assert.equal(emptyMetrics.contributionScore, 0);
  assert.equal(emptyMetrics.review_state, "needs_review");
  assert.match(emptyMetrics.matchReason, /no positive supported visible traction metric/i);
  assert.deepEqual(hallucinatedLinkedInComments.metrics, {});
  assert.equal(hallucinatedLinkedInComments.contributionScore, 0);
  assert.equal(hallucinatedLinkedInComments.review_state, "needs_review");
  assert.match(hallucinatedLinkedInComments.matchReason, /no positive supported visible traction metric/i);
  assert.deepEqual(linkedInParentEngagement.metrics, { reactions: 236, comments: 24 });
  assert.ok(linkedInParentEngagement.contributionScore > 0);
  assert.equal(linkedInParentEngagement.review_state, "verified");
  assert.equal(matchingFounderLinkedIn.authorHandle, "russellhowardsmith");
  assert.ok(matchingFounderLinkedIn.contributionScore > 0);
  assert.equal(matchingFounderLinkedIn.review_state, "verified");
  assert.equal(mismatchingFounderLinkedIn.contributionScore, 0);
  assert.equal(mismatchingFounderLinkedIn.review_state, "needs_review");
  assert.match(mismatchingFounderLinkedIn.matchReason, /could not match the native post author/i);
  for (const id of [
    "third-party-instagram-fixture",
    "empty-youtube-fixture",
    "linkedin-hallucinated-comments-fixture",
    "founder-linkedin-author-mismatch"
  ]) {
    assert.equal(byId.has(id), false, `${id} must be surfaced as review debt, not successful evidence`);
  }
  assert.equal(byId.has("hn-unrecoverable-fixture"), false);
  assert.equal(byId.has("ambiguous-linkedin-first"), true);
  assert.equal(byId.has("ambiguous-linkedin-second"), true);
  const unrecoverableReview = normalized.needsReview.find((row) => row.submittedUrl === "https://9mothers.com/no-native-id");
  assert.equal(unrecoverableReview.review_state, "needs_review");
  assert.match(unrecoverableReview.matchReason, /could not recover a native Hacker News item ID/i);
  const ambiguousReviews = normalized.needsReview.filter((row) => row.platformPostId === "7475000000000000000");
  assert.equal(ambiguousReviews.length, 0);
  assert.deepEqual(
    normalized.evidence
      .filter((row) => row.platformPostId === "7475000000000000000")
      .map((row) => row.entityId)
      .sort(),
    ["company-9-mothers-corporation", "company-dayjob"].sort()
  );
});

test("legacy semantic false positives carry explicit durable quarantine directives", async () => {
  const directory = await mkdtemp(join(tmpdir(), "returner-public-semantic-demotion-"));
  const output = join(directory, "public-evidence.json");
  const checkpoint = join(directory, "checkpoint.json");
  const discoveryAttempts = join(directory, "discovery-attempts.json");
  const sourceDiscoveryPaths = join(directory, "source-discovery-paths.json");
  const row = ({ id, companySlug, companyName, platformPostId, title }) => ({
    id,
    entityType: "company",
    entityId: `company-${companySlug}`,
    companySlug,
    companyName,
    platform: "youtube",
    sourceUrl: `https://www.youtube.com/watch?v=${platformPostId}`,
    platformPostId,
    title,
    text: title,
    rawVisibleText: title,
    metrics: { views: 100 },
    contributionScore: 2,
    review_state: "verified",
    matchReason: "Public YouTube search result matched the company.",
    first_seen_at: "2026-07-18T12:00:00.000Z",
    last_checked_at: "2026-07-18T12:00:00.000Z",
    last_updated_at: "2026-07-18T12:00:00.000Z"
  });
  await Promise.all([
    writeFile(output, `${JSON.stringify({
      source: {},
      evidence: [
        row({
          id: "false-archer",
          companySlug: "archer",
          companyName: "Archer",
          platformPostId: "oY9fNCY2qI0",
          title: "Archer & Olive Spring 2026 notebook unboxing"
        }),
        row({
          id: "potential-walter",
          companySlug: "walter",
          companyName: "Walter",
          platformPostId: "fQHXdii_Hdo",
          title: "Walter (YC P26) Launch Video"
        })
      ],
      needsReview: [],
      failures: []
    }, null, 2)}\n`),
    writeFile(checkpoint, `${JSON.stringify({
      attempts: {}, evidence: [], needsReview: [], failures: [], discoveryAttempts: [], sourceDiscoveryPaths: []
    }, null, 2)}\n`),
    writeFile(discoveryAttempts, "[]\n"),
    writeFile(sourceDiscoveryPaths, "[]\n")
  ]);

  execFileSync(process.execPath, [
    "scripts/fetch-public-traction.mjs",
    "--batch=S2026",
    "--max-companies=0",
    "--social=none",
    "--workers=1",
    "--delay-ms=0",
    `--output=${output}`,
    `--checkpoint=${checkpoint}`,
    `--discovery-attempts=${discoveryAttempts}`,
    `--source-discovery-paths=${sourceDiscoveryPaths}`
  ], { cwd: root, stdio: "pipe" });

  const normalized = JSON.parse(await readFile(output, "utf8"));
  const falsePositive = normalized.needsReview.find((item) => item.platformPostId === "oY9fNCY2qI0");
  const potentialValid = normalized.needsReview.find((item) => item.platformPostId === "fQHXdii_Hdo");
  assert.equal(falsePositive.attributionReconciliationDirective.disposition, "quarantined");
  assert.match(falsePositive.attributionReconciliationDirective.reason, /semantic_attribution/);
  assert.equal(potentialValid.attributionReconciliationDirective, undefined);
});
