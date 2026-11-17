import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { materializeTargetedEvidence, packTargetedEvidence, TARGETED_EVIDENCE_PATH, TARGETED_EVIDENCE_PACK_PATH, TARGETED_EVIDENCE_MANIFEST_PATH } from "../scripts/lib/packed-targeted-evidence.mjs";

async function fixture(t) {
  const rootDir = await mkdtemp(join(tmpdir(), "returner-packed-evidence-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const path = join(rootDir, TARGETED_EVIDENCE_PATH);
  await mkdir(dirname(path), { recursive: true });
  const bytes = Buffer.from('{\n  "source": {"name":"native"},\n  "evidence": [{"text":"Unicode: café 🚀\\n  original whitespace", "postedAt":null}]\n}\n');
  await writeFile(path, bytes);
  const manifest = await packTargetedEvidence({ rootDir });
  return { rootDir, path, bytes, manifest };
}
test("fresh checkout restores every original byte, Unicode and null dates", async (t) => {
  const f = await fixture(t); await rm(f.path);
  const result = await materializeTargetedEvidence(f);
  assert.equal(result.sha256, f.manifest.sha256);
  assert.deepEqual(await readFile(f.path), f.bytes);
});
test("setup preserves newer local ingestion instead of overwriting it", async (t) => {
  const f = await fixture(t), newer = '{"evidence":[{"text":"new local post"}]}\n';
  await writeFile(f.path, newer);
  assert.equal((await materializeTargetedEvidence(f)).status, "existing");
  assert.equal(await readFile(f.path, "utf8"), newer);
});
test("corrupt compressed data cannot materialize a canonical file", async (t) => {
  const f = await fixture(t); await rm(f.path);
  await writeFile(join(f.rootDir, TARGETED_EVIDENCE_PACK_PATH), "corrupt");
  await assert.rejects(materializeTargetedEvidence(f), /compressed checksum/);
  await assert.rejects(readFile(f.path), { code: "ENOENT" });
});
test("uncompressed hash and output-size claims fail closed", async (t) => {
  const f = await fixture(t); await rm(f.path);
  await writeFile(join(f.rootDir, TARGETED_EVIDENCE_MANIFEST_PATH), JSON.stringify({ ...f.manifest, sha256: "0".repeat(64) }));
  await assert.rejects(materializeTargetedEvidence(f), /restored checksum/);
  await writeFile(join(f.rootDir, TARGETED_EVIDENCE_MANIFEST_PATH), JSON.stringify({ ...f.manifest, bytes: 1 }));
  await assert.rejects(materializeTargetedEvidence(f));
  await assert.rejects(readFile(f.path), { code: "ENOENT" });
});
test("manifest cannot select a path outside the fixed canonical destination", async (t) => {
  const f = await fixture(t); await rm(f.path);
  await writeFile(join(f.rootDir, TARGETED_EVIDENCE_MANIFEST_PATH), JSON.stringify({ ...f.manifest, path: "../elsewhere.json" }));
  await assert.rejects(materializeTargetedEvidence(f), /Invalid targeted/);
});
test("packaging refuses a canonical SHA different from the frozen checkpoint", async (t) => {
  const f = await fixture(t);
  await assert.rejects(packTargetedEvidence({ rootDir: f.rootDir, expectedSha256: "0".repeat(64) }), /changed before packaging/);
});
