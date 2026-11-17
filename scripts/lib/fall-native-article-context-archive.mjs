import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, relative, join } from "node:path";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const defaultVerifier = async (ledger, options) => {
  const { verifyNativeXArticleContextLedger } = await import("../ingest-fall-2026-x-article-context.mjs");
  return verifyNativeXArticleContextLedger(ledger, options);
};

/** Freeze this separate body-context namespace and every physically verified
 * source. These records do not enter the native-post/scoring ledger. */
export async function freezeFallNativeArticleContexts({ rootDir = process.cwd(), frozenDirectory, ledgerPath = "src/lib/social/native-article-context-fall-2026.json", verify = defaultVerifier } = {}) {
  const root = resolve(rootDir), output = resolve(root, frozenDirectory);
  let bytes;
  try { bytes = await readFile(resolve(root, ledgerPath)); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const ledger = JSON.parse(bytes), verification = await verify(ledger, { rootDir: root });
  if (verification.ok !== true || !Array.isArray(verification.archives)) throw new Error("Native Article body ledger did not pass physical verification.");
  await mkdir(join(output, "native-article-context-source-archives"), { recursive: true });
  const archives = [];
  for (const archive of verification.archives) {
    const sourceBytes = await readFile(resolve(root, archive.path));
    if (sha(sourceBytes) !== archive.sha256) throw new Error("Native Article source changed after verification.");
    const frozenPath = join(output, "native-article-context-source-archives", archive.sha256);
    await writeFile(frozenPath, sourceBytes);
    if (sha(await readFile(frozenPath)) !== archive.sha256) throw new Error("Native Article archive copy differs.");
    archives.push({ sourcePath: archive.path, frozenPath: relative(root, frozenPath), sha256: archive.sha256, bytes: sourceBytes.length });
  }
  if (sha(await readFile(resolve(root, ledgerPath))) !== sha(bytes)) throw new Error("Native Article context ledger changed during freeze.");
  const frozenLedgerPath = join(output, "native-article-body-contexts.json");
  await writeFile(frozenLedgerPath, bytes);
  const audit = { source: "fall_2026_separate_native_article_context_archive_v1", ledgerSourcePath: ledgerPath, ledgerFrozenPath: relative(root, frozenLedgerPath), ledgerSha256: sha(bytes), contexts: ledger.contexts.length, countsAsNativePosts: false, contributionScore: 0, archives };
  await writeFile(join(output, "native-article-context-source-freeze-audit.json"), `${JSON.stringify(audit, null, 2)}\n`);
  return audit;
}

/** Export only the already validated frozen snapshot. Rehash every frozen
 * archive, so later edits to a live input cannot affect this checkpoint. */
export async function exportFrozenNativeArticleContexts({ rootDir = process.cwd(), checkpoint, output, verify = defaultVerifier } = {}) {
  const root = resolve(rootDir), checkpointPath = resolve(root, checkpoint), outputPath = resolve(root, output);
  let auditBytes;
  try { auditBytes = await readFile(join(checkpointPath, "native-article-context-source-freeze-audit.json")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const audit = JSON.parse(auditBytes), ledgerBytes = await readFile(resolve(root, audit.ledgerFrozenPath));
  if (sha(ledgerBytes) !== audit.ledgerSha256 || audit.countsAsNativePosts !== false || audit.contributionScore !== 0) throw new Error("Frozen native Article context ledger changed.");
  const ledger = JSON.parse(ledgerBytes), expectedDirectory = join(checkpointPath, "native-article-context-source-archives");
  const archives = [], frozenBytes = new Map();
  for (const archive of audit.archives) {
    const frozenPath = resolve(root, archive.frozenPath);
    if (frozenPath !== join(expectedDirectory, archive.sha256)) throw new Error("Frozen native Article source path is outside its receipt namespace.");
    const bytes = await readFile(frozenPath);
    if (sha(bytes) !== archive.sha256) throw new Error("Frozen native Article source SHA changed.");
    frozenBytes.set(archive.sourcePath, { bytes, sha256: archive.sha256 });
    const archivedPath = join(outputPath, `native-article-source-${archive.sha256}`);
    await writeFile(archivedPath, bytes);
    archives.push({ ...archive, archivedPath: relative(root, archivedPath) });
  }
  const verification = await verify(ledger, { rootDir: root, readArchive: async (path, expectedSha256) => {
    const archive = frozenBytes.get(path);
    if (!archive || archive.sha256 !== expectedSha256) throw new Error("Native Article body references an unfrozen source archive.");
    return archive.bytes;
  } });
  if (verification.ok !== true || ledger.contexts.length !== audit.contexts) throw new Error("Frozen native Article context verification failed.");
  const archivedLedgerPath = join(outputPath, "native-article-body-contexts.json");
  await writeFile(archivedLedgerPath, ledgerBytes);
  await writeFile(join(outputPath, "native-article-context-source-freeze-audit.json"), auditBytes);
  return { ledger, path: relative(root, archivedLedgerPath), sha256: sha(ledgerBytes), archives, countsAsNativePosts: false };
}
