import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findSecretLikeFields, hasSecretLikeContent } from "../../src/lib/workers/secret-guard";

const REPO_ROOT = process.cwd();
const SKIP_DIRS = new Set([".git", ".next", "coverage", "node_modules", "outputs", "work"]);
const SCANNED_EXTENSIONS = new Set([
  ".css",
  ".example",
  ".json",
  ".md",
  ".mjs",
  ".sql",
  ".ts",
  ".tsx",
  ".txt",
  ".yml",
  ".yaml"
]);

describe("no-secret guard", () => {
  it("flags secret-like fields in nested payloads", () => {
    const findings = findSecretLikeFields({
      batchSlug: "S2026",
      options: {
        demo: true,
        cookies: ["auth", "_token=abcdefghijklmnop", "qrstuvwxyz; ct0=abcdefghijklmnop", "qrstuvwxyz"].join("")
      }
    });

    expect(findings.map((finding) => finding.path)).toContain("$.options.cookies");
  });

  it("allows ordinary ingest options", () => {
    expect(
      findSecretLikeFields({
        batchSlug: "S2026",
        options: { demo: true, refreshProfiles: true, refreshPosts: false, platforms: ["github", "web"] }
      })
    ).toEqual([]);
  });

  it("does not find committed secret values in source, docs, or config files", () => {
    const hits: string[] = [];

    for (const filePath of listFiles(REPO_ROOT)) {
      const content = fs.readFileSync(filePath, "utf8");
      if (hasSecretLikeContent(content)) {
        hits.push(path.relative(REPO_ROOT, filePath));
      }
    }

    expect(hits).toEqual([]);
  });
});

function listFiles(root: string): string[] {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) {
      continue;
    }

    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(fullPath));
      continue;
    }

    if (entry.isFile() && SCANNED_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }

  return files;
}
