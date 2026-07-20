import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const REGISTRY_PATH = resolve(
  process.cwd(),
  "docs/scoring-research/source-registry.json"
);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const STABLE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const nonEmptyText = z.string().trim().min(1);

const decisionStatusSchema = z.enum([
  "accepted_protocol",
  "conditional_dataset",
  "conditional_method",
  "rejected_dataset",
  "screen_only"
]);

const sourceSchema = z
  .object({
    id: z.string().regex(STABLE_ID),
    kind: nonEmptyText,
    citation: nonEmptyText,
    identifiers: z.record(z.string(), z.string().nullable()),
    publication: z
      .object({
        status: nonEmptyText,
        venue: nonEmptyText,
        peer_reviewed: z.boolean()
      })
      .strict(),
    platforms: z.array(nonEmptyText).min(1),
    task: nonEmptyText,
    unit_of_prediction: nonEmptyText,
    feature_observation_time: nonEmptyText,
    prediction_horizon: nonEmptyText,
    target_labels: z.array(nonEmptyText),
    evaluation_metrics: z.array(nonEmptyText),
    sample_size: nonEmptyText,
    date_range: nonEmptyText,
    split_protocol: nonEmptyText,
    author_or_user_leakage_protections: nonEmptyText,
    availability: z
      .object({
        paper: nonEmptyText,
        code: nonEmptyText,
        dataset: nonEmptyText,
        license: nonEmptyText,
        redistribution_restrictions: nonEmptyText,
        deletion_or_privacy_behavior: nonEmptyText
      })
      .strict(),
    provenance: z
      .object({
        access_date: z.string().regex(ISO_DATE),
        source_revision: nonEmptyText,
        downloaded_sha256: z.string().regex(SHA256).nullable()
      })
      .strict(),
    compatibility: z
      .object({
        compatible_repository_features: z.array(nonEmptyText),
        incompatible_or_unavailable_features: z.array(nonEmptyText)
      })
      .strict(),
    decision: z
      .object({
        status: decisionStatusSchema,
        reason: nonEmptyText
      })
      .strict(),
    incorporation: z
      .object({
        state: z.enum(["registry_only", "implemented"]),
        exact_use: nonEmptyText,
        implementation_evidence: z.array(nonEmptyText)
      })
      .strict(),
    // These legacy-style fields are optional, but their semantics are checked below if
    // a future registry revision adds them. The canonical representation is incorporation.
    incorporated: z.boolean().optional(),
    howIncorporated: z.string().optional()
  })
  .strict();

const registrySchema = z
  .object({
    schema_version: z.literal("1.0.0"),
    generated_at: z.string().regex(ISO_DATE),
    research_cutoff: z.string().regex(ISO_DATE),
    access_timezone: nonEmptyText,
    scope: nonEmptyText,
    incorporation_policy: nonEmptyText,
    decision_values: z
      .object({
        accepted_protocol: nonEmptyText,
        conditional_dataset: nonEmptyText,
        conditional_method: nonEmptyText,
        rejected_dataset: nonEmptyText,
        screen_only: nonEmptyText
      })
      .strict(),
    incorporation_values: z
      .object({
        registry_only: nonEmptyText,
        implemented: nonEmptyText
      })
      .strict(),
    summary: z
      .object({
        source_count: z.number().int().nonnegative(),
        accepted_protocol: z.number().int().nonnegative(),
        conditional_dataset: z.number().int().nonnegative(),
        conditional_method: z.number().int().nonnegative(),
        rejected_dataset: z.number().int().nonnegative(),
        screen_only: z.number().int().nonnegative(),
        incorporated_count: z.number().int().nonnegative(),
        key_conclusion: nonEmptyText
      })
      .strict(),
    sources: z.array(sourceSchema).min(1)
  })
  .strict();

type Registry = z.infer<typeof registrySchema>;
type RegistrySource = z.infer<typeof sourceSchema>;

// IDs are external provenance handles. Changing one is a migration, not an editorial edit.
const EXPECTED_STABLE_SOURCE_IDS = [
  "calibration-guo-2017",
  "calibration-niculescu-mizil-2005",
  "can-cascades-be-predicted-2014",
  "concat-2025",
  "conformal-angelopoulos-bates-2021",
  "ctcp-2023",
  "deepcas-2017",
  "deepcas-independent-mmg-2026",
  "deephawkes-2017",
  "feature-point-process-2016",
  "gh-archive",
  "ghtorrent",
  "github-popularity-2016",
  "lambdamart-2010",
  "mmg-pop-2026",
  "online-conformal-2024",
  "poprero-2024",
  "recsys-2020-x-engineering-review",
  "reddit-data-api-terms-2025",
  "reddit-v-2025",
  "seismic-2015",
  "twitter-recsys-2020",
  "twitter-recsys-2021",
  "xgboost-monotonic-docs",
  "xgboost-paper-2016"
] as const;

// This is the initial downloaded-paper acquisition set. An intentional artifact
// revision must update both the registry and this integrity snapshot.
const EXPECTED_DOWNLOADED_ARTIFACT_HASHES = {
  "concat-2025": "f12aaa51ece1cfd8282ad80af8beb61478e8b19c17d39911ed1e1dfe0c1b4f67",
  "ctcp-2023": "ef4d1f6c4b0ee4b486c8cbd523a2ee06e13a5747f9880229a1b1d7808cd2c23b",
  "deepcas-2017": "500f3f507ba5b1fd17d0703984ef7a7769e42e40cf479449a65d05213b69e2ad",
  "deepcas-independent-mmg-2026":
    "9f0fba4bb9d11fde9aadb2f5d56fe4b3e70e469b755948e7dd37b0d1f368aafb",
  "feature-point-process-2016":
    "2e97c5dfbc6d6efeb6422162dc33656f573fbac3cf990f19c6bc19b07d6a4fb7",
  "github-popularity-2016":
    "6aac682c598aa62fef7cf7eb554c757d353c04f3ee53764bba3b97ead0c038d4",
  "mmg-pop-2026": "9f0fba4bb9d11fde9aadb2f5d56fe4b3e70e469b755948e7dd37b0d1f368aafb",
  "poprero-2024": "63260c09629800b2507b78f12b85186cee1f7f50546e3c7c80423f941ffddb49",
  "reddit-v-2025": "e96b16fb3f3ed67b4dc5a9e863569b47c10a6ed2e85d7b24162b6bb1081cced9",
  "seismic-2015": "451bf3ce2634151c8b67156e5b728336256c65e69c6bcd1cae1226dce1a4c476",
  "twitter-recsys-2020":
    "5c1c138c302d9de86ab9f3a63b5781c79eded3d8c0ee13ec7a86b7db8b82e59e",
  "twitter-recsys-2021":
    "29384d0fe4bda61a0a7f6ab5f4e9c2260699c0236140343a6843fd51f2e320f9"
} as const;

describe("scoring research source registry", () => {
  it("validates the complete machine-readable schema", () => {
    const result = registrySchema.safeParse(readRawRegistry());
    expect(result.error?.issues).toEqual(undefined);
    expect(result.success).toBe(true);
  });

  it("keeps unique, stable, URL-safe source IDs", () => {
    const registry = loadRegistry();
    const ids = registry.sources.map((source) => source.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(EXPECTED_STABLE_SOURCE_IDS);
  });

  it("requires exact access dates that do not exceed the research cutoff", () => {
    const registry = loadRegistry();
    const cutoff = dateValue(registry.research_cutoff);

    expect(dateValue(registry.generated_at)).toBe(cutoff);
    for (const source of registry.sources) {
      expect(dateValue(source.provenance.access_date), source.id).toBeLessThanOrEqual(cutoff);
    }
  });

  it("requires a substantive citation and an official HTTPS URL for every source", () => {
    for (const source of loadRegistry().sources) {
      expect(source.citation.length, source.id).toBeGreaterThanOrEqual(12);

      const officialUrl = source.identifiers.official_url;
      expect(officialUrl, `${source.id} official_url`).toEqual(expect.any(String));
      const parsed = new URL(officialUrl as string);
      expect(parsed.protocol, source.id).toBe("https:");
      expect(parsed.hostname.length, source.id).toBeGreaterThan(0);
      expect(parsed.username, source.id).toBe("");
      expect(parsed.password, source.id).toBe("");
    }
  });

  it("records licensing for every conditionally accepted dataset", () => {
    const datasetDecisions = loadRegistry().sources.filter((source) =>
      ["accepted_dataset", "conditional_dataset"].includes(source.decision.status)
    );

    expect(datasetDecisions.length).toBeGreaterThan(0);
    for (const source of datasetDecisions) {
      expect(source.availability.license.trim().length, source.id).toBeGreaterThanOrEqual(8);
      expect(source.availability.redistribution_restrictions.trim().length, source.id).toBeGreaterThanOrEqual(8);
    }
  });

  it("records an explicit, substantive reason for every rejected source", () => {
    const rejected = loadRegistry().sources.filter((source) =>
      source.decision.status.startsWith("rejected")
    );

    expect(rejected.length).toBeGreaterThan(0);
    for (const source of rejected) {
      expect(source.decision.reason.trim().length, source.id).toBeGreaterThanOrEqual(20);
      expect(source.decision.reason.trim().toLowerCase(), source.id).not.toMatch(
        /^(?:n\/?a|none|tbd|unknown)\.?$/
      );
    }
  });

  it("pins a SHA-256 for every downloaded artifact", () => {
    const actual = Object.fromEntries(
      loadRegistry()
        .sources.filter((source) => source.provenance.downloaded_sha256 !== null)
        .map((source) => [source.id, source.provenance.downloaded_sha256])
    );

    expect(actual).toEqual(EXPECTED_DOWNLOADED_ARTIFACT_HASHES);
  });

  it("keeps summary counts consistent with the source records", () => {
    const registry = loadRegistry();
    const statusCounts = Object.fromEntries(
      decisionStatusSchema.options.map((status) => [
        status,
        registry.sources.filter((source) => source.decision.status === status).length
      ])
    );
    const incorporatedCount = registry.sources.filter(
      (source) => source.incorporation.state === "implemented"
    ).length;

    expect(registry.summary).toMatchObject({
      source_count: registry.sources.length,
      ...statusCounts,
      incorporated_count: incorporatedCount
    });
  });

  it("forbids claiming incorporation without a concrete use and evidence", () => {
    const registry = loadRegistry();
    for (const source of registry.sources) {
      expect(incorporationErrors(source), source.id).toEqual([]);
    }

    const emptyHow = implementedClone(registry.sources[0]);
    emptyHow.incorporated = true;
    emptyHow.howIncorporated = "";
    expect(incorporationErrors(emptyHow)).toContain("how incorporated is empty or registry-only");

    const registryOnlyHow = implementedClone(registry.sources[0]);
    registryOnlyHow.incorporated = true;
    registryOnlyHow.howIncorporated = "registry_only";
    expect(incorporationErrors(registryOnlyHow)).toContain(
      "how incorporated is empty or registry-only"
    );
  });
});

function readRawRegistry(): unknown {
  return JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
}

function loadRegistry(): Registry {
  return registrySchema.parse(readRawRegistry());
}

function dateValue(value: string): number {
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  expect(Number.isNaN(timestamp), value).toBe(false);
  expect(new Date(timestamp).toISOString().slice(0, 10), value).toBe(value);
  return timestamp;
}

function incorporationErrors(source: RegistrySource): string[] {
  const errors: string[] = [];
  const incorporated = source.incorporated ?? source.incorporation.state === "implemented";
  const how = (source.howIncorporated ?? source.incorporation.exact_use).trim().toLowerCase();

  if (!incorporated) return errors;
  if (how === "" || /^(?:registry[-_ ]?only|none)\.?$/.test(how)) {
    errors.push("how incorporated is empty or registry-only");
  }
  if (source.incorporation.state !== "implemented") {
    errors.push("incorporated source is not in implemented state");
  }
  if (source.incorporation.implementation_evidence.length === 0) {
    errors.push("incorporated source has no implementation evidence");
  }
  return errors;
}

function implementedClone(source: RegistrySource): RegistrySource {
  const clone = structuredClone(source);
  clone.incorporation = {
    state: "implemented",
    exact_use: "Reproduced as a held-out baseline.",
    implementation_evidence: ["tests/example-reproduction.test.ts"]
  };
  return clone;
}
