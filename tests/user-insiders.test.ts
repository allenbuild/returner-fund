import { describe, expect, it } from "vitest";
import {
  createAddedInsider,
  effectiveInsiderMembers,
  emptyInsiderConfiguration,
  validateInsiderConfiguration
} from "@/lib/social/user-insiders";
import {
  CANONICAL_INSIDER_WEIGHTS,
  defaultInsiderMembers
} from "@/lib/social/top-voices";

describe("per-user Insiders configuration", () => {
  it("starts from the exact canonical 58-person weighted list", () => {
    const defaults = defaultInsiderMembers();
    expect(defaults).toHaveLength(58);
    expect(new Set(defaults.map((member) => member.personId)).size).toBe(58);
    expect(Object.fromEntries(defaults.map((member) => [member.displayName, member.weight])))
      .toEqual(CANONICAL_INSIDER_WEIGHTS);
    const distribution = defaults.reduce<Record<number, number>>((counts, member) => {
      counts[member.weight] = (counts[member.weight] ?? 0) + 1;
      return counts;
    }, {});
    expect(distribution).toEqual({ 1: 29, 2: 11, 3: 8, 4: 6, 5: 4 });
    expect(defaults.every((member) => member.active)).toBe(true);
    expect(defaults.find((member) => member.personId === "philip-johnston")?.aliases)
      .toContain("Phillip Johnston");
    expect(effectiveInsiderMembers(emptyInsiderConfiguration())).toEqual(defaults);
  });

  it("applies exclusions, sparse weight overrides, and additions without mutating defaults", () => {
    const defaults = defaultInsiderMembers();
    const added = createAddedInsider({
      displayName: "New Signal",
      handles: { x: ["new_signal"] },
      weight: 2
    });
    const effective = effectiveInsiderMembers({
      excludedDefaultIds: [defaults[0].personId],
      weightOverrides: { [defaults[1].personId]: 2 },
      addedInsiders: [added]
    });

    expect(effective).toHaveLength(58);
    expect(effective.some((member) => member.personId === defaults[0].personId)).toBe(false);
    expect(effective.find((member) => member.personId === defaults[1].personId)?.weight).toBe(2);
    expect(effective.at(-1)).toMatchObject({ displayName: "New Signal", weight: 2, source: "user-added" });
    expect(defaultInsiderMembers()[1].weight).toBe(defaults[1].weight);
  });

  it("normalizes additions and strips default-valued overrides", () => {
    const defaults = defaultInsiderMembers();
    const parsed = validateInsiderConfiguration({
      expectedVersion: 3,
      excludedDefaultIds: [defaults[0].personId, defaults[0].personId],
      weightOverrides: {
        [defaults[1].personId]: defaults[1].weight,
        [defaults[2].personId]: defaults[2].weight === 4 ? 3 : 4
      },
      addedInsiders: [{
        personId: "user:x:signal",
        displayName: " Signal Person ",
        aliases: ["Signal Person"],
        handles: { x: ["@Signal"] },
        category: "insider",
        weight: 2,
        active: true,
        source: "user-added"
      }]
    });

    expect(parsed.excludedDefaultIds).toEqual([defaults[0].personId]);
    expect(parsed.weightOverrides).toEqual({
      [defaults[2].personId]: defaults[2].weight === 4 ? 3 : 4
    });
    expect(parsed.addedInsiders[0]).toMatchObject({
      displayName: "Signal Person",
      handles: { x: ["signal"] }
    });
  });

  it("rejects unknown defaults, out-of-range weights, duplicate identities, and duplicate handles", () => {
    const defaults = defaultInsiderMembers();
    const base = {
      expectedVersion: 0,
      excludedDefaultIds: [],
      weightOverrides: {},
      addedInsiders: []
    };
    expect(() => validateInsiderConfiguration({ ...base, excludedDefaultIds: ["not-a-default"] }))
      .toThrow(/Unknown default insider/);
    expect(() => validateInsiderConfiguration({
      ...base,
      weightOverrides: { [defaults[0].personId]: 0 }
    })).toThrow();
    for (const weight of [1.5, -1, 6, Number.NaN]) {
      expect(() => validateInsiderConfiguration({
        ...base,
        weightOverrides: { [defaults[0].personId]: weight }
      })).toThrow();
    }
    expect(() => validateInsiderConfiguration({
      ...base,
      addedInsiders: [{
        ...createAddedInsider({ displayName: "Collision", handles: { x: ["paulg"] } }),
        personId: "user:x:collision"
      }]
    })).toThrow(/Duplicate x handle/);
    const duplicate = createAddedInsider({ displayName: "Duplicate", handles: { x: ["unique_new"] } });
    expect(() => validateInsiderConfiguration({ ...base, addedInsiders: [duplicate, duplicate] }))
      .toThrow(/Duplicate insider identity/);
  });

  it("supports a name-only addition and keeps disabled custom identities for restoration", () => {
    const added = createAddedInsider({
      displayName: "Stored Evidence Person",
      handles: {},
      weight: 3
    });
    const parsed = validateInsiderConfiguration({
      expectedVersion: 0,
      excludedDefaultIds: [],
      weightOverrides: {},
      addedInsiders: [{ ...added, active: false }]
    });
    expect(parsed.addedInsiders[0]).toMatchObject({
      personId: "user:name:stored-evidence-person",
      active: false
    });
    expect(effectiveInsiderMembers(parsed)).not.toContainEqual(
      expect.objectContaining({ personId: added.personId })
    );
  });

  it("merges the historical Phillip Johnston spelling into canonical Philip Johnston", () => {
    const duplicate = createAddedInsider({
      displayName: "Phillip Johnston",
      handles: {},
      weight: 4
    });
    const parsed = validateInsiderConfiguration({
      expectedVersion: 0,
      excludedDefaultIds: [],
      weightOverrides: {},
      addedInsiders: [duplicate]
    });
    expect(parsed.addedInsiders).toEqual([]);
    expect(parsed.weightOverrides["philip-johnston"]).toBe(4);
  });
});
