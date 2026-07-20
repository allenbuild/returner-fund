import { describe, expect, it } from "vitest";
import {
  applyCalibration,
  byteIdentityReport,
  predictV5,
  nearestRankQuantile,
  rawLinearOutput,
  registeredSourceForContent,
  runV5Pipeline,
  serializeSourceRows,
  sha256Text,
  stableHash,
  transformedFeatureValue,
  V5_FROZEN_CANDIDATE_GRID,
  V5_PREREG_PLATFORM_TARGETS,
  V5_PREREG_SPLIT,
  V5_PREREG_THRESHOLD_DEFINITION,
  type V5InputManifest,
  type V5RawObservation,
  type V5ResearchRegistry
} from "@/lib/scoring/v5";

const LOCK_HASH = "a".repeat(64);
const CODE_REVISION = `sha256:${"b".repeat(64)}`;

describe("scoring v5 deterministic training pipeline", () => {
  it("rejects an unverifiable code revision", () => {
    expect(() =>
      runV5Pipeline({
        inputManifest: manifest([]),
        registeredFiles: {},
        modelVersion: "5.0.0-research",
        codeRevision: "unverifiable",
        dependencyLockHash: LOCK_HASH,
        researchRegistry: researchRegistryFor([])
      })
    ).toThrow(/SHA-256 code snapshot/);
  });

  it("freezes a finite, declared candidate grid", () => {
    expect(Object.isFrozen(V5_FROZEN_CANDIDATE_GRID)).toBe(true);
    expect(V5_FROZEN_CANDIDATE_GRID.every((candidate) => Object.isFrozen(candidate))).toBe(true);
    expect(V5_FROZEN_CANDIDATE_GRID.map((candidate) => candidate.id)).toEqual([
      "equal-log-sum",
      "age-only-logistic-l2-0.01",
      "metric-logistic-l2-0",
      "metric-logistic-l2-0.01",
      "metric-logistic-l2-0.1",
      "metric-logistic-l2-1",
      "metric-age-logistic-l2-0.01",
      "metric-age-logistic-l2-0.1"
    ]);
  });

  it("emits a deterministic insufficient-data rejection without inventing benchmark rows", () => {
    const artifacts = runV5Pipeline({
      inputManifest: manifest([]),
      registeredFiles: {},
      modelVersion: "5.0.0-research",
      codeRevision: CODE_REVISION,
      dependencyLockHash: LOCK_HASH,
      researchRegistry: researchRegistryFor([])
    });
    expect(artifacts.model.status).toBe("rejected_insufficient_data");
    expect(artifacts.evaluation.gateDecision).toBe("reject");
    expect(artifacts.model.supportedPlatforms).toEqual([]);
    expect(artifacts.model.companyAggregation.status).toBe("unsupported");
    expect(artifacts.evaluation.gateReasons[0]).toMatch(/No platform has compatible rows/);
  });

  it("runs twice byte-identically and exports verifiable artifact hashes", () => {
    const fixture = trainingFixture();
    const options = {
      inputManifest: fixture.manifest,
      registeredFiles: fixture.files,
      modelVersion: "5.0.0-fixture",
      codeRevision: CODE_REVISION,
      dependencyLockHash: LOCK_HASH,
      researchRegistry: researchRegistryFor(fixture.manifest.sources)
    };
    const first = runV5Pipeline(options);
    const second = runV5Pipeline(options);
    expect(byteIdentityReport(first, second)).toMatchObject({ identical: true, mismatches: [] });
    expect(first.manifest.modelArtifactHash).toBe(sha256Text(first.serialized.model));
    expect(first.manifest.evaluationArtifactHash).toBe(sha256Text(first.serialized.evaluation));
    expect(first.manifest.candidateSearchArtifactHash).toBe(
      sha256Text(first.serialized.candidateSearch)
    );
    expect(first.manifest.incorporatedResearchSources).toEqual([
      {
        id: "fixture",
        decision: "accepted_dataset",
        exactUse: "Deterministic pipeline test.",
        implementationEvidence: ["tests/scoring-v5-pipeline.test.ts"]
      }
    ]);
    expect(first.model.status).toBe("experimental");
    expect(first.model.supportedPlatforms).toEqual(["x"]);
    expect(first.model.platformModels.x?.calibration.fittedOn).toBe("validation");
    expect(first.model.platformModels.x?.featureEnvelopes.likes).toEqual({
      minimum: 1,
      maximum: 100,
      observations: 25,
      fittedOn: "training"
    });
    expect(first.model.platformModels.x?.featureNames).not.toContain("shares");
    expect(first.model.platformModels.x?.featureNames).toContain("likes_missing");
    expect(first.model.target.id).toBe("returner-post-performance-v5-prereg-2026-07-20");
    expect(first.model.target.platformTargets.x?.horizonHours).toBe(168);
    expect(first.model.trainingPlatformGrowthThresholds.x).toBeTypeOf("number");
    const holdout = new Set(first.split.unseenEntityHoldoutIds);
    const expectedThreshold = nearestRankQuantile(
      first.split.rows.train
        .filter((row) => row.platform === "x" && !holdout.has(row.entityId))
        .map((row) => row.growth),
      0.8
    );
    expect(first.model.trainingPlatformGrowthThresholds.x).toBe(expectedThreshold);
    expect(first.evaluation.testWasUsedForSelection).toBe(false);
    expect(first.candidateSearch.containsTestMetrics).toBe(false);
  });

  it("rejects an accepted manifest source absent from the research registry", () => {
    const fixture = trainingFixture();
    expect(() =>
      runV5Pipeline({
        inputManifest: fixture.manifest,
        registeredFiles: fixture.files,
        modelVersion: "5.0.0-fixture",
        codeRevision: CODE_REVISION,
        dependencyLockHash: LOCK_HASH,
        researchRegistry: { schema_version: "test-v1", sources: [] }
      })
    ).toThrow(/absent from the research registry/);
  });

  it("does not promote a conditional dataset without an accepted legal/data decision", () => {
    const fixture = trainingFixture();
    const conditionalRegistry = researchRegistryFor(fixture.manifest.sources);
    conditionalRegistry.sources[0].decision.status = "conditional_dataset";
    expect(() =>
      runV5Pipeline({
        inputManifest: fixture.manifest,
        registeredFiles: fixture.files,
        modelVersion: "5.0.0-fixture",
        codeRevision: CODE_REVISION,
        dependencyLockHash: LOCK_HASH,
        researchRegistry: conditionalRegistry
      })
    ).toThrow(/does not permit/);
  });

  it("binds registry approval to the exact source revision, hash, access time, and license", () => {
    const fixture = trainingFixture();
    const registry = researchRegistryFor(fixture.manifest.sources);
    registry.sources[0].training_artifact!.sha256 = "0".repeat(64);
    expect(() =>
      runV5Pipeline({
        inputManifest: fixture.manifest,
        registeredFiles: fixture.files,
        modelVersion: "5.0.0-fixture",
        codeRevision: CODE_REVISION,
        dependencyLockHash: LOCK_HASH,
        researchRegistry: registry
      })
    ).toThrow(/artifact identity does not match/);
  });

  it("keeps source registration order from changing model, evaluation, or export bytes", () => {
    const allRows = fixtureRows();
    const firstRows = allRows.filter((_, index) => index % 2 === 0);
    const secondRows = allRows.filter((_, index) => index % 2 === 1);
    const firstContent = serializeSourceRows(firstRows);
    const secondContent = serializeSourceRows(secondRows);
    const sourceA = source("a", "a.json", firstContent);
    const sourceB = source("b", "b.json", secondContent);
    const files = { "a.json": firstContent, "b.json": secondContent };
    const baseOptions = {
      registeredFiles: files,
      modelVersion: "5.0.0-fixture",
      codeRevision: CODE_REVISION,
      dependencyLockHash: LOCK_HASH,
      researchRegistry: researchRegistryFor([sourceA, sourceB])
    };
    const forward = runV5Pipeline({ ...baseOptions, inputManifest: manifest([sourceA, sourceB]) });
    const reverse = runV5Pipeline({ ...baseOptions, inputManifest: manifest([sourceB, sourceA]) });
    expect(reverse.serialized.model).toBe(forward.serialized.model);
    expect(reverse.serialized.evaluation).toBe(forward.serialized.evaluation);
    expect(reverse.serialized.manifest).toBe(forward.serialized.manifest);
  });

  it("does not let final-test labels alter selected hyperparameters or calibration", () => {
    const ordinary = trainingFixture(false);
    const flipped = trainingFixture(true);
    const shared = {
      modelVersion: "5.0.0-fixture",
      codeRevision: CODE_REVISION,
      dependencyLockHash: LOCK_HASH
    };
    const ordinaryRun = runV5Pipeline({
      ...shared,
      inputManifest: ordinary.manifest,
      registeredFiles: ordinary.files,
      researchRegistry: researchRegistryFor(ordinary.manifest.sources)
    });
    const flippedRun = runV5Pipeline({
      ...shared,
      inputManifest: flipped.manifest,
      registeredFiles: flipped.files,
      researchRegistry: researchRegistryFor(flipped.manifest.sources)
    });
    const selected = ordinaryRun.model.platformModels.x;
    const selectedWithFlippedTest = flippedRun.model.platformModels.x;
    expect(selectedWithFlippedTest?.candidateId).toBe(selected?.candidateId);
    expect(selectedWithFlippedTest?.parameters).toEqual(selected?.parameters);
    expect(selectedWithFlippedTest?.calibration).toEqual(selected?.calibration);
    expect(selectedWithFlippedTest?.validation).toEqual(selected?.validation);
    expect(flippedRun.model.trainingPlatformGrowthThresholds).toEqual(
      ordinaryRun.model.trainingPlatformGrowthThresholds
    );
  });

  it("keeps TypeScript inference in parity and positive metrics monotonic", () => {
    const fixture = trainingFixture();
    const run = runV5Pipeline({
      inputManifest: fixture.manifest,
      registeredFiles: fixture.files,
      modelVersion: "5.0.0-fixture",
      codeRevision: CODE_REVISION,
      dependencyLockHash: LOCK_HASH,
      researchRegistry: researchRegistryFor(fixture.manifest.sources)
    });
    const artifact = { ...run.model, status: "accepted" as const };
    const input = {
      featureSchemaVersion: "scoring-v5-features-v3" as const,
      canonicalPostId: "fixture-inference-post",
      platform: "x",
      observationAt: "2026-07-20T12:00:00.000Z",
      publishedAt: "2026-07-19T12:00:00.000Z",
      publishedAtPrecision: "exact" as const,
      metrics: { likes: 5, views: 10 },
      metricObservedAt: {
        likes: "2026-07-20T12:00:00.000Z",
        views: "2026-07-20T12:00:00.000Z"
      },
      evidenceSourceId: "fixture-live-observation",
      evidenceArtifactSha256: "b".repeat(64)
    };
    const inferenceOptions = { trustedObservationCutoff: input.observationAt };
    const prediction = predictV5(artifact, input, inferenceOptions);
    const increased = predictV5(
      artifact,
      { ...input, metrics: { ...input.metrics, likes: 50 } },
      inferenceOptions
    );
    expect(prediction.status).toBe("scored");
    expect(increased.status).toBe("scored");
    if (prediction.status !== "scored" || increased.status !== "scored") return;
    expect(increased.calibratedProbability).toBeGreaterThanOrEqual(prediction.calibratedProbability);

    const model = artifact.platformModels.x!;
    const trainingRuntimeProbability = applyCalibration(
      rawLinearOutput(model.parameters, {
        metrics: input.metrics,
        postAgeHours: 24
      }),
      model.calibration
    );
    expect(prediction.calibratedProbability).toBeCloseTo(trainingRuntimeProbability, 11);
    expect(prediction.missingFeatures).toContain("replies");
    expect(prediction).toMatchObject({
      canonicalPostId: "fixture-inference-post",
      asOf: input.observationAt,
      trustedObservationCutoff: input.observationAt,
      modelArtifactHash: stableHash(artifact),
      targetSpecId: "returner-post-performance-v5-prereg-2026-07-20",
      trainingDataHash: artifact.trainingDataHash,
      splitHash: artifact.splitHash,
      publishedAtPrecision: "exact"
    });
  });

  it("distinguishes missing metrics from observed zero in training and runtime features", () => {
    const missing = { metrics: {}, postAgeHours: 12 };
    const observedZero = { metrics: { likes: 0 }, postAgeHours: 12 };
    expect(transformedFeatureValue(missing, "likes")).toBe(0);
    expect(transformedFeatureValue(observedZero, "likes")).toBe(0);
    expect(transformedFeatureValue(missing, "likes_missing")).toBe(1);
    expect(transformedFeatureValue(observedZero, "likes_missing")).toBe(0);
    const parameters = { intercept: 0, coefficients: { likes: 1, likes_missing: 2 } };
    expect(rawLinearOutput(parameters, missing)).toBe(2);
    expect(rawLinearOutput(parameters, observedZero)).toBe(0);
  });

  it("returns an explicitly unvalidated research output without probability or common-score fields", () => {
    const fixture = trainingFixture();
    const run = runV5Pipeline({
      inputManifest: fixture.manifest,
      registeredFiles: fixture.files,
      modelVersion: "5.0.0-fixture",
      codeRevision: CODE_REVISION,
      dependencyLockHash: LOCK_HASH,
      researchRegistry: researchRegistryFor(fixture.manifest.sources)
    });
    const observationAt = "2026-07-20T12:00:00.000Z";
    const input = {
      featureSchemaVersion: "scoring-v5-features-v3" as const,
      canonicalPostId: "experimental-post",
      platform: "x",
      observationAt,
      publishedAt: "2026-07-20T00:00:00.000Z",
      publishedAtPrecision: "exact" as const,
      metrics: { likes: 5, views: 10 },
      metricObservedAt: { likes: observationAt, views: observationAt },
      evidenceSourceId: "fixture-live-observation",
      evidenceArtifactSha256: "c".repeat(64)
    };
    expect(predictV5(run.model, input)).toMatchObject({
      status: "unscored",
      reason: "model_not_accepted"
    });
    const result = predictV5(run.model, input, {
      allowExperimental: true,
      trustedObservationCutoff: observationAt
    });
    expect(result).toMatchObject({
      status: "experimental_unvalidated",
      validationState: "acceptance_gate_failed",
      modelArtifactHash: stableHash(run.model)
    });
    expect(result).not.toHaveProperty("calibratedProbability");
    expect(result).not.toHaveProperty("score");
  });

  it("leaves unsupported platforms and missing publication dates visibly unscored", () => {
    const fixture = trainingFixture();
    const run = runV5Pipeline({
      inputManifest: fixture.manifest,
      registeredFiles: fixture.files,
      modelVersion: "5.0.0-fixture",
      codeRevision: CODE_REVISION,
      dependencyLockHash: LOCK_HASH,
      researchRegistry: researchRegistryFor(fixture.manifest.sources)
    });
    const artifact = { ...run.model, status: "accepted" as const };
    expect(
      predictV5(artifact, {
        featureSchemaVersion: "scoring-v5-features-v3",
        canonicalPostId: "linkedin-post",
        platform: "linkedin",
        observationAt: "2026-07-20T12:00:00.000Z",
        publishedAt: "2026-07-20T00:00:00.000Z",
        publishedAtPrecision: "exact",
        metrics: { reactions: 10, impressions: 5 },
        metricObservedAt: {
          reactions: "2026-07-20T12:00:00.000Z",
          impressions: "2026-07-20T12:00:00.000Z"
        },
        evidenceSourceId: "fixture-live-observation",
        evidenceArtifactSha256: "d".repeat(64)
      })
    ).toMatchObject({ status: "unscored", reason: "unsupported_platform" });
    expect(
      predictV5(artifact, {
        featureSchemaVersion: "scoring-v5-features-v3",
        canonicalPostId: "missing-date-post",
        platform: "x",
        observationAt: "2026-07-20T12:00:00.000Z",
        publishedAt: null,
        publishedAtPrecision: "unknown",
        metrics: { likes: 10, views: 5 },
        metricObservedAt: {
          likes: "2026-07-20T12:00:00.000Z",
          views: "2026-07-20T12:00:00.000Z"
        },
        evidenceSourceId: "fixture-live-observation",
        evidenceArtifactSha256: "e".repeat(64)
      }, { trustedObservationCutoff: "2026-07-20T12:00:00.000Z" })
    ).toMatchObject({ status: "unscored", reason: "missing_publication_date" });
  });

  it("rejects non-canonical inference times, shifted metric times, and artifact-hash mismatches", () => {
    const fixture = trainingFixture();
    const run = runV5Pipeline({
      inputManifest: fixture.manifest,
      registeredFiles: fixture.files,
      modelVersion: "5.0.0-fixture",
      codeRevision: CODE_REVISION,
      dependencyLockHash: LOCK_HASH,
      researchRegistry: researchRegistryFor(fixture.manifest.sources)
    });
    const artifact = { ...run.model, status: "accepted" as const };
    const observationAt = "2026-07-20T12:00:00.000Z";
    const input = {
      featureSchemaVersion: "scoring-v5-features-v3" as const,
      canonicalPostId: "adversarial-inference-post",
      platform: "x",
      observationAt,
      publishedAt: "2026-07-20T00:00:00.000Z",
      publishedAtPrecision: "exact" as const,
      metrics: { likes: 5, views: 10 },
      metricObservedAt: { likes: observationAt, views: observationAt },
      evidenceSourceId: "fixture-live-observation",
      evidenceArtifactSha256: "f".repeat(64)
    };
    const inferenceOptions = { trustedObservationCutoff: observationAt };
    expect(predictV5(artifact, { ...input, observationAt: "2026-07-20" }, inferenceOptions)).toMatchObject({
      status: "unscored",
      reason: "invalid_observation_time"
    });
    expect(
      predictV5(artifact, {
        ...input,
        metricObservedAt: { ...input.metricObservedAt, likes: "2026-07-20T13:00:00.000Z" }
      }, inferenceOptions)
    ).toMatchObject({ status: "unscored", reason: "invalid_metric_observation_time" });
    expect(
      predictV5(artifact, input, {
        ...inferenceOptions,
        modelArtifactHash: "0".repeat(64)
      })
    ).toMatchObject({
      status: "unscored",
      reason: "model_artifact_hash_mismatch"
    });
    expect(
      predictV5(artifact, {
        ...input,
        featureSchemaVersion: "scoring-v5-features-v1" as typeof input.featureSchemaVersion
      }, inferenceOptions)
    ).toMatchObject({ status: "unscored", reason: "feature_schema_mismatch" });
  });

  it("fails closed on incompatible namespaces, missing support, OOD values, and untrusted future time", () => {
    const fixture = trainingFixture();
    const run = runV5Pipeline({
      inputManifest: fixture.manifest,
      registeredFiles: fixture.files,
      modelVersion: "5.0.0-fixture",
      codeRevision: CODE_REVISION,
      dependencyLockHash: LOCK_HASH,
      researchRegistry: researchRegistryFor(fixture.manifest.sources)
    });
    const artifact = { ...run.model, status: "accepted" as const };
    const observationAt = "2026-07-20T12:00:00.000Z";
    const input = {
      featureSchemaVersion: "scoring-v5-features-v3" as const,
      canonicalPostId: "support-envelope-post",
      platform: "x",
      observationAt,
      publishedAt: "2026-07-19T12:00:00.000Z",
      publishedAtPrecision: "exact" as const,
      metrics: { likes: 5, views: 10 },
      metricObservedAt: { likes: observationAt, views: observationAt },
      evidenceSourceId: "fixture-live-observation",
      evidenceArtifactSha256: "9".repeat(64)
    };
    const options = { trustedObservationCutoff: observationAt };

    expect(
      predictV5(
        artifact,
        {
          ...input,
          metrics: { ...input.metrics, stars: 5 },
          metricObservedAt: { ...input.metricObservedAt, stars: observationAt }
        },
        options
      )
    ).toMatchObject({ status: "unscored", reason: "incompatible_platform_metric" });

    const likesMaximum = artifact.platformModels.x!.featureEnvelopes.likes!.maximum;
    expect(
      predictV5(
        artifact,
        { ...input, metrics: { ...input.metrics, likes: likesMaximum + 1 } },
        options
      )
    ).toMatchObject({ status: "unscored", reason: "out_of_distribution" });

    expect(
      predictV5(
        artifact,
        {
          ...input,
          metrics: { ...input.metrics, quotes: 1 },
          metricObservedAt: { ...input.metricObservedAt, quotes: observationAt }
        },
        options
      )
    ).toMatchObject({ status: "unscored", reason: "missing_feature_support" });

    const futureObservationAt = "2099-07-20T12:00:00.000Z";
    expect(
      predictV5(
        artifact,
        {
          ...input,
          observationAt: futureObservationAt,
          publishedAt: "2099-07-19T12:00:00.000Z",
          metricObservedAt: { likes: futureObservationAt, views: futureObservationAt }
        },
        options
      )
    ).toMatchObject({ status: "unscored", reason: "observation_after_trusted_cutoff" });

    expect(predictV5(artifact, input)).toMatchObject({
      status: "unscored",
      reason: "missing_trusted_observation_cutoff"
    });
  });
});

function trainingFixture(flipTestLabels = false): {
  manifest: V5InputManifest;
  files: Record<string, string>;
} {
  const content = serializeSourceRows(fixtureRows(flipTestLabels));
  const registered = source("fixture", "observations.json", content);
  return { manifest: manifest([registered]), files: { "observations.json": content } };
}

function fixtureRows(flipTestLabels = false): V5RawObservation[] {
  return [
    ...periodRows("train", "2026-08-01T00:00:00.000Z", false),
    ...periodRows("validation", "2026-09-20T00:00:00.000Z", false),
    ...periodRows("test", "2026-10-20T00:00:00.000Z", flipTestLabels)
  ];
}

function periodRows(prefix: string, start: string, flipLabels: boolean): V5RawObservation[] {
  return Array.from({ length: 36 }, (_, index) => {
    const sourceRowId = `${prefix}-${String(index).padStart(2, "0")}`;
    const observationAt = new Date(Date.parse(start) + index * 12 * 3_600_000).toISOString();
    const outcomeObservedAt = new Date(Date.parse(observationAt) + 168 * 3_600_000).toISOString();
    const publishedAt = new Date(Date.parse(observationAt) - 24 * 3_600_000).toISOString();
    const targetValueAtObservation = 10;
    const growthIndex = flipLabels ? 35 - index : index;
    const targetValueAtOutcome = 11 + growthIndex * 10;
    const metrics = {
      likes: 1 + index * 3,
      replies: index % 7,
      views: targetValueAtObservation,
      ...(prefix === "test" ? { quotes: 1_000_000 + index } : {})
    };
    return {
      sourceRowId,
      canonicalPostId: `post-${sourceRowId}`,
      contentFingerprint: `content-${sourceRowId}`,
      platform: "x",
      entityId: `entity-${sourceRowId}`,
      batchId: prefix,
      publishedAt,
      publishedAtPrecision: "exact",
      observationAt,
      outcomeObservedAt,
      collectorWaveId: `${prefix}-wave-${index % 3}`,
      metrics,
      metricObservedAt: Object.fromEntries(Object.keys(metrics).map((metric) => [metric, observationAt])),
      targetMetric: "views",
      targetValueAtObservation,
      targetValueAtOutcome
    };
  });
}

function source(id: string, relativePath: string, content: string) {
  return registeredSourceForContent(
    {
      id,
      relativePath,
      schemaVersion: "scoring-v5-observations-v2",
      citation: `Deterministic test fixture ${id}.`,
      sourceRevision: "fixture-v1",
      accessedAt: "2026-07-20T00:00:00.000Z",
      license: { id: "CC0-1.0", permitsResearchUse: true, redistribution: "allowed" },
      status: "accepted",
      rejectionReason: null
    },
    content
  );
}

function manifest(sources: V5InputManifest["sources"]): V5InputManifest {
  return {
    schemaVersion: "scoring-v5-input-manifest-v1",
    registeredAt: "2026-07-20T00:00:00.000Z",
    target: {
      id: "returner-post-performance-v5-prereg-2026-07-20",
      description: "Fixture probability target at 168 hours.",
      thresholdDefinition: V5_PREREG_THRESHOLD_DEFINITION,
      platformTargets: structuredClone(V5_PREREG_PLATFORM_TARGETS),
      outcome: "binary_high_performance_at_horizon",
      observationRule: "features_at_or_before_observation_time"
    },
    split: { ...V5_PREREG_SPLIT },
    sources
  };
}

function researchRegistryFor(sources: V5InputManifest["sources"]): V5ResearchRegistry {
  return {
    schema_version: "test-v1",
    sources: sources.map((source) => ({
      id: source.id,
      citation: source.citation,
      decision: { status: "accepted_dataset", reason: "Test-only compatible fixture." },
      incorporation: {
        state: "implemented",
        exact_use: "Deterministic pipeline test.",
        implementation_evidence: ["tests/scoring-v5-pipeline.test.ts"]
      },
      training_artifact: {
        sha256: source.sha256,
        source_revision: source.sourceRevision,
        accessed_at: source.accessedAt,
        license: { ...source.license }
      }
    }))
  };
}
