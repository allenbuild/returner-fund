import assert from "node:assert/strict";
import test from "node:test";
import { unionFallNativeCheckpointDocuments } from "../scripts/lib/fall-native-checkpoint-union.mjs";

const sha = "a".repeat(64);
const base = () => ({ path: "outputs/fall-2026/browser-checkpoints/base.json", sha256: sha, document: { source: { batchSlug: "F26" }, profiles: [{ url: "profile" }], nativePosts: [{ url: "older", observedAt: "2026-11-16T17:00:00Z" }] } });
const delta = () => ({ path: "outputs/fall-2026/browser-checkpoints/delta.json", sha256: "b".repeat(64), document: { source: { batchSlug: "F26", parentFile: "base.json", parentSha256: sha }, profiles: [], nativePosts: [{ url: "newer", observedAt: "2026-11-16T17:01:00Z" }] } });

test("explicit native delta unions preserve sources and put newer complete observations first", () => {
  const source = base(), patch = delta(), result = unionFallNativeCheckpointDocuments([source, patch]);
  assert.deepEqual(result.nativePosts.map((post) => post.url), ["newer", "older"]);
  assert.deepEqual(result.profiles, source.document.profiles);
  assert.equal(result.source.inputs[1].sha256, patch.sha256);
  assert.equal(result.source.fullHistoryComplete, false);
});

test("missing, tampered, self-referencing, or mixed-cohort native delta parents fail closed", () => {
  assert.throws(() => unionFallNativeCheckpointDocuments([delta()]), /parent/);
  const wrong = base(); wrong.sha256 = "c".repeat(64);
  assert.throws(() => unionFallNativeCheckpointDocuments([wrong, delta()]), /parent/);
  const self = delta(); self.document.source.parentFile = "delta.json"; self.document.source.parentSha256 = self.sha256;
  assert.throws(() => unionFallNativeCheckpointDocuments([base(), self]), /parent/);
  const mixed = delta(); mixed.document.source.batchSlug = "S26";
  assert.throws(() => unionFallNativeCheckpointDocuments([base(), mixed]), /explicit F26/);
});
