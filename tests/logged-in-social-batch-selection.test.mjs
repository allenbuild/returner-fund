import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  linkedinAccountSlugFromUrl,
  linkedinNativeAuthorSlugFromUrl,
  linkedinPostIdFromUrl,
  linkedinPostMatchesAccount
} from "../scripts/lib/social-native-identity.mjs";
import { canonicalSocialAccountUrl } from "../scripts/lib/social-account-url.mjs";

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
    ["S2026", 197, 397, 1_783, 2_971, 967],
    ["S26", null, null, null, null, null],
    ["A16ZSR006", 59, 128, 564, 938, 289]
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

    if (batchSlug === "S26") {
      expect(logged.companyCount).toBeGreaterThanOrEqual(167);
      expect(logged.companyCount).toBe(publicPlan.companyCount);
      expect(logged.founderCount).toBe(publicPlan.founderCount);
      expect(logged.coverage).toHaveLength((logged.companyCount + logged.founderCount) * 3);
      expect(publicPlan.socialCoverage).toHaveLength(
        (publicPlan.companyCount + publicPlan.founderCount) * 5
      );
      targetCount = publicPlan.socialTargets.length;
    } else {
      expect(logged.companyCount).toBe(companyCount);
      expect(logged.founderCount).toBe(founderCount);
      expect(logged.coverage).toHaveLength(coverageCount);
      expect(publicPlan.companyCount).toBe(companyCount);
      expect(publicPlan.founderCount).toBe(founderCount);
      expect(publicPlan.socialCoverage).toHaveLength(publicCoverageCount);
    }
    expect(logged.targets).toHaveLength(
      targetCount - logged.quarantinedTargetCount
    );
    expect(publicPlan.socialTargets).toHaveLength(targetCount);

    const accountIdentity = (platform, accountUrl) =>
      canonicalSocialAccountUrl(platform, accountUrl)
      ?? accountUrl?.toLowerCase().replace(/\/$/, "")
      ?? "unmapped";
    const ownerPlatformAccount = logged.coverage.map((row) =>
      `${row.entityId}:${row.platform}:${accountIdentity(row.platform, row.accountUrl)}`
    );
    expect(new Set(ownerPlatformAccount).size).toBe(ownerPlatformAccount.length);
    expect(logged.coverage.filter((row) => row.status === "mapped_target")).toHaveLength(
      targetCount - logged.quarantinedTargetCount
    );
    const targetKey = (target) => [
      target.entityType,
      target.entityId,
      target.platform,
      accountIdentity(target.platform, target.accountUrl)
    ].join(":");
    const quarantinedTargets = logged.ownerAccountCollisions.flatMap(
      (collision) => collision.targets
    );
    expect(quarantinedTargets).toHaveLength(logged.quarantinedTargetCount);
    expect(
      [...logged.targets, ...quarantinedTargets].map(targetKey).sort()
    ).toEqual(publicPlan.socialTargets.map(targetKey).sort());
    expect(new Set(logged.targets.map((target) => target.checkpointKey)).size).toBe(
      targetCount - logged.quarantinedTargetCount
    );
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
    expect(spring.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        companySlug: "allowance",
        platform: "instagram",
        accountUrl: "https://www.instagram.com/useallowance/"
      }),
      expect.objectContaining({
        companySlug: "hub",
        platform: "instagram",
        accountUrl: "https://www.instagram.com/hubxyz_official/"
      }),
      expect.objectContaining({
        companySlug: "surtr-defense-systems",
        platform: "instagram",
        accountUrl: "https://www.instagram.com/surtrdefense/"
      })
    ]));
    for (const [companySlug, rejectedHandle] of [
      ["amboras", "amboras.ai"],
      ["arzana", "arzana_automation"],
      ["juno-chat", "junocompanion"],
      ["playablai", "playabl_ai"],
      ["projectx", "projectx.cloud"]
    ]) {
      expect(spring.targets.some(
        (target) =>
          target.companySlug === companySlug &&
          target.platform === "instagram" &&
          target.accountUrl.includes(rejectedHandle)
      )).toBe(false);
    }

    const summer = runPlan([
      "--batch=S26",
      "--entities=all",
      "--platforms=instagram"
    ]);
    expect(summer.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        companySlug: "control-seat",
        accountUrl: "https://www.instagram.com/controlseat/"
      }),
      expect.objectContaining({
        companySlug: "talentpluto",
        accountUrl: "https://www.instagram.com/talentpluto_/"
      })
    ]));
  });

  it("reports the explicit LinkedIn mode while retaining company DOM targets", () => {
    const plan = runPlan([
      "--batch=S2026",
      "--company=eden-robotics",
      "--entities=company",
      "--platforms=linkedin",
      "--allow-linkedin",
      "--linkedin-mode=adapter"
    ]);

    expect(plan.linkedinCollectionMode).toBe("adapter");
    expect(plan.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        platform: "linkedin",
        accountUrl: expect.stringContaining("/company/"),
        activityUrl: expect.stringContaining("/company/")
      })
    ]));
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
