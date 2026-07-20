import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = process.cwd();
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("strict source-hunt evidence importer", () => {
  it("keeps one verified copy of a physical post for each distinct entity attribution", async () => {
    const directory = await mkdtemp(join(tmpdir(), "returner-source-hunt-import-"));
    temporaryDirectories.push(directory);
    const target = join(directory, "target.json");
    const input = join(directory, "input.json");
    const sourceUrl =
      "https://www.linkedin.com/posts/test_multi-company-list-activity-7999999999999999999-fixture";
    const base = {
      batch: "S2026",
      entityType: "company",
      platform: "linkedin",
      sourceUrl,
      platformPostId: "7999999999999999999",
      authorName: "Verified Author",
      authorHandle: "verified-author",
      postedAt: "2026-06-12T16:00:21.775Z",
      metrics: { reactions: 37, comments: 2, reposts: 4 },
      contributionScore: 1,
      review_state: "verified",
      linkStatus: "verified",
      title: "Two-company fixture",
      text: "This native post explicitly names both companies.",
      matchReason: "Native LinkedIn post explicitly names the attributed company."
    };

    await writeFile(target, `${JSON.stringify({ source: {}, evidence: [] }, null, 2)}\n`);
    const acceptedBase = {
      batch: base.batch,
      platform: base.platform,
      url: base.sourceUrl,
      platformPostId: base.platformPostId,
      voiceName: base.authorName,
      publishedAt: base.postedAt,
      metrics: base.metrics,
      title: base.title,
      text: base.text,
      evidenceReason: base.matchReason,
      rawVisibleText: {
        profile: { name: base.authorName, username: base.authorHandle },
        post: { authorName: base.authorName, authorHandle: base.authorHandle }
      }
    };
    await writeFile(
      input,
      `${JSON.stringify({
        accepted: [
          { ...acceptedBase, company: "Eden Robotics" },
          { ...acceptedBase, company: "9 Mothers" }
        ]
      }, null, 2)}\n`
    );

    const stdout = execFileSync(
      process.execPath,
      [
        "scripts/import-source-hunt-evidence.mjs",
        `--target=${target}`,
        `--external-evidence-root=${root}`,
        `--input=${input}`,
        "--observed-at=2026-07-20T12:00:00.000Z",
        "--write"
      ],
      { cwd: root, encoding: "utf8" }
    );
    const audit = JSON.parse(stdout);
    const written = JSON.parse(await readFile(target, "utf8"));

    expect(audit.accepted).toBe(2);
    expect(audit.rejected).toBe(0);
    expect(written.evidence).toHaveLength(2);
    expect(written.evidence.map((row) => row.entityId).sort()).toEqual([
      "company-9-mothers-corporation",
      "company-eden-robotics"
    ]);
    expect(new Set(written.evidence.map((row) => row.platformPostId))).toEqual(
      new Set(["7999999999999999999"])
    );
  });
});
