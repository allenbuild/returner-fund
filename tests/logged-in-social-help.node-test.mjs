import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

const collectorPath = resolve(
  "scripts/fetch-logged-in-social-traction.mjs"
);

describe("logged-in social collector help", () => {
  for (const flag of ["--help", "-h"]) {
    it(`${flag} exits before reads, collection, or writes`, () => {
      const fakeRoot = mkdtempSync(join(tmpdir(), "logged-in-help-"));
      const evidencePath = join(
        fakeRoot,
        "src/lib/social/logged-in-evidence-current.json"
      );
      const checkpointPath = join(
        fakeRoot,
        "work/logged-in-social-checkpoint-s2026.json"
      );
      const evidenceSentinel = '{"sentinel":"evidence"}\n';
      const checkpointSentinel = '{"sentinel":"checkpoint"}\n';

      mkdirSync(dirname(evidencePath), { recursive: true });
      mkdirSync(dirname(checkpointPath), { recursive: true });
      writeFileSync(evidencePath, evidenceSentinel);
      writeFileSync(checkpointPath, checkpointSentinel);
      const beforeEvidence = statSync(evidencePath);
      const beforeCheckpoint = statSync(checkpointPath);

      try {
        const result = spawnSync(
          process.execPath,
          [
            collectorPath,
            flag,
            "--batch=NOT_A_BATCH",
            "--x-mode=NOT_A_MODE",
            "--platforms=linkedin",
            "--allow-linkedin"
          ],
          {
            cwd: fakeRoot,
            encoding: "utf8",
            env: {
              ...process.env,
              OPENCLI_BIN: join(fakeRoot, "must-not-run-opencli")
            }
          }
        );

        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /^Usage: node scripts\//);
        assert.match(
          result.stdout,
          /--fresh-for-hours=N\s+Re-run completed targets after N hours \(default: 12\)/
        );
        assert.match(
          result.stdout,
          /--delay-ms=N\s+LinkedIn enforces a 30000ms minimum between targets/
        );
        assert.doesNotMatch(result.stdout, /Logged-in social targets:|Wrote/);
        assert.equal(result.stderr, "");
        assert.equal(readFileSync(evidencePath, "utf8"), evidenceSentinel);
        assert.equal(readFileSync(checkpointPath, "utf8"), checkpointSentinel);

        const afterEvidence = statSync(evidencePath);
        const afterCheckpoint = statSync(checkpointPath);
        assert.deepEqual(
          pickStableStat(afterEvidence),
          pickStableStat(beforeEvidence)
        );
        assert.deepEqual(
          pickStableStat(afterCheckpoint),
          pickStableStat(beforeCheckpoint)
        );
      } finally {
        rmSync(fakeRoot, { recursive: true, force: true });
      }
    });
  }
});

function pickStableStat(value) {
  return {
    ino: value.ino,
    size: value.size,
    mtimeMs: value.mtimeMs
  };
}
