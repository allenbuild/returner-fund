import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  materializeTargetedEvidence,
  packTargetedEvidence,
  decodePackedTargetedEvidence,
  TARGETED_EVIDENCE_PATH,
  TARGETED_EVIDENCE_PACK_PATH,
  TARGETED_EVIDENCE_MANIFEST_PATH,
} from "../scripts/lib/packed-targeted-evidence.mjs";
import {
  assertNoTrackedRawTargetedEvidence,
  readTargetedEvidenceFromGitRef,
  refreshPublicationTargetedEvidence,
} from "../scripts/lib/autonomous-targeted-evidence.mjs";
import {
  assertReplaySafePublicationChanges,
  isReplaySafePublicationDataPath,
  isProtectedSourcePolicyPath,
} from "../scripts/lib/autonomous-publication-trust.mjs";

const exec = promisify(execFile);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const nativeSnapshot = () => ({
  source: { fetchedAt: "2026-11-16T22:44:01.322Z" },
  evidence: [{
    id: "native-original-1", batchSlug: "F26", platform: "x", platformPostId: "1",
    text: "Exact café 🚀\n  original whitespace", postedAt: null,
    publishedAtPrecision: "unknown", metrics: { likes: 0 },
    contributionScore: 0, tractionStatus: "unscored",
  }],
});
const encoded = (snapshot) => Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`);
async function put(root, relative, bytes) {
  const path = join(root, relative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}
async function git(root, args) {
  return (await exec("git", args, { cwd: root, encoding: "utf8" })).stdout.trim();
}
async function commit(root, message) {
  await git(root, ["-c", "core.hooksPath=/dev/null", "commit", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
}
async function repository(t) {
  const parent = await mkdtemp(join(tmpdir(), "returner-packed-publication-"));
  const root = join(parent, "repo");
  await mkdir(root);
  t.after(() => rm(parent, { recursive: true, force: true }));
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.name", "Local Publication Fixture"]);
  await git(root, ["config", "user.email", "publication-fixture@example.invalid"]);
  return { root, parent };
}
async function packedCommit(root, snapshot = nativeSnapshot()) {
  await put(root, TARGETED_EVIDENCE_PATH, encoded(snapshot));
  await packTargetedEvidence({ rootDir: root });
  await put(root, ".gitignore", `${TARGETED_EVIDENCE_PATH}\n`);
  await git(root, ["add", "--", ".gitignore", TARGETED_EVIDENCE_PACK_PATH, TARGETED_EVIDENCE_MANIFEST_PATH]);
  return commit(root, "packed native baseline");
}

test("fresh Git publication worktree restores, appends and stages only the exact packed artifacts", async (t) => {
  const { root, parent } = await repository(t);
  const base = await packedCommit(root);
  const worktree = join(parent, "publication");
  await git(root, ["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", worktree, base]);
  t.after(() => git(root, ["worktree", "remove", "--force", worktree]).catch(() => {}));
  await assert.rejects(readFile(join(worktree, TARGETED_EVIDENCE_PATH)), { code: "ENOENT" });
  await materializeTargetedEvidence({ rootDir: worktree });
  assert.deepEqual(await readFile(join(worktree, TARGETED_EVIDENCE_PATH)), encoded(nativeSnapshot()));
  const updated = nativeSnapshot();
  updated.evidence.push({ ...updated.evidence[0], id: "native-original-2", platformPostId: "2", text: "Second  exact\nbody", metrics: { likes: 3 } });
  const updatedBytes = encoded(updated);
  await put(worktree, TARGETED_EVIDENCE_PATH, updatedBytes);
  const manifest = await packTargetedEvidence({ rootDir: worktree, expectedSha256: sha(updatedBytes) });
  await git(worktree, ["add", "--", TARGETED_EVIDENCE_PACK_PATH, TARGETED_EVIDENCE_MANIFEST_PATH]);
  const changed = (await git(worktree, ["diff", "--cached", "--name-only"])).split("\n").sort();
  assert.deepEqual(changed, [TARGETED_EVIDENCE_PACK_PATH, TARGETED_EVIDENCE_MANIFEST_PATH].sort());
  assertReplaySafePublicationChanges(changed);
  assert.equal(await git(worktree, ["ls-files", "--", TARGETED_EVIDENCE_PATH]), "");
  assert.deepEqual(decodePackedTargetedEvidence(manifest, await readFile(join(worktree, TARGETED_EVIDENCE_PACK_PATH))), updatedBytes);
  const candidate = await commit(worktree, "append a native original through the packed publication path");
  assert.deepEqual(await readTargetedEvidenceFromGitRef({ cwd: worktree, ref: base }), nativeSnapshot());
  assert.deepEqual(await readTargetedEvidenceFromGitRef({ cwd: worktree, ref: candidate }), updated);
});

test("legacy raw and packed Git refs preserve the same exact baseline including unknown clocks", async (t) => {
  const { root } = await repository(t);
  const snapshot = nativeSnapshot();
  await put(root, TARGETED_EVIDENCE_PATH, encoded(snapshot));
  await git(root, ["add", "--", TARGETED_EVIDENCE_PATH]);
  const legacy = await commit(root, "legacy raw baseline");
  await git(root, ["rm", "--cached", "--", TARGETED_EVIDENCE_PATH]);
  const packed = await packedCommit(root, snapshot);
  assert.deepEqual(await readTargetedEvidenceFromGitRef({ cwd: root, ref: legacy }), snapshot);
  assert.deepEqual(await readTargetedEvidenceFromGitRef({ cwd: root, ref: packed }), snapshot);
});

test("publication refuses a Git index that still tracks raw data even when a valid pack exists", async (t) => {
  const { root } = await repository(t);
  await put(root, TARGETED_EVIDENCE_PATH, encoded(nativeSnapshot()));
  await packTargetedEvidence({ rootDir: root });
  await git(root, ["add", "--", TARGETED_EVIDENCE_PATH]);
  const indexed = await git(root, ["ls-files", "--stage", "--", TARGETED_EVIDENCE_PATH]);
  assert.ok(indexed.includes(TARGETED_EVIDENCE_PATH));
  assert.throws(() => assertNoTrackedRawTargetedEvidence(indexed), /still tracks legacy raw targeted evidence/);
  assert.equal(await git(root, ["ls-files", "--stage", "--", TARGETED_EVIDENCE_PATH]), indexed);
  assert.deepEqual(await readFile(join(root, TARGETED_EVIDENCE_PATH)), encoded(nativeSnapshot()));
  await git(root, ["rm", "--cached", "--", TARGETED_EVIDENCE_PATH]);
  const migrated = await git(root, ["ls-files", "--stage", "--", TARGETED_EVIDENCE_PATH]);
  assert.equal(migrated, "");
  assert.doesNotThrow(() => assertNoTrackedRawTargetedEvidence(migrated));
});

test("corrupt or partial committed packages fail closed instead of becoming empty baselines", async (t) => {
  const { root } = await repository(t);
  const valid = await packedCommit(root);
  await put(root, TARGETED_EVIDENCE_PACK_PATH, "corrupt compressed native data");
  await git(root, ["add", "--", TARGETED_EVIDENCE_PACK_PATH]);
  const corrupt = await commit(root, "corrupt package");
  await assert.rejects(readTargetedEvidenceFromGitRef({ cwd: root, ref: corrupt }));
  await git(root, ["reset", "--hard", valid]);
  await git(root, ["rm", "--", TARGETED_EVIDENCE_PACK_PATH]);
  const missingPack = await commit(root, "missing compressed package");
  await assert.rejects(readTargetedEvidenceFromGitRef({ cwd: root, ref: missingPack }));
  await git(root, ["reset", "--hard", valid]);
  await git(root, ["rm", "--", TARGETED_EVIDENCE_MANIFEST_PATH]);
  const missingManifest = await commit(root, "missing package manifest");
  await assert.rejects(readTargetedEvidenceFromGitRef({ cwd: root, ref: missingManifest }));
  assert.deepEqual(await readTargetedEvidenceFromGitRef({ cwd: root, ref: valid }), nativeSnapshot());
});

test("absent targeted data is distinct from a partial pack and unsafe refs are rejected", async (t) => {
  const { root } = await repository(t);
  await put(root, "README.md", "empty history fixture\n");
  await git(root, ["add", "--", "README.md"]);
  const empty = await commit(root, "no targeted data at this historical ref");
  assert.equal(await readTargetedEvidenceFromGitRef({ cwd: root, ref: empty }), null);
  await assert.rejects(readTargetedEvidenceFromGitRef({ cwd: root, ref: "--help" }));
});

test("retry refresh replaces owned stale raw data only with verified pack bytes, preserving legacy raw", async (t) => {
  const { root, parent } = await repository(t);
  await packedCommit(root);
  const next = join(parent, "next-package");
  const updated = nativeSnapshot();
  updated.evidence.push({ ...updated.evidence[0], id: "retry-native", platformPostId: "3", text: "Retry native body" });
  await put(next, TARGETED_EVIDENCE_PATH, encoded(updated));
  await packTargetedEvidence({ rootDir: next });
  for (const path of [TARGETED_EVIDENCE_PACK_PATH, TARGETED_EVIDENCE_MANIFEST_PATH]) await copyFile(join(next, path), join(root, path));
  await refreshPublicationTargetedEvidence({ rootDir: root });
  assert.deepEqual(await readFile(join(root, TARGETED_EVIDENCE_PATH)), encoded(updated));
  await put(root, TARGETED_EVIDENCE_PACK_PATH, "tampered retry package");
  await assert.rejects(refreshPublicationTargetedEvidence({ rootDir: root }));
  assert.deepEqual(await readFile(join(root, TARGETED_EVIDENCE_PATH)), encoded(updated));
  await rm(join(root, TARGETED_EVIDENCE_MANIFEST_PATH));
  await assert.rejects(refreshPublicationTargetedEvidence({ rootDir: root }));
  assert.deepEqual(await readFile(join(root, TARGETED_EVIDENCE_PATH)), encoded(updated));
  await rm(join(root, TARGETED_EVIDENCE_PACK_PATH));
  await refreshPublicationTargetedEvidence({ rootDir: root });
  assert.deepEqual(await readFile(join(root, TARGETED_EVIDENCE_PATH)), encoded(updated));
});

test("publication trust admits only fixed package paths and the exact Fall generated artifact families", () => {
  const allowed = [TARGETED_EVIDENCE_PACK_PATH, TARGETED_EVIDENCE_MANIFEST_PATH,
    "outputs/benchmarks/f26-score-benchmarks.json", "public/graph/f26.json",
    "public/graph/f26-insiders.json", "public/graph/f26-yc-partners.json", "public/topic-facets/f26.json"];
  assertReplaySafePublicationChanges(allowed);
  for (const path of allowed) {
    assert.equal(isReplaySafePublicationDataPath(path), true, path);
    assert.equal(isProtectedSourcePolicyPath(path), false, path);
  }
  for (const path of ["src/lib/social/other-evidence.json.gz", "src/lib/social/targeted-evidence-current.pack2.json",
    "src/lib/social/targeted-evidence-current.json.gz.js", "src/lib/social/package.json", "scripts/pack-policy.mjs",
    "public/graph/f26-config.json", "public/topic-facets/f26-extra.json", "outputs/benchmarks/f26-settings.json"]) {
    assert.equal(isReplaySafePublicationDataPath(path), false, path);
    assert.throws(() => assertReplaySafePublicationChanges([...allowed, path]), /non-allowlisted drift/);
  }
});
