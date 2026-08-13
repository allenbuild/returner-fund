import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { generateRecentCompletionProofs } from
  "../scripts/lib/recent-completion-proof-generator.mjs";
import {
  PUBLIC_INGESTION_PROOF_ARTIFACT_VERSION,
  appendGithubOutputs,
  packagePublicIngestionProofArtifact,
  safeIngestionArtifactSegment
} from "../scripts/lib/public-ingestion-proof-artifact.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GENERATED_AT = "2026-08-02T23:06:00.000Z";

describe("public-safe ingestion proof artifact", () => {
  it("projects only allowlisted proof data and feeds the recent proof generator", async () => {
    await withFixture({}, async ({ root, sourceDir, outputDir, idempotencyKey }) => {
      const result = await packageArtifact({
        sourceDir,
        outputDir,
        idempotencyKey
      });
      const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
      const uploadedText = await readTreeText(outputDir);

      expect(manifest.schemaVersion).toBe(PUBLIC_INGESTION_PROOF_ARTIFACT_VERSION);
      expect(manifest.distribution.classification)
        .toBe("public_safe_github_actions_artifact");
      expect(manifest.distribution.containsRawCollectorBodies).toBe(false);
      expect(manifest.distribution.containsStoredUnpublishedRows).toBe(false);
      expect(manifest.artifacts.supporting).toHaveLength(1);
      expect(uploadedText).not.toContain("RAW_RESPONSE_BODY_MARKER");
      expect(uploadedText).not.toContain("Bearer source-only-secret-value");
      expect(uploadedText).not.toContain("rawVisibleText");
      expect(uploadedText).not.toContain("storedUnpublishedReceipt");
      expect(uploadedText).toContain("redacted_operational_error_present");
      expect(uploadedText).toContain("responseSha256");
      expect(result.manifestSha256).toMatch(/^[a-f0-9]{64}$/);

      const audit = await generateRecentCompletionProofs({
        root,
        campaignManifestPath: result.manifestPath,
        expectedCampaignSha256: result.manifestSha256,
        dryRun: true
      });
      expect(audit.status).toBe("generated_verified");
      expect(audit.denominator.completionEligiblePairs).toBe(1);
      expect(audit.packagingDecision).toMatch(/separately authenticated private pair-scopes/);
      const usage = await readFile(join(outputDir, "USAGE.md"), "utf8");
      expect(usage).toContain("PROOF_MANIFEST_SHA256=<digest-from-workflow-summary>");
      expect(manifest.artifacts.documentation.sha256).toBe(sha256(usage));
      expect(await listTreeFiles(outputDir)).toEqual([
        "campaign.json",
        ...declaredPaths(manifest.artifacts)
      ].sort());
    });
  });

  it("is deterministic for the same source binding and workflow metadata", async () => {
    await withFixture({}, async ({ sourceDir, root, idempotencyKey }) => {
      const first = await packageArtifact({
        sourceDir,
        outputDir: join(root, "proof-first"),
        idempotencyKey
      });
      const second = await packageArtifact({
        sourceDir,
        outputDir: join(root, "proof-second"),
        idempotencyKey
      });
      expect(first.manifestSha256).toBe(second.manifestSha256);
      expect(await readFile(first.manifestPath, "utf8"))
        .toBe(await readFile(second.manifestPath, "utf8"));
    });
  });

  it("fails closed after a source-declared journal is changed", async () => {
    await withFixture({}, async ({ sourceDir, outputDir, journalPath, idempotencyKey }) => {
      await writeFile(journalPath, "tampered\n");
      await expect(packageArtifact({ sourceDir, outputDir, idempotencyKey }))
        .rejects.toThrow(/SHA-256 mismatch|byte count mismatch/);
    });
  });

  it("rejects sensitive request parameters and request or response body fields", async () => {
    await withFixture({
      requestUrl:
        "https://www.instagram.com/api/v1/users/web_profile_info/?username=acme&access_token=do-not-upload"
    }, async ({ sourceDir, outputDir, idempotencyKey }) => {
      await expect(packageArtifact({ sourceDir, outputDir, idempotencyKey }))
        .rejects.toThrow(/forbidden or duplicate query parameter/);
    });

    await withFixture({ extraJournalFields: { responseBody: "RAW_RESPONSE_BODY_MARKER" } },
      async ({ sourceDir, outputDir, idempotencyKey }) => {
        await expect(packageArtifact({ sourceDir, outputDir, idempotencyKey }))
          .rejects.toThrow(/forbidden field responseBody/);
      });
  });

  it("rejects secret-shaped allowed-field content and nonstandard revision lengths", async () => {
    await withFixture({
      proofOverrides: { blockers: ["Bearer source-only-secret-value"] }
    }, async ({ sourceDir, outputDir, idempotencyKey }) => {
      await expect(packageArtifact({ sourceDir, outputDir, idempotencyKey }))
        .rejects.toThrow(/complete, body-free recent-window proof/);
    });

    await withFixture({}, async ({ sourceDir, outputDir, idempotencyKey }) => {
      await expect(packageArtifact({
        sourceDir,
        outputDir,
        idempotencyKey,
        sourceRevision: "a".repeat(41)
      })).rejects.toThrow(/lowercase Git commit digest/);
    });

    await withFixture({
      idempotencyKey: `ghp_${"A".repeat(20)}`
    }, async ({ sourceDir, outputDir, idempotencyKey }) => {
      await expect(packageArtifact({ sourceDir, outputDir, idempotencyKey }))
        .rejects.toThrow(/secret-shaped material/);
    });

    await withFixture({
      requestUrl:
        `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(`Bearer ghp_${"B".repeat(20)}`)}`
    }, async ({ sourceDir, outputDir, idempotencyKey }) => {
      await expect(packageArtifact({ sourceDir, outputDir, idempotencyKey }))
        .rejects.toThrow(/secret-shaped material/);
    });
  });

  it("writes exact single-line GitHub outputs and rejects command injection", async () => {
    const root = await mkdtemp(join(tmpdir(), "proof-outputs-"));
    try {
      const outputPath = join(root, "github-output.txt");
      await appendGithubOutputs(outputPath, {
        proof_manifest_sha256: "a".repeat(64),
        recent_window_journals: 2,
        artifact_path: "/tmp/safe artifact"
      });
      expect(await readFile(outputPath, "utf8")).toBe(
        `proof_manifest_sha256=${"a".repeat(64)}\n` +
        "recent_window_journals=2\n" +
        "artifact_path=/tmp/safe artifact\n"
      );
      await expect(appendGithubOutputs(outputPath, { unsafe: "ok\nINJECTED=1" }))
        .rejects.toThrow(/single line/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("derives traversal-safe, collision-resistant run directories", () => {
    const first = safeIngestionArtifactSegment("../../slot:2026-08-02T18:00");
    const second = safeIngestionArtifactSegment("../../slot:2026-08-02T18:01");
    expect(first).not.toContain("/");
    expect(first).not.toContain(":");
    expect(first).not.toBe(second);
    expect(first).toMatch(/-[a-f0-9]{16}$/);
  });
});

describe("autonomous ingestion public-safe proof retention", () => {
  it("uploads only the exact projected directory and records a reproducible command", async () => {
    const workflow = await readFile(
      join(repositoryRoot, ".github", "workflows", "autonomous-ingestion.yml"),
      "utf8"
    );
    const packageIndex = workflow.indexOf("Package public-safe ingestion proof journals");
    const uploadIndex = workflow.indexOf("Upload public-safe ingestion proof journals");
    const validateIndex = workflow.indexOf("Validate generated public artifacts");

    expect(packageIndex).toBeGreaterThan(-1);
    expect(uploadIndex).toBeGreaterThan(packageIndex);
    expect(validateIndex).toBeGreaterThan(uploadIndex);
    expect(workflow).toContain("scripts/package-public-ingestion-proof-artifact.mjs");
    expect(workflow).toContain("uses: actions/upload-artifact@v4");
    expect(workflow).toContain("path: ${{ steps.proof_package.outputs.artifact_path }}");
    expect(workflow).toContain("if-no-files-found: error");
    expect(workflow).toContain("retention-days: 90");
    expect(workflow).toContain(
      "always() && steps.ingestion.outputs.runner_status == 'refreshed'"
    );
    expect(workflow).toContain(
      "always() && steps.proof_package.outcome == 'success'"
    );
    expect(workflow).toContain("steps.proof_package.outputs.proof_manifest_sha256");
    expect(workflow).toContain("steps.proof_upload.outputs.artifact-digest");
    expect(workflow).toContain("generate-recent-completion-proofs.mjs");
    expect(workflow).toContain("no raw collector bodies");
    expect(workflow).not.toContain("work/private-ingestion-proof-artifacts/");
    expect(workflow).not.toContain("private-ingestion-proof-");
  });

  it("is reached by the application release gate through Vitest discovery", async () => {
    const [workflow, packageJson, runner] = await Promise.all([
      readFile(join(repositoryRoot, ".github", "workflows", "public-artifacts.yml"), "utf8"),
      readFile(join(repositoryRoot, "package.json"), "utf8").then(JSON.parse),
      readFile(join(repositoryRoot, "scripts", "run-vitest-isolated.mjs"), "utf8")
    ]);
    expect(workflow).toContain("run: npm run check");
    expect(packageJson.scripts.check).toMatch(/npm run test/);
    expect(packageJson.scripts.test).toContain("run-vitest-isolated.mjs");
    expect(runner).toContain("/\\.test\\.(?:[cm]?[jt]sx?)$/");
  });
});

async function withFixture(options, run) {
  const root = await mkdtemp(join(tmpdir(), "public-ingestion-proof-"));
  const sourceDir = join(root, "prepared");
  const outputDir = join(root, "uploadable");
  const {
    idempotencyKey = "slot-2026-08-02-18",
    ...fixtureOptions
  } = options;
  try {
    const fixture = await writeFixture({
      root: sourceDir,
      idempotencyKey,
      ...fixtureOptions
    });
    await run({ root, sourceDir, outputDir, idempotencyKey, ...fixture });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeFixture({
  root,
  idempotencyKey,
  requestUrl = "https://www.instagram.com/api/v1/users/web_profile_info/?username=acme",
  extraJournalFields = {},
  proofOverrides = {}
}) {
  const coveredThrough = "2026-08-02T23:00:00.000Z";
  const coveredFrom = "2026-05-04T23:00:00.000Z";
  const requestedAt = "2026-08-02T23:00:01.000Z";
  const checkedAt = "2026-08-02T23:00:02.000Z";
  const completedAt = "2026-08-02T23:00:03.000Z";
  const campaignGeneratedAt = "2026-08-02T23:05:00.000Z";
  const attemptKey = "instagram:company:company-acme:https://www.instagram.com/acme";
  const pairKey = "TEST:company:company-acme:instagram";
  const journalRelative = "recent-window-journals/shard-0/proof.ndjson";
  const journalRow = {
    schemaVersion: "recent-native-page-receipt.v1",
    sequence: 1,
    attemptKey,
    pairKey,
    requestedAt,
    completedAt: checkedAt,
    requestUrl,
    status: "success",
    cursorIn: null,
    cursorOut: null,
    sourceExhausted: true,
    responseSha256: sha256("RAW_RESPONSE_BODY_MARKER"),
    coverageFrom: coveredFrom,
    coverageThrough: coveredThrough,
    ...extraJournalFields
  };
  const journalBody = `${JSON.stringify(journalRow)}\n`;
  const runnerBody = [
    { eventType: "run.started", createdAt: coveredThrough, payload: { raw: "not-uploaded" } },
    { eventType: "run.completed", createdAt: completedAt, payload: { raw: "not-uploaded" } }
  ].map(JSON.stringify).join("\n") + "\n";
  const catalogsBody = `${JSON.stringify([{
    slug: "TEST",
    sourcePath: "private/source.ts",
    sourceVersion: "source-v1",
    companies: [{
      id: "company-acme",
      name: "Acme Private Display Name",
      accounts: [],
      founders: [{
        id: "founder-alice",
        name: "Alice Private Display Name",
        accounts: []
      }]
    }]
  }])}\n`;
  const proof = {
    schemaVersion: "recent-native-window-proof.v1",
    status: "complete",
    coverageScope: "pair_all_native_targets",
    coveredFrom,
    coveredThrough,
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
      path: journalRelative,
      sha256: sha256(journalBody),
      observedAt: checkedAt
    },
    ...proofOverrides
  };
  const collectorBody = `${JSON.stringify({
    source: { batchSlug: "TEST", fetchedAt: checkedAt },
    attempts: {
      proof: {
        batchSlug: "TEST",
        platform: "instagram",
        entityType: "company",
        entityId: "company-acme",
        attemptKey,
        status: "done",
        outcomeStatus: "completed",
        checkedAt,
        recentWindowCoverageCutoff: coveredThrough,
        recentWindowProof: proof,
        rawRequestHeaders: { authorization: "Bearer source-only-secret-value" }
      },
      blocked: {
        batchSlug: "TEST",
        platform: "linkedin",
        entityType: "company",
        entityId: "company-acme",
        attemptKey: "linkedin:company:company-acme:missing-url",
        status: "failed",
        outcomeStatus: "blocked_or_empty",
        checkedAt,
        error: "Bearer source-only-secret-value"
      }
    },
    evidence: [{ rawVisibleText: "RAW_RESPONSE_BODY_MARKER" }],
    pairScopes: [{ storedUnpublishedReceipt: "RAW_RESPONSE_BODY_MARKER" }]
  })}\n`;

  await Promise.all([
    mkdir(join(root, "generated"), { recursive: true }),
    mkdir(join(root, "collectors"), { recursive: true }),
    mkdir(join(root, "recent-window-journals", "shard-0"), { recursive: true })
  ]);
  const journalPath = join(root, journalRelative);
  await Promise.all([
    writeFile(join(root, "generated", "catalogs.json"), catalogsBody),
    writeFile(join(root, "generated", "runner.ndjson"), runnerBody),
    writeFile(join(root, "collectors", "public-test.json"), collectorBody),
    writeFile(journalPath, journalBody)
  ]);
  const campaign = {
    schemaVersion: "ingestion-coverage-campaign.v1",
    runId: idempotencyKey,
    idempotencyKey,
    campaignKey: idempotencyKey,
    generatedAt: campaignGeneratedAt,
    coverageGeneratedAt: completedAt,
    recentCoverageCutoff: coveredThrough,
    artifacts: {
      catalogs: descriptor("generated/catalogs.json", catalogsBody, campaignGeneratedAt, "json"),
      runnerLog: descriptor("generated/runner.ndjson", runnerBody, completedAt, "ndjson"),
      collectors: [{
        kind: "public",
        ...descriptor("collectors/public-test.json", collectorBody, checkedAt, "json")
      }],
      supporting: [{
        kind: "public_test_recent_window_journal",
        ...descriptor(journalRelative, journalBody, checkedAt, "ndjson")
      }]
    }
  };
  await writeFile(join(root, "campaign.json"), `${JSON.stringify(campaign)}\n`);
  return { journalPath };
}

function packageArtifact({
  sourceDir,
  outputDir,
  idempotencyKey,
  sourceRevision = "a".repeat(40)
}) {
  return packagePublicIngestionProofArtifact({
    preparedCampaignDir: sourceDir,
    outputDir,
    idempotencyKey,
    artifactName: "ingestion-proof-journals-123-1",
    repository: "owner/repository",
    workflowRunId: "123",
    workflowRunAttempt: "1",
    sourceRevision,
    generatedAt: GENERATED_AT
  });
}

function descriptor(path, body, observedAt, format) {
  return {
    path,
    sha256: sha256(body),
    bytes: Buffer.byteLength(body),
    observedAt,
    format
  };
}

async function readTreeText(root) {
  const files = (await listTreeFiles(root)).map((path) => join(root, path));
  return (await Promise.all(files.map((path) => readFile(path, "utf8")))).join("\n");
}

async function listTreeFiles(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
    .sort();
}

function declaredPaths(value, output = []) {
  if (Array.isArray(value)) {
    value.forEach((row) => declaredPaths(row, output));
  } else if (value && typeof value === "object") {
    if (["path", "sha256", "observedAt", "format"].every((key) =>
      Object.hasOwn(value, key)
    )) {
      output.push(value.path);
    } else {
      Object.values(value).forEach((row) => declaredPaths(row, output));
    }
  }
  return output;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
