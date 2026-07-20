import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  linkedinAccountSlugFromUrl,
  linkedinNativeAuthorSlugFromUrl,
  linkedinPostIdFromUrl,
  linkedinPostMatchesAccount
} from "../scripts/lib/social-native-identity.mjs";

const root = process.cwd();

describe("logged-in social batch selection", () => {
  it("plans the official Eden founder LinkedIn activity targets for Spring/P26", () => {
    const plan = runPlan([
      "--batch=S2026",
      "--company=eden-robotics",
      "--entities=founder",
      "--platforms=linkedin",
      "--allow-linkedin"
    ]);

    expect(plan.batchSlug).toBe("S2026");
    expect(plan.snapshotPath).toContain("spring-2026-companies.json");
    expect(plan.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityId: "founder-eden-robotics-stamatios-floratos-1956825",
          accountUrl: "https://www.linkedin.com/in/stamatis-floratos-535b19244",
          activityUrl: "https://www.linkedin.com/in/stamatis-floratos-535b19244/recent-activity/all/",
          checkpointKey: expect.stringMatching(/^S2026:linkedin:/)
        }),
        expect.objectContaining({
          entityId: "founder-eden-robotics-joseph-humphreys-2772947",
          activityUrl: "https://www.linkedin.com/in/joseph-humphreys-1163b8150/recent-activity/all/"
        })
      ])
    );
  });

  it("keeps the Summer batch as the default without mixing Spring targets", () => {
    const plan = runPlan([
      "--company=6thsense",
      "--entities=founder",
      "--platforms=linkedin",
      "--allow-linkedin"
    ]);

    expect(plan.batchSlug).toBe("S26");
    expect(plan.snapshotPath).toContain("summer-2026-companies.json");
    expect(plan.targets.length).toBeGreaterThan(0);
    expect(plan.targets.every((target) => target.batchSlug === "S26")).toBe(true);
    expect(plan.targets.some((target) => target.companySlug === "eden-robotics")).toBe(false);
  });

  it("preserves both independently verified Eden founder X accounts", () => {
    const plan = runPlan([
      "--batch=S2026",
      "--company=eden-robotics",
      "--entities=founder",
      "--platforms=x"
    ]);

    const xTargets = plan.targets.filter((target) => target.platform === "x");
    expect(xTargets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entityId: "founder-eden-robotics-stamatios-floratos-1956825",
        accountUrl: "https://x.com/cybermetheus"
      }),
      expect.objectContaining({
        entityId: "founder-eden-robotics-stamatios-floratos-1956825",
        accountUrl: "https://x.com/StamatisTWIY"
      })
    ]));
    expect(xTargets).toHaveLength(2);
  });

  it.each([
    ["S2026", 197, 397, 1_783, 2_971, 953],
    ["S26", 115, 230, 1_035, 1_725, 529],
    ["A16ZSR006", 59, 128, 564, 938, 288]
  ])("covers every exact %s account target and matches the public plan", (
    batchSlug,
    companyCount,
    founderCount,
    coverageCount,
    publicCoverageCount,
    targetCount
  ) => {
    const logged = runPlan([
      `--batch=${batchSlug}`,
      "--entities=all",
      "--platforms=x,linkedin,instagram",
      "--allow-linkedin"
    ]);
    const publicPlan = runPublicPlan([
      `--batch=${batchSlug}`,
      "--social=all",
      "--platforms=x,linkedin,instagram"
    ]);

    expect(logged.companyCount).toBe(companyCount);
    expect(logged.founderCount).toBe(founderCount);
    expect(logged.coverage).toHaveLength(coverageCount);
    expect(publicPlan.companyCount).toBe(companyCount);
    expect(publicPlan.founderCount).toBe(founderCount);
    expect(publicPlan.socialCoverage).toHaveLength(publicCoverageCount);
    expect(logged.targets).toHaveLength(targetCount);
    expect(publicPlan.socialTargets).toHaveLength(targetCount);

    const ownerPlatformAccount = logged.coverage.map((row) =>
      `${row.entityId}:${row.platform}:${row.accountUrl?.toLowerCase().replace(/\/$/, "") ?? "unmapped"}`
    );
    expect(new Set(ownerPlatformAccount).size).toBe(ownerPlatformAccount.length);
    expect(logged.coverage.filter((row) => row.status === "mapped_target")).toHaveLength(targetCount);
    expect(new Set(logged.targets.map((target) => target.checkpointKey)).size).toBe(targetCount);

    const targetKey = (target) => [
      target.entityType,
      target.entityId,
      target.platform,
      target.accountUrl.toLowerCase().replace(/\/$/, "")
    ].join(":");
    expect(logged.targets.map(targetKey).sort()).toEqual(publicPlan.socialTargets.map(targetKey).sort());
    if (batchSlug === "A16ZSR006") {
      expect(logged.targets.every((target) => target.entityId.startsWith("a16z-speedrun-006-"))).toBe(true);
      expect(logged.targets.some((target) => target.entityId.startsWith("company-"))).toBe(false);
    }
  });

  it("includes override-only owners while excluding retired Playabl identity mappings", () => {
    const spring = runPlan([
      "--batch=S2026",
      "--entities=all",
      "--platforms=x,linkedin,instagram",
      "--allow-linkedin"
    ]);
    expect(spring.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        companySlug: "heyclicky",
        entityType: "founder",
        entityName: "Farza Majeed",
        platform: "instagram",
        accountUrl: "https://www.instagram.com/farza954/"
      })
    ]));
    expect(spring.targets.some(
      (target) => target.companySlug === "playablai" && /instagram\.com\/playabl_ai/i.test(target.accountUrl)
    )).toBe(false);
  });
});

describe("native LinkedIn identity extraction", () => {
  const founderProfile = "https://www.linkedin.com/in/stamatis-floratos-535b19244/";
  const nativePost = "https://www.linkedin.com/posts/stamatis-floratos-535b19244_eden-robotics-activity-7999999999999999993-good";

  it("extracts native object and exact author identities without treating profiles as posts", () => {
    expect(linkedinPostIdFromUrl(nativePost)).toBe("7999999999999999993");
    expect(linkedinNativeAuthorSlugFromUrl(nativePost)).toBe("stamatis-floratos-535b19244");
    expect(linkedinAccountSlugFromUrl(founderProfile)).toBe("stamatis-floratos-535b19244");
    expect(linkedinPostIdFromUrl(`${founderProfile}#activity-7999999999999999993`)).toBeNull();
  });

  it("requires exact native author slugs while permitting direct opaque activity URNs", () => {
    expect(linkedinPostMatchesAccount(nativePost, founderProfile)).toBe(true);
    expect(linkedinPostMatchesAccount(
      nativePost.replace("stamatis-floratos-535b19244", "someone-else"),
      founderProfile
    )).toBe(false);
    expect(linkedinPostMatchesAccount(
      "https://www.linkedin.com/feed/update/urn:li:activity:7999999999999999994",
      founderProfile
    )).toBe(true);
  });
});

function runPlan(args) {
  const output = execFileSync(
    process.execPath,
    ["scripts/fetch-logged-in-social-traction.mjs", "--plan", ...args],
    { cwd: root, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }
  );
  return JSON.parse(output.slice(output.indexOf("{")));
}

function runPublicPlan(args) {
  const output = execFileSync(
    process.execPath,
    ["scripts/fetch-public-traction.mjs", "--plan", ...args],
    { cwd: root, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }
  );
  return JSON.parse(output.slice(output.indexOf("{")));
}
