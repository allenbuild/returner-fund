import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptanceBindingSha256,
  buildIngestionAcceptanceMarker,
  inspectIngestionAcceptanceMarker,
  inspectIngestionPublicationBinding,
  sha256Text
} from "../scripts/lib/ingestion-acceptance-marker.mjs";

const publicationCommit = "a".repeat(40);
const validatedCommit = "b".repeat(40);
const sourceCommit = "c".repeat(40);
const slotKey = "central-2026-09-06-1800";
const scheduledAt = "2026-09-06T23:00:00.000Z";
const evidenceCollectedAt = "2026-09-07T05:47:11.477Z";
const receiptText = `${JSON.stringify({
  schemaVersion: 1,
  idempotencyKey: slotKey,
  trigger: "schedule",
  scheduledAt,
  evidenceCollectedAt
})}\n`;
const manifestText = `${JSON.stringify({
  schemaVersion: 2,
  evidenceCollectedAt,
  evidenceCollectedAtKind: "accepted-full-collection",
  contentHash: "d".repeat(64)
})}\n`;
const refreshedManifestText = `${JSON.stringify({
  schemaVersion: 2,
  evidenceCollectedAt,
  evidenceCollectedAtKind: "accepted-full-collection",
  contentHash: "e".repeat(64)
})}\n`;
const publicationMessage = [
  `Publish autonomous ingestion ${slotKey}`,
  "",
  `Returner-Slot-Key: ${slotKey}`,
  `Returner-Source-SHA: ${sourceCommit}`,
  "Returner-Run-ID: 34085679151",
  "Returner-Run-Attempt: 1",
  `Returner-Receipt-SHA256: ${sha256Text(receiptText)}`,
  ""
].join("\n");

test("builds a publication-bound marker from an artifact-equivalent latest-policy validation", async () => {
  const marker = await buildFixtureMarker();

  assert.equal(marker.publicationCommit, publicationCommit);
  assert.equal(marker.validation.validatedSha, validatedCommit);
  assert.equal(marker.receiptSha256, sha256Text(receiptText));
  assert.equal(marker.publicationManifestSha256, sha256Text(manifestText));
  assert.equal(marker.validatedManifestSha256, sha256Text(manifestText));
  assert.equal(marker.bindingSha256, acceptanceBindingSha256(marker));

  const inspection = inspectIngestionAcceptanceMarker({
    markerText: `${JSON.stringify(marker)}\n`,
    receiptText,
    manifestText,
    now: new Date("2026-09-07T07:01:00.000Z")
  });
  assert.equal(inspection.status, "valid", inspection.error);
});

test("acceptance inspection fails closed on marker, receipt, or manifest mismatches", async () => {
  const marker = await buildFixtureMarker();
  const cases = [
    {
      marker: { ...marker, publicationCommit: "e".repeat(40) },
      receiptText,
      manifestText,
      expected: /binding hash mismatch/
    },
    {
      marker,
      receiptText: `${receiptText} `,
      manifestText,
      expected: /receipt does not match/
    },
    {
      marker,
      receiptText,
      manifestText: manifestText.replace(`"contentHash":"${"d".repeat(64)}"`, `"contentHash":"${"e".repeat(64)}"`),
      expected: /manifest does not match/
    }
  ];

  for (const fixture of cases) {
    const inspection = inspectIngestionAcceptanceMarker({
      markerText: `${JSON.stringify(fixture.marker)}\n`,
      receiptText: fixture.receiptText,
      manifestText: fixture.manifestText,
      now: new Date("2026-09-07T07:01:00.000Z")
    });
    assert.equal(inspection.status, "invalid");
    assert.match(inspection.error, fixture.expected);
  }
});

test("builder binds a rebuilt latest-policy manifest when current main matches it", async () => {
  const marker = await buildFixtureMarker({
    validatedManifestText: refreshedManifestText,
    currentManifestText: refreshedManifestText
  });

  assert.equal(marker.publicationManifestSha256, sha256Text(manifestText));
  assert.equal(marker.publicationManifestContentHash, "d".repeat(64));
  assert.equal(marker.validatedManifestSha256, sha256Text(refreshedManifestText));
  assert.equal(marker.validatedManifestContentHash, "e".repeat(64));

  const inspection = inspectIngestionAcceptanceMarker({
    markerText: `${JSON.stringify(marker)}\n`,
    receiptText,
    manifestText: refreshedManifestText,
    now: new Date("2026-09-07T07:01:00.000Z")
  });
  assert.equal(inspection.status, "valid", inspection.error);

  const publicationInspection = inspectIngestionPublicationBinding({
    marker,
    receiptText,
    manifestText
  });
  assert.equal(publicationInspection.status, "valid", publicationInspection.error);
});

test("builder rejects current main when it diverges from the exact validated manifest", async () => {
  await assert.rejects(
    () => buildFixtureMarker({
      validatedManifestText: refreshedManifestText,
      currentManifestText: manifestText
    }),
    /current main graph manifest diverged from the validated target/
  );
});

test("builder rejects a refreshed manifest that no longer represents the ingestion receipt", async () => {
  const wrongEvidenceManifest = refreshedManifestText.replace(
    evidenceCollectedAt,
    "2026-09-07T05:48:11.477Z"
  );
  await assert.rejects(
    () => buildFixtureMarker({
      validatedManifestText: wrongEvidenceManifest,
      currentManifestText: wrongEvidenceManifest
    }),
    /graph manifest evidence timestamp does not match publication receipt/
  );
});

test("builder rejects current main unless it is the exact validated commit", async () => {
  await assert.rejects(
    () => buildFixtureMarker({ currentCommit: "f".repeat(40) }),
    /current main is not the exact validated target/
  );
});

test("immutable publication and latest validation bindings fail independently", async () => {
  const marker = await buildFixtureMarker({
    validatedManifestText: refreshedManifestText,
    currentManifestText: refreshedManifestText
  });
  const publicationTamper = inspectIngestionPublicationBinding({
    marker,
    receiptText,
    manifestText: refreshedManifestText
  });
  assert.equal(publicationTamper.status, "invalid");
  assert.match(publicationTamper.error, /publication graph manifest does not match/);

  const validationTamper = inspectIngestionAcceptanceMarker({
    markerText: `${JSON.stringify(marker)}\n`,
    receiptText,
    manifestText,
    now: new Date("2026-09-07T07:01:00.000Z")
  });
  assert.equal(validationTamper.status, "invalid");
  assert.match(validationTamper.error, /current graph manifest does not match/);
});

async function buildFixtureMarker({
  publicationManifestText = manifestText,
  validatedManifestText = manifestText,
  currentManifestText = validatedManifestText,
  currentCommit = validatedCommit
} = {}) {
  const textByRef = new Map([
    [publicationCommit, { receipt: receiptText, manifest: publicationManifestText }],
    [validatedCommit, { receipt: receiptText, manifest: validatedManifestText }],
    ["refs/remotes/origin/main", { receipt: receiptText, manifest: currentManifestText }]
  ]);
  return buildIngestionAcceptanceMarker({
    publicationRef: publicationCommit,
    validatedRef: validatedCommit,
    currentRef: "refs/remotes/origin/main",
    slotKey,
    scheduledAt,
    acceptedAt: "2026-09-07T07:00:00.000Z",
    validationWorkflowRunId: "34099999999",
    validationWorkflowRunAttempt: "2",
    readTextAtRef: async (ref, relativePath) => {
      const fixture = textByRef.get(ref);
      if (!fixture) throw new Error(`unknown ref ${ref}`);
      return relativePath.endsWith("manifest.json") ? fixture.manifest : fixture.receipt;
    },
    readCommitMessage: async () => publicationMessage,
    resolveRef: async () => currentCommit,
    isAncestor: async (ancestor, descendant) =>
      [publicationCommit, validatedCommit, sourceCommit].includes(ancestor) &&
      [publicationCommit, validatedCommit, "refs/remotes/origin/main"].includes(descendant)
  });
}
