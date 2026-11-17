import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createNativeGithubReleaseContextVerifier, githubReleaseSha256 as sha, githubReleaseNativeFields,
  nativeGithubReleaseContextReasons, nativeGithubReleaseOwnerNeedsReview, nativeGithubReleaseReceipt,
  NATIVE_GITHUB_RELEASE_SOURCE, NATIVE_GITHUB_RELEASE_VALIDATION, NATIVE_GITHUB_REVIEWED_REPOSITORIES,
  isVerifiedNativeGithubRepositoryOwnershipProof
} from "../src/lib/graph/github-release-context-receipt.mjs";

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const nativeKey = (row) => `${row.batchSlug}:${row.entityId}:github-release:${row.nativeReleaseId ?? row.platformPostId}`;

/** Rehash existing public YC receipts and authorize only the three independently reviewed repositories. */
export async function loadVerifiedNativeGithubRepositoryOwnershipProofs({ rootDir = process.cwd(), proofAuditPath = "outputs/source-hunt/2026-11-15-fall-2026-github-review-owner-proof-audit.json", expectedProofAuditSha256 } = {}) {
  const root = await realpath(resolve(rootDir)), auditAbsolute = resolve(root, proofAuditPath);
  let auditBytes;
  try { auditBytes = await readFile(auditAbsolute); } catch (error) { if (error.code === "ENOENT" && !expectedProofAuditSha256) return new Map(); throw error; }
  const proofAuditSha256 = sha(auditBytes);
  if (expectedProofAuditSha256 && expectedProofAuditSha256 !== proofAuditSha256) throw new Error("repository_ownership_audit_hash_conflict");
  const audit = JSON.parse(auditBytes.toString("utf8")), sourceRef = audit.source?.archives?.ycLaunchArchive;
  if (sourceRef?.path !== "outputs/source-hunt/2026-11-15-fall-2026-web-context.json") throw new Error("invalid_yc_launch_ownership_source_archive");
  const sourceBytes = await readFile(resolve(root, sourceRef.path));
  if (sha(sourceBytes) !== sourceRef.sha256) throw new Error("yc_launch_ownership_source_archive_hash_conflict");
  const source = JSON.parse(sourceBytes.toString("utf8")), proofs = new Map();
  for (const candidate of audit.proofs ?? []) {
    const key = String(candidate.repositoryFullName ?? "").toLowerCase(), reviewed = NATIVE_GITHUB_REVIEWED_REPOSITORIES[key];
    if (!reviewed || candidate.companySlug !== reviewed.companySlug || candidate.entityId !== `company-${reviewed.companySlug}`) throw new Error("unreviewed_repository_ownership_tuple");
    const company = source.companies?.find((entry) => entry.companySlug === reviewed.companySlug);
    if (!company || company.companyName !== candidate.companyName || company.sourceUrl !== `https://www.ycombinator.com/companies/${reviewed.companySlug}`) throw new Error("yc_launch_ownership_company_conflict");
    const launchProofs = candidate.ycLaunchProofs?.filter((entry) => entry.nativeLaunchId === reviewed.nativeLaunchId);
    if (launchProofs?.length !== 1) throw new Error("missing_unique_reviewed_yc_launch_ownership_proof");
    const receipt = launchProofs[0], launches = company.launches?.filter((entry) => entry.id === reviewed.nativeLaunchId);
    if (launches?.length !== 1) throw new Error("reviewed_yc_launch_not_unique_in_archive");
    const launch = launches[0], repoUrl = candidate.repositoryUrl;
    if (receipt.nativeLaunchUrl !== launch.url || receipt.authorName !== launch.authorName || receipt.postedAt !== launch.created_at || receipt.nativeState !== launch.state || receipt.nativeFullBodySha256 !== sha(launch.body) || receipt.companyPageUrl !== company.sourceUrl || receipt.sourceHtmlSha256 !== company.sourceHtmlSha256 || receipt.observedAt !== company.observedAt || !receipt.exactRepositoryLinks?.some((link) => link.toLowerCase() === repoUrl?.toLowerCase()) || !launch.outboundLinks?.some((link) => link.toLowerCase() === repoUrl?.toLowerCase())) throw new Error("reviewed_yc_launch_native_fields_conflict");
    const paragraphs = launch.body.split("\n\n"), repositoryLinkParagraphs = receipt.ownershipParagraphs;
    if (!Array.isArray(repositoryLinkParagraphs) || !repositoryLinkParagraphs.length || repositoryLinkParagraphs.some((paragraph) => !paragraphs.includes(paragraph) || !paragraph.toLowerCase().includes(repoUrl.toLowerCase()))) throw new Error("reviewed_yc_repository_link_paragraph_conflict");
    const ownershipClaimParagraphs = paragraphs.filter((paragraph) => reviewed.ownershipClaims.some((claim) => paragraph.toLowerCase().includes(claim.toLowerCase())));
    if (reviewed.ownershipClaims.some((claim) => !ownershipClaimParagraphs.some((paragraph) => paragraph.toLowerCase().includes(claim.toLowerCase())))) throw new Error("reviewed_yc_repository_ownership_claim_missing");
    const content = {
      source: "official_yc_launch_repository_ownership_v1", companySlug: company.companySlug, companyName: company.companyName,
      entityId: candidate.entityId, repositoryFullName: candidate.repositoryFullName, repositoryUrl: repoUrl, officialYcCompanyUrl: company.sourceUrl,
      nativeLaunch: { id: launch.id, url: launch.url, state: launch.state, postedAt: launch.created_at, authorName: launch.authorName, body: launch.body, bodySha256: sha(launch.body), repositoryLinkParagraphs, ownershipClaimParagraphs },
      observedAt: company.observedAt, sourceArchivePath: sourceRef.path, sourceArchiveSha256: sourceRef.sha256, proofAuditPath, proofAuditSha256
    };
    const proof = { ...content, validation: { source: "fall_2026_yc_launch_repository_ownership_ingestion_v1", archiveHashesVerified: true, nativeLaunchFieldsVerified: true, sourceArchiveSha256: sourceRef.sha256, proofAuditSha256, proofContentSha256: sha(JSON.stringify(content)) } };
    if (!isVerifiedNativeGithubRepositoryOwnershipProof(proof)) throw new Error("portable_repository_ownership_proof_self_check_failed");
    if (proofs.has(key)) throw new Error("duplicate_reviewed_repository_ownership_proof");
    proofs.set(key, proof);
  }
  return proofs;
}

/** Public source archive -> verified, unscored release context. No network or credential access. */
export async function ingestFallGithubReleaseContext(options) {
  const root = await realpath(resolve(options.root ?? process.cwd()));
  const path = (value) => resolve(root, value);
  if (!["dry-run", "write"].includes(options.mode)) throw new Error("Pass exactly one of --write or --dry-run.");
  if (options.mode === "write" && !/^[a-f0-9]{64}$/.test(options.expectedTargetSha256 ?? "")) throw new Error("Write requires --expected-target-sha256 for compare-and-swap.");
  const inputPath = options.input ?? "outputs/source-hunt/2026-11-15-fall-2026-github-release-context.json";
  const targetPath = options.target ?? "src/lib/social/targeted-evidence-current.json";
  const snapshotPath = options.snapshot ?? "src/lib/social/github-traction-fall-2026.json";
  const catalogPath = options.catalog ?? "src/lib/yc/fall-2026-companies.json";
  const outputPath = options.output ?? `outputs/fall-2026/collection/github-release-context-${Date.now()}`;
  const [inputText, beforeText, snapshotText, catalogText] = await Promise.all([inputPath, targetPath, snapshotPath, catalogPath].map((p) => readFile(path(p), "utf8")));
  if (options.expectedTargetSha256 && sha(beforeText) !== options.expectedTargetSha256) throw new Error("target_compare_and_swap_hash_conflict");
  if (options.expectedInputSha256 && sha(inputText) !== options.expectedInputSha256) throw new Error("input_frozen_hash_conflict");
  const input = JSON.parse(inputText), before = JSON.parse(beforeText), snapshot = JSON.parse(snapshotText), catalog = JSON.parse(catalogText);
  if (!Array.isArray(input.context) || !Array.isArray(before.evidence) || !Array.isArray(catalog.companies)) throw new Error("invalid_release_ingestion_envelope");
  await mkdir(path(outputPath), { recursive: false });
  await writeFile(path(`${outputPath}/source-context-frozen.json`), inputText);
  const companies = new Map(catalog.companies.map((company) => [company.slug, company]));
  const snapshotSha256 = sha(snapshotText), snapshotContentSha256 = sha(JSON.stringify(snapshot));
  const verifyRelease = createNativeGithubReleaseContextVerifier(snapshot);
  const ownershipProofs = await loadVerifiedNativeGithubRepositoryOwnershipProofs({ rootDir: root, proofAuditPath: options.ownershipProofs, expectedProofAuditSha256: options.expectedOwnershipProofsSha256 });
  const archives = new Map(), accepted = [], held = [], rejected = [], duplicates = [];
  const existing = new Map(before.evidence.filter((row) => row.platform === "github" && (row.contentKind === "github_release_post" || row.attributionProvenance === NATIVE_GITHUB_RELEASE_SOURCE)).map((row) => [nativeKey(row), row]));
  const cacheRoots = ["outputs/fall-2026/github-release-cache", "outputs/fall-2026/public-history-cache"].map(path);
  async function verifiedNativePage(row) {
    const absolute = await realpath(path(row.nativeCollectionArchivePath));
    if (!cacheRoots.some((cache) => absolute.startsWith(`${cache}${sep}`))) throw new Error("native_release_archive_outside_allowed_cache");
    if (!archives.has(absolute)) {
      const bytes = await readFile(absolute), envelope = JSON.parse(bytes.toString("utf8"));
      if (typeof envelope.responseContent !== "string" || !Array.isArray(envelope.nativeResponse) || !equal(JSON.parse(envelope.responseContent), envelope.nativeResponse)) throw new Error("native_release_json_response_conflict");
      archives.set(absolute, { sha256: sha(bytes), envelope });
    }
    const archive = archives.get(absolute), envelope = archive.envelope;
    if (archive.sha256 !== row.nativeCollectionArchiveSha256) throw new Error("native_release_archive_hash_conflict");
    if (envelope.requestUrl !== row.nativeCollectionRequestUrl || envelope.observedAt !== row.observedAt || (envelope.repository !== undefined && envelope.repository.toLowerCase() !== row.repositoryFullName.toLowerCase())) throw new Error("native_release_collection_receipt_conflict");
    const matches = envelope.nativeResponse.filter((entry) => String(entry.id) === row.platformPostId);
    if (matches.length !== 1) throw new Error("native_release_id_not_uniquely_present_in_response");
    const native = matches[0], fields = githubReleaseNativeFields(row);
    const expected = Object.fromEntries(Object.keys(fields).map((key) => [key, native[key]]));
    if (!equal(fields, expected)) throw new Error("native_release_api_fields_conflict");
    if (native.draft !== false) throw new Error("native_release_draft_not_published");
  }
  for (const originalRow of input.context) {
    const proof = ownershipProofs.get(String(originalRow.repositoryFullName ?? "").toLowerCase());
    const proofMatches = proof && proof.companySlug === originalRow.companySlug && proof.companyName === originalRow.companyName && proof.entityId === originalRow.entityId && proof.repositoryUrl.toLowerCase() === originalRow.repositoryUrl?.toLowerCase();
    const row = proofMatches ? { ...originalRow, officialRepositoryOwnershipProof: proof, rawVisibleText: JSON.stringify({ ...nativeGithubReleaseReceipt(originalRow), officialRepositoryOwnershipProof: proof }) } : originalRow;
    const reasons = nativeGithubReleaseContextReasons(row, snapshot), company = companies.get(row.companySlug);
    if (!company || row.companyName !== company.name || row.entityId !== `company-${company.slug}` || row.entityType !== "company" || row.batchSlug !== "F26") reasons.push("unknown_or_conflicting_fall_company");
    if (row.officialRepositoryLineage?.snapshotPath !== snapshotPath || row.officialRepositoryLineage?.snapshotSha256 !== snapshotSha256) reasons.push("upstream_snapshot_file_hash_or_path_conflict");
    if (!reasons.length) {
      try { await verifiedNativePage(row); } catch (error) { reasons.push(error.code === "ENOENT" ? "native_release_archive_missing" : error.message); }
    }
    if (reasons.length) { rejected.push({ sourceUrl: row.sourceUrl, platformPostId: row.platformPostId, companySlug: row.companySlug, reasons: [...new Set(reasons)] }); continue; }
    if (!proofMatches && (nativeGithubReleaseOwnerNeedsReview(row) || row.review_state === "needs_review" || row.attributionStatus === "needs_review")) {
      held.push({ ...row, review_state: "needs_review", attributionStatus: "needs_review", holdReason: "existing_official_repository_owner_attribution_requires_review" }); continue;
    }
    const key = nativeKey(row), prior = existing.get(key);
    if (prior) {
      if (!equal(githubReleaseNativeFields(prior), githubReleaseNativeFields(row)) || prior.originalText !== row.text || !verifyRelease(prior)) rejected.push({ sourceUrl: row.sourceUrl, platformPostId: row.platformPostId, companySlug: row.companySlug, reasons: ["existing_immutable_release_context_conflict"] });
      else duplicates.push({ sourceUrl: row.sourceUrl, platformPostId: row.platformPostId, existingId: prior.id });
      continue;
    }
    const raw = nativeGithubReleaseReceipt(row), checkedAt = new Date(row.observedAt).toISOString();
    const evidence = {
      ...row, id: `github-f26-release-${sha(key).slice(0, 24)}`, nativeTitle: row.title,
      ...(typeof row.title === "string" ? { title: row.title } : { title: undefined }),
      text: row.text, originalText: row.text, captionAbsent: row.text.length === 0,
      authorHandle: row.nativeAuthor.login, metrics: {}, contributionScore: 0, tractionStatus: "unscored",
      tractionLimitations: ["Native repository release context only; repository stars and forks are not release engagement."],
      publishedAtPrecision: "exact", mediaType: "text", accountUrl: row.repositoryUrl,
      review_state: "verified", attributionVersion: 3, attributionStatus: "verified", attributionMode: "publisher",
      attributionProvenance: NATIVE_GITHUB_RELEASE_SOURCE,
      attributionSignals: ["official_repository_snapshot_owner_verified", "native_release_json_sha256_verified"],
      rawVisibleText: JSON.stringify({ ...raw, validation: {
        source: NATIVE_GITHUB_RELEASE_VALIDATION, archiveHashesVerified: true, nativeResponseFieldsVerified: true,
        nativeCollectionArchiveSha256: row.nativeCollectionArchiveSha256, upstreamSnapshotSha256: snapshotSha256,
        upstreamSnapshotContentSha256: snapshotContentSha256, originalBodySha256: sha(row.text), nativeFieldsSha256: sha(JSON.stringify(githubReleaseNativeFields(row))),
        ...(proofMatches ? { ownershipProofVerified: true, ownershipProofSha256: sha(JSON.stringify(proof)) } : {})
      } }),
      linkStatus: "verified", linkCheckedAt: checkedAt, first_seen_at: checkedAt, last_checked_at: checkedAt, last_updated_at: row.postedAt,
      why: "Exact published GitHub release preserved from native API JSON, under the snapshot-linked repository owner. No traction score.",
      matchReason: "Explicit Fall 2026 company and exact official repository snapshot lineage; immutable release ID, native publication clock and original body verified against hashed on-disk API response. Native author remains separate from repository publisher."
    };
    delete evidence.platformObjectId;
    if (!verifyRelease(evidence)) throw new Error(`runtime_release_receipt_self_check_failed:${row.platformPostId}`);
    accepted.push(evidence); existing.set(key, evidence);
  }
  const beforeOlder = JSON.stringify(before.evidence.filter((row) => row.batchSlug !== "F26"));
  const latestObservation = Math.max(Date.parse(before.source?.fetchedAt ?? "") || 0, ...accepted.map((row) => Date.parse(row.observedAt)));
  const next = { ...before, source: { ...before.source, ...(latestObservation ? { fetchedAt: new Date(latestObservation).toISOString() } : {}), evidenceCount: before.evidence.length + accepted.length }, evidence: [...before.evidence, ...accepted] };
  if (JSON.stringify(next.evidence.filter((row) => row.batchSlug !== "F26")) !== beforeOlder) throw new Error("earlier_cohort_rows_changed");
  const audit = { status: rejected.length ? "rejected" : options.mode === "write" ? "written" : "dry_run", source: inputPath, sourceSha256: sha(inputText),
    upstreamSnapshotSha256: snapshotSha256, upstreamSnapshotContentSha256: snapshotContentSha256,
    before: before.evidence.length, received: input.context.length, accepted: accepted.length, held: held.length, duplicates: duplicates.length, rejected: rejected.length,
    after: next.evidence.length, archiveFilesVerified: archives.size, metadataOnlyAccepted: accepted.filter((row) => row.captionAbsent).length,
    exactRepositoryOwnershipProofsLoaded: ownershipProofs.size, acceptedWithRepositoryOwnershipProof: accepted.filter((row) => row.officialRepositoryOwnershipProof).length,
    beforeTargetSha256: sha(beforeText), earlierCohortRowsSha256: sha(beforeOlder), canonicalWritten: false,
    rejectedRows: rejected, duplicateRows: duplicates };
  await writeFile(path(`${outputPath}/accepted-context.json`), `${JSON.stringify({ source: input.source, context: accepted }, null, 2)}\n`);
  await writeFile(path(`${outputPath}/held-context.json`), `${JSON.stringify({ context: held }, null, 2)}\n`);
  if (options.mode === "write" && !rejected.length) {
    if (sha(await readFile(path(targetPath))) !== options.expectedTargetSha256 || await readFile(path(targetPath), "utf8") !== beforeText) throw new Error("target_compare_and_swap_changed_during_release_preflight");
    const temporary = `${path(targetPath)}.github-release-${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`); await rename(temporary, path(targetPath));
    audit.canonicalWritten = true;
    await writeFile(path(`${outputPath}/targeted-after.json`), `${JSON.stringify(next, null, 2)}\n`);
  }
  await writeFile(path(`${outputPath}/audit.json`), `${JSON.stringify(audit, null, 2)}\n`);
  return audit;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), arg = (name) => args.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
  if (args.includes("--write") === args.includes("--dry-run")) throw new Error("Pass exactly one of --write or --dry-run.");
  const audit = await ingestFallGithubReleaseContext({ mode: args.includes("--write") ? "write" : "dry-run", input: arg("--input"), target: arg("--target"), output: arg("--output"), snapshot: arg("--snapshot"), catalog: arg("--catalog"), expectedTargetSha256: arg("--expected-target-sha256"), expectedInputSha256: arg("--expected-input-sha256"), ownershipProofs: arg("--ownership-proofs"), expectedOwnershipProofsSha256: arg("--expected-ownership-proofs-sha256") });
  console.log(JSON.stringify({ ...audit, rejectedRows: audit.rejectedRows.slice(0, 10), duplicateRows: undefined }));
  if (audit.rejected) process.exitCode = 1;
}
