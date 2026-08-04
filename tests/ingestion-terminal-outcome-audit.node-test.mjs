import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  REQUIRED_TERMINAL_OUTCOMES,
  auditTerminalOutcomePair,
  scanMaterializationCoveragePairs
} from "../scripts/lib/ingestion-terminal-outcome-audit.mjs";

describe("core pair terminal-outcome audit", () => {
  it("accepts exactly the four user-required terminal categories", () => {
    const rows = [
      pair({ status: "collected", reasonCode: "native_evidence_collected" }),
      pair({
        key: "TEST:company:acme:x",
        platform: "x",
        status: "verified_no_account",
        reasonCode: "exhaustive_absence_verified",
        absenceVerification: { checkedAt: "2026-08-03T03:10:00.000Z" }
      }),
      pair({
        key: "TEST:company:acme:instagram",
        platform: "instagram",
        status: "blocked",
        reasonCode: "captcha_required"
      }),
      pair({
        key: "TEST:company:acme:linkedin",
        platform: "linkedin",
        status: "queued",
        reasonCode: "missing_credentials"
      }),
      pair({
        key: "TEST:company:acme:youtube",
        platform: "youtube",
        status: "queued",
        reasonCode: "manual_review_required"
      })
    ];
    const audits = rows.map(auditTerminalOutcomePair);

    assert.ok(audits.every((audit) => audit.compliant));
    assert.deepEqual(
      new Set(audits.map((audit) => audit.outcome)),
      new Set(REQUIRED_TERMINAL_OUTCOMES)
    );
    assert.equal(audits[3].queueSubdisposition, "requires_credentials");
    assert.equal(audits[4].queueSubdisposition, "manual_review");
  });

  it("records unsupported queues, missing text, and contradictory account outcomes", () => {
    const unsupported = auditTerminalOutcomePair(pair({
      status: "queued",
      reasonCode: "ambiguous_legacy_outcome"
    }));
    const missingTextPair = pair({
      status: "blocked",
      reasonCode: "access_denied"
    });
    missingTextPair.terminal.reason = "blocked";
    missingTextPair.terminal.nextAction = "none";
    const missingText = auditTerminalOutcomePair(missingTextPair);
    const contradictoryPair = pair({
      status: "queued",
      reasonCode: "manual_review_required"
    });
    contradictoryPair.accountOutcomes.push(outcome({
      status: "blocked",
      reasonCode: "rate_limited",
      taskKey: "task-two"
    }));
    const contradictory = auditTerminalOutcomePair(contradictoryPair);

    assert.equal(unsupported.outcome, null);
    assert.equal(unsupported.structurallyUndocumented, true);
    assert.deepEqual(
      unsupported.issues.map((entry) => entry.code),
      ["unsupported_terminal_outcome", "account_outcome_unsupported"]
    );
    assert.deepEqual(
      missingText.issues.map((entry) => entry.code),
      ["missing_exact_reason", "missing_concrete_next_action"]
    );
    assert.equal(contradictory.contradictory, true);
    assert.ok(contradictory.issues.some((entry) =>
      entry.code === "contradictory_account_outcomes"
    ));
    assert.equal(contradictory.compliant, false);
  });

  it("streams core pairs, ignores extended lanes, and binds the exact receipt bytes", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "terminal-outcome-scan-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const core = pair({
      status: "queued",
      reasonCode: "manual_review_required",
      reason: "Manually verify the official account marked with 🚀 before completing this pair."
    });
    const extended = {
      ...pair({
        key: "TEST:company:acme:tiktok",
        platform: "tiktok",
        status: "queued",
        reasonCode: "manual_review_required"
      }),
      matrixScope: "extended_only"
    };
    const receipt = { schemaVersion: "ingestion-coverage.v1", pairs: [core, extended] };
    const materialization = {
      schemaVersion: "ingestion-coverage-materialization.v1",
      runId: "fixture",
      coverageReceipt: receipt,
      provenance: {}
    };
    const path = join(root, "materialization.json");
    await writeFile(path, JSON.stringify(materialization));
    const observed = [];
    const result = await scanMaterializationCoveragePairs({
      materializationPath: path,
      onPair: (row) => observed.push(row.pairKey),
      maxPairBytes: 64 * 1024
    });

    assert.deepEqual(observed, [core.pairKey, extended.pairKey]);
    assert.equal(result.allPairs, 2);
    assert.equal(result.corePairs, 1);
    assert.equal(result.materializationSchemaVersion, materialization.schemaVersion);
    assert.equal(result.coverageReceiptSha256, sha256(JSON.stringify(receipt)));
    assert.equal(result.coverageReceiptBytes, Buffer.byteLength(JSON.stringify(receipt)));
  });

  it("fails closed on duplicate rows and the per-pair safety cap", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "terminal-outcome-fail-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const row = pair({ status: "collected", reasonCode: "native_evidence_collected" });
    const duplicatePath = join(root, "duplicate.json");
    await writeFile(duplicatePath, JSON.stringify({
      schemaVersion: "ingestion-coverage-materialization.v1",
      coverageReceipt: { pairs: [row, row] }
    }));
    await assert.rejects(
      scanMaterializationCoveragePairs({
        materializationPath: duplicatePath,
        onPair() {},
        maxPairBytes: 64 * 1024
      }),
      /Duplicate coverage pair/
    );

    const oversizedPath = join(root, "oversized.json");
    const oversized = { ...row, rawCollectorReason: "x".repeat(4_000) };
    await writeFile(oversizedPath, JSON.stringify({
      schemaVersion: "ingestion-coverage-materialization.v1",
      coverageReceipt: { pairs: [oversized] }
    }));
    await assert.rejects(
      scanMaterializationCoveragePairs({
        materializationPath: oversizedPath,
        onPair() {},
        maxPairBytes: 1024
      }),
      /exceeds the 1024-byte safety limit/
    );
  });
});

function pair({
  key = "TEST:company:acme:github",
  platform = "github",
  status,
  reasonCode,
  reason = "The collector recorded a precise native-source terminal outcome for this pair.",
  nextAction = "Retain this receipt and continue scheduled ingestion for the canonical pair.",
  absenceVerification = null
}) {
  return {
    pairKey: key,
    matrixScope: "core",
    batchSlug: "TEST",
    entity: { type: "company", id: "acme", name: "Acme" },
    platform,
    terminal: {
      status,
      reasonCode,
      isTerminal: status !== "queued",
      reason,
      nextAction,
      absenceVerification
    },
    accountOutcomes: [outcome({ status, reasonCode })],
    scope: { objectiveComplete: false }
  };
}

function outcome({
  status,
  reasonCode,
  taskKey = "task-one"
}) {
  return {
    taskKey,
    status,
    reasonCode,
    isTerminal: status !== "queued",
    reason: "The task recorded a precise native-source outcome.",
    nextAction: "Retain the task receipt and continue the canonical workflow."
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
