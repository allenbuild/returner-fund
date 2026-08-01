import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  publishCatalogAndAliasLedger,
  reconcileMutableYcRoster,
  validateAliasLedger
} from "../scripts/lib/yc-mutable-roster-refresh.mjs";

function catalog(companies) {
  return { source: { fetchedAt: "fixture" }, companies };
}

function company({
  id = "42",
  slug = "former-company",
  name = "Former Company",
  socialLinks = { x: "https://x.com/formercompany" },
  founders = [
    {
      id: "founder-7",
      name: "Ada Founder",
      socialLinks: {
        linkedin: "https://www.linkedin.com/in/ada-founder",
        x: "https://x.com/adafounder"
      }
    }
  ]
} = {}) {
  return { id, slug, name, socialLinks, founders };
}

function ledger(aliases = []) {
  return { version: 1, aliases };
}

test("appends immutable-ID rename history with former company and founder accounts", () => {
  const previousCatalog = catalog([company()]);
  const nextCatalog = catalog([
    company({
      slug: "current-company",
      name: "Current Company",
      socialLinks: { x: "https://x.com/currentcompany" },
      founders: [
        {
          id: "founder-7",
          name: "Ada Current",
          socialLinks: { x: "https://x.com/adacurrent" }
        }
      ]
    })
  ]);
  const existing = ledger([
    {
      companyId: "9",
      fromSlug: "older",
      fromName: "Older",
      toSlug: "old",
      toName: "Old",
      companyAccounts: {},
      founders: []
    }
  ]);

  const result = reconcileMutableYcRoster({ previousCatalog, nextCatalog, aliasLedger: existing });

  assert.equal(result.appended.length, 1);
  assert.equal(result.aliasLedger.aliases.length, 2);
  assert.deepEqual(result.aliasLedger.aliases[0], existing.aliases[0]);
  assert.deepEqual(result.appended[0], {
    companyId: "42",
    fromSlug: "former-company",
    fromName: "Former Company",
    toSlug: "current-company",
    toName: "Current Company",
    companyAccounts: { x: ["https://x.com/formercompany"] },
    founders: [
      {
        founderId: "founder-7",
        name: "Ada Founder",
        toName: "Ada Current",
        accounts: {
          linkedin: ["https://www.linkedin.com/in/ada-founder"],
          x: ["https://x.com/adafounder"]
        }
      }
    ]
  });
  assert.deepEqual(existing.aliases.length, 1, "the input ledger must not be mutated");
});

test("does not append an alias when immutable identity, slug, and name are unchanged", () => {
  const unchanged = catalog([company()]);
  const existing = ledger();
  const result = reconcileMutableYcRoster({
    previousCatalog: unchanged,
    nextCatalog: structuredClone(unchanged),
    aliasLedger: existing
  });

  assert.deepEqual(result.appended, []);
  assert.deepEqual(result.aliasLedger, existing);
});

test("records founder additions and removals even when company identity is unchanged", () => {
  const previousCatalog = catalog([
    company({
      founders: [
        {
          id: "founder-removed",
          name: "Former Founder",
          socialLinks: { x: "https://x.com/formerfounder" }
        },
        {
          id: "founder-renamed",
          name: "Old Name",
          socialLinks: { linkedin: "https://linkedin.com/in/old-name" }
        }
      ]
    })
  ]);
  const nextCatalog = catalog([
    company({
      founders: [
        {
          id: "founder-renamed",
          name: "New Name",
          socialLinks: { linkedin: "https://linkedin.com/in/new-name" }
        },
        {
          id: "founder-added",
          name: "Added Founder",
          socialLinks: { linkedin: "https://linkedin.com/in/added-founder" }
        }
      ]
    })
  ]);

  const result = reconcileMutableYcRoster({
    previousCatalog,
    nextCatalog,
    aliasLedger: ledger()
  });

  assert.deepEqual(result.appended, []);
  assert.deepEqual(result.appendedFounderTransitions, [
    {
      companyId: "42",
      companySlug: "former-company",
      companyName: "Former Company",
      founderId: "founder-added",
      change: "added",
      fromName: null,
      toName: "Added Founder",
      accounts: { linkedin: ["https://linkedin.com/in/added-founder"] }
    },
    {
      companyId: "42",
      companySlug: "former-company",
      companyName: "Former Company",
      founderId: "founder-removed",
      change: "removed",
      fromName: "Former Founder",
      toName: null,
      accounts: { x: ["https://x.com/formerfounder"] }
    },
    {
      companyId: "42",
      companySlug: "former-company",
      companyName: "Former Company",
      founderId: "founder-renamed",
      change: "renamed",
      fromName: "Old Name",
      toName: "New Name",
      accounts: { linkedin: ["https://linkedin.com/in/old-name"] }
    }
  ]);
  assert.deepEqual(result.aliasLedger.founderTransitions, result.appendedFounderTransitions);
});

test("appends successive transitions while retaining the complete earlier chain", () => {
  const firstCatalog = catalog([company({ slug: "alpha", name: "Alpha" })]);
  const middleCatalog = catalog([company({ slug: "beta", name: "Beta" })]);
  const finalCatalog = catalog([company({ slug: "gamma", name: "Gamma" })]);
  const firstRefresh = reconcileMutableYcRoster({
    previousCatalog: firstCatalog,
    nextCatalog: middleCatalog,
    aliasLedger: ledger()
  });
  const secondRefresh = reconcileMutableYcRoster({
    previousCatalog: middleCatalog,
    nextCatalog: finalCatalog,
    aliasLedger: firstRefresh.aliasLedger
  });

  assert.deepEqual(
    secondRefresh.aliasLedger.aliases.map(({ fromSlug, toSlug }) => ({ fromSlug, toSlug })),
    [
      { fromSlug: "alpha", toSlug: "beta" },
      { fromSlug: "beta", toSlug: "gamma" }
    ]
  );
  assert.deepEqual(secondRefresh.aliasLedger.aliases[0], firstRefresh.aliasLedger.aliases[0]);
});

const edge = {
    companyId: "42",
    fromSlug: "alpha",
    fromName: "Alpha",
    toSlug: "beta",
    toName: "Beta",
    companyAccounts: {},
    founders: []
};

test("rejects duplicate alias histories before publication", () => {
  assert.throws(
    () => validateAliasLedger(ledger([edge, structuredClone(edge)])),
    /Duplicate YC alias transition/
  );
});

test("rejects conflicting immutable owners before publication", () => {
  assert.throws(
    () =>
      validateAliasLedger(
        ledger([
          edge,
          { ...edge, companyId: "99", toSlug: "gamma", toName: "Gamma" }
        ])
      ),
    /assigned to immutable IDs/
  );
});

test("rejects cyclic alias histories before publication", () => {
  assert.throws(
    () =>
      validateAliasLedger(
        ledger([
          edge,
          {
            ...edge,
            fromSlug: "beta",
            fromName: "Beta",
            toSlug: "alpha",
            toName: "Alpha"
          }
        ])
      ),
    /contains a cycle/
  );
});

test("restores both original files when the second filesystem replacement fails", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "yc-roster-transaction-"));
  try {
    const catalogPath = join(directory, "catalog.json");
    const aliasLedgerPath = join(directory, "aliases.json");
    const originalCatalogText = `${JSON.stringify(catalog([company()]), null, 2)}\n`;
    const originalAliasText = `${JSON.stringify(ledger(), null, 2)}\n`;
    await Promise.all([
      fs.writeFile(catalogPath, originalCatalogText),
      fs.writeFile(aliasLedgerPath, originalAliasText)
    ]);

    const nextCatalog = catalog([company({ slug: "renamed", name: "Renamed" })]);
    const reconciliation = reconcileMutableYcRoster({
      previousCatalog: JSON.parse(originalCatalogText),
      nextCatalog,
      aliasLedger: JSON.parse(originalAliasText)
    });
    const failingFs = {
      ...fs,
      async rename(source, destination) {
        if (destination === aliasLedgerPath && source.endsWith(".tmp")) {
          throw new Error("simulated second replacement failure");
        }
        return fs.rename(source, destination);
      }
    };

    await assert.rejects(
      publishCatalogAndAliasLedger({
        catalogPath,
        aliasLedgerPath,
        catalog: nextCatalog,
        aliasLedger: reconciliation.aliasLedger,
        fs: failingFs
      }),
      /simulated second replacement failure/
    );

    assert.equal(await fs.readFile(catalogPath, "utf8"), originalCatalogText);
    assert.equal(await fs.readFile(aliasLedgerPath, "utf8"), originalAliasText);
    assert.deepEqual(await fs.readdir(directory), ["aliases.json", "catalog.json"]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("publishes both validated files together on the success path", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "yc-roster-success-"));
  try {
    const catalogPath = join(directory, "catalog.json");
    const aliasLedgerPath = join(directory, "aliases.json");
    const previousCatalog = catalog([company()]);
    const nextCatalog = catalog([company({ slug: "renamed", name: "Renamed" })]);
    await Promise.all([
      fs.writeFile(catalogPath, `${JSON.stringify(previousCatalog)}\n`),
      fs.writeFile(aliasLedgerPath, `${JSON.stringify(ledger())}\n`)
    ]);
    const reconciliation = reconcileMutableYcRoster({
      previousCatalog,
      nextCatalog,
      aliasLedger: ledger()
    });

    await publishCatalogAndAliasLedger({
      catalogPath,
      aliasLedgerPath,
      catalog: nextCatalog,
      aliasLedger: reconciliation.aliasLedger
    });

    assert.deepEqual(JSON.parse(await fs.readFile(catalogPath, "utf8")), nextCatalog);
    assert.deepEqual(
      JSON.parse(await fs.readFile(aliasLedgerPath, "utf8")),
      reconciliation.aliasLedger
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
