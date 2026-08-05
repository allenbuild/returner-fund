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
  it("runs independent release gates in parallel behind one required result", () => {
    for (const [job, command, jobTimeout, gateTimeout] of [
      ["application", "npm run check", 90, 75],
      ["scoring", "npm run check:release:scoring", 70, 55],
      ["artifacts", "npm run check:release:artifacts", 70, 55]
    ]) {
      const section = workflow.match(
        new RegExp(`\\n  ${job}:[\\s\\S]*?(?=\\n  [a-z][a-z-]*:|$)`)
      )?.[0] ?? "";
      expect(section).toContain(`timeout-minutes: ${jobTimeout}`);
      expect(section).toContain("timeout-minutes: 10");
      expect(section).toContain(`timeout-minutes: ${gateTimeout}`);
      expect(section).toContain("run: npm ci");
      expect(section).toContain(`run: ${command}`);
    }

    const validateJob = workflow.match(/\n  validate:[\s\S]*$/)?.[0] ?? "";
    expect(validateJob).toContain("if: always()");
    expect(validateJob).toContain("- application");
    expect(validateJob).toContain("- scoring");
    expect(validateJob).toContain("- artifacts");
    expect(validateJob).toContain("APPLICATION_RESULT: ${{ needs.application.result }}");
    expect(validateJob).toContain('test "$APPLICATION_RESULT" = success');
  });

  it("validates branch pushes only on main while keeping pull requests", () => {
    expect(workflow).toContain("pull_request:");
    expect(workflow).toMatch(/push:\s*\n\s+branches:\s*\n\s+- main/);
  });
});
