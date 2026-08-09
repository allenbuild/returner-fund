import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  validateTopicFacetSnapshots,
  writeTopicFacetSnapshotsAtomically
} from "../scripts/build-topic-facets.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("topic facet snapshot publication", () => {
  it("names stale outputs without mutating existing or missing files", () => {
    const directory = temporaryDirectory();
    const existingPath = path.join(directory, "s26.json");
    const missingPath = path.join(directory, "s2026.json");
    const original = Buffer.from('{"version":"old"}', "utf8");
    fs.writeFileSync(existingPath, original);
    const directoryBefore = fs.readdirSync(directory);

    const result = validateTopicFacetSnapshots([
      snapshot(existingPath, "public/topic-facets/s26.json", '{"version":"new"}'),
      snapshot(missingPath, "public/topic-facets/s2026.json", '{"version":"new"}')
    ]);

    expect(result).toEqual({
      valid: false,
      stalePaths: [
        "public/topic-facets/s26.json",
        "public/topic-facets/s2026.json"
      ]
    });
    expect(fs.readFileSync(existingPath)).toEqual(original);
    expect(fs.existsSync(missingPath)).toBe(false);
    expect(fs.readdirSync(directory)).toEqual(directoryBefore);
  });

  it("atomically writes deterministic bytes accepted by validation", () => {
    const directory = temporaryDirectory();
    const outputPath = path.join(directory, "a16zsr006.json");
    const expected = '{"version":"current","rows":[]}';
    const snapshots = [snapshot(
      outputPath,
      "public/topic-facets/a16zsr006.json",
      expected
    )];

    writeTopicFacetSnapshotsAtomically(snapshots);

    expect(fs.readFileSync(outputPath, "utf8")).toBe(expected);
    expect(validateTopicFacetSnapshots(snapshots)).toEqual({
      valid: true,
      stalePaths: []
    });
    expect(fs.readdirSync(directory)).toEqual(["a16zsr006.json"]);
  });
});

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "topic-facets-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function snapshot(outputPath, displayPath, serialized) {
  return { outputPath, displayPath, serialized };
}
