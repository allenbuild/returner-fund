import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  HOSTED_COLLECTOR_STATE_ARTIFACT_PREFIX,
  HOSTED_COLLECTOR_STATE_MANIFEST_MAX_BYTES,
  HOSTED_COLLECTOR_STATE_MAX_BYTES,
  HOSTED_COLLECTOR_STATE_MAX_FILES,
  hostedCollectorStateArtifactName,
  hostedCollectorStateSlotSegment,
  inspectHostedCollectorState,
  locateHostedCollectorStateArtifact,
  prepareHostedCollectorArtifactFallback,
  promoteHostedCollectorStateArtifact,
  stageHostedCollectorStateArtifact
} from "../scripts/lib/hosted-collector-state-artifact.mjs";
import { redactTokenLikeValues } from "../scripts/lib/public-token-redaction.mjs";

const SLOT = "central-2026-09-07-1800";
const SHA = "a".repeat(40);
const REPOSITORY_ID = 1284654556;
const RUN_ID = 34100000000;
const RUN_ATTEMPT = 2;
const NOW = new Date("2026-09-08T03:00:00.000Z");
const TOKEN = "ghs_fixture_token_1234567890";
const PRODUCER_REDACTION_CASES = Object.freeze([
  {
    name: "complete generic private key",
    field: "privateKey",
    value: `-----BEGIN PRIVATE KEY-----\n${"private-material".repeat(2)}\n-----END PRIVATE KEY-----`,
    sensitiveFragment: "-----BEGIN PRIVATE KEY-----"
  },
  {
    name: "RSA private-key header",
    field: "rsaPrivateKey",
    value: "-----BEGIN RSA PRIVATE KEY----- truncated",
    sensitiveFragment: "-----BEGIN RSA PRIVATE KEY-----"
  },
  {
    name: "EC private-key header",
    field: "ecPrivateKey",
    value: "-----BEGIN EC PRIVATE KEY----- truncated",
    sensitiveFragment: "-----BEGIN EC PRIVATE KEY-----"
  },
  {
    name: "OpenSSH private-key header",
    field: "openSshPrivateKey",
    value: "-----BEGIN OPENSSH PRIVATE KEY----- truncated",
    sensitiveFragment: "-----BEGIN OPENSSH PRIVATE KEY-----"
  },
  {
    name: "GitHub legacy token",
    field: "githubLegacy",
    value: "ghp_fixtureToken1234567890",
    sensitiveFragment: "ghp_fixtureToken1234567890"
  },
  {
    name: "GitHub fine-grained token",
    field: "githubFineGrained",
    value: "github_pat_fixtureToken1234567890",
    sensitiveFragment: "github_pat_fixtureToken1234567890"
  },
  {
    name: "Slack token",
    field: "slack",
    value: "xoxb-fixture-token-1234567890",
    sensitiveFragment: "xoxb-fixture-token-1234567890"
  },
  {
    name: "AWS access-key identifier",
    field: "aws",
    value: "AKIAABCDEFGHIJKLMNOP",
    sensitiveFragment: "AKIAABCDEFGHIJKLMNOP"
  },
  {
    name: "boundary-sensitive sk token",
    field: "openAiStyle",
    value: `(sk-${"s".repeat(24)})`,
    sensitiveFragment: `sk-${"s".repeat(24)}`
  },
  {
    name: "JWT",
    field: "jwt",
    value: `eyJ${"h".repeat(12)}.${"p".repeat(12)}.${"s".repeat(12)}`,
    sensitiveFragment: `eyJ${"h".repeat(12)}.${"p".repeat(12)}.${"s".repeat(12)}`
  },
  {
    name: "punctuation-only Bearer value",
    field: "bearer",
    value: `Bearer <${"*".repeat(12)}!>`,
    sensitiveFragment: `<${"*".repeat(12)}!>`
  },
  {
    name: "escaped JSON authorization value",
    field: "maskedAuthorization",
    value: "authorization=************",
    sensitiveFragment: "************"
  },
  {
    name: "escaped JSON authorization backslashes",
    field: "authorization",
    value: "\\".repeat(6),
    sensitiveFragment: "\\".repeat(6)
  },
  {
    name: "authorization diagnostic backslashes",
    field: "backslashAuthorizationDiagnostic",
    value: `authorization:${"\\".repeat(6)}`,
    sensitiveFragment: "\\".repeat(6)
  },
  {
    name: "Bearer diagnostic backslashes",
    field: "backslashBearerDiagnostic",
    value: `Bearer ${"\\".repeat(6)}`,
    sensitiveFragment: "\\".repeat(6)
  },
  {
    name: "escaped JSON proxy authorization with a custom scheme",
    field: "proxy-authorization",
    value: `Custom-Scheme <${"!".repeat(12)}>`,
    sensitiveFragment: `<${"!".repeat(12)}>`
  }
]);

test("state artifact names are immutable and bound to Linux, slot, source, run, and attempt", () => {
  assert.equal(
    hostedCollectorStateArtifactName({
      slotKey: SLOT,
      sourceSha: SHA,
      runId: RUN_ID,
      runAttempt: RUN_ATTEMPT
    }),
    `${HOSTED_COLLECTOR_STATE_ARTIFACT_PREFIX}-Linux-${SLOT}-${SHA}-${RUN_ID}-${RUN_ATTEMPT}`
  );
  assert.throws(
    () => hostedCollectorStateArtifactName({
      slotKey: "manual-replay",
      sourceSha: SHA,
      runId: RUN_ID,
      runAttempt: RUN_ATTEMPT
    }),
    /slot key is invalid/
  );
});

test("validated public state stages with a content manifest and atomically promotes", async (t) => {
  const fixture = await stateFixture(t);
  const bundleRoot = path.join(
    fixture.managedRoot,
    "returner-fund-hosted-collector-artifact",
    "upload-fixture"
  );
  const staged = await stageHostedCollectorStateArtifact({
    ...provenance(),
    managedRoot: fixture.managedRoot,
    stateRoot: fixture.stateRoot,
    bundleRoot,
    secrets: ["exact-fixture-secret"]
  });
  assert.equal(staged.artifactName, hostedCollectorStateArtifactName(provenance()));
  assert.equal(staged.fileCount, 2);
  const manifest = JSON.parse(await readFile(path.join(bundleRoot, "manifest.json"), "utf8"));
  assert.equal(manifest.slotKey, SLOT);
  assert.equal(manifest.sourceSha, SHA);
  assert.deepEqual(
    manifest.files.map((file) => file.path),
    [
      `slots/${hostedCollectorStateSlotSegment(SLOT)}/checkpoint-public-s26-shard-0-of-1.json`,
      `slots/${hostedCollectorStateSlotSegment(SLOT)}/recent-window-journals/shard-0-of-1/${"b".repeat(64)}.ndjson`
    ]
  );

  await prepareHostedCollectorArtifactFallback({
    managedRoot: fixture.managedRoot,
    stateRoot: fixture.stateRoot,
    downloadRoot: path.join(
      fixture.managedRoot,
      "returner-fund-hosted-collector-artifact",
      "unused-download"
    )
  });
  await promoteHostedCollectorStateArtifact({
    ...provenance(),
    managedRoot: fixture.managedRoot,
    bundleRoot,
    stateRoot: fixture.stateRoot,
    artifactRunId: RUN_ID,
    artifactRunAttempt: RUN_ATTEMPT,
    artifactName: staged.artifactName,
    secrets: ["exact-fixture-secret"]
  });
  const restored = JSON.parse(await readFile(
    path.join(
      fixture.stateRoot,
      "slots",
      hostedCollectorStateSlotSegment(SLOT),
      "checkpoint-public-s26-shard-0-of-1.json"
    ),
    "utf8"
  ));
  assert.equal(restored.attempts.complete.status, "completed");
});

test("redacted nested authorization diagnostics remain valid and artifact-safe", async (t) => {
  const fixture = await stateFixture(t, { empty: true });
  const nested = JSON.stringify({
    authorization: `Bearer <${"a".repeat(24)}>`,
    proxyAuthorization: `Proxy-Authorization: Custom-Scheme ${"b".repeat(24)}`
  });
  const checkpointText = JSON.stringify(redactTokenLikeValues({ rawVisibleText: nested }));
  const checkpoint = JSON.parse(checkpointText);
  assert.deepEqual(JSON.parse(checkpoint.rawVisibleText), {
    authorization: "Bearer [redacted-public-token]",
    proxyAuthorization: "Proxy-Authorization: [redacted-public-token]"
  });
  await writeFile(
    path.join(fixture.slotRoot, "checkpoint-public-s26-shard-0-of-1.json"),
    `${checkpointText}\n`
  );

  const bundleRoot = path.join(
    fixture.managedRoot,
    "returner-fund-hosted-collector-artifact",
    "redacted-nested-authorization"
  );
  const staged = await stageHostedCollectorStateArtifact({
    ...provenance(),
    managedRoot: fixture.managedRoot,
    stateRoot: fixture.stateRoot,
    bundleRoot
  });
  assert.equal(staged.fileCount, 1);
});

test("producer redaction aligns with every artifact detector and preserves resumable bytes", async (t) => {
  const fixture = await stateFixture(t, { empty: true });
  const attemptKey = "instagram:company:company-fixture:https://www.instagram.com/fixture/";
  const campaignKey = "central-2026-09-07-1800-public-s26-shard-0-of-1";
  const checkedAt = "2026-09-08T02:10:00.000Z";
  const cutoff = "2026-09-08T02:00:00.000Z";
  const journalName = `${"b".repeat(64)}.ndjson`;
  const journalRelativePath = `recent-window-journals/shard-0-of-1/${journalName}`;
  const journalText = `${JSON.stringify({
    schemaVersion: "recent-native-page-receipt.v1",
    sequence: 1,
    attemptKey,
    pairKey: "S26:company:company-fixture:instagram",
    requestedAt: cutoff,
    completedAt: checkedAt,
    requestUrl: "https://www.instagram.com/api/v1/feed/user/fixture/",
    status: "success",
    cursorIn: null,
    cursorOut: null,
    sourceExhausted: true,
    responseSha256: "c".repeat(64),
    coverageFrom: "2026-08-08T02:00:00.000Z",
    coverageThrough: cutoff
  })}\n`;
  const journalSha256 = createHash("sha256").update(journalText).digest("hex");
  const journalPath = path.join(fixture.slotRoot, ...journalRelativePath.split("/"));
  await mkdir(path.dirname(journalPath), { recursive: true });
  await writeFile(journalPath, journalText);

  const nestedDiagnostics = Object.fromEntries(
    PRODUCER_REDACTION_CASES.map(({ field, value }) => [field, value])
  );
  const checkpoint = {
    attempts: {
      [attemptKey]: {
        attemptKey,
        batchSlug: "S26",
        platform: "instagram",
        companySlug: "fixture",
        entityType: "company",
        entityId: "company-fixture",
        entityName: "Fixture",
        accountUrl: "https://www.instagram.com/fixture/",
        startedAt: cutoff,
        checkedAt,
        status: "completed",
        outcomeStatus: "verified_recent_window",
        retryable: false,
        recentWindowCoverageCutoff: cutoff,
        recentWindowProof: {
          schemaVersion: "recent-native-window-proof.v1",
          status: "complete",
          coverageScope: "pair_all_native_targets",
          coveredFrom: "2026-08-08T02:00:00.000Z",
          coveredThrough: cutoff,
          checkedAt,
          sourceExhausted: true,
          nextCursor: null,
          truncated: false,
          limitReached: false,
          pageLimit: 2,
          pagesAttempted: 1,
          pagesFetched: 1,
          blockers: [],
          requestJournal: {
            path: journalRelativePath,
            sha256: journalSha256,
            observedAt: checkedAt
          }
        },
        source: {
          autonomousAttempt: { campaignKey, attemptKey }
        },
        authorization: "\\".repeat(6),
        backslashDiagnostic: `authorization:${"\\".repeat(6)}`,
        rawVisibleText: JSON.stringify(nestedDiagnostics)
      }
    }
  };
  const checkpointText = `${JSON.stringify(redactTokenLikeValues(checkpoint))}\n`;
  const parsedCheckpoint = JSON.parse(checkpointText);
  const parsedAttempt = parsedCheckpoint.attempts[attemptKey];
  const parsedDiagnostics = JSON.parse(parsedAttempt.rawVisibleText);
  for (const detectorCase of PRODUCER_REDACTION_CASES) {
    assert.equal(
      checkpointText.includes(detectorCase.sensitiveFragment),
      false,
      `${detectorCase.name} must be removed before artifact staging`
    );
    assert.ok(
      parsedDiagnostics[detectorCase.field].includes("[redacted-public-token]"),
      `${detectorCase.name} must use the stable producer redaction marker`
    );
  }
  assert.equal(parsedAttempt.attemptKey, attemptKey);
  assert.equal(parsedAttempt.source.autonomousAttempt.campaignKey, campaignKey);
  assert.equal(parsedAttempt.source.autonomousAttempt.attemptKey, attemptKey);
  assert.equal(parsedAttempt.authorization, "[redacted-public-token]");
  assert.equal(
    parsedAttempt.backslashDiagnostic,
    "authorization:[redacted-public-token]"
  );
  assert.equal(parsedAttempt.recentWindowProof.requestJournal.path, journalRelativePath);
  assert.equal(parsedAttempt.recentWindowProof.requestJournal.sha256, journalSha256);

  const checkpointPath = path.join(
    fixture.slotRoot,
    "checkpoint-public-s26-shard-0-of-1.json"
  );
  await writeFile(checkpointPath, checkpointText);
  const bundleRoot = path.join(
    fixture.managedRoot,
    "returner-fund-hosted-collector-artifact",
    "detector-alignment"
  );
  const staged = await stageHostedCollectorStateArtifact({
    ...provenance(),
    managedRoot: fixture.managedRoot,
    stateRoot: fixture.stateRoot,
    bundleRoot
  });
  assert.equal(staged.fileCount, 2);

  const stagedCheckpointPath = path.join(
    bundleRoot,
    "state",
    "slots",
    hostedCollectorStateSlotSegment(SLOT),
    "checkpoint-public-s26-shard-0-of-1.json"
  );
  const stagedJournalPath = path.join(
    bundleRoot,
    "state",
    "slots",
    hostedCollectorStateSlotSegment(SLOT),
    ...journalRelativePath.split("/")
  );
  assert.equal(await readFile(stagedCheckpointPath, "utf8"), checkpointText);
  const stagedJournalText = await readFile(stagedJournalPath, "utf8");
  assert.equal(stagedJournalText, journalText);
  assert.equal(createHash("sha256").update(stagedJournalText).digest("hex"), journalSha256);
  assert.equal(await readFile(checkpointPath, "utf8"), checkpointText);
  assert.equal(await readFile(journalPath, "utf8"), journalText);
});

test("the maximum supported file count produces a bounded manifest that promotes", async (t) => {
  const fixture = await stateFixture(t, { empty: true });
  const journal = path.join(
    fixture.slotRoot,
    "recent-window-journals",
    "shard-0-of-1"
  );
  await mkdir(journal, { recursive: true });
  const pendingWrites = [];
  for (let index = 0; index < HOSTED_COLLECTOR_STATE_MAX_FILES; index += 1) {
    const fileName = `${index.toString(16).padStart(64, "0")}.ndjson`;
    pendingWrites.push(writeFile(path.join(journal, fileName), "{}\n"));
    if (pendingWrites.length === 200) await Promise.all(pendingWrites.splice(0));
  }
  await Promise.all(pendingWrites);

  const bundleRoot = path.join(
    fixture.managedRoot,
    "returner-fund-hosted-collector-artifact",
    "maximum-file-count"
  );
  const staged = await stageHostedCollectorStateArtifact({
    ...provenance(),
    managedRoot: fixture.managedRoot,
    stateRoot: fixture.stateRoot,
    bundleRoot
  });
  assert.equal(staged.fileCount, HOSTED_COLLECTOR_STATE_MAX_FILES);
  const manifestBytes = (await stat(path.join(bundleRoot, "manifest.json"))).size;
  assert.ok(manifestBytes > 2 * 1024 * 1024);
  assert.ok(manifestBytes <= HOSTED_COLLECTOR_STATE_MANIFEST_MAX_BYTES);

  await prepareHostedCollectorArtifactFallback({
    managedRoot: fixture.managedRoot,
    stateRoot: fixture.stateRoot,
    downloadRoot: path.join(
      fixture.managedRoot,
      "returner-fund-hosted-collector-artifact",
      "unused-maximum-file-count-download"
    )
  });
  const promoted = await promoteHostedCollectorStateArtifact({
    ...provenance(),
    managedRoot: fixture.managedRoot,
    bundleRoot,
    stateRoot: fixture.stateRoot,
    artifactRunId: RUN_ID,
    artifactRunAttempt: RUN_ATTEMPT,
    artifactName: staged.artifactName
  });
  assert.equal(promoted.fileCount, HOSTED_COLLECTOR_STATE_MAX_FILES);
});

test("tampered downloads fail before promotion and preserve the prior target", async (t) => {
  const fixture = await stateFixture(t);
  const bundleRoot = path.join(
    fixture.managedRoot,
    "returner-fund-hosted-collector-artifact",
    "tampered-download"
  );
  const staged = await stageHostedCollectorStateArtifact({
    ...provenance(),
    managedRoot: fixture.managedRoot,
    stateRoot: fixture.stateRoot,
    bundleRoot
  });
  const checkpoint = path.join(
    bundleRoot,
    "state",
    "slots",
    hostedCollectorStateSlotSegment(SLOT),
    "checkpoint-public-s26-shard-0-of-1.json"
  );
  await writeFile(checkpoint, '{"tampered":true}\n');
  const original = await readFile(path.join(
    fixture.stateRoot,
    "slots",
    hostedCollectorStateSlotSegment(SLOT),
    "checkpoint-public-s26-shard-0-of-1.json"
  ), "utf8");
  await assert.rejects(
    promoteHostedCollectorStateArtifact({
      ...provenance(),
      managedRoot: fixture.managedRoot,
      bundleRoot,
      stateRoot: fixture.stateRoot,
      artifactRunId: RUN_ID,
      artifactRunAttempt: RUN_ATTEMPT,
      artifactName: staged.artifactName
    }),
    /do not match/
  );
  assert.equal(await readFile(path.join(
    fixture.stateRoot,
    "slots",
    hostedCollectorStateSlotSegment(SLOT),
    "checkpoint-public-s26-shard-0-of-1.json"
  ), "utf8"), original);
});

test("public state validator rejects secrets, auth/temp paths, malformed data, bounds, and links", async (t) => {
  assert.equal(HOSTED_COLLECTOR_STATE_MAX_BYTES, 128 * 1024 * 1024);
  assert.equal(HOSTED_COLLECTOR_STATE_MAX_FILES, 10_000);

  for (const scenario of [
    {
      name: "exact secret",
      file: "public-s26.json",
      body: '{"value":"exact-fixture-secret"}\n',
      options: { secrets: ["exact-fixture-secret"] },
      error: /exact configured secret/
    },
    {
      name: "credential shape",
      file: "public-s26.json",
      body: '{"value":"github_pat_fixtureSecretToken123456"}\n',
      error: /credential-shaped/
    },
    {
      name: "authenticated path",
      file: "logged-in-s26.json",
      body: "{}\n",
      error: /authenticated path/
    },
    {
      name: "temporary path",
      file: "public-s26.json.tmp",
      body: "{}\n",
      error: /temporary path/
    },
    {
      name: "malformed JSON",
      file: "public-s26.json",
      body: "{\n",
      error: /malformed JSON/
    }
  ]) {
    await t.test(scenario.name, async (st) => {
      const fixture = await stateFixture(st, { empty: true });
      await writeFile(path.join(fixture.slotRoot, scenario.file), scenario.body);
      await assert.rejects(
        inspectHostedCollectorState({
          stateRoot: fixture.stateRoot,
          slotKey: SLOT,
          ...(scenario.options ?? {})
        }),
        scenario.error
      );
    });
  }

  await t.test("byte bound", async (st) => {
    const fixture = await stateFixture(st);
    await assert.rejects(
      inspectHostedCollectorState({
        stateRoot: fixture.stateRoot,
        slotKey: SLOT,
        maximumBytes: 1
      }),
      /exceeds 1 bytes/
    );
  });

  await t.test("file-count bound", async (st) => {
    const fixture = await stateFixture(st);
    await assert.rejects(
      inspectHostedCollectorState({
        stateRoot: fixture.stateRoot,
        slotKey: SLOT,
        maximumFiles: 1
      }),
      /exceeds 1 files/
    );
  });

  await t.test("symbolic link", async (st) => {
    const fixture = await stateFixture(st, { empty: true });
    const outside = path.join(fixture.managedRoot, "outside.json");
    await writeFile(outside, "{}\n");
    await symlink(outside, path.join(fixture.slotRoot, "public-s26.json"));
    await assert.rejects(
      inspectHostedCollectorState({ stateRoot: fixture.stateRoot, slotKey: SLOT }),
      /symbolic link/
    );
  });

  await t.test("FIFO", async (st) => {
    const fixture = await stateFixture(st, { empty: true });
    const fifo = path.join(fixture.slotRoot, "public-s26.json");
    execFileSync("mkfifo", [fifo]);
    await assert.rejects(
      inspectHostedCollectorState({ stateRoot: fixture.stateRoot, slotKey: SLOT }),
      /non-regular file/
    );
  });

  await t.test("unexpected traversal-like directory", async (st) => {
    const fixture = await stateFixture(st, { empty: true });
    await mkdir(path.join(fixture.slotRoot, "unexpected"));
    await assert.rejects(
      inspectHostedCollectorState({ stateRoot: fixture.stateRoot, slotKey: SLOT }),
      /unexpected directory/
    );
  });
});

test("locator selects only the newest exact failed workflow artifact", async () => {
  const older = recoveryRun({ id: RUN_ID - 2, createdAt: "2026-09-08T02:00:00.000Z" });
  const newest = recoveryRun({ id: RUN_ID - 1, createdAt: "2026-09-08T02:00:00.000Z" });
  const wrongSha = recoveryRun({ id: RUN_ID - 3, headSha: "c".repeat(40) });
  const current = recoveryRun({ id: RUN_ID });
  const newestName = hostedCollectorStateArtifactName({
    slotKey: SLOT,
    sourceSha: SHA,
    runId: newest.id,
    runAttempt: newest.run_attempt
  });
  const olderName = hostedCollectorStateArtifactName({
    slotKey: SLOT,
    sourceSha: SHA,
    runId: older.id,
    runAttempt: older.run_attempt
  });
  const wrongShaName = hostedCollectorStateArtifactName({
    slotKey: SLOT,
    sourceSha: wrongSha.head_sha,
    runId: wrongSha.id,
    runAttempt: wrongSha.run_attempt
  });
  const currentName = hostedCollectorStateArtifactName({
    slotKey: SLOT,
    sourceSha: SHA,
    runId: current.id,
    runAttempt: current.run_attempt
  });
  const calls = [];
  const result = await locateHostedCollectorStateArtifact({
    slotKey: SLOT,
    sourceSha: SHA,
    currentRunId: RUN_ID,
    token: TOKEN,
    now: NOW,
    fetchImpl: mockGitHub({
      calls,
      fullRuns: new Map([[newest.id, newest]]),
      artifactPages: new Map([[1, {
        total_count: 5,
        artifacts: [
          recoveryArtifact(current, {
            id: 1_005,
            name: currentName,
            created_at: "2026-09-08T02:42:00.000Z"
          }),
          recoveryArtifact(newest, {
            id: 1_004,
            name: newestName,
            created_at: "2026-09-08T02:40:00.000Z"
          }),
          recoveryArtifact(newest, {
            id: 1_003,
            name: `${newestName}-prefix-collision`,
            created_at: "2026-09-08T02:39:00.000Z"
          }),
          recoveryArtifact(wrongSha, {
            id: 1_002,
            name: wrongShaName,
            created_at: "2026-09-08T02:37:00.000Z"
          }),
          recoveryArtifact(older, {
            id: 1_001,
            name: olderName,
            created_at: "2026-09-08T02:35:00.000Z"
          })
        ]
      }]])
    })
  });
  assert.equal(result.found, true);
  assert.equal(result.artifactName, newestName);
  assert.equal(result.artifactRunId, newest.id);
  assert.equal(calls.some((url) => url.includes(`/runs/${older.id}`)), false);
  assert.equal(calls.some((url) => url.includes("/runs?")), false);
});

test("newer failed runs without artifacts cannot hide an older live artifact", async () => {
  const run = recoveryRun({ id: RUN_ID - 100 });
  const name = hostedCollectorStateArtifactName({
    slotKey: SLOT,
    sourceSha: SHA,
    runId: run.id,
    runAttempt: run.run_attempt
  });
  const calls = [];
  const newerRunsWithoutArtifacts = Array.from({ length: 25 }, (_, index) =>
    recoveryRun({ id: RUN_ID - index - 1 })
  );
  const result = await locateHostedCollectorStateArtifact({
    slotKey: SLOT,
    sourceSha: SHA,
    currentRunId: RUN_ID,
    token: TOKEN,
    now: NOW,
    fetchImpl: mockGitHub({
      calls,
      runs: newerRunsWithoutArtifacts,
      fullRuns: new Map([[run.id, run]]),
      artifactPages: new Map([[1, {
        total_count: 1,
        artifacts: [recoveryArtifact(run, { name })]
      }]])
    })
  });
  assert.equal(result.found, true);
  assert.equal(result.artifactRunId, run.id);
  assert.equal(calls.some((url) => url.includes("/runs?")), false);
});

test("locator accepts an exact artifact from a timed-out hosted workflow", async () => {
  const run = recoveryRun({ id: RUN_ID - 1, conclusion: "timed_out" });
  const name = hostedCollectorStateArtifactName({
    slotKey: SLOT,
    sourceSha: SHA,
    runId: run.id,
    runAttempt: run.run_attempt
  });
  const result = await locatorWith({
    run,
    artifacts: [recoveryArtifact(run, { name })]
  });
  assert.equal(result.found, true);
  assert.equal(result.artifactName, name);
  assert.equal(result.artifactRunId, run.id);
});

test("locator fails closed on invalid exact provenance, duplicate artifacts, and API failure", async (t) => {
  const run = recoveryRun({ id: RUN_ID - 1 });
  const name = hostedCollectorStateArtifactName({
    slotKey: SLOT,
    sourceSha: SHA,
    runId: run.id,
    runAttempt: run.run_attempt
  });

  await t.test("wrong repository", async () => {
    const invalid = structuredClone(run);
    invalid.repository.full_name = "attacker/repository";
    await assert.rejects(locatorWith({
      run,
      fullRun: invalid,
      artifacts: [recoveryArtifact(run, { name })]
    }), /run provenance is not exact/);
  });

  await t.test("expired", async () => {
    const result = await locatorWith({
      run,
      artifacts: [recoveryArtifact(run, { name, expired: true })]
    });
    assert.equal(result.found, false);
  });

  await t.test("duplicate immutable name", async () => {
    const artifact = recoveryArtifact(run, { name });
    await assert.rejects(locatorWith({
      run,
      artifacts: [artifact, { ...artifact, id: artifact.id + 1 }]
    }), /duplicate immutable/);
  });

  await t.test("API failure", async () => {
    await assert.rejects(
      locateHostedCollectorStateArtifact({
        slotKey: SLOT,
        sourceSha: SHA,
        currentRunId: RUN_ID,
        token: TOKEN,
        now: NOW,
        fetchImpl: async () => new Response("unavailable", { status: 503 })
      }),
      /HTTP 503/
    );
  });
});

test("locator stops after a wholly stale artifact page and returns none", async () => {
  const recent = Array.from({ length: 100 }, (_, index) => recoveryArtifact(
    recoveryRun({ id: RUN_ID - index - 1 }),
    {
      id: 10_000 - index,
      name: `unrelated-recent-${index}`,
      created_at: "2026-09-08T02:00:00.000Z"
    }
  ));
  const stale = Array.from({ length: 100 }, (_, index) => recoveryArtifact(
    recoveryRun({ id: RUN_ID - index - 101 }),
    {
      id: 9_000 - index,
      name: `unrelated-stale-${index}`,
      created_at: "2026-09-01T02:00:00.000Z"
    }
  ));
  const calls = [];
  const result = await locateHostedCollectorStateArtifact({
    slotKey: SLOT,
    sourceSha: SHA,
    currentRunId: RUN_ID,
    token: TOKEN,
    now: NOW,
    maximumPages: 2,
    fetchImpl: mockGitHub({
      calls,
      artifactPages: new Map([
        [1, { total_count: 500, artifacts: recent }],
        [2, { total_count: 500, artifacts: stale }]
      ])
    })
  });
  assert.equal(result.found, false);
  assert.equal(calls.filter((url) => url.includes("/actions/artifacts?")).length, 2);
});

test("locator fails closed when recent artifact pagination exhausts its bound", async () => {
  const page = (offset) => Array.from({ length: 100 }, (_, index) => recoveryArtifact(
    recoveryRun({ id: RUN_ID - offset - index - 1 }),
    {
      id: 20_000 - offset - index,
      name: `unrelated-recent-${offset + index}`,
      created_at: "2026-09-08T02:00:00.000Z"
    }
  ));
  await assert.rejects(
    locateHostedCollectorStateArtifact({
      slotKey: SLOT,
      sourceSha: SHA,
      currentRunId: RUN_ID,
      token: TOKEN,
      now: NOW,
      maximumPages: 2,
      fetchImpl: mockGitHub({
        artifactPages: new Map([
          [1, { total_count: 300, artifacts: page(0) }],
          [2, { total_count: 300, artifacts: page(100) }]
        ])
      })
    }),
    /exceeded its recent-page bound/
  );
});

async function stateFixture(t, { empty = false } = {}) {
  const managedRoot = await mkdtemp(path.join(tmpdir(), "hosted-state-artifact-test-"));
  t.after(() => rm(managedRoot, { recursive: true, force: true }));
  const stateRoot = path.join(
    managedRoot,
    "returner-fund-autonomous-ingestion-state",
    "v1"
  );
  const slotRoot = path.join(stateRoot, "slots", hostedCollectorStateSlotSegment(SLOT));
  await mkdir(slotRoot, { recursive: true });
  if (!empty) {
    await writeFile(
      path.join(slotRoot, "checkpoint-public-s26-shard-0-of-1.json"),
      `${JSON.stringify({ attempts: { complete: { status: "completed" } } })}\n`
    );
    const journal = path.join(slotRoot, "recent-window-journals", "shard-0-of-1");
    await mkdir(journal, { recursive: true });
    await writeFile(
      path.join(journal, `${"b".repeat(64)}.ndjson`),
      '{"schemaVersion":"recent-native-page-receipt.v1"}\n'
    );
  }
  return { managedRoot, stateRoot, slotRoot };
}

function provenance() {
  return {
    repository: "allenbuild/returner-fund",
    repositoryId: REPOSITORY_ID,
    workflowPath: ".github/workflows/autonomous-ingestion.yml",
    slotKey: SLOT,
    sourceSha: SHA,
    runId: RUN_ID,
    runAttempt: RUN_ATTEMPT,
    now: NOW
  };
}

function workflow() {
  return {
    id: 315868583,
    path: ".github/workflows/autonomous-ingestion.yml",
    state: "active"
  };
}

function recoveryRun({
  id,
  createdAt = "2026-09-08T02:00:00.000Z",
  headSha = SHA,
  conclusion = "failure"
} = {}) {
  return {
    id,
    workflow_id: workflow().id,
    path: workflow().path,
    event: "repository_dispatch",
    status: "completed",
    conclusion,
    head_branch: "main",
    head_sha: headSha,
    run_attempt: 1,
    created_at: createdAt,
    updated_at: "2026-09-08T02:30:00.000Z",
    repository: { id: REPOSITORY_ID, full_name: "allenbuild/returner-fund" },
    head_repository: { id: REPOSITORY_ID, full_name: "allenbuild/returner-fund" }
  };
}

function recoveryArtifact(run, overrides = {}) {
  return {
    id: 1000 + Number(run.id % 1000),
    name: "fixture",
    size_in_bytes: 20_000_000,
    digest: `sha256:${"d".repeat(64)}`,
    expired: false,
    created_at: "2026-09-08T02:35:00.000Z",
    expires_at: "2026-09-10T02:35:00.000Z",
    workflow_run: {
      id: run.id,
      repository_id: REPOSITORY_ID,
      head_repository_id: REPOSITORY_ID,
      head_branch: "main",
      head_sha: SHA
    },
    ...overrides
  };
}

function mockGitHub({
  calls = [],
  runs = [],
  fullRuns = new Map(),
  artifactPages = new Map()
} = {}) {
  return async (url) => {
    calls.push(url);
    if (/\/actions\/workflows\/autonomous-ingestion\.yml$/.test(url)) {
      return jsonResponse(workflow());
    }
    if (url.includes("/runs?")) return jsonResponse({ workflow_runs: runs });
    if (url.includes("/actions/artifacts?")) {
      const page = Number(new URL(url).searchParams.get("page"));
      const payload = artifactPages.get(page);
      if (!payload) throw new Error(`unexpected artifact inventory page ${page}`);
      return jsonResponse(payload);
    }
    const runId = Number(/\/actions\/runs\/(\d+)/.exec(url)?.[1]);
    if (!Number.isSafeInteger(runId)) throw new Error(`unexpected URL ${url}`);
    const run = fullRuns.get(runId);
    if (!run) throw new Error(`unexpected run ${runId}`);
    return jsonResponse(run);
  };
}

function locatorWith({ run, fullRun = run, artifacts }) {
  return locateHostedCollectorStateArtifact({
    slotKey: SLOT,
    sourceSha: SHA,
    currentRunId: RUN_ID,
    token: TOKEN,
    now: NOW,
    fetchImpl: mockGitHub({
      runs: [run],
      fullRuns: new Map([[run.id, fullRun]]),
      artifactPages: new Map([[1, {
        total_count: artifacts.length,
        artifacts
      }]])
    })
  });
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
