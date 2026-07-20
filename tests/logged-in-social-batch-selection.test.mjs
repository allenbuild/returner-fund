import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

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

  it("supersedes Eden's stale founder X handle with the verified active account", () => {
    const plan = runPlan([
      "--batch=S2026",
      "--company=eden-robotics",
      "--entities=founder",
      "--platforms=x"
    ]);

    const xTargets = plan.targets.filter((target) => target.platform === "x");
    expect(xTargets).toEqual([
      expect.objectContaining({
        entityId: "founder-eden-robotics-stamatios-floratos-1956825",
        accountUrl: "https://x.com/cybermetheus"
      })
    ]);
    expect(xTargets.some((target) => /StamatisTWIY/i.test(target.accountUrl))).toBe(false);
  });
});

function runPlan(args) {
  const output = execFileSync(
    process.execPath,
    ["scripts/fetch-logged-in-social-traction.mjs", "--plan", ...args],
    { cwd: root, encoding: "utf8" }
  );
  return JSON.parse(output.slice(output.indexOf("{")));
}
