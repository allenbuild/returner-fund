import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import {
  STRICT_METRIC_ALLOWLIST_ROWS,
  cleanupAllowlistedRow,
  derivePhysicalIdentity,
  parseStrictMetricAllowlist,
  quarantineValidatedMetriclessRow
} from "../scripts/lib/strict-metric-remediation.mjs";
import { planStrictMetricRemediation } from "../scripts/remediate-strict-metrics.mjs";

const ROOT = resolve(import.meta.dirname, "..");

describe("strict metric remediation", () => {
  it("parses only the exact 164-row canonical allowlist", async () => {
    const markdown = await readFile(resolve(ROOT, "outputs/source-hunt/strict-metric-remediation-2026-07-20.md"), "utf8");
    const rows = parseStrictMetricAllowlist(markdown);

    assert.equal(rows.length, STRICT_METRIC_ALLOWLIST_ROWS);
    assert.equal(rows.filter((row) => row.sourceFile.endsWith("targeted-evidence-current.json")).length, 30);
    assert.equal(rows.filter((row) => row.sourceFile.endsWith("a16z-speedrun-006-social-evidence.json")).length, 134);
    assert.deepEqual(rows.find((row) => row.number === 34).metadataKeys, ["language"]);
    assert.equal(new Set(rows.map((row) => row.pointer)).size, STRICT_METRIC_ALLOWLIST_ROWS);
  });

  it("preserves metadata verbatim, retains the maximum alias collision, and leaves arbitrary keys untouched", () => {
    const input = {
      platform: "linkedin",
      metrics: {
        reactions: 4,
        likes: 7,
        comments: 2,
        authorFollowers: "1,234 exact source text",
        customCounter: 99
      }
    };

    const result = cleanupAllowlistedRow(input, {
      platform: "linkedin",
      metadataKeys: ["authorFollowers"]
    });

    assert.deepEqual(result.row.metrics, { reactions: 7, comments: 2, customCounter: 99 });
    assert.deepEqual(result.row.sourceMetadata, { authorFollowers: "1,234 exact source text" });
    assert.deepEqual(result.positiveSupportedMetrics, { reactions: 7, comments: 2 });
    assert.deepEqual(input.metrics, {
      reactions: 4,
      likes: 7,
      comments: 2,
      authorFollowers: "1,234 exact source text",
      customCounter: 99
    });
  });

  it("fails closed on an unallowlisted metadata key or an ambiguous destination", () => {
    assert.throws(() => cleanupAllowlistedRow({ metrics: { surprise: 1 } }, {
      platform: "github",
      metadataKeys: ["surprise"]
    }), /Unsupported metadata cleanup key/);

    assert.throws(() => cleanupAllowlistedRow({
      metrics: { language: "TypeScript", stars: 1 },
      sourceMetadata: { repositoryLanguage: "Python" }
    }, {
      platform: "github",
      metadataKeys: ["language"]
    }), /Expected exactly one/);
  });

  it("quarantines a metricless result only after native identity and attribution validation", () => {
    const cleaned = cleanupAllowlistedRow({
      id: "repo-1",
      platform: "github",
      sourceUrl: "https://github.com/example/repo",
      review_state: "verified",
      contributionScore: 10,
      metrics: { language: "TypeScript", stars: 0 }
    }, {
      platform: "github",
      metadataKeys: ["language"]
    }).row;

    assert.throws(() => quarantineValidatedMetriclessRow(cleaned, {
      nativeIdentityValidated: false,
      attributionValidated: true
    }), /native identity validation/);

    const quarantined = quarantineValidatedMetriclessRow(cleaned, {
      nativeIdentityValidated: true,
      attributionValidated: true
    });
    assert.equal(quarantined.review_state, "needs_review");
    assert.equal(quarantined.contributionScore, 0);
    assert.deepEqual(quarantined.quarantineReasons, ["no_positive_supported_metric_after_metadata_cleanup"]);
    assert.equal(quarantined.sourceMetadata.repositoryLanguage, "TypeScript");
  });

  it("derives strict native identities for every platform in this allowlist", () => {
    assert.equal(derivePhysicalIdentity("github", "https://github.com/Owner/Repo/"), "github:Owner/Repo");
    assert.equal(derivePhysicalIdentity("x", "https://x.com/name/status/123"), "x:123");
    assert.equal(derivePhysicalIdentity("linkedin", "https://www.linkedin.com/posts/name_activity-1234567890123456789-x"), "linkedin:1234567890123456789");
    assert.equal(derivePhysicalIdentity("instagram", "https://www.instagram.com/reel/AbC_123-/"), "instagram:AbC_123-");
    assert.equal(derivePhysicalIdentity("youtube", "https://www.youtube.com/watch?v=AbC_123-"), "youtube:AbC_123-");
    assert.equal(derivePhysicalIdentity("github", "https://github.com/Owner"), null);
  });

  it("validates every production pointer, identity, attribution, and metric guard without writing", async () => {
    const plan = await planStrictMetricRemediation(ROOT);

    assert.equal(plan.allRows.length, 164);
    assert.equal(plan.sourcePlans.find((entry) => entry.relativePath.endsWith("targeted-evidence-current.json")).rows.length, 30);
    assert.equal(plan.sourcePlans.find((entry) => entry.relativePath.endsWith("a16z-speedrun-006-social-evidence.json")).rows.length, 134);
    assert.equal(plan.retainedRows, 164);
    assert.equal(plan.quarantinedRows, 0);
    assert.equal(plan.preservedMetadataFields, 167);
    assert.equal(new Set(plan.allRows.map((row) => row.physicalIdentity)).size, 164);
  });
});
