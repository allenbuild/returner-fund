import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildAutonomousPublicNativeAuthorResolver,
  buildLegacyPublicEvidenceBatchResolver,
  loadAutonomousCatalogs,
  mergePublicEvidenceSnapshots
} from "./lib/autonomous-ingestion-plan.mjs";
import {
  PUBLIC_EVIDENCE_OPERATIONAL_KEYS,
  hydratePublicEvidenceArtifactWithLoader,
  writePublicEvidenceArtifactPairAtomic
} from "./lib/public-evidence-artifact.mjs";
import { linkedinPostIdFromUrl } from "./lib/social-native-identity.mjs";

const root = process.cwd();
const args = parseArgs(process.argv.slice(2));
const canonicalPath = resolve(root, "src/lib/social/public-evidence-current.json");
const candidatePath = resolve(root, requiredArg(args, "candidate"));
const expectedPostId = requiredArg(args, "expected-post-id");
const expectedCompanySlug = requiredArg(args, "expected-company-slug");

if (!/^\d{12,}$/.test(expectedPostId)) {
  throw new Error("--expected-post-id must be a LinkedIn activity ID.");
}

const canonicalBytes = await readFile(canonicalPath);
const canonicalHash = sha256(canonicalBytes);
const [candidateBytes, targeted, loggedIn, a16z, catalogs] = await Promise.all([
  readFile(candidatePath),
  readJson(resolve(root, "src/lib/social/targeted-evidence-current.json")),
  readJson(resolve(root, "src/lib/social/logged-in-evidence-current.json")),
  readJson(resolve(root, "src/lib/social/a16z-speedrun-006-social-evidence.json")),
  loadAutonomousCatalogs(root)
]);
const canonicalDocument = JSON.parse(canonicalBytes.toString("utf8"));
let canonicalOperationalLedgerBytes = null;
let canonicalReviewLedgerBytes = null;
const canonical = await hydratePublicEvidenceArtifactWithLoader(
  canonicalDocument,
  {
    loadLedger: async (relativePath) => {
      const bytes = await readFile(resolve(root, relativePath));
      if (canonicalDocument.reviewLedgerRef?.path === relativePath) {
        canonicalReviewLedgerBytes = bytes;
      } else {
        canonicalOperationalLedgerBytes = bytes;
      }
      return bytes;
    }
  }
);
const candidate = JSON.parse(candidateBytes.toString("utf8"));

const merged = mergePublicEvidenceSnapshots([canonical, candidate], {
  fetchedAt: candidate?.source?.fetchedAt,
  durableStorageConfigured: false,
  resolveBatchSlug: buildLegacyPublicEvidenceBatchResolver(catalogs),
  resolveNativeAuthor: buildAutonomousPublicNativeAuthorResolver(catalogs),
  contentIdentityReferenceRows: [targeted, loggedIn, a16z]
    .flatMap((snapshot) => snapshot.evidence ?? [])
});

const canonicalEvidenceIds = new Set((canonical.evidence ?? []).map(requiredRowId));
const canonicalReviewIds = new Set((canonical.needsReview ?? []).map(requiredRowId));
const mergedEvidenceIds = new Set((merged.evidence ?? []).map(requiredRowId));
const removedEvidence = (canonical.evidence ?? [])
  .filter((row) => !mergedEvidenceIds.has(row.id));
const addedEvidence = (merged.evidence ?? [])
  .filter((row) => !canonicalEvidenceIds.has(row.id));
const addedReviews = (merged.needsReview ?? [])
  .filter((row) => !canonicalReviewIds.has(row.id));

if (removedEvidence.length !== 0) {
  throw new Error(`Promotion would remove ${removedEvidence.length} canonical evidence row(s).`);
}
if (addedEvidence.length !== 1) {
  throw new Error(`Promotion must add exactly one evidence row; received ${addedEvidence.length}.`);
}
const [newRow] = addedEvidence;
if (
  newRow.companySlug !== expectedCompanySlug ||
  newRow.platform !== "linkedin" ||
  linkedinPostIdFromUrl(newRow.sourceUrl) !== expectedPostId
) {
  throw new Error("Promoted evidence did not match the expected company and LinkedIn activity.");
}
if (addedReviews.length > 1) {
  throw new Error(`Promotion may add at most one contextual review row; received ${addedReviews.length}.`);
}
for (const key of PUBLIC_EVIDENCE_OPERATIONAL_KEYS) {
  const fallback = key === "attempts" ? {} : [];
  if (JSON.stringify(merged[key] ?? fallback) !== JSON.stringify(canonical[key] ?? fallback)) {
    throw new Error(`Promotion unexpectedly changed the canonical ${key} ledger.`);
  }
}

// Use the canonical merge only as the trust/attribution gate, then append its
// newly accepted rows to the existing document. This preserves every existing
// byte-ordered ledger instead of rewriting a multi-cohort export as one batch.
const promoted = {
  ...canonical,
  source: updateCanonicalSource(canonical.source, merged.source),
  evidence: [...(canonical.evidence ?? []), newRow],
  needsReview: [...(canonical.needsReview ?? []), ...addedReviews]
};

const currentHash = sha256(await readFile(canonicalPath));
if (currentHash !== canonicalHash) {
  throw new Error("Canonical evidence changed during promotion; refusing to overwrite concurrent work.");
}

const published = await writePublicEvidenceArtifactPairAtomic({
  rootDir: root,
  canonicalPath,
  snapshot: promoted,
  expectedCanonicalSha256: canonicalHash,
  expectedLedgerSha256: canonicalOperationalLedgerBytes
    ? sha256(canonicalOperationalLedgerBytes)
    : null,
  expectedReviewLedgerSha256: canonicalReviewLedgerBytes
    ? sha256(canonicalReviewLedgerBytes)
    : null
});

console.log(JSON.stringify({
  status: "promoted",
  canonicalPath,
  candidatePath,
  expectedCompanySlug,
  expectedPostId,
  addedEvidence: addedEvidence.length,
  addedReviews: addedReviews.length,
  removedEvidence: removedEvidence.length,
  canonicalHashBefore: canonicalHash,
  canonicalHashAfter: sha256(await readFile(canonicalPath)),
  operationalLedgerHashBefore: canonicalOperationalLedgerBytes
    ? sha256(canonicalOperationalLedgerBytes)
    : null,
  operationalLedgerHashAfter: published.ledgerSha256,
  reviewLedgerHashBefore: canonicalReviewLedgerBytes
    ? sha256(canonicalReviewLedgerBytes)
    : null,
  reviewLedgerHashAfter: published.reviewLedgerSha256
}, null, 2));

function updateCanonicalSource(canonicalSource = {}, mergedSource = {}) {
  return {
    ...canonicalSource,
    fetchedAt: mergedSource.fetchedAt ?? canonicalSource.fetchedAt,
    evidenceCount: Number(canonicalSource.evidenceCount ?? 0) + 1,
    needsReviewCount: Number(canonicalSource.needsReviewCount ?? 0) + addedReviews.length
  };
}

function requiredRowId(row) {
  if (!row?.id) throw new Error("Canonical merge produced a row without an id.");
  return row.id;
}

function parseArgs(values) {
  return Object.fromEntries(values.map((value) => {
    const match = value.match(/^--([^=]+)=(.+)$/);
    if (!match) throw new Error(`Expected --name=value; received ${value}`);
    return [match[1], match[2]];
  }));
}

function requiredArg(values, name) {
  const value = String(values[name] ?? "").trim();
  if (!value) throw new Error(`Missing --${name}=...`);
  return value;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
