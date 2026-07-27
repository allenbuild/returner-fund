import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  TRACTION_SCORING_CONFIG,
  validateTractionScoringConfig,
  type TractionScoringConfig
} from "@/lib/scoring/traction-config";

type ConfigMutation = (config: TractionScoringConfig) => void;

describe("traction scoring config validation", () => {
  it("accepts the canonical v4 config without mutating it", () => {
    const config = cloneConfig();
    const original = cloneConfig();

    expect(() => validateTractionScoringConfig(config)).not.toThrow();
    expect(config).toEqual(original);
    expect(config.version).toBe("4.0.1");
    expect(config.name).toBe("returner-traction-v4-monotonic");
    expect(config.absoluteEvidenceWeight).toBe(1);
    expect(config.cohortPercentileWeight).toBe(0);
  });

  it("configures X and Instagram with equal platform importance", () => {
    expect(TRACTION_SCORING_CONFIG.platformWeights.x).toBe(0.21);
    expect(TRACTION_SCORING_CONFIG.platformWeights.instagram).toBe(0.21);
    expect(TRACTION_SCORING_CONFIG.platformWeights.x).toBe(
      TRACTION_SCORING_CONFIG.platformWeights.instagram
    );
  });

  it("registers the exact monotonic config as immutable model version 4.0.1", () => {
    const migration = readFileSync(
      "supabase/migrations/013_register_traction_scoring_v4_0_1.sql",
      "utf8"
    );
    const configJson = migration.match(/v4_config constant jsonb := \$config\$([\s\S]*?)\$config\$/i)?.[1];
    const registeredHash = migration.match(
      /v4_config_hash constant text := '([a-f0-9]{64})'/i
    )?.[1];

    expect(configJson).toBeDefined();
    expect(JSON.parse(configJson!)).toEqual(TRACTION_SCORING_CONFIG);
    expect(registeredHash).toBe(
      createHash("sha256")
        .update(JSON.stringify(sortKeys(TRACTION_SCORING_CONFIG)))
        .digest("hex")
    );
    expect(migration).toContain("The 4.0.0 row from migration 007 remains untouched");
  });

  it("accepts normalized totals inside the deterministic tolerance", () => {
    const config = cloneConfig();
    config.platformWeights.x = config.platformWeights.x! + 1e-10;

    expect(() => validateTractionScoringConfig(config)).not.toThrow();
  });

  it.each<[string, ConfigMutation, RegExp]>([
    [
      "non-finite platform weights",
      (config) => {
        config.platformWeights.x = Number.POSITIVE_INFINITY;
      },
      /platformWeights\.x.*finite non-negative weight/
    ],
    [
      "negative metric weights",
      (config) => {
        config.metricWeights.x!.likes = -1;
      },
      /metricWeights\.x\.likes.*finite non-negative weight/
    ],
    [
      "non-finite weights on unscored metric maps",
      (config) => {
        config.metricWeights.web = { likes: Number.NaN };
      },
      /metricWeights\.web\.likes.*finite non-negative weight/
    ],
    [
      "platform totals outside tolerance",
      (config) => {
        config.platformWeights.x = config.platformWeights.x! + 1e-6;
      },
      /platform weights must sum to 1/
    ],
    [
      "missing references for scored platforms",
      (config) => {
        delete config.platformReferences.x;
      },
      /platformReferences\.x is required/
    ],
    [
      "zero reference half-lives",
      (config) => {
        config.platformReferences.x!.halfLifeDays = 0;
      },
      /platformReferences\.x\.halfLifeDays.*positive finite number/
    ],
    [
      "non-finite high-engagement references",
      (config) => {
        config.platformReferences.x!.highEngagement = Number.NaN;
      },
      /platformReferences\.x\.highEngagement.*positive finite number/
    ],
    [
      "metric maps with no positive signal",
      (config) => {
        config.metricWeights.x = { views: 0, likes: 0 };
      },
      /metricWeights\.x must contain at least one positive metric weight/
    ],
    [
      "missing metric maps for scored platforms",
      (config) => {
        delete config.metricWeights.x;
      },
      /metricWeights\.x must contain at least one positive metric weight/
    ]
  ])("rejects %s", (_name, mutate, expectedMessage) => {
    expectInvalidConfig(mutate, expectedMessage);
  });

  it.each<[string, ConfigMutation, RegExp]>([
    [
      "an evidence blend outside its normalized total",
      (config) => {
        config.absoluteEvidenceWeight = 0.84;
      },
      /evidence blend must sum to 1/
    ],
    [
      "a normalized but cohort-dependent evidence blend",
      (config) => {
        config.absoluteEvidenceWeight = 0.85;
        config.cohortPercentileWeight = 0.15;
      },
      /monotonic evidence blend must be fully reference-anchored/
    ],
    [
      "a signal blend weight above one",
      (config) => {
        config.durableSignalWeight = 1.01;
      },
      /durableSignalWeight must be at most 1/
    ],
    [
      "missing-date momentum outside the unit interval",
      (config) => {
        config.missingDateMomentum = -0.01;
      },
      /missingDateMomentum.*finite non-negative weight/
    ],
    [
      "a platform blend outside its normalized total",
      (config) => {
        config.diversifiedPlatformWeight = 0.29;
      },
      /platform blend must sum to 1/
    ],
    [
      "batch calibration weights outside the unit interval",
      (config) => {
        config.batchCalibration.absoluteScoreWeight = Number.POSITIVE_INFINITY;
      },
      /batchCalibration\.absoluteScoreWeight.*finite non-negative weight/
    ],
    [
      "an unnormalized batch calibration blend",
      (config) => {
        config.batchCalibration.cohortPercentileWeight = 0.17;
      },
      /batch calibration must sum to 1/
    ],
    [
      "confidence weights outside the unit interval",
      (config) => {
        config.confidence.evidenceDepthWeight = 1.01;
      },
      /confidence\.evidenceDepthWeight must be at most 1/
    ],
    [
      "an unnormalized confidence blend",
      (config) => {
        config.confidence.verifiedLinkWeight = 0.07;
      },
      /confidence must sum to 1/
    ],
    [
      "a non-positive confidence depth scale",
      (config) => {
        config.confidence.evidenceDepthScale = 0;
      },
      /confidence\.evidenceDepthScale.*positive finite number/
    ],
    [
      "confidence thresholds outside the unit interval",
      (config) => {
        config.confidence.highThreshold = 1.01;
      },
      /confidence\.highThreshold must be at most 1/
    ],
    [
      "unordered confidence thresholds",
      (config) => {
        config.confidence.mediumThreshold = config.confidence.highThreshold;
      },
      /confidence thresholds must satisfy mediumThreshold < highThreshold/
    ]
  ])("rejects %s", (_name, mutate, expectedMessage) => {
    expectInvalidConfig(mutate, expectedMessage);
  });

  it.each<[string, ConfigMutation, RegExp]>([
    [
      "an empty slot list",
      (config) => {
        config.platformEvidenceSlots = [];
      },
      /platformEvidenceSlots must be a non-empty array/
    ],
    [
      "zero-valued slots",
      (config) => {
        config.platformEvidenceSlots[4] = 0;
      },
      /platformEvidenceSlots\[4\] must be positive/
    ],
    [
      "non-finite slots",
      (config) => {
        config.platformEvidenceSlots[2] = Number.NaN;
      },
      /platformEvidenceSlots\[2\].*finite non-negative weight/
    ],
    [
      "non-monotone slots",
      (config) => {
        config.platformEvidenceSlots = [0.82, 0.05, 0.08, 0.03, 0.02];
      },
      /platformEvidenceSlots must be monotonically non-increasing/
    ],
    [
      "slot totals outside tolerance",
      (config) => {
        config.platformEvidenceSlots[4] = 0.021;
      },
      /platform evidence slots must sum to 1/
    ]
  ])("rejects %s", (_name, mutate, expectedMessage) => {
    expectInvalidConfig(mutate, expectedMessage);
  });
});

function expectInvalidConfig(mutate: ConfigMutation, expectedMessage: RegExp): void {
  const config = cloneConfig();
  mutate(config);

  expect(() => validateTractionScoringConfig(config)).toThrowError(expectedMessage);
}

function cloneConfig(): TractionScoringConfig {
  return structuredClone(TRACTION_SCORING_CONFIG);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortKeys(entry)])
  );
}
