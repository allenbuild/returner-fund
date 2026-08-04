import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  INGESTION_TERMINAL_OUTCOME_RESOLUTION_VERSION,
  buildTerminalOutcomeResolutionSummary,
  resolveTerminalOutcomePair
} from "../scripts/lib/ingestion-terminal-outcome-resolution.mjs";

describe("canonical terminal-outcome resolution", () => {
  it("uses deterministic evidence precedence and retains every discarded signal", () => {
    const row = pair({
      terminal: signal("queued", "manual_review_required", "terminal"),
      outcomes: [
        signal("blocked", "rate_limited", "blocked-task"),
        signal("collected", "native_evidence_collected", "collected-task")
      ],
      evidencePosts: 1,
      mappedAccounts: 1
    });

    const resolved = resolveTerminalOutcomePair(row);
    assert.equal(resolved.outcome, "collected");
    assert.equal(resolved.reasonCode, "native_evidence_collected");
    assert.equal(resolved.compliant, true);
    assert.equal(resolved.resolutionProvenance.rawContradictory, true);
    assert.deepEqual(
      resolved.resolutionProvenance.discardedSignals.map((entry) => entry.reasonCode),
      ["manual_review_required", "rate_limited"]
    );
  });

  it("never infers verified_no_account without exhaustive, internally consistent proof", () => {
    const missingProof = resolveTerminalOutcomePair(pair({
      terminal: signal("verified_no_account", "exhaustive_absence_verified", "terminal"),
      outcomes: [signal(
        "verified_no_account",
        "exhaustive_absence_verified",
        "task"
      )]
    }));
    assert.equal(missingProof.outcome, "requires_credentials_or_manual_review");
    assert.equal(missingProof.queueSubdisposition, "manual_review");
    assert.match(missingProof.reason, /No exhaustive native-account absence proof exists/);

    const contradictoryMapping = pair({
      terminal: signal("verified_no_account", "exhaustive_absence_verified", "terminal", {
        absenceVerification: exhaustiveAbsenceProof()
      }),
      outcomes: [signal(
        "verified_no_account",
        "exhaustive_absence_verified",
        "task",
        { absenceVerification: exhaustiveAbsenceProof() }
      )],
      mappedAccounts: 1
    });
    const inconsistent = resolveTerminalOutcomePair(contradictoryMapping);
    assert.equal(inconsistent.outcome, "requires_credentials_or_manual_review");
    assert.equal(inconsistent.queueSubdisposition, "manual_review");

    const proved = resolveTerminalOutcomePair(pair({
      terminal: signal("verified_no_account", "exhaustive_absence_verified", "terminal", {
        absenceVerification: exhaustiveAbsenceProof()
      }),
      outcomes: []
    }));
    assert.equal(proved.outcome, "verified_no_account");
    assert.ok(proved.absenceVerification);
  });

  it("does not accept a collected label without a linked native evidence row", () => {
    const resolved = resolveTerminalOutcomePair(pair({
      terminal: signal("collected", "native_evidence_collected", "terminal"),
      outcomes: [signal("collected", "native_evidence_collected", "task")],
      evidencePosts: 0
    }));
    assert.equal(resolved.outcome, "requires_credentials_or_manual_review");
    assert.equal(resolved.queueSubdisposition, "manual_review");
    assert.match(resolved.reason, /No exhaustive native-account absence proof exists/);
  });

  it("records exact provider/code provenance for multiple access blockers", () => {
    const resolved = resolveTerminalOutcomePair(pair({
      terminal: signal("queued", "ambiguous_legacy_outcome", "terminal"),
      outcomes: [
        signal("blocked", "network_error", "provider-a"),
        signal("blocked", "captcha_required", "provider-b")
      ]
    }));
    assert.equal(resolved.outcome, "access_blocked");
    assert.equal(resolved.reasonCode, "multiple_access_blocks");
    assert.match(resolved.reason, /network_error@provider-a/);
    assert.match(resolved.reason, /captcha_required@provider-b/);
    assert.equal(resolved.resolutionProvenance.discardedSignals.length, 1);
  });

  it("reconciles every core pair once and fails closed on duplicate ordering", () => {
    const pairs = [
      pair({
        key: "TEST:company:a:github",
        terminal: signal("queued", "ambiguous_legacy_outcome", "terminal"),
        outcomes: []
      }),
      pair({
        key: "TEST:company:b:github",
        terminal: signal("blocked", "access_denied", "terminal"),
        outcomes: []
      })
    ];
    const receipt = {
      inventory: { corePairCount: 2 },
      pairs
    };
    const summary = buildTerminalOutcomeResolutionSummary(receipt, { previewLimit: 1 });
    assert.equal(summary.schemaVersion, INGESTION_TERMINAL_OUTCOME_RESOLUTION_VERSION);
    assert.equal(summary.complete, true);
    assert.equal(summary.resolvedPairs, 2);
    assert.deepEqual(summary.outcomeCounts, {
      collected: 0,
      verified_no_account: 0,
      access_blocked: 1,
      requires_credentials_or_manual_review: 1
    });
    assert.match(summary.pairResolutionSha256, /^[a-f0-9]{64}$/);
    assert.equal(summary.auditProvenance.discardedSignalPreviewLimit, 1);

    assert.throws(
      () => buildTerminalOutcomeResolutionSummary({
        inventory: { corePairCount: 2 },
        pairs: [pairs[0], structuredClone(pairs[0])]
      }),
      /unique and ascending/
    );
  });
});

function pair({
  key = "TEST:company:acme:github",
  terminal,
  outcomes,
  evidencePosts = 0,
  mappedAccounts = 0
}) {
  return {
    pairKey: key,
    matrixScope: "core",
    batchSlug: "TEST",
    entity: { type: "company", id: key.split(":")[2], name: "Acme" },
    platform: "github",
    terminal,
    accountOutcomes: outcomes,
    mapping: { accountCount: mappedAccounts },
    evidence: { postCount: evidencePosts },
    scope: { objectiveComplete: false }
  };
}

function signal(status, reasonCode, taskKey, overrides = {}) {
  return {
    taskKey,
    status,
    reasonCode,
    isTerminal: status !== "queued",
    reason: `Exact ${reasonCode} source result from ${taskKey}.`,
    nextAction: `Execute the concrete next action for ${taskKey}.`,
    absenceVerification: null,
    ...overrides
  };
}

function exhaustiveAbsenceProof() {
  return {
    receiptId: "absence-proof-one",
    exhaustive: true,
    checkedAt: "2026-08-03T03:10:00.000Z",
    checkedSources: ["native profile", "official website"],
    method: "Exhaustively checked every declared native and official source."
  };
}
