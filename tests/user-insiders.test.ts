import { describe, expect, it } from "vitest";
import {
  createAddedInsider,
  effectiveInsiderMembers,
  emptyInsiderConfiguration,
  validateInsiderConfiguration
} from "@/lib/social/user-insiders";
import { defaultInsiderMembers } from "@/lib/social/top-voices";

describe("per-user Insiders configuration", () => {
  it("starts from the exact canonical 50-person list at weight 1", () => {
    const defaults = defaultInsiderMembers();
    expect(defaults).toHaveLength(50);
    expect(new Set(defaults.map((member) => member.personId)).size).toBe(50);
    expect(defaults.every((member) => member.weight === 1 && member.active)).toBe(true);
    expect(effectiveInsiderMembers(emptyInsiderConfiguration())).toEqual(defaults);
  });

  it("applies exclusions, sparse weight overrides, and additions without mutating defaults", () => {
    const defaults = defaultInsiderMembers();
    const added = createAddedInsider({
      displayName: "New Signal",
      handles: { x: ["new_signal"] },
      weight: 1.75
    });
    const effective = effectiveInsiderMembers({
      excludedDefaultIds: [defaults[0].personId],
      weightOverrides: { [defaults[1].personId]: 2.25 },
      addedInsiders: [added]
    });

    expect(effective).toHaveLength(50);
    expect(effective.some((member) => member.personId === defaults[0].personId)).toBe(false);
    expect(effective.find((member) => member.personId === defaults[1].personId)?.weight).toBe(2.25);
    expect(effective.at(-1)).toMatchObject({ displayName: "New Signal", weight: 1.75, source: "user-added" });
    expect(defaultInsiderMembers()[1].weight).toBe(1);
  });

  it("normalizes additions and strips default-valued overrides", () => {
    const defaults = defaultInsiderMembers();
    const parsed = validateInsiderConfiguration({
      expectedVersion: 3,
      excludedDefaultIds: [defaults[0].personId, defaults[0].personId],
      weightOverrides: { [defaults[1].personId]: 1, [defaults[2].personId]: 1.4 },
      addedInsiders: [{
        personId: "user:x:signal",
        displayName: " Signal Person ",
        aliases: ["Signal Person"],
        handles: { x: ["@Signal"] },
        category: "insider",
        weight: 1.2,
        active: true,
        source: "user-added"
      }]
    });

    expect(parsed.excludedDefaultIds).toEqual([defaults[0].personId]);
    expect(parsed.weightOverrides).toEqual({ [defaults[2].personId]: 1.4 });
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
});
