import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AUTONOMOUS_BATCHES } from "../scripts/lib/autonomous-ingestion-plan.mjs";

const root = process.cwd();
const [summerCycle, autonomousRunner, publicCollector] = await Promise.all([
  readFile(join(root, "scripts", "run-summer-collection-cycle.mjs"), "utf8"),
  readFile(join(root, "scripts", "run-autonomous-ingestion.mjs"), "utf8"),
  readFile(join(root, "scripts", "fetch-public-traction.mjs"), "utf8")
]);

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Missing section start: ${start}`);
  assert.notEqual(endIndex, -1, `Missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("Summer collection keeps LinkedIn on the public lane", () => {
  const phases = section(summerCycle, "function collectionPhases()", "let loop = 0");
  const publicPhase = section(
    phases,
    'phase("public-web-and-community-evidence"',
    'phase("logged-in-x"'
  );
  const loggedInX = section(phases, 'phase("logged-in-x"', 'phase("logged-in-instagram"');
  const loggedInInstagram = section(
    phases,
    'phase("logged-in-instagram"',
    'phase("reports-and-benchmark-hydration"'
  );

  assert.match(publicPhase, /fetch-public-traction\.mjs/);
  assert.match(publicPhase, /"--social=all"/);
  assert.doesNotMatch(phases, /--allow-linkedin/);
  assert.match(loggedInX, /fetch-logged-in-social-traction\.mjs/);
  assert.match(loggedInX, /"--platforms=x"/);
  assert.doesNotMatch(loggedInX, /--platforms=linkedin|--allow-linkedin/);
  assert.match(loggedInInstagram, /fetch-logged-in-social-traction\.mjs/);
  assert.match(loggedInInstagram, /"--platforms=instagram"/);
  assert.doesNotMatch(loggedInInstagram, /--platforms=linkedin|--allow-linkedin/);
});

test("S26 public collection keeps its anonymous LinkedIn transport separate", () => {
  assert.ok(AUTONOMOUS_BATCHES.some((batch) => batch.slug === "S26"));

  const collectors = section(
    autonomousRunner,
    "async function runCollectors()",
    "async function runTopVoiceCollector"
  );
  const publicCommands = section(collectors, "const commands = [", "for (const command of commands)");
  assert.match(collectors, /AUTONOMOUS_BATCHES\.map/);
  assert.match(
    publicCommands,
    /sourcePath\(\s*"scripts",\s*"fetch-public-traction\.mjs"\s*\)/
  );
  assert.match(publicCommands, /`--batch=\$\{batchSlug\}`/);
  assert.match(publicCommands, /"--social=all"/);
  assert.match(publicCommands, /`--linkedin-workers=\$\{PUBLIC_SOCIAL_LANE_CONCURRENCY\}`/);
  assert.match(autonomousRunner, /const PUBLIC_SOCIAL_LANE_CONCURRENCY = 1/);
  assert.doesNotMatch(
    publicCommands,
    /fetch-logged-in-social-traction|ingest:logged-social|--allow-linkedin/
  );
  assert.match(collectors, /fetch-logged-in-social-traction/);
});

test("the anonymous LinkedIn transport strips credential-bearing headers", () => {
  const fetchHelper = section(
    publicCollector,
    "function fetchLinkedInPublicText",
    "async function fetchLinkedInBoundedResponse"
  );
  const headerHelper = section(
    publicCollector,
    "function anonymousLinkedInRequestHeaders",
    "function isDuckDuckGoPublicSearchUrl"
  );
  assert.match(fetchHelper, /headers: anonymousLinkedInRequestHeaders\(options\)/);
  assert.match(headerHelper, /headers\.delete\(name\)/);
  for (const header of [
    "authorization",
    "cookie",
    "csrf-token",
    "proxy-authorization",
    "x-csrf-token",
    "x-li-at",
    "x-linkedin-auth-token"
  ]) {
    assert.ok(headerHelper.includes(`"${header}"`), `missing explicit ${header} removal`);
  }
  assert.doesNotMatch(fetchHelper, /credentials|browser|cookieJar|session/i);
});

test("S26 public LinkedIn fetches send no Cookie or Authorization headers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "returner-linkedin-no-auth-"));
  const output = join(directory, "public-evidence.json");
  const checkpoint = join(directory, "checkpoint.json");
  const discoveryAttempts = join(directory, "discovery-attempts.json");
  const sourceDiscoveryPaths = join(directory, "source-discovery-paths.json");
  const preload = join(directory, "audit-fetch.mjs");
  const auditPath = join(directory, "fetch-audit.json");

  try {
    await writeFile(preload, `
import { writeFileSync } from "node:fs";

const calls = [];
process.on("exit", () => {
  writeFileSync(process.env.PUBLIC_FETCH_AUDIT_PATH, JSON.stringify(calls));
});

globalThis.fetch = async (input, options = {}) => {
  const headers = Object.fromEntries(new Headers(options.headers ?? {}).entries());
  calls.push({
    url: String(input),
    headers,
    credentials: options.credentials ?? null,
    optionKeys: Object.keys(options).sort()
  });
  return new Response(
    "Title: Public LinkedIn page\\nNo public posts were exposed by this test fixture.",
    { status: 200, headers: { "content-type": "text/plain" } }
  );
};
`);

    execFileSync(process.execPath, [
      "scripts/fetch-public-traction.mjs",
      "--batch=S26",
      "--company=graphify-labs",
      "--platforms=linkedin",
      "--social=all",
      "--workers=1",
      "--linkedin-workers=1",
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
        X_BEARER_TOKEN: "",
        LINKEDIN_COOKIE: "must-not-be-forwarded",
        LINKEDIN_AUTHORIZATION: "must-not-be-forwarded",
        LINKEDIN_SESSION: "must-not-be-forwarded",
        LI_AT: "must-not-be-forwarded",
        PUBLIC_FETCH_AUDIT_PATH: auditPath,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${preload}`].filter(Boolean).join(" ")
      },
      stdio: "pipe"
    });

    const calls = JSON.parse(await readFile(auditPath, "utf8"));
    const linkedInDirectCalls = calls.filter((call) => {
      const url = new URL(call.url);
      return url.hostname.endsWith("linkedin.com") &&
        (url.pathname.startsWith("/company/") || url.pathname.startsWith("/in/"));
    });
    assert.ok(linkedInDirectCalls.length >= 2, "expected direct company and founder public LinkedIn reads");
    assert.ok(
      calls.every((call) => new URL(call.url).hostname !== "r.jina.ai"),
      "LinkedIn URLs must not be forwarded through a remote reader"
    );
    const directCounts = new Map();
    for (const call of linkedInDirectCalls) {
      directCounts.set(call.url, (directCounts.get(call.url) ?? 0) + 1);
    }
    assert.ok(
      [...directCounts.values()].every((count) => count === 1),
      "each anonymous LinkedIn profile must be requested at most once"
    );

    for (const call of calls) {
      const headerNames = Object.keys(call.headers).map((name) => name.toLowerCase());
      assert.ok(!headerNames.includes("cookie"), `Cookie leaked to ${call.url}`);
      assert.ok(!headerNames.includes("authorization"), `Authorization leaked to ${call.url}`);
      assert.ok(
        !JSON.stringify(call.headers).includes("must-not-be-forwarded"),
        `LinkedIn environment credentials leaked to ${call.url}`
      );
      assert.ok(
        call.credentials === null || call.credentials === "omit",
        `credentialed fetch mode leaked to ${call.url}`
      );
      assert.ok(
        call.optionKeys.every((key) => !/(?:browser|cookiejar|auth|session)/i.test(key)),
        `browser/authenticated session option leaked to ${call.url}`
      );
    }

    const payload = JSON.parse(await readFile(output, "utf8"));
    assert.deepEqual(payload.source.platformsAttempted, ["linkedin"]);
    assert.ok(
      Object.values(payload.attempts).every((attempt) => attempt.platform === "linkedin"),
      "LinkedIn-only collection metadata must match its actual attempt surface"
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
