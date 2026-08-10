import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  withOpenCliBrowserSession
} from "../scripts/lib/opencli-browser-session.mjs";
import {
  buildOpenCliChildEnvironment,
  openCliProcessSignalAuthorization,
  sanitizeOpenCliDiagnostic
} from "../scripts/lib/opencli-runtime.mjs";
import {
  LINKEDIN_MINIMUM_INTERACTION_DELAY_MS,
  LINKEDIN_MINIMUM_TARGET_DELAY_MS,
  LINKEDIN_MAX_TARGETS_PER_INVOCATION,
  LINKEDIN_UNPROVEN_SESSION_QUARANTINE_MS,
  createLinkedInInteractionPacer,
  createSupabaseLinkedInGlobalLeaseProvider,
  finalizeLinkedInInteractionPacing,
  linkedinAdapterSupportsAccountUrl,
  linkedinCircuitDecision,
  linkedinCircuitStateTransition,
  linkedinCollectionAttemptState,
  linkedinExecutionPolicy,
  linkedinBrowserSessionCleanupFailed,
  linkedinPacingStateUnproven,
  linkedinFailureKind,
  linkedinFailureRequiresImmediateAbort,
  limitLinkedInTargetsPerInvocation,
  linkedinPostIsExplicitRepost,
  linkedinPostStrictlyBelongsToAccount,
  linkedinSafetySignal,
  mergeOwnedLinkedInPosts,
  prioritizeLinkedInTargets,
  runLinkedInSerialLane,
  withLinkedInAccountLock
} from "../scripts/lib/logged-in-linkedin-collection.mjs";

const collectorSource = readFileSync(
  new URL("../scripts/fetch-logged-in-social-traction.mjs", import.meta.url),
  "utf8"
);

function permissiveGlobalLeaseProvider() {
  let sequence = 0;
  return {
    async claim() {
      sequence += 1;
      return { leaseToken: `test-lease-${sequence}` };
    },
    async renew() {
      return true;
    },
    async quarantine() {
      return true;
    },
    async release() {
      return true;
    }
  };
}

function linkedInLockOptions(lockPath, globalLeaseProvider = permissiveGlobalLeaseProvider()) {
  return {
    lockPath,
    globalLeaseProvider,
    globalLockNamespace: "returner-test-linkedin-account"
  };
}

describe("OpenCLI browser session cleanup", () => {
  it("releases the exact browser session lease after successful collection", async () => {
    const calls = [];
    const result = await withOpenCliBrowserSession({
      session: "linkedin-worker-3",
      runOpenCli: async (args, options) => {
        calls.push({ args, options });
        return "closed";
      },
      operation: async () => "collected"
    });

    assert.equal(result, "collected");
    assert.deepEqual(calls, [
      {
        args: ["browser", "linkedin-worker-3", "close"],
        options: { timeoutMs: 12_000 }
      }
    ]);
  });

  it("preserves the collection error when releasing the lease also fails", async () => {
    const collectionError = new Error("page extraction failed");
    let closeAttempts = 0;

    await assert.rejects(
      withOpenCliBrowserSession({
        session: "linkedin-worker-4",
        runOpenCli: async () => {
          closeAttempts += 1;
          throw new Error("browser close failed");
        },
        operation: async () => {
          throw collectionError;
        }
      }),
      (error) => {
        assert.equal(error, collectionError);
        assert.equal(
          error.sessionCleanupFailure?.code,
          "OPENCLI_BROWSER_SESSION_CLOSE_FAILED"
        );
        assert.match(
          error.sessionCleanupFailure?.message ?? "",
          /authenticated session lease may still be active/
        );
        return true;
      }
    );
    assert.equal(closeAttempts, 1);
  });

  it("turns a successful operation into an explicit terminal failure when lease cleanup fails", async () => {
    await assert.rejects(
      withOpenCliBrowserSession({
        session: "linkedin-worker-5",
        runOpenCli: async () => {
          throw new Error("browser close failed with li_at=must-not-escape");
        },
        operation: async () => ["native-post"]
      }),
      (error) => {
        assert.equal(error.code, "OPENCLI_BROWSER_SESSION_CLOSE_FAILED");
        assert.match(error.message, /collection outcome is failed/);
        assert.doesNotMatch(error.message, /must-not-escape/);
        assert.equal(linkedinFailureRequiresImmediateAbort(error.message), true);
        return true;
      }
    );
    assert.match(
      collectorSource,
      /const detailKeys = \[\s+"primaryError",\s+"cause",\s+"sessionCleanupFailure",[\s\S]*?"globalLeaseCleanupFailure"\s+\];/
    );
    assert.match(
      collectorSource,
      /for \(const key of detailKeys\) \{[\s\S]*?const nested = current\[key\];[\s\S]*?queue\.push\(nested\);/
    );
  });

  it("preserves a non-extensible primary failure when cleanup also fails", async () => {
    const primaryError = Object.freeze(new Error("primary navigation failure"));
    await assert.rejects(
      withOpenCliBrowserSession({
        session: "linkedin-worker-frozen-error",
        runOpenCli: async () => {
          throw new Error("browser close failed");
        },
        operation: async () => {
          throw primaryError;
        }
      }),
      (error) => {
        assert.equal(error.code, "OPENCLI_BROWSER_OPERATION_AND_CLOSE_FAILED");
        assert.equal(error.primaryError, primaryError);
        assert.equal(
          error.sessionCleanupFailure?.code,
          "OPENCLI_BROWSER_SESSION_CLOSE_FAILED"
        );
        return true;
      }
    );
    assert.match(collectorSource, /const queue = \[error\?\.primaryError \?\? error, error\];/);
  });
});

describe("OpenCLI subprocess isolation", () => {
  it("records a unique owner marker and revalidates process identity before teardown signals", () => {
    const runtimeSource = readFileSync(new URL("../scripts/lib/opencli-runtime.mjs", import.meta.url), "utf8");
    assert.match(runtimeSource, /RETURNER_OPENCLI_PROCESS_OWNER:\s*owner\.marker/);
    assert.match(runtimeSource, /ownedProcessIdentityStatus\(pid, processState, owner\)/);
    assert.match(
      runtimeSource,
      /snapshot\.startIdentity !== processState\.startIdentity/
    );
    assert.match(
      runtimeSource,
      /processOwnerMarker\(pid, marker\)/
    );
    assert.match(runtimeSource, /scanLinuxProcessTable\(owner\.marker\)/);
    assert.match(runtimeSource, /Buffer\.from\(`RETURNER_OPENCLI_PROCESS_OWNER=\$\{marker\}`\)/);
    assert.match(runtimeSource, /environment\.indexOf\(0, start\)/);
    assert.match(runtimeSource, /environment\.subarray\(start, fieldEnd\)\.equals\(expected\)/);
    assert.match(runtimeSource, /readLinuxProcStat\(pid\).*readLinuxProcessEnvironmentMarker\(pid, marker\).*readLinuxProcStat\(pid\)/s);
  });

  it("fails closed for same-second PID reuse and Windows PID-only signaling", () => {
    const sameSecond = "ps-lstart:Sun Aug 09 12:00:00 2026";
    assert.equal(openCliProcessSignalAuthorization({
      platform: "darwin",
      expectedStartIdentity: sameSecond,
      currentStartIdentity: sameSecond,
      expectedMarker: "owner-a",
      currentMarker: "owner-b"
    }), false);
    assert.equal(openCliProcessSignalAuthorization({
      platform: "darwin",
      expectedStartIdentity: sameSecond,
      currentStartIdentity: sameSecond,
      expectedMarker: "owner-a",
      currentMarker: "owner-a"
    }), true);
    assert.equal(openCliProcessSignalAuthorization({
      platform: "win32",
      expectedStartIdentity: "windows-start-a",
      currentStartIdentity: "windows-start-a",
      expectedMarker: "owner-a",
      currentMarker: "owner-a"
    }), false);
    const runtimeSource = readFileSync(new URL("../scripts/lib/opencli-runtime.mjs", import.meta.url), "utf8");
    assert.doesNotMatch(runtimeSource, /execFileAsync\(["']taskkill["']/);
    assert.match(runtimeSource, /OPENCLI_UNSAFE_PLATFORM/);
  });

  it("builds a strict child environment without unrelated parent secrets", () => {
    const childEnv = buildOpenCliChildEnvironment({
      PATH: "/usr/bin:/bin",
      HOME: "/tmp/opencli-home",
      LANG: "C.UTF-8",
      TMPDIR: "/tmp/opencli-tmp",
      OPENCLI_BIN: "/tmp/opencli",
      AUDIT_PARENT_SECRET_SENTINEL: "must-not-be-forwarded",
      LINKEDIN_COOKIE: "must-not-be-forwarded",
      SUPABASE_SERVICE_ROLE_KEY: "must-not-be-forwarded",
      GITHUB_TOKEN: "must-not-be-forwarded"
    }, { nodeBinDir: "/runtime/node/bin" });

    assert.deepEqual(childEnv, {
      HOME: "/tmp/opencli-home",
      LANG: "C.UTF-8",
      TMPDIR: "/tmp/opencli-tmp",
      PATH: `/runtime/node/bin${process.platform === "win32" ? ";" : ":"}/usr/bin:/bin`
    });
    assert.equal(JSON.stringify(childEnv).includes("must-not-be-forwarded"), false);
  });

  it("redacts secret sentinels from child stdout, stderr, and thrown diagnostics", () => {
    const secretValue = "abcdefghijklmnopqrstuvwxyz0123456789";
    const cookieSecret = `li_at=${secretValue}`;
    const bearerSecret = "Bearer abcdefghijklmnopqrstuvwxyz012345";
    const genericSecret = "AUDIT_OUTPUT_SECRET=0123456789abcdefghijklmnopqrstuvwxyz";
    const nestedCookieJson = JSON.stringify({
      payload: JSON.stringify({
        li_at: secretValue,
        JSESSIONID: secretValue,
        sessionSecret: secretValue
      })
    });
    const failingProgram = [
      `process.stdout.write("env-leak=" + String(Boolean(process.env.AUDIT_PARENT_SECRET_SENTINEL)) + " " + ${JSON.stringify(`${cookieSecret} ${genericSecret} ${nestedCookieJson}`)});`,
      `process.stderr.write(${JSON.stringify(`${bearerSecret} JSESSIONID: ${secretValue}`)});`,
      "process.exit(7);"
    ].join("");
    const runtimeUrl = new URL(
      "../scripts/lib/opencli-runtime.mjs",
      import.meta.url
    ).href;
    const probeProgram = `
      import { runOpenCli } from ${JSON.stringify(runtimeUrl)};
      try {
        await runOpenCli(["--input-type=module", "-e", ${JSON.stringify(failingProgram)}]);
        process.exitCode = 2;
      } catch (error) {
        process.stdout.write(JSON.stringify({
          message: error.message,
          stdout: error.stdout,
          stderr: error.stderr,
          code: error.code
        }));
      }
    `;
    const raw = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", probeProgram],
      {
        encoding: "utf8",
        env: {
          HOME: process.env.HOME,
          LANG: process.env.LANG,
          PATH: process.env.PATH,
          TMPDIR: process.env.TMPDIR,
          OPENCLI_BIN: process.execPath,
          AUDIT_PARENT_SECRET_SENTINEL: "parent-secret-must-not-be-forwarded"
        }
      }
    );
    const diagnostic = JSON.parse(raw);
    const serialized = JSON.stringify(diagnostic);

    for (const secret of [cookieSecret, bearerSecret, genericSecret, secretValue]) {
      assert.doesNotMatch(serialized, new RegExp(escapeRegExp(secret)));
    }
    assert.match(serialized, /redacted-(?:cookie|public-token|public-param)/);
    assert.equal(diagnostic.code, 7);
    assert.match(diagnostic.stdout, /env-leak=false/);
    assert.doesNotMatch(
      sanitizeOpenCliDiagnostic(`cookie: ${cookieSecret}`),
      /abcdefghijklmnopqrstuvwxyz0123456789/
    );
  });

  it("iteratively redacts escaped, nested, JSON, colon, and equals session assignments", () => {
    const secret = "linkedin-session-cookie-secret-0123456789";
    const variants = [
      `li_at=${secret}`,
      `li_at: ${secret}`,
      `JSESSIONID=${secret}`,
      `JSESSIONID: ${secret}`,
      `Cookie: li_at=${secret}; JSESSIONID=${secret}`,
      `Authorization: Bearer ${secret}`,
      JSON.stringify({ li_at: secret, JSESSIONID: secret }),
      JSON.stringify({ authorization: `Bearer ${secret}` }),
      JSON.stringify({ sessionSecret: secret }),
      JSON.stringify({ payload: JSON.stringify({ li_at: secret }) }),
      JSON.stringify({
        payload: JSON.stringify({
          nested: JSON.stringify({ JSESSIONID: secret })
        })
      }),
      String.raw`{\"li_at\":\"${secret}\",\"sessionToken\":\"${secret}\"}`
    ];

    for (const variant of variants) {
      const sanitized = sanitizeOpenCliDiagnostic(variant);
      assert.doesNotMatch(sanitized, new RegExp(escapeRegExp(secret)), variant);
      assert.match(sanitized, /redacted-(?:secret|public-token|public-param)/);
    }
  });

  it("drains a detached descendant before a timed-out OpenCLI command returns", {
    skip: process.platform === "win32"
  }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "returner-opencli-drain-test-"));
    const pidPath = join(directory, "detached.pid");
    const survivedPath = join(directory, "detached-survived");
    const runtimeUrl = new URL(
      "../scripts/lib/opencli-runtime.mjs",
      import.meta.url
    ).href;
    const detachedProgram = [
      `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(survivedPath)}, "survived"), 750);`,
      "setInterval(() => {}, 1000);"
    ].join("");
    const rootProgram = `
      const { spawn } = require("node:child_process");
      const { writeFileSync } = require("node:fs");
      const child = spawn(process.execPath, ["-e", ${JSON.stringify(detachedProgram)}], {
        detached: true,
        stdio: "ignore"
      });
      writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
      child.unref();
      setInterval(() => {}, 1000);
    `;
    const probeProgram = `
      import { execFileSync } from "node:child_process";
      import { readFileSync } from "node:fs";
      import { runOpenCli } from ${JSON.stringify(runtimeUrl)};
      let errorCode = null;
      try {
        await runOpenCli(["--input-type=commonjs", "-e", ${JSON.stringify(rootProgram)}], {
          timeoutMs: 150
        });
      } catch (error) {
        errorCode = error.code;
      }
      const pid = Number(readFileSync(${JSON.stringify(pidPath)}, "utf8"));
      function processIsAlive(candidatePid) {
        try {
          process.kill(candidatePid, 0);
          return true;
        } catch (error) {
          return error?.code !== "ESRCH";
        }
      }
      const descendantRunning = processIsAlive(pid);
      let processState = "";
      try {
        processState = execFileSync("/bin/ps", ["-p", String(pid), "-o", "stat="], {
          encoding: "utf8"
        }).trim();
      } catch {}
      process.stdout.write(JSON.stringify({
        errorCode,
        descendantRunning,
        processState
      }));
    `;

    try {
      const raw = execFileSync(
        process.execPath,
        ["--input-type=module", "-e", probeProgram],
        {
          encoding: "utf8",
          timeout: 5_000,
          env: {
            HOME: process.env.HOME,
            LANG: process.env.LANG,
            PATH: process.env.PATH,
            TMPDIR: process.env.TMPDIR,
            OPENCLI_BIN: process.execPath
          }
        }
      );
      const result = JSON.parse(raw);
      assert.equal(result.errorCode, "ETIMEDOUT");
      assert.equal(result.descendantRunning, false);
      await new Promise((resolve) => setTimeout(resolve, 850));
      await assert.rejects(readFile(survivedPath, "utf8"), { code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("logged-in LinkedIn collection", () => {
  it("forces one serial worker and a conservative delay without throttling other platform workers", () => {
    assert.equal(LINKEDIN_MINIMUM_TARGET_DELAY_MS, 30_000);
    assert.ok(LINKEDIN_MINIMUM_INTERACTION_DELAY_MS >= 3_000);
    assert.equal(LINKEDIN_MAX_TARGETS_PER_INVOCATION, 5);
    assert.deepEqual(
      linkedinExecutionPolicy({ requestedWorkers: 8, requestedDelayMs: 1_500 }),
      {
        requestedWorkers: 8,
        workers: 1,
        delayMs: 30_000,
        requestedTargetCap: 5,
        targetCap: 5,
        maximumTargetCap: 5
      }
    );
    assert.deepEqual(
      linkedinExecutionPolicy({
        requestedWorkers: 4,
        requestedDelayMs: 45_000,
        requestedTargetCap: 2
      }),
      {
        requestedWorkers: 4,
        workers: 1,
        delayMs: 45_000,
        requestedTargetCap: 2,
        targetCap: 2,
        maximumTargetCap: 5
      }
    );
    assert.throws(
      () => linkedinExecutionPolicy({ requestedTargetCap: 6 }),
      /cannot exceed 5 per invocation/
    );
    assert.throws(
      () => linkedinExecutionPolicy({ requestedTargetCap: 1.5 }),
      /must be a nonnegative integer/
    );

    assert.deepEqual(
      limitLinkedInTargetsPerInvocation([
        { platform: "linkedin", id: "li-1" },
        { platform: "x", id: "x-1" },
        { platform: "linkedin", id: "li-2" },
        { platform: "instagram", id: "ig-1" },
        { platform: "linkedin", id: "li-3" }
      ], 2).map((item) => item.id),
      ["li-1", "x-1", "li-2", "ig-1"]
    );
    assert.equal(
      limitLinkedInTargetsPerInvocation(
        Array.from({ length: 8 }, (_, index) => ({
          platform: "linkedin",
          id: `li-${index}`
        }))
      ).length,
      5
    );

    assert.match(
      collectorSource,
      /runWorkerPool\(otherTargets, workers, async \(target, workerIndex\)/
    );
    assert.match(
      collectorSource,
      /runLinkedInSerialLane\(linkedinTargets, \(target, workerIndex\) => \{/
    );
    assert.match(
      collectorSource,
      /limitLinkedInTargetsPerInvocation\(\s+globallyBoundedRunnableTargets,\s+linkedinExecution\.targetCap/
    );
    assert.match(collectorSource, /targetCap: linkedinExecution\.targetCap/);
    assert.match(
      collectorSource,
      /shouldAbort: \(\) => linkedinCircuitOpen \|\| signal\.aborted/
    );
    assert.match(collectorSource, /requiredLinkedInGlobalLockConfiguration\(\)/);
    assert.match(collectorSource, /LINKEDIN_GLOBAL_LOCK_NAMESPACE/);
    assert.match(collectorSource, /createSupabaseLinkedInGlobalLeaseProvider\(client\)/);
  });

  it("executes LinkedIn targets serially, always as worker zero, with the delay floor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "returner-linkedin-pacing-test-"));
    const pacingStatePath = join(directory, "pacing.json");
    let active = 0;
    let maximumActive = 0;
    let clock = 1_000;
    const calls = [];
    const sleeps = [];
    try {
      const summary = await runLinkedInSerialLane(
        ["first", "second", "third"],
        async (target, workerIndex) => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          calls.push({ target, workerIndex });
          await Promise.resolve();
          active -= 1;
        },
        {
          delayMs: 500,
          now: () => clock,
          pacingStatePath,
          sleep: async (ms) => {
            sleeps.push(ms);
            clock += ms;
          }
        }
      );

      assert.equal(maximumActive, 1);
      assert.deepEqual(calls, [
        { target: "first", workerIndex: 0 },
        { target: "second", workerIndex: 0 },
        { target: "third", workerIndex: 0 }
      ]);
      assert.deepEqual(sleeps, [30_000, 30_000]);
      assert.deepEqual(summary, {
        attemptedCount: 3,
        untouchedCount: 0,
        aborted: false,
        workers: 1,
        delayMs: 30_000
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("persists completion pacing across separate serial-lane process handoffs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "returner-linkedin-handoff-test-"));
    const pacingStatePath = join(directory, "pacing.json");
    let clock = 10_000;
    const calls = [];
    const sleeps = [];
    const options = {
      now: () => clock,
      pacingStatePath,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      }
    };

    try {
      await runLinkedInSerialLane(["first-process"], async (target) => {
        calls.push(target);
      }, options);
      await runLinkedInSerialLane(["second-process"], async (target) => {
        calls.push(target);
      }, options);

      assert.deepEqual(calls, ["first-process", "second-process"]);
      assert.deepEqual(sleeps, [30_000]);
      const state = JSON.parse(await readFile(pacingStatePath, "utf8"));
      assert.equal(state.version, 1);
      assert.equal(state.phase, "completed");
      assert.equal(state.lastTargetAttemptAtMs, 40_000);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("enforces the per-invocation cap inside the serial lane", async () => {
    const directory = await mkdtemp(join(tmpdir(), "returner-linkedin-lane-cap-test-"));
    const pacingStatePath = join(directory, "pacing.json");
    let clock = 1_000;
    const calls = [];

    try {
      const summary = await runLinkedInSerialLane(
        ["first", "second", "untouched"],
        async (target) => calls.push(target),
        {
          now: () => clock,
          pacingStatePath,
          sleep: async (ms) => {
            clock += ms;
          },
          targetCap: 2
        }
      );

      assert.deepEqual(calls, ["first", "second"]);
      assert.deepEqual(summary, {
        attemptedCount: 2,
        untouchedCount: 1,
        aborted: false,
        workers: 1,
        delayMs: 30_000
      });
      await assert.rejects(
        runLinkedInSerialLane(["refused"], async () => undefined, {
          pacingStatePath,
          targetCap: 6
        }),
        /cannot exceed 5 per invocation/
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed for malformed or interrupted host-local pacing state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "returner-linkedin-malformed-test-"));
    const pacingStatePath = join(directory, "pacing.json");
    let collectCalls = 0;
    const collect = async () => {
      collectCalls += 1;
    };

    try {
      await writeFile(pacingStatePath, "not-json\n");
      await assert.rejects(
        runLinkedInSerialLane(["untouched"], collect, { pacingStatePath }),
        /host-local pacing state is malformed/
      );

      await writeFile(pacingStatePath, JSON.stringify({
        version: 1,
        phase: "in_progress",
        attemptToken: "interrupted-attempt",
        pid: process.pid,
        lastTargetAttemptAtMs: Date.now()
      }));
      await assert.rejects(
        runLinkedInSerialLane(["still-untouched"], collect, { pacingStatePath }),
        /contains a prior host-local target attempt that did not finish cleanly/
      );
      assert.equal(collectCalls, 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("quarantines the durable lease when a prior target remains in progress", async () => {
    const directory = await mkdtemp(join(tmpdir(), "returner-linkedin-stale-pacing-lease-test-"));
    const lockPath = join(directory, "linkedin.lock");
    const pacingStatePath = join(directory, "pacing.json");
    let quarantines = 0;
    let releases = 0;
    const provider = {
      async claim() {
        return { leaseToken: "stale-pacing-lease" };
      },
      async renew() {
        return true;
      },
      async quarantine({ safetyReason }) {
        quarantines += 1;
        assert.equal(safetyReason, "unproven-host-pacing-state");
        return true;
      },
      async release() {
        releases += 1;
        return true;
      }
    };

    try {
      await writeFile(pacingStatePath, `${JSON.stringify({
        version: 1,
        phase: "in_progress",
        attemptToken: "interrupted-attempt",
        pid: process.pid,
        lastTargetAttemptAtMs: Date.now()
      })}\n`);
      await assert.rejects(
        withLinkedInAccountLock(
          () => runLinkedInSerialLane(["untouched"], async () => undefined, { pacingStatePath }),
          linkedInLockOptions(lockPath, provider)
        ),
        (error) => {
          assert.equal(linkedinPacingStateUnproven(error), true);
          return /did not finish cleanly/.test(error.message);
        }
      );
      assert.equal(quarantines, 1);
      assert.equal(releases, 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("quarantines the durable lease when target pacing completion cannot be persisted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "returner-linkedin-pacing-write-lease-test-"));
    const lockPath = join(directory, "linkedin.lock");
    const pacingStatePath = join(directory, "pacing.json");
    let clock = 1_000;
    let pacingClockReads = 0;
    let quarantines = 0;
    let releases = 0;
    const provider = {
      async claim() {
        return { leaseToken: "pacing-write-failure-lease" };
      },
      async renew() {
        return true;
      },
      async quarantine({ safetyReason }) {
        quarantines += 1;
        assert.equal(safetyReason, "unproven-host-pacing-state");
        return true;
      },
      async release() {
        releases += 1;
        return true;
      }
    };
    const sleep = async (milliseconds) => {
      clock += milliseconds;
    };

    try {
      await assert.rejects(
        withLinkedInAccountLock(
          () => runLinkedInSerialLane(["attempted"], async () => undefined, {
            pacingStatePath,
            now: () => (++pacingClockReads === 1 ? clock : Number.NaN),
            releaseNow: () => clock,
            sleep
          }),
          {
            ...linkedInLockOptions(lockPath, provider),
            now: () => clock,
            sleep
          }
        ),
        (error) => {
          assert.equal(linkedinPacingStateUnproven(error), true);
          return /completion could not be persisted/.test(error.message);
        }
      );
      assert.equal(quarantines, 1);
      assert.equal(releases, 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("paces every browser interaction with a process-level fail-closed delay", async () => {
    let clock = 1_000;
    const sleeps = [];
    const pacer = createLinkedInInteractionPacer({
      minimumDelayMs: 500,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      }
    });

    await pacer.beforeInteraction();
    pacer.afterInteraction();
    await pacer.beforeInteraction();
    pacer.afterInteraction();

    assert.equal(pacer.delayMs, 3_000);
    assert.deepEqual(sleeps, [3_000]);
    assert.match(collectorSource, /createLinkedInInteractionPacer\(\{ sleep: delay \}\)/);
    assert.match(
      collectorSource,
      /finalizeLinkedInInteractionPacing\(interactionPacer,\s*\{\s*operationError,\s*operationMustAbort\s*\}\);/
    );
  });

  it("preserves a primary interaction failure when pacing finalization also fails", () => {
    const primary = new Error("browser safety probe failed");
    const pacing = new Error("interaction pacing clock failed");
    const interactionPacer = {
      afterInteraction() {
        throw pacing;
      }
    };

    finalizeLinkedInInteractionPacing(interactionPacer, {
      operationError: primary,
      operationMustAbort: true
    });
    assert.equal(primary.interactionPacingFailure, pacing);
    assert.throws(
      () => finalizeLinkedInInteractionPacing(interactionPacer),
      (error) => error === pacing
    );
  });

  it("fails closed when interaction pacing makes no progress, rolls back, or wakes early repeatedly", async () => {
    let fixedClock = 1_000;
    let noProgressSleeps = 0;
    const noProgress = createLinkedInInteractionPacer({
      now: () => fixedClock,
      sleep: async () => {
        noProgressSleeps += 1;
      }
    });
    await noProgress.beforeInteraction();
    noProgress.afterInteraction();
    await assert.rejects(
      noProgress.beforeInteraction(),
      (error) => {
        assert.match(error.message, /LinkedIn safety stop \(account_safety\)/);
        assert.match(error.message, /without advancing the clock/);
        assert.equal(linkedinFailureRequiresImmediateAbort(error.message), true);
        return true;
      }
    );
    assert.equal(noProgressSleeps, 1);

    let rollbackClock = 5_000;
    const rollback = createLinkedInInteractionPacer({
      now: () => rollbackClock,
      sleep: async () => undefined
    });
    await rollback.beforeInteraction();
    rollback.afterInteraction();
    rollbackClock = 4_999;
    await assert.rejects(
      rollback.beforeInteraction(),
      /interaction pacing clock moved backwards/
    );

    let partialClock = 10_000;
    let partialSleeps = 0;
    const partialProgress = createLinkedInInteractionPacer({
      now: () => partialClock,
      sleep: async () => {
        partialSleeps += 1;
        partialClock += 1;
      }
    });
    await partialProgress.beforeInteraction();
    partialProgress.afterInteraction();
    await assert.rejects(
      partialProgress.beforeInteraction(),
      /sleep repeatedly completed before the required delay elapsed/
    );
    assert.equal(partialSleeps, 4);
  });

  it("fails closed before collection without a durable provider and stable namespace", async () => {
    let operationCalls = 0;
    await assert.rejects(
      withLinkedInAccountLock(async () => {
        operationCalls += 1;
      }),
      /requires a configured durable global-lock provider/
    );
    await assert.rejects(
      withLinkedInAccountLock(async () => {
        operationCalls += 1;
      }, {
        globalLeaseProvider: permissiveGlobalLeaseProvider()
      }),
      /requires an explicit stable global-lock namespace/
    );
    assert.equal(operationCalls, 0);
  });

  it("uses a non-reclaiming insert for the authenticated LinkedIn durable lease", async () => {
    const calls = [];
    let inserted = null;
    let duplicate = false;
    const query = {
      insert(input) {
        inserted = input;
        calls.push({ operation: "insert", input });
        return query;
      },
      select(value) {
        calls.push({ operation: "select", value });
        return query;
      },
      async maybeSingle() {
        return duplicate
          ? { data: null, error: { code: "23505", message: "duplicate key" } }
          : { data: { lease_token: inserted.lease_token }, error: null };
      }
    };
    const provider = createSupabaseLinkedInGlobalLeaseProvider({
      async rpc() {
        throw new Error("claim must not use the reclaiming generic RPC");
      },
      from(table) {
        calls.push({ operation: "from", table });
        return query;
      }
    }, { now: () => Date.parse("2026-08-10T00:00:00.000Z") });

    const claimed = await provider.claim({
      lockKey: "authenticated-linkedin:test",
      ownerId: "owner",
      leaseDurationMs: 20 * 60_000,
      metadata: { collector: "authenticated-linkedin" }
    });
    assert.equal(claimed.leaseToken, inserted.lease_token);
    assert.equal(inserted.heartbeat_at, "2026-08-10T00:00:00.000Z");
    assert.equal(inserted.lease_expires_at, "2026-08-10T00:20:00.000Z");
    duplicate = true;
    assert.equal(await provider.claim({
      lockKey: "authenticated-linkedin:test",
      ownerId: "other-owner",
      leaseDurationMs: 20 * 60_000
    }), null);
    assert.equal(calls.some((call) => call.operation === "rpc"), false);
  });

  it("materializes the fixed one-year cleanup quarantine even after nominal expiry", async () => {
    const calls = [];
    const query = {
      update(input) {
        calls.push({ operation: "update", input });
        return query;
      },
      eq(column, value) {
        calls.push({ operation: "eq", column, value });
        return query;
      },
      gt(column, value) {
        calls.push({ operation: "gt", column, value });
        return query;
      },
      select(value) {
        calls.push({ operation: "select", value });
        return query;
      },
      async maybeSingle() {
        return { data: { lock_key: "authenticated-linkedin:test" }, error: null };
      }
    };
    const provider = createSupabaseLinkedInGlobalLeaseProvider({
      async rpc() {
        throw new Error("quarantine must not use the one-hour renewal RPC");
      },
      from(table) {
        calls.push({ operation: "from", table });
        return query;
      }
    }, { now: () => Date.parse("2026-08-10T00:00:00.000Z") });

    assert.equal(
      await provider.quarantine({
        lockKey: "authenticated-linkedin:test",
        ownerId: "owner",
        leaseToken: "lease",
        leaseDurationMs: LINKEDIN_UNPROVEN_SESSION_QUARANTINE_MS
      }),
      true
    );
    assert.deepEqual(calls[0], { operation: "from", table: "ingestion_runtime_locks" });
    const update = calls.find((call) => call.operation === "update")?.input;
    assert.equal(update.heartbeat_at, "2026-08-10T00:00:00.000Z");
    assert.equal(update.lease_expires_at, "2027-08-10T00:00:00.000Z");
    assert.equal(update.metadata_json.manualRecoveryRequired, true);
    assert.equal(calls.some((call) => call.operation === "gt"), false);
  });

  it("uses a shared durable lease across different host-local lock paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "returner-linkedin-global-lock-test-"));
    const activeLeases = new Map();
    let leaseSequence = 0;
    const provider = {
      async claim({ lockKey, ownerId }) {
        if (activeLeases.has(lockKey)) return null;
        leaseSequence += 1;
        const leaseToken = `shared-lease-${leaseSequence}`;
        activeLeases.set(lockKey, { ownerId, leaseToken });
        return { leaseToken };
      },
      async renew({ lockKey, ownerId, leaseToken }) {
        const lease = activeLeases.get(lockKey);
        return lease?.ownerId === ownerId && lease?.leaseToken === leaseToken;
      },
      async quarantine({ lockKey, ownerId, leaseToken }) {
        const lease = activeLeases.get(lockKey);
        return lease?.ownerId === ownerId && lease?.leaseToken === leaseToken;
      },
      async release({ lockKey, ownerId, leaseToken }) {
        const lease = activeLeases.get(lockKey);
        if (lease?.ownerId !== ownerId || lease?.leaseToken !== leaseToken) return false;
        activeLeases.delete(lockKey);
        return true;
      }
    };
    let releaseFirst;
    let firstAcquired;
    const acquired = new Promise((resolve) => {
      firstAcquired = resolve;
    });
    const hold = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const firstOptions = linkedInLockOptions(join(directory, "host-a.lock"), provider);
    const secondOptions = linkedInLockOptions(join(directory, "host-b.lock"), provider);

    try {
      const first = withLinkedInAccountLock(async () => {
        firstAcquired();
        await hold;
      }, firstOptions);
      await acquired;
      await assert.rejects(
        withLinkedInAccountLock(async () => undefined, secondOptions),
        /another authenticated collector already holds the durable global lease/
      );
      releaseFirst();
      await first;
      await withLinkedInAccountLock(async () => undefined, secondOptions);
    } finally {
      releaseFirst?.();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("holds the durable lease through the final cooldown after a target failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "returner-linkedin-final-cooldown-failure-test-"));
    const lockPath = join(directory, "host-a.lock");
    const pacingStatePath = join(directory, "host-a-pacing.json");
    let clock = 1_000;
    const sleeps = [];
    const releases = [];
    const provider = {
      async claim() {
        return { leaseToken: "final-cooldown-failure-lease" };
      },
      async renew() {
        return true;
      },
      async quarantine() {
        return true;
      },
      async release() {
        releases.push(clock);
        return true;
      }
    };
    const sleep = async (milliseconds) => {
      sleeps.push(milliseconds);
      clock += milliseconds;
    };

    try {
      await assert.rejects(
        withLinkedInAccountLock(
          () => runLinkedInSerialLane(
            ["failed-target"],
            async () => {
              throw new Error("target transport failed");
            },
            { pacingStatePath, now: () => clock, releaseNow: () => clock, sleep }
          ),
          {
            ...linkedInLockOptions(lockPath, provider),
            now: () => clock,
            sleep
          }
        ),
        /target transport failed/
      );
      assert.deepEqual(sleeps, [LINKEDIN_MINIMUM_TARGET_DELAY_MS]);
      assert.deepEqual(releases, [1_000 + LINKEDIN_MINIMUM_TARGET_DELAY_MS]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retains the durable lease when authenticated browser cleanup is unproven", async () => {
    const directory = await mkdtemp(join(tmpdir(), "returner-linkedin-session-cleanup-lease-test-"));
    const lockPath = join(directory, "host-a.lock");
    let releases = 0;
    const renewals = [];
    const provider = {
      async claim() {
        return { leaseToken: "session-cleanup-failure-lease" };
      },
      async renew() {
        return true;
      },
      async quarantine(input) {
        renewals.push(input);
        return true;
      },
      async release() {
        releases += 1;
        return true;
      }
    };
    const cleanupFailure = Object.assign(
      new Error("authenticated browser cleanup failed"),
      { code: "OPENCLI_BROWSER_SESSION_CLOSE_FAILED" }
    );
    const collectionFailure = new Error("collection failed first");
    Object.defineProperty(collectionFailure, "sessionCleanupFailure", {
      value: cleanupFailure
    });

    try {
      await assert.rejects(
        withLinkedInAccountLock(
          async () => {
            throw collectionFailure;
          },
          linkedInLockOptions(lockPath, provider)
        ),
        (error) => error === collectionFailure
      );
      assert.equal(releases, 0);
      assert.equal(renewals.length, 1);
      assert.equal(
        renewals[0].leaseDurationMs,
        LINKEDIN_UNPROVEN_SESSION_QUARANTINE_MS
      );
      assert.equal(renewals[0].safetyQuarantine, true);
      assert.equal(renewals[0].safetyReason, "unproven-browser-session-cleanup");
      assert.equal(linkedinBrowserSessionCleanupFailed(collectionFailure), true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("propagates browser cleanup failure through checkpointing to the account lock", () => {
    assert.match(
      collectorSource,
      /if \(linkedinBrowserSessionCleanupFailed\(error\)\) throw error;/
    );
    assert.match(
      collectorSource,
      /catch \(checkpointError\)[\s\S]{0,500}throw terminalSafetyError;/
    );
    assert.doesNotMatch(
      collectorSource,
      /checkpointWriteChain\s*=\s*checkpointWriteChain\.catch/
    );
    for (const property of [
      "interactionPacingFailure",
      "checkpointFailure",
      "targetPacingFailure",
      "globalLeaseHeartbeatFailure",
      "globalLeaseQuarantineFailure",
      "globalLeaseCleanupFailure"
    ]) {
      assert.match(collectorSource, new RegExp(`"${property}"`));
    }
  });

  it("preserves browser cleanup failure when pacing completion also fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "returner-linkedin-pacing-cleanup-error-test-"));
    const pacingStatePath = join(directory, "pacing.json");
    const cleanupFailure = Object.assign(
      new Error("authenticated browser cleanup failed"),
      { code: "OPENCLI_BROWSER_SESSION_CLOSE_FAILED" }
    );
    let clockReads = 0;

    try {
      await assert.rejects(
        runLinkedInSerialLane(
          ["target"],
          async () => {
            throw cleanupFailure;
          },
          {
            pacingStatePath,
            now: () => (++clockReads === 1 ? 1_000 : Number.NaN),
            releaseNow: () => 2_000,
            sleep: async () => undefined
          }
        ),
        (error) => {
          assert.equal(error, cleanupFailure);
          assert.match(
            error.targetPacingFailure?.cause?.message ?? "",
            /clock must return a finite number/
          );
          assert.equal(linkedinBrowserSessionCleanupFailed(error), true);
          return true;
        }
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the final cooldown across distinct host-local paths under one durable lease", async () => {
    const directory = await mkdtemp(join(tmpdir(), "returner-linkedin-final-cooldown-global-test-"));
    const firstLockPath = join(directory, "host-a.lock");
    const secondLockPath = join(directory, "host-b.lock");
    const firstPacingStatePath = join(directory, "host-a-pacing.json");
    const secondPacingStatePath = join(directory, "host-b-pacing.json");
    const activeLeases = new Map();
    const releases = [];
    const sleeps = [];
    let leaseSequence = 0;
    let clock = 1_000;
    let firstCooldownStarted;
    const firstCooldown = new Promise((resolve) => {
      firstCooldownStarted = resolve;
    });
    let releaseFirstCooldown;
    const firstCooldownGate = new Promise((resolve) => {
      releaseFirstCooldown = resolve;
    });
    const provider = {
      async claim({ lockKey, ownerId }) {
        if (activeLeases.has(lockKey)) return null;
        leaseSequence += 1;
        const leaseToken = `final-cooldown-global-${leaseSequence}`;
        activeLeases.set(lockKey, { ownerId, leaseToken });
        return { leaseToken };
      },
      async renew({ lockKey, ownerId, leaseToken }) {
        const lease = activeLeases.get(lockKey);
        return lease?.ownerId === ownerId && lease?.leaseToken === leaseToken;
      },
      async quarantine({ lockKey, ownerId, leaseToken }) {
        const lease = activeLeases.get(lockKey);
        return lease?.ownerId === ownerId && lease?.leaseToken === leaseToken;
      },
      async release({ lockKey, ownerId, leaseToken }) {
        const lease = activeLeases.get(lockKey);
        if (lease?.ownerId !== ownerId || lease?.leaseToken !== leaseToken) return false;
        releases.push(clock);
        activeLeases.delete(lockKey);
        return true;
      }
    };
    let sleepCount = 0;
    const sleep = async (milliseconds) => {
      sleepCount += 1;
      sleeps.push(milliseconds);
      if (sleepCount === 1) {
        firstCooldownStarted();
        await firstCooldownGate;
      }
      clock += milliseconds;
    };
    const firstOptions = {
      ...linkedInLockOptions(firstLockPath, provider),
      now: () => clock,
      sleep
    };
    const secondOptions = {
      ...linkedInLockOptions(secondLockPath, provider),
      now: () => clock,
      sleep
    };
    let first;

    try {
      first = withLinkedInAccountLock(
        () => runLinkedInSerialLane(
          ["first-host-target"],
          async () => undefined,
          {
            pacingStatePath: firstPacingStatePath,
            now: () => clock,
            releaseNow: () => clock,
            sleep
          }
        ),
        firstOptions
      );
      await firstCooldown;

      await assert.rejects(
        withLinkedInAccountLock(
          () => runLinkedInSerialLane(
            ["second-host-target"],
            async () => undefined,
            {
              pacingStatePath: secondPacingStatePath,
              now: () => clock,
              releaseNow: () => clock,
              sleep
            }
          ),
          secondOptions
        ),
        /another authenticated collector already holds the durable global lease/
      );

      releaseFirstCooldown();
      await first;
      await withLinkedInAccountLock(
        () => runLinkedInSerialLane(
          ["second-host-target"],
          async () => undefined,
          {
            pacingStatePath: secondPacingStatePath,
            now: () => clock,
            releaseNow: () => clock,
            sleep
          }
        ),
        secondOptions
      );

      assert.deepEqual(sleeps, [
        LINKEDIN_MINIMUM_TARGET_DELAY_MS,
        LINKEDIN_MINIMUM_TARGET_DELAY_MS
      ]);
      assert.deepEqual(releases, [
        1_000 + LINKEDIN_MINIMUM_TARGET_DELAY_MS,
        1_000 + LINKEDIN_MINIMUM_TARGET_DELAY_MS * 2
      ]);
    } finally {
      releaseFirstCooldown?.();
      await first?.catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("aborts authenticated work immediately when the durable lease heartbeat is lost", async () => {
    const directory = await mkdtemp(join(tmpdir(), "returner-linkedin-heartbeat-test-"));
    const lockPath = join(directory, "linkedin.lock");
    let releases = 0;
    let quarantines = 0;
    const provider = {
      async claim() {
        return { leaseToken: "heartbeat-lease" };
      },
      async renew() {
        return false;
      },
      async quarantine({ safetyReason }) {
        quarantines += 1;
        assert.equal(safetyReason, "durable-lease-heartbeat-failure");
        return true;
      },
      async release() {
        releases += 1;
        return true;
      }
    };

    try {
      await assert.rejects(
        withLinkedInAccountLock(async ({ signal }) => {
          await new Promise((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", resolve, { once: true });
          });
        }, {
          ...linkedInLockOptions(lockPath, provider),
          leaseDurationMs: 60_000,
          heartbeatIntervalMs: 10
        }),
        (error) => {
          assert.match(error.message, /LinkedIn safety stop \(account_safety\)/);
          assert.match(error.message, /heartbeat failed closed/);
          return true;
        }
      );
      assert.equal(quarantines, 1);
      assert.equal(releases, 0);
      await assert.rejects(readFile(lockPath, "utf8"), { code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves a host-local serialized lock as defense in depth", async () => {
    const directory = await mkdtemp(join(tmpdir(), "returner-linkedin-lock-test-"));
    const lockPath = join(directory, "linkedin.lock");
    const lockOptions = linkedInLockOptions(lockPath);
    let releaseFirst;
    let firstAcquired;
    const acquired = new Promise((resolve) => {
      firstAcquired = resolve;
    });
    const hold = new Promise((resolve) => {
      releaseFirst = resolve;
    });

    try {
      const first = withLinkedInAccountLock(async () => {
        firstAcquired();
        await hold;
      }, lockOptions);
      await acquired;

      await assert.rejects(
        withLinkedInAccountLock(async () => undefined, lockOptions),
        /another authenticated collector already holds the account lock/
      );

      releaseFirst();
      await first;
      await withLinkedInAccountLock(async () => undefined, lockOptions);
    } finally {
      releaseFirst?.();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("serializes concurrent stale-lock reclaim without unlinking a replacement lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "returner-linkedin-stale-lock-test-"));
    const lockPath = join(directory, "linkedin.lock");
    const lockOptions = linkedInLockOptions(lockPath);
    const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    assert.ok(Number.isInteger(exited.pid));
    await writeFile(lockPath, JSON.stringify({
      pid: exited.pid,
      token: "stale-owner-token",
      acquiredAt: new Date(0).toISOString()
    }));

    let active = 0;
    let maximumActive = 0;
    let acquiredCount = 0;
    let releaseWinner;
    let markWinnerAcquired;
    const winnerAcquired = new Promise((resolve) => {
      markWinnerAcquired = resolve;
    });
    const holdWinner = new Promise((resolve) => {
      releaseWinner = resolve;
    });

    try {
      const contenders = Array.from({ length: 12 }, () =>
        withLinkedInAccountLock(async () => {
          active += 1;
          acquiredCount += 1;
          maximumActive = Math.max(maximumActive, active);
          markWinnerAcquired();
          await holdWinner;
          active -= 1;
        }, lockOptions).then(
          (value) => ({ status: "fulfilled", value }),
          (reason) => ({ status: "rejected", reason })
        )
      );

      await winnerAcquired;
      await new Promise((resolve) => setTimeout(resolve, 25));
      releaseWinner();
      const settled = await Promise.all(contenders);
      const fulfilled = settled.filter((result) => result.status === "fulfilled");
      const rejected = settled.filter((result) => result.status === "rejected");

      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 11);
      assert.equal(acquiredCount, 1);
      assert.equal(maximumActive, 1);
      for (const result of rejected) {
        assert.match(
          result.reason?.message ?? "",
          /another collector is acquiring the account lock|another authenticated collector already holds the account lock/
        );
      }
      await assert.rejects(readFile(lockPath, "utf8"), { code: "ENOENT" });
      await assert.rejects(readFile(`${lockPath}.acquire`, "utf8"), { code: "ENOENT" });
    } finally {
      releaseWinner?.();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("stops the serial lane immediately and leaves later targets untouched", async () => {
    const directory = await mkdtemp(join(tmpdir(), "returner-linkedin-circuit-test-"));
    const pacingStatePath = join(directory, "pacing.json");
    let circuitOpen = false;
    let clock = 1_000;
    const calls = [];
    const sleeps = [];
    try {
      const summary = await runLinkedInSerialLane(
        ["warning", "untouched-one", "untouched-two"],
        async (target) => {
          calls.push(target);
          circuitOpen = true;
        },
        {
          now: () => clock,
          pacingStatePath,
          sleep: async (ms) => {
            sleeps.push(ms);
            clock += ms;
          },
          shouldAbort: () => circuitOpen
        }
      );

      assert.deepEqual(calls, ["warning"]);
      assert.deepEqual(sleeps, []);
      assert.deepEqual(summary, {
        attemptedCount: 1,
        untouchedCount: 2,
        aborted: true,
        workers: 1,
        delayMs: 30_000
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("treats challenge, checkpoint, account-warning, and 429 responses as immediate stops", () => {
    const cases = [
      ["HTTP 401 Unauthorized", "auth"],
      ["HTTP/2 403 Forbidden", "auth"],
      ["Request failed with status 401", "auth"],
      ["Request failed with status code 403", "auth"],
      ["Response status 401", "auth"],
      ["Response status code 403", "auth"],
      ["Response code 401 (Unauthorized)", "auth"],
      ["HTTPError: Response code 403 (Forbidden)", "auth"],
      [{ statusCode: 401, message: "Unauthorized" }, "auth"],
      [{ status: 403, message: "Forbidden" }, "auth"],
      [{ response: { statusCode: 401 } }, "auth"],
      [{ responseCode: "403" }, "auth"],
      [JSON.stringify({ response: { status: 401 } }), "auth"],
      [JSON.stringify(JSON.stringify({ http_status_code: 403 })), "auth"],
      [
        "OpenCLI browser session cleanup failed; the authenticated session lease may still be active.",
        "account_safety"
      ],
      ["https://www.linkedin.com/checkpoint/challenge/", "account_safety"],
      ["Security checkpoint required", "account_safety"],
      ["We've detected automated activity on your account", "account_safety"],
      ["Your account has been temporarily restricted", "account_safety"],
      ["Account warning: verify your identity", "account_safety"],
      ["HTTP 429 Too Many Requests", "rate_limited"],
      [{ statusCode: 429, message: "Too many requests" }, "rate_limited"],
      ["HTTP 999 Request Denied", "account_safety"],
      [{ response: { statusCode: 999 } }, "account_safety"],
      ["LinkedIn safety stop (account_safety) during browser safety probe.", "account_safety"],
      ["Sign in to continue", "auth"],
      ["LinkedIn: Log In or Sign Up", "auth"],
      ["Log In", "auth"],
      ["Log in to continue", "auth"],
      ["LinkedIn Login", "auth"],
      [JSON.stringify({ title: "Log In", visibleText: "Log In" }), "auth"],
      [JSON.stringify({ title: "LinkedIn: Log In or Sign Up", visibleText: "Log In" }), "auth"],
      ["https://www.linkedin.com/login?fromSignIn=true", "auth"],
      ["/login", "auth"],
      ["Sign In | LinkedIn", "auth"],
      ["Sign in", "auth"],
      [JSON.stringify([{ currentUrl: "https://www.linkedin.com/login", title: "Sign In | LinkedIn", visibleText: "Sign in" }]), "auth"],
      ["You've reached the commercial use limit", "rate_limited"]
    ];

    for (const [value, expected] of cases) {
      assert.equal(linkedinSafetySignal(value), expected);
      assert.equal(linkedinFailureKind(typeof value === "string" ? value : JSON.stringify(value)), expected);
      assert.equal(linkedinFailureRequiresImmediateAbort(value), true);
      assert.deepEqual(
        linkedinCircuitStateTransition({
          previousConsecutiveFailures: 0,
          collectionFailed: true,
          failureKind: expected
        }),
        { consecutiveFailures: 1, open: true, reason: expected }
      );
    }

    assert.equal(
      linkedinSafetySignal("A founder explained a generic account-security challenge."),
      null
    );
    for (const unrelated of [
      "The post says you should log in to continue reading.",
      "Our support guide explains how to log in to continue.",
      "The founder interviewed 401 customers and published 403 roadmap notes.",
      "Activity identifier 401403429 was processed normally.",
      "Release status improved after 401 commits.",
      "Project status 401 was an internal milestone label.",
      { code: 401, metric: 403 },
      { metrics: { status: 200, count: 401 } },
      { metrics: { status: 401 } }
    ]) {
      assert.equal(linkedinSafetySignal(unrelated), null);
      assert.equal(linkedinFailureRequiresImmediateAbort(unrelated), false);
    }
    assert.match(collectorSource, /await probeSafety\(\);/);
    assert.match(
      collectorSource,
      /const raw = await interact\([\s\S]*?linkedInExtractJs\(\)[\s\S]*?const safetyProbe = await probeSafety\(\);[\s\S]*?if \(posts\.length === 0\)/
    );
    assert.doesNotMatch(collectorSource, /fetchLinkedInPostsFromAdapter/);
    assert.match(collectorSource, /stringArg\("--linkedin-mode"\) \?\? "browser"/);
    assert.match(
      collectorSource,
      /if \(linkedinFailureRequiresImmediateAbort\(failureKind\)\) \{\s+return linkedinFailedCollection/
    );
  });

  it("recognizes legacy adapter-compatible personal profile URLs without invoking the adapter", () => {
    assert.equal(
      linkedinAdapterSupportsAccountUrl("https://www.linkedin.com/in/founder/"),
      true
    );
    assert.equal(
      linkedinAdapterSupportsAccountUrl("https://www.linkedin.com/company/acme/"),
      false
    );
    assert.equal(linkedinAdapterSupportsAccountUrl("https://example.com/in/founder"), false);
  });

  it("fails closed on a native post URL or author that differs from the target", () => {
    const accountUrl = "https://www.linkedin.com/in/founder/";
    const valid = {
      url: "https://www.linkedin.com/posts/founder_launch-activity-7475000000000000001-good",
      author: "Founder Name",
      rawText: "Founder Name\\n2h\\nWe launched.",
      authorUrls: ["https://www.linkedin.com/in/founder/"]
    };
    assert.equal(
      linkedinPostStrictlyBelongsToAccount(valid, accountUrl, "Founder Name"),
      true
    );
    assert.equal(
      linkedinPostStrictlyBelongsToAccount(
        {
          ...valid,
          url: "https://www.linkedin.com/posts/third-party_launch-activity-7475000000000000001-bad"
        },
        accountUrl,
        "Founder Name"
      ),
      false
    );
    assert.equal(
      linkedinPostStrictlyBelongsToAccount(
        {
          ...valid,
          url: "https://www.linkedin.com/feed/update/urn:li:activity:7475000000000000001/",
          authorUrls: []
        },
        accountUrl,
        "Founder Name"
      ),
      false
    );
    assert.equal(
      linkedinPostStrictlyBelongsToAccount(
        { ...valid, author: "Someone Else", rawText: "Someone Else\\n2h\\nWe launched." },
        accountUrl,
        "Founder Name"
      ),
      false
    );
  });

  it("rejects repost wrappers even when a long adapter body precedes DOM text", () => {
    const repost = {
      url: "https://www.linkedin.com/feed/update/urn:li:activity:7475000000000000005/",
      author: "Founder Name",
      authorUrls: ["https://www.linkedin.com/in/founder/"],
      body: "adapter body ".repeat(100),
      rawText: "Feed post number 3 Founder Name reposted this Someone Else 2h Original body"
    };

    assert.equal(linkedinPostIsExplicitRepost(repost, "Founder Name"), true);
    assert.equal(
      linkedinPostStrictlyBelongsToAccount(
        repost,
        "https://www.linkedin.com/in/founder/",
        "Founder Name"
      ),
      false
    );
    assert.deepEqual(
      mergeOwnedLinkedInPosts([[repost]], {
        accountUrl: "https://www.linkedin.com/in/founder/",
        targetName: "Founder Name",
        limit: 5
      }),
      []
    );
  });

  it("quarantines an entire activity when DOM proves the adapter copy is a repost", () => {
    const postId = "7475000000000000006";
    const merged = mergeOwnedLinkedInPosts(
      [
        [
          {
            url: `https://www.linkedin.com/posts/founder_launch-activity-${postId}-good`,
            author: "Founder Name",
            authorUrls: ["https://www.linkedin.com/in/founder/"],
            body: "Rich adapter body without a wrapper marker.",
            raw_text: "Founder Name 2h Rich adapter body without a wrapper marker.",
            reactions: 25
          }
        ],
        [
          {
            url: `https://www.linkedin.com/feed/update/urn:li:activity:${postId}/`,
            author: "Founder Name",
            authorUrls: ["https://www.linkedin.com/in/founder/"],
            body: "Someone else's original post.",
            rawText:
              "Feed post number 2 Founder Name reposted this Someone Else 2h Original body"
          }
        ]
      ],
      {
        accountUrl: "https://www.linkedin.com/in/founder/",
        targetName: "Founder Name",
        limit: 5
      }
    );

    assert.deepEqual(merged, []);
  });

  it("does not confuse ordinary native prose containing shared this with a wrapper", () => {
    const original = {
      url: "https://www.linkedin.com/posts/founder_analysis-activity-7475000000000000007-good",
      author: "Founder Name",
      authorUrls: ["https://www.linkedin.com/in/founder/"],
      body: "I shared this analysis with our customers before publishing it.",
      rawText:
        "Feed post number 1 Founder Name • 1st Founder at Acme 2h I shared this analysis with our customers before publishing it."
    };

    assert.equal(linkedinPostIsExplicitRepost(original, "Founder Name"), false);
    assert.equal(
      mergeOwnedLinkedInPosts([[original]], {
        accountUrl: "https://www.linkedin.com/in/founder/",
        targetName: "Founder Name",
        limit: 5
      }).length,
      1
    );
  });

  it("rejects nested reshare cards that expose the embedded parent's activity id", () => {
    const nested = {
      url: "https://www.linkedin.com/feed/update/urn:li:activity:7475000000000000008/",
      author: "Founder Name",
      authorUrls: [
        "https://www.linkedin.com/in/founder/",
        "https://www.linkedin.com/in/embedded-author/"
      ],
      body: "The embedded author's original post body.",
      rawText:
        "Feed post number 4 Founder Name • 2nd Founder at Acme 2w • Follow " +
        "Proud to support this launch. Embedded Author • 2nd CEO at Other 2w • Follow " +
        "The embedded author's original post body. 14 reactions 2 comments"
    };

    assert.equal(linkedinPostIsExplicitRepost(nested, "Founder Name"), true);
    assert.deepEqual(
      mergeOwnedLinkedInPosts([[nested]], {
        accountUrl: "https://www.linkedin.com/in/founder/",
        targetName: "Founder Name",
        limit: 5
      }),
      []
    );
  });

  it("rejects one-Follow founder wrappers around an embedded organization activity", () => {
    const wrapper = {
      url:
        "https://www.linkedin.com/feed/update/urn:li:activity:7479927233340702722/",
      author: "Eric Taylor",
      authorUrls: ["https://www.linkedin.com/in/eric-taylor/"],
      body: "Baud is building high-performance AI infrastructure.",
      rawText:
        "Feed post number 1 Eric Taylor • 2nd Founder at Baud 2d • Follow " +
        "Today we are coming out of stealth. Y Combinator 1,736,380 followers " +
        "2d • Baud is building high-performance AI infrastructure."
    };

    assert.equal(linkedinPostIsExplicitRepost(wrapper, "Eric Taylor"), true);
    assert.deepEqual(
      mergeOwnedLinkedInPosts([[wrapper]], {
        accountUrl: "https://www.linkedin.com/in/eric-taylor/",
        targetName: "Eric Taylor",
        limit: 5
      }),
      []
    );
  });

  it("does not reject a native organization card whose follower header precedes Follow", () => {
    const native = {
      url:
        "https://www.linkedin.com/posts/acme_launch-activity-7479927233340702723-good",
      author: "Acme",
      authorUrls: ["https://www.linkedin.com/company/acme/"],
      body: "We launched today.",
      rawText:
        "Feed post number 1 Acme 12,340 followers 2d • Follow We launched today."
    };

    assert.equal(linkedinPostIsExplicitRepost(native, "Acme"), false);
  });

  it("rejects compact reshare headers that omit the feed-post prefix", () => {
    const nested = {
      url: "https://www.linkedin.com/feed/update/urn:li:activity:7487596571207815168/",
      author: "Alexandre Labreche",
      authorUrls: ["https://www.linkedin.com/in/alexandrelabreche/"],
      body: "The embedded company's original post body.",
      rawText:
        "Alexandre Labreche Alexandre Labreche 1d Alexandre Labreche shared this " +
        "The embedded company's original post body."
    };

    assert.equal(
      linkedinPostIsExplicitRepost(nested, "Alexandre Labreche"),
      true
    );
    assert.equal(linkedinPostIsExplicitRepost(nested), true);
    assert.equal(
      linkedinPostIsExplicitRepost({
        rawText:
          "Alexandre Labreche Alexandre Labreche 1d I shared this analysis with our customers."
      }),
      false
    );
    assert.deepEqual(
      mergeOwnedLinkedInPosts([[nested]], {
        accountUrl: "https://www.linkedin.com/in/alexandrelabreche/",
        targetName: "Alexandre Labreche",
        limit: 5
      }),
      []
    );
  });

  it("unions adapter and DOM observations by native activity ID", () => {
    const url =
      "https://www.linkedin.com/posts/founder_launch-activity-7475000000000000001-good";
    const merged = mergeOwnedLinkedInPosts(
      [
        [
          {
            url,
            author: "Founder Name",
            authorUrls: ["https://www.linkedin.com/in/founder/"],
            body: "Short DOM body",
            rawText: "Founder Name\\n2h\\nShort DOM body",
            reactions: 10,
            comments: 4,
            reposts: 1,
            impressions: 100,
            mediaUrls: ["https://media.licdn.com/dom.jpg"]
          }
        ],
        [
          {
            url,
            author: "Founder Name",
            body: "Longer adapter body for the same native post.",
            raw_text: "Founder Name 2h Longer adapter body for the same native post.",
            reactions: 12,
            comments: 3,
            reposts: 2,
            impressions: 150,
            media_urls: "https://media.licdn.com/adapter.jpg",
            posted_at: "2026-07-29T10:00:00.000Z"
          }
        ]
      ],
      {
        accountUrl: "https://www.linkedin.com/in/founder/",
        targetName: "Founder Name",
        limit: 10
      }
    );

    assert.equal(merged.length, 1);
    assert.equal(merged[0].id, "7475000000000000001");
    assert.equal(merged[0].body, "Longer adapter body for the same native post.");
    assert.equal(merged[0].reactions, 12);
    assert.equal(merged[0].comments, 4);
    assert.equal(merged[0].reposts, 2);
    assert.equal(merged[0].impressions, 150);
    assert.deepEqual(merged[0].mediaUrls, [
      "https://media.licdn.com/dom.jpg",
      "https://media.licdn.com/adapter.jpg"
    ]);
  });

  it("uses exact DOM author proof to authorize metrics from an opaque adapter activity", () => {
    const accountUrl = "https://www.linkedin.com/in/founder/";
    const opaqueUrl =
      "https://www.linkedin.com/feed/update/urn:li:activity:7475000000000000002/";
    const merged = mergeOwnedLinkedInPosts(
      [
        [
          {
            url: opaqueUrl,
            author: "Founder Name",
            authorUrls: [accountUrl],
            body: "DOM body",
            rawText: "Founder Name\\n2h\\nDOM body",
            reactions: 3
          }
        ],
        [
          {
            url: opaqueUrl,
            author: "Founder Name",
            body: "Longer adapter body for the opaque native activity.",
            raw_text: "Founder Name 2h Longer adapter body for the opaque native activity.",
            reactions: 19,
            comments: 4,
            reposts: 2,
            posted_at: "2026-07-29T11:00:00.000Z"
          }
        ]
      ],
      { accountUrl, targetName: "Founder Name", limit: 5 }
    );

    assert.equal(merged.length, 1);
    assert.equal(merged[0].id, "7475000000000000002");
    assert.equal(merged[0].reactions, 19);
    assert.equal(merged[0].comments, 4);
    assert.equal(merged[0].reposts, 2);
  });

  it("rejects an opaque adapter activity without exact DOM owner proof", () => {
    const accountUrl = "https://www.linkedin.com/in/founder/";
    const opaque = {
      url: "https://www.linkedin.com/feed/update/urn:li:activity:7475000000000000003/",
      author: "Founder Name",
      body: "Adapter-only body",
      raw_text: "Founder Name 2h Adapter-only body",
      reactions: 21
    };
    assert.deepEqual(
      mergeOwnedLinkedInPosts([[opaque]], {
        accountUrl,
        targetName: "Founder Name",
        limit: 5
      }),
      []
    );
  });

  it("does not let mismatched DOM identity authorize opaque adapter metrics", () => {
    const opaqueUrl =
      "https://www.linkedin.com/feed/update/urn:li:activity:7475000000000000004/";
    const merged = mergeOwnedLinkedInPosts(
      [
        [
          {
            url: opaqueUrl,
            author: "Someone Else",
            authorUrls: ["https://www.linkedin.com/in/someone-else/"],
            body: "DOM body from another profile",
            rawText: "Someone Else\\n2h\\nDOM body from another profile"
          }
        ],
        [
          {
            url: opaqueUrl,
            author: "Founder Name",
            body: "Adapter body",
            raw_text: "Founder Name 2h Adapter body",
            reactions: 50
          }
        ]
      ],
      {
        accountUrl: "https://www.linkedin.com/in/founder/",
        targetName: "Founder Name",
        limit: 5
      }
    );
    assert.deepEqual(merged, []);
  });

  it("distinguishes successful empty reads from command failures", () => {
    assert.deepEqual(
      linkedinCollectionAttemptState({
        postCount: 0,
        attemptedSourceCount: 1,
        completedSourceCount: 1
      }),
      { status: "done", collectionFailed: false }
    );
    assert.deepEqual(
      linkedinCollectionAttemptState({
        postCount: 0,
        attemptedSourceCount: 1,
        completedSourceCount: 1,
        failedSourceCount: 1
      }),
      { status: "failed", collectionFailed: true }
    );
    assert.deepEqual(
      linkedinCollectionAttemptState({
        postCount: 2,
        attemptedSourceCount: 2,
        completedSourceCount: 1,
        failedSourceCount: 1
      }),
      { status: "done", collectionFailed: false }
    );
    assert.deepEqual(
      linkedinCollectionAttemptState({
        postCount: 0,
        attemptedSourceCount: 1,
        completedSourceCount: 0
      }),
      { status: "failed", collectionFailed: true }
    );
  });

  it("exhausts untouched zero-coverage targets before failed retries and low-coverage refreshes", () => {
    const targets = [
      { platform: "x", entityId: "x-first" },
      {
        platform: "linkedin",
        batchSlug: "S2026",
        entityId: "many",
        url: "https://www.linkedin.com/in/many/"
      },
      {
        platform: "linkedin",
        batchSlug: "S2026",
        entityId: "never",
        url: "https://www.linkedin.com/in/never/"
      },
      {
        platform: "linkedin",
        batchSlug: "S2026",
        entityId: "failed",
        url: "https://www.linkedin.com/in/failed/"
      },
      {
        platform: "linkedin",
        batchSlug: "S2026",
        entityId: "old-low",
        url: "https://www.linkedin.com/in/old-low/"
      },
      {
        platform: "linkedin",
        batchSlug: "S2026",
        entityId: "new-low",
        url: "https://www.linkedin.com/in/new-low/"
      }
    ];
    const prioritized = prioritizeLinkedInTargets(targets, {
      evidence: [
        {
          platform: "linkedin",
          batchSlug: "S2026",
          entityId: "many",
          platformPostId: "7475000000000000010"
        },
        {
          platform: "linkedin",
          batchSlug: "S2026",
          entityId: "many",
          sourceUrl:
            "https://www.linkedin.com/posts/many_activity-7475000000000000011-good"
        },
        {
          platform: "linkedin",
          batchSlug: "S2026",
          entityId: "many",
          sourceUrl:
            "https://www.linkedin.com/feed/update/urn:li:activity:7475000000000000011/"
        },
        {
          platform: "linkedin",
          batchSlug: "S2026",
          entityId: "many",
          sourceUrl: "https://www.linkedin.com/in/many/"
        },
        {
          platform: "linkedin",
          batchSlug: "S2026",
          entityId: "old-low",
          platformPostId: "7475000000000000012"
        },
        {
          platform: "linkedin",
          batchSlug: "S2026",
          entityId: "new-low",
          platformPostId: "7475000000000000013"
        }
      ],
      attempts: new Map([
        ["failed", { status: "failed", checkedAt: "2026-07-28T00:00:00.000Z" }],
        ["old-low", { status: "done", checkedAt: "2026-07-27T00:00:00.000Z" }],
        ["new-low", { status: "done", checkedAt: "2026-07-29T00:00:00.000Z" }]
      ]),
      attemptKey: (target) => target.entityId
    });
    assert.deepEqual(
      prioritized.map((target) => target.entityId),
      ["x-first", "never", "failed", "old-low", "new-low", "many"]
    );
  });

  it("opens the circuit immediately for auth/rate limiting or after repeated infrastructure failures", () => {
    assert.equal(linkedinFailureKind("HTTP 429 too many requests"), "rate_limited");
    assert.equal(linkedinFailureKind("Sign in to continue"), "auth");
    assert.equal(
      linkedinFailureKind(
        "No attributable original LinkedIn posts were visible in browser mode."
      ),
      "target_specific"
    );
    assert.equal(
      linkedinFailureKind("LinkedIn browser DOM extractor failed: connection dropped"),
      "transport"
    );
    assert.deepEqual(
      linkedinCircuitDecision({
        consecutiveFailures: 1,
        maxConsecutiveFailures: 5,
        failureKind: "auth"
      }),
      { open: true, reason: "auth" }
    );
    assert.deepEqual(
      linkedinCircuitDecision({
        consecutiveFailures: 5,
        maxConsecutiveFailures: 5,
        failureKind: "transport"
      }),
      { open: true, reason: "consecutive_failures" }
    );
    assert.deepEqual(
      linkedinCircuitDecision({
        consecutiveFailures: 50,
        maxConsecutiveFailures: 5,
        failureKind: "target_specific"
      }),
      { open: false, reason: null }
    );
    assert.deepEqual(
      linkedinCircuitDecision({
        consecutiveFailures: 50,
        maxConsecutiveFailures: 5,
        failureKind: "empty"
      }),
      { open: false, reason: null }
    );
  });

  it("keeps target-specific misses retryable without advancing the global circuit", () => {
    assert.deepEqual(
      linkedinCircuitStateTransition({
        previousConsecutiveFailures: 4,
        collectionFailed: true,
        maxConsecutiveFailures: 5,
        failureKind: "target_specific"
      }),
      { consecutiveFailures: 0, open: false, reason: null }
    );
    assert.deepEqual(
      linkedinCircuitStateTransition({
        previousConsecutiveFailures: 4,
        collectionFailed: true,
        maxConsecutiveFailures: 5,
        failureKind: "system"
      }),
      {
        consecutiveFailures: 5,
        open: true,
        reason: "consecutive_failures"
      }
    );
    assert.deepEqual(
      linkedinCircuitStateTransition({
        previousConsecutiveFailures: 0,
        collectionFailed: true,
        maxConsecutiveFailures: 5,
        failureKind: "auth"
      }),
      { consecutiveFailures: 1, open: true, reason: "auth" }
    );
  });
});

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
