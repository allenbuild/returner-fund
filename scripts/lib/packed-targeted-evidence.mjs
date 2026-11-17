import { createHash, randomUUID } from "node:crypto";
import { access, link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

export const TARGETED_EVIDENCE_PATH = "src/lib/social/targeted-evidence-current.json";
export const TARGETED_EVIDENCE_PACK_PATH = `${TARGETED_EVIDENCE_PATH}.gz`;
export const TARGETED_EVIDENCE_MANIFEST_PATH = "src/lib/social/targeted-evidence-current.pack.json";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const validHash = (value) => /^[a-f0-9]{64}$/.test(value ?? "");
const exists = async (path) => { try { await access(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } };

/** Restore the exact committed bytes on a fresh checkout; preserve local ingestion work. */
export async function materializeTargetedEvidence({ rootDir = process.cwd() } = {}) {
  const root = resolve(rootDir), target = join(root, TARGETED_EVIDENCE_PATH);
  if (await exists(target)) return { status: "existing", path: TARGETED_EVIDENCE_PATH };
  const manifest = JSON.parse(await readFile(join(root, TARGETED_EVIDENCE_MANIFEST_PATH), "utf8"));
  if (manifest.version !== 1 || manifest.path !== TARGETED_EVIDENCE_PATH || manifest.packPath !== TARGETED_EVIDENCE_PACK_PATH
    || !validHash(manifest.sha256) || !validHash(manifest.packSha256)
    || !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 1 || manifest.bytes > 1024 ** 3
    || !Number.isSafeInteger(manifest.packBytes) || manifest.packBytes < 1 || manifest.packBytes >= 100 * 1024 ** 2) {
    throw new Error("Invalid targeted evidence pack manifest");
  }
  const packed = await readFile(join(root, TARGETED_EVIDENCE_PACK_PATH));
  if (packed.length !== manifest.packBytes || sha256(packed) !== manifest.packSha256) throw new Error("Targeted evidence compressed checksum mismatch");
  const bytes = gunzipSync(packed, { maxOutputLength: manifest.bytes });
  if (bytes.length !== manifest.bytes || sha256(bytes) !== manifest.sha256) throw new Error("Targeted evidence restored checksum mismatch");
  JSON.parse(bytes.toString("utf8"));
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  let restored = true;
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    try { await link(temporary, target); } catch (error) { if (error.code !== "EEXIST") throw error; restored = false; }
  } finally { await rm(temporary, { force: true }); }
  if (!restored) return { status: "existing", path: TARGETED_EVIDENCE_PATH };
  return { status: "materialized", path: TARGETED_EVIDENCE_PATH, bytes: bytes.length, sha256: manifest.sha256 };
}

export async function packTargetedEvidence({ rootDir = process.cwd(), expectedSha256 } = {}) {
  const root = resolve(rootDir), bytes = await readFile(join(root, TARGETED_EVIDENCE_PATH));
  const digest = sha256(bytes);
  if (expectedSha256 && digest !== expectedSha256) throw new Error("Canonical evidence changed before packaging");
  JSON.parse(bytes.toString("utf8"));
  const packed = gzipSync(bytes, { level: 9 });
  if (packed.length >= 100 * 1024 ** 2) throw new Error("Targeted evidence package exceeds Git's file size budget");
  const manifest = { version: 1, path: TARGETED_EVIDENCE_PATH, bytes: bytes.length, sha256: digest,
    packPath: TARGETED_EVIDENCE_PACK_PATH, packBytes: packed.length, packSha256: sha256(packed) };
  for (const [relativePath, body] of [[TARGETED_EVIDENCE_PACK_PATH, packed], [TARGETED_EVIDENCE_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`]]) {
    const target = join(root, relativePath), temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, body); await rename(temporary, target);
  }
  return manifest;
}
