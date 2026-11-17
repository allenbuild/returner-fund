import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  decodePackedTargetedEvidence,
  materializeTargetedEvidence,
  TARGETED_EVIDENCE_MANIFEST_PATH,
  TARGETED_EVIDENCE_PACK_PATH,
  TARGETED_EVIDENCE_PATH
} from "./packed-targeted-evidence.mjs";

export function assertNoTrackedRawTargetedEvidence(indexEntries) {
  if (String(indexEntries).trim()) {
    throw new Error("Publication base still tracks legacy raw targeted evidence; migrate its Git index before packed publication");
  }
}

/** Read immutable Git blobs as bytes; gzip must never pass through UTF-8 capture. */
export async function readTargetedEvidenceFromGitRef({
  cwd, ref, timeoutMs = 45_000, env, beforeRead, onChild, onChildExit
}) {
  if (typeof ref !== "string" || !ref || ref.startsWith("-") || /[\0\r\n:]/.test(ref)) {
    throw new Error("Invalid targeted evidence Git ref");
  }
  const readBlob = (path, maxBuffer) => new Promise((resolve, reject) => {
    let child;
    try {
      const effectiveTimeout = beforeRead ? beforeRead(path) : timeoutMs;
      child = execFile("git", ["--no-pager", "show", "--no-textconv", `${ref}:${path}`], {
        cwd, encoding: "buffer", maxBuffer, timeout: Math.min(timeoutMs, effectiveTimeout),
        detached: process.platform !== "win32",
        env: { ...(env ?? process.env), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" }
      }, (error, stdout, stderr) => {
        onChildExit?.(child);
        if (!error) return resolve(stdout);
        const diagnostic = stderr.toString("utf8");
        if (error.code === 128 && /(?:does not exist in|exists on disk, but not in)/.test(diagnostic)) return resolve(null);
        reject(new Error(`Could not read targeted evidence Git blob ${ref}:${path}: ${error.code ?? error.message}`));
      });
      onChild?.(child);
    } catch (error) {
      if (child) { child.kill("SIGTERM"); onChildExit?.(child); }
      reject(error);
    }
  });
  const legacy = await readBlob(TARGETED_EVIDENCE_PATH, 1024 ** 3);
  if (legacy !== null) return JSON.parse(legacy.toString("utf8"));
  const manifestBytes = await readBlob(TARGETED_EVIDENCE_MANIFEST_PATH, 1024 ** 2);
  const packed = await readBlob(TARGETED_EVIDENCE_PACK_PATH, 100 * 1024 ** 2);
  if (manifestBytes === null && packed === null) return null;
  if (manifestBytes === null || packed === null) throw new Error("Incomplete targeted evidence pack at Git ref");
  const bytes = decodePackedTargetedEvidence(JSON.parse(manifestBytes.toString("utf8")), packed);
  return JSON.parse(bytes.toString("utf8"));
}

/** Only runner-owned retry worktrees may replace ignored raw data from restored Git packs. */
export async function refreshPublicationTargetedEvidence({ rootDir }) {
  let manifestBytes;
  try {
    manifestBytes = await readFile(join(rootDir, TARGETED_EVIDENCE_MANIFEST_PATH));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    try {
      await stat(join(rootDir, TARGETED_EVIDENCE_PACK_PATH));
    } catch (packError) {
      if (packError.code !== "ENOENT") throw packError;
      return materializeTargetedEvidence({ rootDir });
    }
    throw new Error("Incomplete targeted evidence pack in publication worktree");
  }
  const packed = await readFile(join(rootDir, TARGETED_EVIDENCE_PACK_PATH));
  const bytes = decodePackedTargetedEvidence(JSON.parse(manifestBytes.toString("utf8")), packed);
  JSON.parse(bytes.toString("utf8"));
  const target = join(rootDir, TARGETED_EVIDENCE_PATH);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
  return { status: "refreshed", path: TARGETED_EVIDENCE_PATH };
}
