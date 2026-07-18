import { describe, expect, it } from "vitest";
import {
  ACCOUNT_INVENTORY_TERMINAL_STATUSES,
  ACCOUNT_INVENTORY_STATUSES,
  buildAccountInventory,
  isTerminalAccountInventoryStatus,
  type BuildAccountInventoryInput
} from "@/lib/ingestion/account-inventory";
import {
  CONTEXTUAL_PLATFORMS,
  NATIVE_TRACTION_PLATFORMS,
  PLATFORM_REGISTRY,
  REPRESENTED_PLATFORMS
} from "@/lib/ingestion/platform-registry";

describe("ingestion platform registry", () => {
  it("enumerates every represented platform exactly once and separates source roles", () => {
    expect(PLATFORM_REGISTRY.map((entry) => entry.platform)).toEqual(REPRESENTED_PLATFORMS);
    expect(new Set(REPRESENTED_PLATFORMS).size).toBe(REPRESENTED_PLATFORMS.length);
    expect(NATIVE_TRACTION_PLATFORMS).toEqual([
      "github",
      "x",
      "linkedin",
      "instagram",
      "product_hunt",
      "youtube",
      "reddit",
      "hacker_news",
      "bilibili"
    ]);
    expect(CONTEXTUAL_PLATFORMS).toEqual(["rss", "web"]);
    expect(PLATFORM_REGISTRY.filter((entry) => entry.sourceRole === "native_unscored").map((entry) => entry.platform)).toEqual([
      "tiktok",
      "bluesky"
    ]);
  });

  it("models auth and actual collector capability independently from scoring eligibility", () => {
    const byPlatform = Object.fromEntries(PLATFORM_REGISTRY.map((entry) => [entry.platform, entry]));

    expect(byPlatform.github?.auth.mode).toBe("optional");
    expect(byPlatform.github?.collector.modes).toContain("standalone_script");
    expect(byPlatform.linkedin?.collector.availability).toBe("manual_only");
    expect(byPlatform.web?.nativeTractionEligible).toBe(false);
    expect(byPlatform.web?.collector.supportsEvidenceCollection).toBe(true);
    expect(byPlatform.bilibili?.nativeTractionEligible).toBe(true);
    expect(byPlatform.bilibili?.collector.supportsEvidenceCollection).toBe(false);
    expect(byPlatform.tiktok?.collector.availability).toBe("disabled");
    expect(byPlatform.bluesky?.auth.mode).toBe("unavailable");
  });
});

describe("buildAccountInventory", () => {
  it("emits one deterministic terminal row for every entity/platform pair", () => {
    const input: BuildAccountInventoryInput = {
      companies: [
        {
          id: "company-z",
          name: "Zeta",
          websiteUrl: " https://zeta.example ",
          socialAccounts: [
            { id: "github-z", platform: "github", url: "https://github.com/zeta" }
          ]
        }
      ],
      founders: [
        {
          id: "founder-a",
          name: "Avery",
          personalWebsiteUrl: "https://avery.example",
          xUrl: "https://x.com/avery"
        }
      ]
    };

    const rows = buildAccountInventory(input);
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));

    expect(rows).toHaveLength(2 * REPRESENTED_PLATFORMS.length);
    expect(rows[0]?.key).toBe("company:company-z:github");
    expect(rows[REPRESENTED_PLATFORMS.length]?.key).toBe("founder:founder-a:github");
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
    expect(rows.every((row) => row.terminal === isTerminalAccountInventoryStatus(row.status))).toBe(true);
    expect(ACCOUNT_INVENTORY_STATUSES).toEqual([
      "ready",
      "missing_account",
      "not_applicable",
      "disabled"
    ]);
    expect(ACCOUNT_INVENTORY_TERMINAL_STATUSES).toEqual([
      "missing_account",
      "not_applicable",
      "disabled"
    ]);

    expect(byKey["company:company-z:github"]?.status).toBe("ready");
    expect(byKey["company:company-z:github"]?.terminal).toBe(false);
    expect(byKey["company:company-z:web"]).toMatchObject({
      status: "ready",
      sourceRole: "contextual",
      nativeTractionEligible: false
    });
    expect(byKey["company:company-z:rss"]?.status).toBe("missing_account");
    expect(byKey["founder:founder-a:x"]?.status).toBe("ready");
    expect(byKey["founder:founder-a:product_hunt"]?.status).toBe("not_applicable");
    expect(byKey["founder:founder-a:product_hunt"]?.terminal).toBe(true);
    expect(byKey["founder:founder-a:tiktok"]?.status).toBe("disabled");
    expect(byKey["founder:founder-a:bluesky"]?.status).toBe("disabled");
  });

  it("is independent of input order, sorts accounts, and does not mutate its inputs", () => {
    const first: BuildAccountInventoryInput = {
      companies: [{ id: "b" }, { id: "a" }],
      founders: [],
      accounts: [
        { entityType: "company", entityId: "a", platform: "x", id: "z", url: "https://x.com/z" },
        { entityType: "company", entityId: "a", platform: "x", id: "a", url: "https://x.com/a" }
      ]
    };
    const snapshot = JSON.stringify(first);
    const second: BuildAccountInventoryInput = {
      ...first,
      companies: [...first.companies].reverse(),
      accounts: [...(first.accounts ?? [])].reverse()
    };

    const firstRows = buildAccountInventory(first);
    const secondRows = buildAccountInventory(second);

    expect(firstRows).toEqual(secondRows);
    expect(JSON.stringify(first)).toBe(snapshot);
    expect(firstRows.find((row) => row.key === "company:a:x")?.accounts.map((account) => account.id)).toEqual([
      "a",
      "z"
    ]);
  });

  it("uses explicit disablement and disabled accounts without dropping pairs", () => {
    const rows = buildAccountInventory({
      companies: [
        {
          id: "company-a",
          socialAccounts: [
            { id: "ig-disabled", platform: "instagram", enabled: false, url: "https://instagram.com/a" }
          ]
        }
      ],
      founders: [],
      disabledPlatforms: ["youtube"]
    });

    expect(rows.find((row) => row.key === "company:company-a:instagram")?.status).toBe("disabled");
    expect(rows.find((row) => row.key === "company:company-a:youtube")?.status).toBe("disabled");
    expect(rows.find((row) => row.key === "company:company-a:github")?.status).toBe("missing_account");
    expect(rows).toHaveLength(REPRESENTED_PLATFORMS.length);
  });

  it("rejects duplicate entities and orphaned global accounts", () => {
    expect(() =>
      buildAccountInventory({ companies: [{ id: "same" }, { id: "same" }], founders: [] })
    ).toThrow("Duplicate inventory entity: company:same");

    expect(() =>
      buildAccountInventory({
        companies: [],
        founders: [],
        accounts: [{ entityType: "company", entityId: "unknown", platform: "github" }]
      })
    ).toThrow("Inventory account references unknown entity: company:unknown");
  });
});
