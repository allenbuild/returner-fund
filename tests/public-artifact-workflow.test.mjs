import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(
  path.join(repositoryRoot, ".github", "workflows", "public-artifacts.yml"),
  "utf8"
);

describe("Public Artifact Validation workflow", () => {
  it("budgets enough time for the complete release gate and preserves job headroom", () => {
    const validateJob = workflow.match(/\n  validate:[\s\S]*$/)?.[0] ?? "";
    const jobTimeout = Number(validateJob.match(/^\s{4}timeout-minutes:\s*(\d+)/m)?.[1]);
    const installTimeout = Number(
      validateJob.match(
        /- name: Install dependencies[\s\S]*?^\s{8}timeout-minutes:\s*(\d+)/m
      )?.[1]
    );
    const releaseGateTimeout = Number(
      validateJob.match(
        /- name: Run release gate[\s\S]*?^\s{8}timeout-minutes:\s*(\d+)/m
      )?.[1]
    );

    expect(jobTimeout).toBe(120);
    expect(installTimeout).toBe(10);
    expect(releaseGateTimeout).toBe(105);
    expect(installTimeout + releaseGateTimeout).toBeLessThan(jobTimeout);
  });
});
