import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freezeFallNativeArticleContexts, exportFrozenNativeArticleContexts } from "../scripts/lib/fall-native-article-context-archive.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fixture(fn) {
  const rootDir = await mkdtemp(join(tmpdir(), "article-context-archive-"));
  try {
    await mkdir(join(rootDir, "src/lib/social"), { recursive: true });
    await mkdir(join(rootDir, "outputs/export"), { recursive: true });
    const ledgerPath = "src/lib/social/native-article-context-fall-2026.json", sourcePath = "outputs/native.json", bytes = Buffer.from('{"native":"exact body receipt"}\n');
    await writeFile(join(rootDir, ledgerPath), JSON.stringify({ contexts: [{ contextId: "local-body:one", text: "Exact body", articleNativeId: null }] }));
    await writeFile(join(rootDir, sourcePath), bytes);
    const verify = async () => ({ ok: true, archives: [{ path: sourcePath, sha256: sha(bytes) }] });
    await fn({ rootDir, ledgerPath, sourcePath, verify, frozenDirectory: "outputs/checkpoint", checkpoint: "outputs/checkpoint", output: "outputs/export" });
  } finally { await rm(rootDir, { recursive: true, force: true }); }
}

test("separate body ledger and exact source bytes freeze and export without a native post ID", async () => fixture(async (options) => {
  const audit = await freezeFallNativeArticleContexts(options);
  const exported = await exportFrozenNativeArticleContexts(options);
  assert.equal(audit.contexts, 1);
  assert.equal(exported.countsAsNativePosts, false);
  assert.equal(exported.ledger.contexts[0].platformPostId, undefined);
  assert.deepEqual(await readFile(join(options.rootDir, exported.archives[0].archivedPath)), await readFile(join(options.rootDir, options.sourcePath)));
}));

test("later live source edits cannot alter an already frozen collected-history export", async () => fixture(async (options) => {
  await freezeFallNativeArticleContexts(options);
  await writeFile(join(options.rootDir, options.sourcePath), "changed live source");
  const exported = await exportFrozenNativeArticleContexts(options);
  assert.equal(await readFile(join(options.rootDir, exported.archives[0].archivedPath), "utf8"), '{"native":"exact body receipt"}\n');
}));

test("changed native archive after physical validation prevents freeze", async () => fixture(async (options) => {
  const verify = async (...args) => { const result = await options.verify(...args); await writeFile(join(options.rootDir, options.sourcePath), "changed"); return result; };
  await assert.rejects(freezeFallNativeArticleContexts({ ...options, verify }), /source changed/);
}));

test("changed body ledger during physical validation prevents freeze", async () => fixture(async (options) => {
  const verify = async (...args) => { const result = await options.verify(...args); await writeFile(join(options.rootDir, options.ledgerPath), '{"contexts":[]}'); return result; };
  await assert.rejects(freezeFallNativeArticleContexts({ ...options, verify }), /ledger changed/);
}));

test("modified frozen source or ledger cannot enter collected-history export", async () => {
  for (const kind of ["source", "ledger"]) await fixture(async (options) => {
    const audit = await freezeFallNativeArticleContexts(options);
    await writeFile(join(options.rootDir, kind === "source" ? audit.archives[0].frozenPath : audit.ledgerFrozenPath), "changed");
    await assert.rejects(exportFrozenNativeArticleContexts(options), /changed/);
  });
});

test("missing optional body ledger leaves earlier checkpoints unchanged", async () => fixture(async (options) => {
  assert.equal(await freezeFallNativeArticleContexts({ ...options, ledgerPath: "missing.json" }), null);
  assert.equal(await exportFrozenNativeArticleContexts(options), null);
}));
