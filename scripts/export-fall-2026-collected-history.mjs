import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { exportFrozenNativeArticleContexts } from "./lib/fall-native-article-context-archive.mjs";

const value = (key, fallback) => process.argv.find((arg) => arg.startsWith(`${key}=`))?.slice(key.length + 1) ?? fallback;
const checkpoint = value("--checkpoint");
if (!checkpoint) throw new Error("Pass --checkpoint=<frozen-checkpoint-directory>.");
const output = value("--output", `${checkpoint}/collected-history`);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const read = async (path) => JSON.parse(await readFile(path, "utf8"));
const scoped = (row) => String(row.batchSlug ?? row.batch_slug ?? "").trim().toUpperCase() === "F26";
const receipts = [];
async function frozenJson(path, archiveName) {
  const bytes = await readFile(path);
  const archivedPath = `${output}/${archiveName}`;
  await writeFile(archivedPath, bytes);
  receipts.push({ sourcePath: path, archivedPath, sha256: sha(bytes), bytes: bytes.length });
  return JSON.parse(bytes);
}

await mkdir(output, { recursive: false });
const beforeCanonical = await readFile("src/lib/social/targeted-evidence-current.json");
const canonical = JSON.parse(beforeCanonical);
const frozenCanonical = await read(`${checkpoint}/targeted-after.json`);
if (JSON.stringify(canonical.evidence) !== JSON.stringify(frozenCanonical.evidence)) {
  throw new Error("Canonical evidence no longer matches this frozen checkpoint.");
}
const observations = [], reviewMetadata = [], runtimeSources = [];
for (const stream of ["public", "logged-in", "targeted", "volume"]) {
  const path = `generated-runtime/graph/${stream}-evidence-current.json`;
  const bytes = await readFile(path), source = JSON.parse(bytes);
  const rows = source.evidence.filter(scoped);
  const artifact = { source: source.source, evidence: rows, needsReview: (source.needsReview ?? []).filter(scoped) };
  const archivedPath = `${output}/${stream}-runtime-f26.json`;
  const encoded = `${JSON.stringify(artifact)}\n`;
  await writeFile(archivedPath, encoded);
  runtimeSources.push({ stream, sourcePath: path, sourceSha256: sha(bytes), archivedPath, sha256: sha(encoded), observations: rows.length, source: source.source });
  observations.push(...rows.map((record) => ({ stream, record })));
  reviewMetadata.push(...artifact.needsReview.map((record) => ({ stream, record })));
}
const githubSnapshot = await frozenJson("src/lib/social/github-traction-fall-2026.json", "github-repository-snapshot.json");
const ownership = await frozenJson("src/lib/social/github-repository-ownership-fall-2026.json", "github-reviewed-repository-ownership.json");
const x = await frozenJson(`${checkpoint}/x-importable.json`, "x-frozen-native-input.json");
const xUnscored = await frozenJson(`${checkpoint}/x-unscored-importable.json`, "x-unscored-frozen-native-input.json").catch((error) => {
  if (error.code === "ENOENT") return null;
  throw error;
});
const xUnscoredExtra = [];
for (const filename of (await readdir(checkpoint)).filter((name) => /^x-unscored-extra-\d+-importable\.json$/.test(name)).sort()) xUnscoredExtra.push(await frozenJson(`${checkpoint}/${filename}`, filename));
const youtubeNative = [];
for (const filename of (await readdir(checkpoint)).filter((name) => /^youtube-native-\d+-importable\.json$/.test(name)).sort()) youtubeNative.push(await frozenJson(`${checkpoint}/${filename}`, filename));
try {
  const nativeYouTubeArchives = await frozenJson(`${checkpoint}/youtube-native-source-freeze-audit.json`, "youtube-native-source-freeze-audit.json");
  for (const archive of nativeYouTubeArchives.archives) {
    const bytes = await readFile(archive.frozenPath);
    if (sha(bytes) !== archive.sha256) throw new Error("Frozen native YouTube source SHA changed.");
    const archivedPath = `${output}/youtube-native-source-${archive.sha256}`;
    await writeFile(archivedPath, bytes);
    receipts.push({ sourcePath: archive.path, frozenPath: archive.frozenPath, archivedPath, sha256: archive.sha256, bytes: bytes.length });
  }
} catch (error) { if (error.code !== "ENOENT") throw error; }
let founderPublicationArchiveDeclared = false;
try {
  const publicationArchives = await frozenJson(`${checkpoint}/founder-publication-context-source-freeze-audit.json`, "founder-publication-context-source-freeze-audit.json");
  founderPublicationArchiveDeclared = true;
  await frozenJson(`${checkpoint}/founder-publication-context-input.json`, "founder-publication-context-input.json");
  await frozenJson(`${checkpoint}/founder-publication-context-cas-audit.json`, "founder-publication-context-cas-audit.json");
  for (const archive of publicationArchives.archives) {
    const bytes = await readFile(archive.frozenPath);
    if (sha(bytes) !== archive.sha256) throw new Error("Frozen founder publication source SHA changed.");
    const archivedPath = `${output}/founder-publication-source-${archive.sha256}`;
    await writeFile(archivedPath, bytes);
    receipts.push({ sourcePath: archive.path, frozenPath: archive.frozenPath, archivedPath, sha256: archive.sha256, bytes: bytes.length });
  }
} catch (error) { if (founderPublicationArchiveDeclared || error.code !== "ENOENT") throw error; }
const linkedin = await frozenJson(`${checkpoint}/linkedin-importable.json`, "linkedin-frozen-native-input.json");
const linkedinFounder = await frozenJson(`${checkpoint}/linkedin-founder-importable.json`, "linkedin-founder-frozen-native-input.json").catch((error) => { if (error.code === "ENOENT") return null; throw error; });
const linkedinCompanyDetail = await frozenJson(`${checkpoint}/linkedin-company-detail-importable.json`, "linkedin-company-detail-frozen-native-input.json").catch((error) => { if (error.code === "ENOENT") return null; throw error; });
await frozenJson(`${checkpoint}/linkedin-company-detail-native-checkpoint.json`, "linkedin-company-detail-native-checkpoint.json").catch((error) => { if (error.code !== "ENOENT") throw error; });
for (const filename of (await readdir(checkpoint)).filter((name) => /^linkedin-founder-(?:source-history|native-checkpoint|native-original)-\d+\.json$/.test(name) || name === "linkedin-founder-source-freeze-audit.json").sort()) await frozenJson(`${checkpoint}/${filename}`, filename);
try {
  const aliasRegistry = await frozenJson(`${checkpoint}/linkedin-founder-alias-proofs.json`, "linkedin-founder-alias-proofs.json");
  for (const proof of aliasRegistry.proofs ?? []) for (const archive of proof.archives ?? []) {
    const path = `${checkpoint}/linkedin-founder-alias-source-archives/${archive.sha256}`, bytes = await readFile(path);
    if (sha(bytes) !== archive.sha256) throw new Error("Frozen founder alias identity source SHA changed.");
    const archivedPath = `${output}/linkedin-founder-alias-source-${archive.sha256}`;
    await writeFile(archivedPath, bytes);
    receipts.push({ sourcePath: archive.path, frozenPath: path, archivedPath, sha256: archive.sha256, bytes: bytes.length });
  }
} catch (error) { if (error.code !== "ENOENT") throw error; }
const instagram = await frozenJson(`${checkpoint}/instagram-importable.json`, "instagram-frozen-native-input.json");
await frozenJson(`${checkpoint}/instagram-identity-proofs.json`, "instagram-verified-identity-proofs.json");
try {
  const identityArchives = await frozenJson(`${checkpoint}/instagram-founder-identity-source-freeze-audit.json`, "instagram-founder-identity-source-freeze-audit.json");
  for (const archive of identityArchives.archives ?? []) {
    const bytes = await readFile(archive.frozenPath);
    if (sha(bytes) !== archive.sha256) throw new Error("Frozen Instagram founder identity source SHA changed.");
    const archivedPath = `${output}/instagram-founder-identity-source-${archive.sha256}${archive.frozenPath.endsWith(".html") ? ".html" : ".json"}`;
    await writeFile(archivedPath, bytes);
    receipts.push({ sourcePath: archive.sourcePath, frozenPath: archive.frozenPath, archivedPath, sha256: archive.sha256, bytes: bytes.length });
  }
} catch (error) { if (error.code !== "ENOENT") throw error; }
const igNative = await frozenJson(`${checkpoint}/instagram-native-checkpoint.json`, "instagram-frozen-native-checkpoint.json");
const igDialog = await frozenJson(`${checkpoint}/instagram-dialog-native-checkpoint.json`, "instagram-frozen-native-dialog.json");
const igAlyDialog = await frozenJson(`${checkpoint}/instagram-aly-dialog-native-checkpoint.json`, "instagram-aly-frozen-native-dialog.json").catch((error) => {
  if (error.code === "ENOENT") return null;
  throw error;
});
const otherPlatformNative = await frozenJson(`${checkpoint}/other-platform-native-checkpoint.json`, "other-platform-frozen-native-checkpoint.json").catch((error) => {
  if (error.code === "ENOENT") return null;
  throw error;
});
const tiktok = await frozenJson(`${checkpoint}/tiktok-importable.json`, "tiktok-frozen-native-input.json").catch((error) => {
  if (error.code === "ENOENT") return null;
  throw error;
});
const facebookNative = await frozenJson(`${checkpoint}/facebook-native-checkpoint.json`, "facebook-frozen-native-checkpoint.json").catch((error) => {
  if (error.code === "ENOENT") return null;
  throw error;
});
const facebook = await frozenJson(`${checkpoint}/facebook-importable.json`, "facebook-frozen-native-input.json").catch((error) => {
  if (error.code === "ENOENT") return null;
  throw error;
});
const threadsNative = await frozenJson(`${checkpoint}/threads-native-checkpoint.json`, "threads-frozen-native-checkpoint.json").catch((error) => { if (error.code === "ENOENT") return null; throw error; });
const threads = await frozenJson(`${checkpoint}/threads-importable.json`, "threads-frozen-native-input.json").catch((error) => { if (error.code === "ENOENT") return null; throw error; });
const instagramExtraDialogs = [];
try {
  const parts = await frozenJson(`${checkpoint}/instagram-native-part-source-freeze-audit.json`, "instagram-native-part-source-freeze-audit.json");
  for (const archive of parts.archives) {
    const bytes = await readFile(archive.frozenPath);
    if (sha(bytes) !== archive.sha256) throw new Error("Frozen native Instagram part archive SHA changed.");
    await frozenJson(archive.frozenPath, `instagram-native-part-source-${archive.sha256}.json`);
  }
} catch (error) { if (error.code !== "ENOENT") throw error; }
for (const filename of (await readdir(checkpoint)).filter((name) => /^instagram-extra-dialog-native-checkpoint-\d+\.json$/.test(name)).sort()) {
  instagramExtraDialogs.push(await frozenJson(`${checkpoint}/${filename}`, filename));
}
for (const [kind, native] of [["other-platform", otherPlatformNative], ["facebook", facebookNative]]) {
  for (const [index, source] of (native?.source?.frozenSources ?? []).entries()) {
    if (sha(await readFile(source.path)) !== source.sha256) throw new Error(`Frozen ${kind} delta parent/source hash changed.`);
    await frozenJson(source.path, `${kind}-source-${index}.json`);
  }
}
const frozenCoverage = {};
for (const filename of new Set([
  "x-account-history-resume-ledger.json", "x-native-search-coverage.json", "x-native-search-ledger.json", "linkedin-founder-jay-history-coverage.json", "linkedin-founder-kevin-history-coverage.json",
  "full-history-coverage-ledger.json", "instagram-company-posts-reels-coverage-queue.json", "youtube-rhem-history-coverage.json", "youtube-aucert-history-coverage.json", "youtube-native-dom-full-visible-audit.json", "x-edit-version-audit.json",
  "youtube-native-history-coverage.json", "youtube-native-available-35-audit.json", "youtube-native-record-selections.json", "native-version-and-unknown-date-retention.json", "founder-publication-context-retention.json",
  "native-youtube-runtime-retention.json", "unknown-publication-display-audit.json",
  "founder-derived-person-url-provenance-audit.json", "historical-founder-url-provenance-scope.json", "native-article-provenance-correction-audit.json",
  "native-article-provenance-reconciliation.json",
  "instagram-caption-absence-decisions.json",
  ...(await readdir(checkpoint)).filter((name) => /^instagram-[a-z0-9-]+-history-(?:coverage|inventory|inventory-complete)\.json$/.test(name))
])) {
  try { frozenCoverage[filename] = await frozenJson(`${checkpoint}/${filename}`, filename); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
for (const [filename, archivedName] of [
  ["native-article-provenance-before/live-ledger-before.json", "historical-native-article-ledger-before-source-correction.json"],
  ["native-article-provenance-before/native-article-context-source-freeze-audit.json", "historical-native-article-freeze-before-source-correction.json"]
]) {
  try { await frozenJson(`${checkpoint}/${filename}`, archivedName); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
for (const [path, name] of [
  ["outputs/source-hunt/2026-11-15-fall-2026-github-release-coverage.json", "github-release-coverage.json"],
  ["outputs/source-hunt/2026-11-15-fall-2026-public-history-coverage.json", "official-website-coverage.json"],
  ["outputs/source-hunt/2026-11-15-fall-2026-public-history-semantic-audit.json", "official-website-semantic-review.json"],
  ["outputs/source-hunt/2026-11-15-fall-2026-web-coverage.json", "yc-launch-youtube-coverage.json"]
]) await frozenJson(path, name);

const result = {
  source: { kind: "fall_2026_collected_history_v1", batchSlug: "F26", checkpoint, exportedAt: new Date().toISOString(), canonicalSha256: sha(beforeCanonical), fullHistoryComplete: false },
  summary: {
    runtimeObservations: observations.length,
    canonicalFallRows: canonical.evidence.filter(scoped).length,
    nativeYouTubePosts: canonical.evidence.filter((row) => scoped(row) && row.platform === "youtube").length,
    nativeYouTubeUnscoredPosts: canonical.evidence.filter((row) => scoped(row) && row.platform === "youtube" && row.tractionStatus === "unscored").length,
    founderPublicationContexts: canonical.evidence.filter((row) => scoped(row) && row.attributionProvenance === "native_owned_robin_founder_publication_context_v1").length,
    repositorySnapshotAccounts: githubSnapshot.accounts.filter((account) => account.fetched).length,
    repositorySnapshotRepositories: githubSnapshot.accounts.reduce((count, account) => count + (account.repos?.length ?? 0), 0),
    exactReviewedRepositoryOwnershipProofs: ownership.proofs.length,
    reviewMetadata: reviewMetadata.length,
    nativeInputReviewRows: (x.candidates?.length ?? 0) + (linkedin.needsReview?.length ?? 0) + (linkedinFounder?.needsReview?.length ?? 0) + (linkedinCompanyDetail?.needsReview?.length ?? 0) + (instagram.needsReview?.length ?? 0) + (tiktok?.needsReview?.length ?? 0) + (facebook?.needsReview?.length ?? 0) + (threads?.needsReview?.length ?? 0)
  },
  coverage: {
    note: "Collected observations at this frozen checkpoint; unfinished account histories, candidates and unknown dates remain explicit. This archive does not claim complete batch history.",
    x: { source: x.source, summary: x.summary, candidates: x.candidates, unscoredNativeInput: xUnscored?.source, additionalUnscoredNativeInputs: xUnscoredExtra.map((entry) => entry.source) },
    youtube: { nativeDomInputs: youtubeNative.map((entry) => ({ source: entry.source, needsReview: entry.needsReview })), fullHistoryComplete: false },
    linkedin: { source: linkedin.source, profileOutcomes: linkedin.profileOutcomes, unvisitedCompanyProfiles: linkedin.unvisitedCompanyProfiles, needsReview: linkedin.needsReview, nativeFounderHistory: linkedinFounder?.source, founderNeedsReview: linkedinFounder?.needsReview, nativeCompanyDetails: linkedinCompanyDetail?.source, companyDetailNeedsReview: linkedinCompanyDetail?.needsReview },
    instagram: { source: instagram.source, needsReview: instagram.needsReview, verifiedProfiles: igNative.verifiedProfiles, founderProofs: igNative.founderProofs, gridHistorySnapshots: igNative.gridHistorySnapshots, dialogListing: igDialog.listing, alyDialogListing: igAlyDialog?.listing, extraDialogListings: instagramExtraDialogs.map((entry) => ({ source: entry.source, listing: entry.listing })) },
    tiktok: { source: tiktok?.source, needsReview: tiktok?.needsReview, profiles: otherPlatformNative?.profiles?.filter((entry) => entry.platform === "tiktok") },
    facebook: { source: facebook?.source, needsReview: facebook?.needsReview, profiles: facebookNative?.profiles, nativePosts: facebookNative?.nativePosts },
    threads: { source: threads?.source, needsReview: threads?.needsReview, coverage: threadsNative?.coverage, nativePosts: threadsNative?.nativePosts },
    otherNativePlatformArchive: {
      status: "native_observations_archived_not_promoted_to_supported_platform_evidence",
      source: otherPlatformNative?.source,
      profiles: otherPlatformNative?.profiles?.filter((entry) => entry.platform !== "tiktok"),
      nativePosts: otherPlatformNative?.nativePosts?.filter((entry) => entry.platform !== "tiktok")
    },
    frozenCoverage
  },
  runtimeSources, frozenInputs: receipts,
  observations, reviewMetadata,
  githubRepositorySnapshot: githubSnapshot,
  verifiedRepositoryOwnership: ownership
};
const nativeArticleBodies = await exportFrozenNativeArticleContexts({ checkpoint, output });
if (nativeArticleBodies) {
  result.nativeArticleBodyContexts = nativeArticleBodies.ledger.contexts;
  result.summary.separateNativeArticleBodyContexts = nativeArticleBodies.ledger.contexts.length;
  result.summary.separateNativeArticleBodyCharacters = nativeArticleBodies.ledger.contexts.reduce((sum, row) => sum + row.text.length, 0);
  result.coverage.x.nativeArticleBodies = { path: nativeArticleBodies.path, sha256: nativeArticleBodies.sha256, countsAsNativePosts: false, archives: nativeArticleBodies.archives };
}
if (sha(await readFile("src/lib/social/targeted-evidence-current.json")) !== sha(beforeCanonical)) throw new Error("Canonical changed while collected history was exported.");
const target = `${output}/collected-history.json`;
await writeFile(target, `${JSON.stringify(result)}\n`);
await writeFile(`${output}/manifest.json`, `${JSON.stringify({ ...result.source, summary: result.summary, runtimeSources, frozenInputs: receipts, collectedHistory: { path: target, sha256: sha(await readFile(target)) } }, null, 2)}\n`);
console.log(JSON.stringify({ status: "exported", path: resolve(target), ...result.summary, fullHistoryComplete: false }));
