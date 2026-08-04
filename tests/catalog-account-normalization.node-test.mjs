import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  AUTONOMOUS_BATCHES,
  loadAutonomousCatalogs
} from "../scripts/lib/autonomous-ingestion-plan.mjs";
import { normalizeAutonomousIngestionCatalogs } from "../scripts/lib/ingestion-coverage-adapter.mjs";
import { computeIngestionCatalogSourceHash } from "../scripts/lib/ingestion-coverage-receipt.mjs";

const repositoryRoot = process.cwd();

function accountUrl(catalog, entitySourceKey, platform) {
  const entity = catalog.companies
    .flatMap((company) => [company, ...company.founders])
    .find((candidate) => candidate.id === entitySourceKey);
  assert.ok(entity, `Missing ${entitySourceKey} from ${catalog.batchSlug}.`);
  const account = entity.accounts.find((candidate) => candidate.platform === platform);
  assert.ok(account, `Missing ${platform} account for ${entitySourceKey}.`);
  return account.url;
}

describe("catalog account normalization", () => {
  it("persists raw YC LinkedIn/X account URLs as canonical HTTPS accounts and hashes every current batch", async () => {
    const summerSource = JSON.parse(await readFile(
      join(repositoryRoot, "src/lib/yc/summer-2026-companies.json"),
      "utf8"
    ));
    const sourceBySlug = new Map(summerSource.companies.map((company) => [company.slug, company]));
    assert.equal(
      sourceBySlug.get("alloovium")?.socialLinks?.linkedin,
      "http://linkedin.com/company/alloovium"
    );
    assert.equal(
      sourceBySlug.get("bloomy")?.socialLinks?.x,
      "https://www.x.com/bloomylearning"
    );
    assert.equal(
      sourceBySlug.get("conifer")?.socialLinks?.linkedin,
      "https://www.linkedin.com/company/coniferbuild/posts/?feedView=all"
    );

    const normalized = normalizeAutonomousIngestionCatalogs(
      await loadAutonomousCatalogs(repositoryRoot)
    );
    assert.deepEqual(
      normalized.map((catalog) => catalog.batchSlug),
      AUTONOMOUS_BATCHES.map((batch) => batch.slug).sort()
    );

    const summer = normalized.find((catalog) => catalog.batchSlug === "S26");
    assert.ok(summer);
    assert.equal(
      accountUrl(summer, "company-alloovium", "linkedin"),
      "https://linkedin.com/company/alloovium"
    );
    assert.equal(
      accountUrl(summer, "company-bloomy", "x"),
      "https://x.com/bloomylearning"
    );
    assert.equal(
      accountUrl(summer, "company-conifer", "linkedin"),
      "https://linkedin.com/company/coniferbuild"
    );

    for (const catalog of normalized) {
      assert.match(catalog.sourceHash, /^[a-f0-9]{64}$/);
      const { sourceHash, ...source } = catalog;
      assert.equal(sourceHash, computeIngestionCatalogSourceHash(source));
      for (const entity of catalog.companies.flatMap((company) => [company, ...company.founders])) {
        for (const account of entity.accounts.filter(({ platform }) =>
          platform === "linkedin" || platform === "x"
        )) {
          const expectedHost = account.platform === "linkedin" ? "linkedin.com" : "x.com";
          assert.match(account.url, new RegExp(`^https://${expectedHost}/`));
          assert.doesNotMatch(account.url, /[?#]/);
        }
      }
    }
  });
});
