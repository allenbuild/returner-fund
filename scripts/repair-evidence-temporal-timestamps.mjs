import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readPublicEvidenceArtifact, writePublicEvidenceCanonicalArtifactAtomic } from "./lib/public-evidence-artifact.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceFiles = [
  "src/lib/social/public-evidence-current.json",
  "src/lib/social/logged-in-evidence-current.json",
  "src/lib/social/targeted-evidence-current.json",
  "src/lib/social/volume-evidence-current.json",
  "src/lib/social/a16z-speedrun-006-social-evidence.json"
];
const timestampKeys = [
  "postedAt",
  "observedAt",
  "metricsCheckedAt",
  "linkCheckedAt",
  "first_seen_at",
  "last_checked_at",
  "last_updated_at"
];

let totalChanged = 0;
for (const relativePath of evidenceFiles) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(absolutePath)) continue;

  const isPublicCanonical = relativePath.endsWith("public-evidence-current.json");
  const loaded = isPublicCanonical
    ? await readPublicEvidenceArtifact(absolutePath, { rootDir: repoRoot })
    : { canonical: JSON.parse(fs.readFileSync(absolutePath, "utf8")) };
  const snapshot = loaded.canonical;
  const sourceObservedAt = snapshot.source?.fetchedAt
    ?? snapshot.source?.generatedAt
    ?? snapshot.source?.sourceHuntImportedAt;
  const sourceObservedAtMs = Date.parse(String(sourceObservedAt || ""));
  if (!Number.isFinite(sourceObservedAtMs)) {
    throw new Error(`${relativePath} has no valid source.fetchedAt timestamp.`);
  }

  let changed = 0;
  for (const item of snapshot.evidence ?? []) {
    for (const key of timestampKeys) {
      const valueMs = Date.parse(String(item[key] || ""));
      if (!Number.isFinite(valueMs) || valueMs <= sourceObservedAtMs) continue;
      item[key] = sourceObservedAt;
      changed += 1;
      totalChanged += 1;
    }
  }

  if (changed === 0) {
    console.log(JSON.stringify({ file: relativePath, changed: 0 }));
    continue;
  }

  if (isPublicCanonical) {
    await writePublicEvidenceCanonicalArtifactAtomic({
      rootDir: repoRoot,
      canonicalPath: absolutePath,
      canonical: snapshot,
      expectedCanonicalSha256: loaded.canonicalSha256,
      expectedLedgerSha256: loaded.ledgerSha256,
      expectedReviewLedgerSha256: loaded.reviewLedgerSha256
    });
  } else {
    const temporaryPath = `${absolutePath}.tmp-${process.pid}`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`);
    fs.renameSync(temporaryPath, absolutePath);
  }
  console.log(JSON.stringify({ file: relativePath, changed }));
}

console.log(JSON.stringify({ totalChanged }));
