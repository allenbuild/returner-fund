import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ingestFallGithubReleaseContext, loadVerifiedNativeGithubRepositoryOwnershipProofs } from "../scripts/ingest-fall-2026-github-release-context.mjs";
import { createNativeGithubReleaseContextVerifier, githubReleaseSha256 as sha, isVerifiedNativeGithubReleaseContext, isVerifiedNativeGithubRepositoryOwnershipProof, nativeGithubReleaseContextReasons } from "../src/lib/graph/github-release-context-receipt.mjs";

test("release ingestion validates native bytes, preserves original author and older cohorts, and replays by immutable ID", async (t) => {
  const f = await fixture(t), before = await readFile(f.target, "utf8");
  const dry = await run(f, "dry-run", "preview");
  assert.deepEqual([dry.accepted, dry.held, dry.rejected], [1, 0, 0], JSON.stringify(dry.rejectedRows));
  assert.equal(await readFile(f.target, "utf8"), before);
  const row = (await json(join(f.directory, "preview/accepted-context.json"))).context[0];
  assert.equal(row.originalText, f.native.body);
  assert.equal(row.nativeReleaseId, 12345);
  assert.equal(row.platformPostId, "12345");
  assert.equal(Object.hasOwn(row, "platformObjectId"), false);
  assert.equal(row.authorName, "release-maintainer");
  assert.equal(row.authorHandle, "release-maintainer");
  assert.equal(row.postedAt, f.native.published_at);
  assert.equal(row.tractionStatus, "unscored");
  assert.equal(row.contributionScore, 0);
  assert.deepEqual(row.metrics, {});
  assert.equal(isVerifiedNativeGithubReleaseContext(row, f.snapshot), true);
  const written = await run(f, "write", "written", { expectedTargetSha256: sha(before) });
  assert.equal(written.canonicalWritten, true);
  const after = await json(f.target);
  assert.equal(JSON.stringify(after.evidence[0]), JSON.stringify(f.older));
  assert.equal(after.source.fetchedAt, "2026-11-15T23:00:00.000Z");
  const replay = await run(f, "dry-run", "replay");
  assert.deepEqual([replay.accepted, replay.duplicates, replay.rejected], [0, 1, 0]);
});

test("native null and empty release bodies stay metadata-only without invented text", async (t) => {
  for (const body of [null, ""]) {
    const f = await fixture(t, { body });
    const audit = await run(f, "dry-run", "empty");
    assert.equal(audit.accepted, 1);
    const row = (await json(join(f.directory, "empty/accepted-context.json"))).context[0];
    assert.equal(row.text, ""); assert.equal(row.originalText, ""); assert.equal(row.captionAbsent, true);
    assert.equal(row.nativeBody, body); assert.equal(row.nativeTitle, null);
    assert.equal(isVerifiedNativeGithubReleaseContext(row, f.snapshot), true);
  }
});

test("forged body and native author remain rejected even when rendered receipt is edited to agree", async (t) => {
  for (const change of [
    (r) => { r.text = "Invented release instructions"; r.nativeBody = r.text; },
    (r) => { r.nativeAuthor.login = "different-author"; r.authorName = "different-author"; }
  ]) {
    const f = await fixture(t), row = structuredClone(f.row);
    change(row); rebuildRaw(row); await f.save(row);
    const audit = await run(f, "dry-run", "forged");
    assert.equal(audit.accepted, 0); assert.equal(audit.rejected, 1);
    assert.ok(audit.rejectedRows[0].reasons.includes("native_release_api_fields_conflict"));
  }
});

test("changed native archive and upstream snapshot byte hashes fail closed", async (t) => {
  const f = await fixture(t), before = await readFile(f.target, "utf8");
  await writeFile(f.archive, (await readFile(f.archive, "utf8")) + "\n");
  const hash = await run(f, "write", "hash", { expectedTargetSha256: sha(before) });
  assert.equal(hash.rejected, 1); assert.equal(hash.canonicalWritten, false);
  assert.ok(hash.rejectedRows[0].reasons.includes("native_release_archive_hash_conflict"));
  assert.equal(await readFile(f.target, "utf8"), before);
  const other = await fixture(t);
  await writeFile(other.snapshotFile, (await readFile(other.snapshotFile, "utf8")) + "\n");
  const snapshot = await run(other, "dry-run", "snapshot");
  assert.ok(snapshot.rejectedRows[0].reasons.includes("upstream_snapshot_file_hash_or_path_conflict"));
});

test("release owner, draft, future clock, repository metrics and immutable object namespace are strict", async (t) => {
  const f = await fixture(t);
  for (const mutation of [
    { companySlug: "other", entityId: "company-other", companyName: "Other" },
    { entityId: "company-other" }, { batchSlug: "S26" }, { nativeDraft: true },
    { postedAt: "2027-01-01T00:00:00Z", nativePublishedAtLiteral: "2027-01-01T00:00:00Z" },
    { postedAt: "2026-11-15T23:00:01Z", nativePublishedAtLiteral: "2026-11-15T23:00:01Z" },
    { metrics: { stars: 400 } }, { contributionScore: 50 }, { platformObjectId: "999" },
    { sourceUrl: "https://github.com/foreign/repo/releases/tag/v1" }
  ]) assert.ok(nativeGithubReleaseContextReasons({ ...f.row, ...mutation }, f.snapshot).length, JSON.stringify(mutation));
  const wrong = structuredClone(f.row);
  wrong.officialRepositoryLineage.owners[0].ownerSnapshot.entityId = "company-other";
  rebuildRaw(wrong);
  assert.ok(nativeGithubReleaseContextReasons(wrong, f.snapshot).includes("release_snapshot_owner_or_repository_conflict"));
});

test("all three unresolved repository owners are held even if input attempts to upgrade attribution", async (t) => {
  for (const companySlug of ["agent-relay", "useterse", "limnion"]) {
    const f = await fixture(t, { companySlug });
    const row = { ...f.row, review_state: "verified", attributionStatus: "verified" };
    await f.save(row);
    const audit = await run(f, "dry-run", "hold");
    assert.deepEqual([audit.accepted, audit.held, audit.rejected], [0, 1, 0]);
    assert.equal(isVerifiedNativeGithubReleaseContext(row, f.snapshot), false);
    assert.equal((await json(join(f.directory, "hold/held-context.json"))).context[0].attributionStatus, "needs_review");
  }
});

test("runtime helper binds current prose, native fields and parsed upstream snapshot to ingestion validation", async (t) => {
  const f = await fixture(t); await run(f, "dry-run", "runtime");
  const good = (await json(join(f.directory, "runtime/accepted-context.json"))).context[0];
  const forged = structuredClone(good);
  forged.text += " Modified"; forged.originalText = forged.text; forged.nativeBody = forged.text;
  rebuildRaw(forged, JSON.parse(good.rawVisibleText).validation);
  assert.equal(isVerifiedNativeGithubReleaseContext(forged, f.snapshot), false);
  const changed = structuredClone(f.snapshot); changed.source.observedAt = "2026-11-16T03:00:00Z";
  assert.equal(isVerifiedNativeGithubReleaseContext(good, changed), false);
  const caption = { ...good, captionAbsent: true };
  assert.equal(isVerifiedNativeGithubReleaseContext(caption, f.snapshot), false);
});

test("compare-and-swap requires explicit current target SHA and never overwrites on conflict", async (t) => {
  const f = await fixture(t), before = await readFile(f.target, "utf8");
  await assert.rejects(run(f, "write", "no-sha"), /Write requires/);
  await assert.rejects(run(f, "write", "bad-sha", { expectedTargetSha256: "0".repeat(64) }), /compare_and_swap_hash_conflict/);
  assert.equal(await readFile(f.target, "utf8"), before);
});

test("bulk verifier pins a private deep snapshot while continuing to reject changed row body and owner", async (t) => {
  const f = await fixture(t); await run(f, "dry-run", "pinned");
  const row = (await json(join(f.directory, "pinned/accepted-context.json"))).context[0];
  const verify = createNativeGithubReleaseContextVerifier(f.snapshot);
  assert.equal(verify(row), true);
  f.snapshot.source.observedAt = "2026-11-16T04:00:00Z";
  f.snapshot.accounts[0].entityId = "company-changed";
  f.snapshot.accounts[0].repos[0].fullName = "someone/else";
  assert.equal(verify(row), true);
  assert.equal(isVerifiedNativeGithubReleaseContext(row, f.snapshot), false);
  assert.equal(verify({ ...row, text: "Changed body", originalText: "Changed body" }), false);
  assert.equal(verify({ ...row, entityId: "company-changed" }), false);
});

test("exact reviewed native YC ownership proof clears one repository while leaving its snapshot unchanged", async (t) => {
  const f = await fixture(t, { companySlug: "agent-relay", companyName: "Agent Relay", repositoryFullName: "AgentWorkforce/relay" });
  await addOwnershipAudit(f);
  const snapshotBefore = await readFile(f.snapshotFile, "utf8"), proofs = await loadVerifiedNativeGithubRepositoryOwnershipProofs({ rootDir: f.directory });
  assert.deepEqual([...proofs.keys()], ["agentworkforce/relay"]);
  const proof = proofs.get("agentworkforce/relay");
  assert.equal(isVerifiedNativeGithubRepositoryOwnershipProof(proof), true);
  const audit = await run(f, "dry-run", "owned");
  assert.deepEqual([audit.accepted, audit.held, audit.rejected], [1, 0, 0]);
  const row = (await json(join(f.directory, "owned/accepted-context.json"))).context[0];
  assert.equal(isVerifiedNativeGithubReleaseContext(row, f.snapshot), true);
  assert.equal(JSON.parse(row.rawVisibleText).validation.ownershipProofVerified, true);
  assert.equal(await readFile(f.snapshotFile, "utf8"), snapshotBefore);
  assert.equal(isVerifiedNativeGithubRepositoryOwnershipProof({ ...proof, repositoryFullName: "AgentWorkforce/unproven", repositoryUrl: "https://github.com/AgentWorkforce/unproven" }), false);
  assert.equal(isVerifiedNativeGithubRepositoryOwnershipProof({ ...proof, nativeLaunch: { ...proof.nativeLaunch, body: proof.nativeLaunch.body + "Changed" } }), false);
  assert.equal(isVerifiedNativeGithubRepositoryOwnershipProof({ ...proof, nativeLaunch: { ...proof.nativeLaunch, repositoryLinkParagraphs: ["Fabricated ownership paragraph"] } }), false);
  assert.equal(isVerifiedNativeGithubRepositoryOwnershipProof({ ...proof, repositoryUrl: 7 }), false);
  const unproven = await fixture(t, { companySlug: "agent-relay", companyName: "Agent Relay", repositoryFullName: "AgentWorkforce/unproven" });
  await addOwnershipAudit(unproven);
  const held = await run(unproven, "dry-run", "still-held");
  assert.deepEqual([held.accepted, held.held, held.rejected], [0, 1, 0]);
});

test("ownership loader fails on changed source archive, wrong owner and changed native launch paragraph", async (t) => {
  for (const mutate of [
    async (f) => writeFile(f.ownershipSourcePath, (await readFile(f.ownershipSourcePath, "utf8")) + "\n"),
    async (f) => { const a = await json(f.ownershipAuditPath); a.proofs[0].companySlug = "limnion"; await writeFile(f.ownershipAuditPath, JSON.stringify(a)); },
    async (f) => { const a = await json(f.ownershipAuditPath); a.proofs[0].ycLaunchProofs[0].ownershipParagraphs = ["Fabricated paragraph"]; await writeFile(f.ownershipAuditPath, JSON.stringify(a)); }
  ]) {
    const f = await fixture(t); await addOwnershipAudit(f); await mutate(f);
    await assert.rejects(loadVerifiedNativeGithubRepositoryOwnershipProofs({ rootDir: f.directory }), /ownership.*conflict|unreviewed_repository|paragraph_conflict/);
  }
});

test("native release clocks allow next-day publications already observed and reject later publications", async (t) => {
  const f = await fixture(t), row = { ...f.row, postedAt: "2026-11-16T12:00:00Z", nativePublishedAtLiteral: "2026-11-16T12:00:00Z", observedAt: "2026-11-16T13:00:00Z" };
  rebuildRaw(row);
  assert.deepEqual(nativeGithubReleaseContextReasons(row, f.snapshot), []);
  row.postedAt = "2026-11-16T14:00:00Z"; row.nativePublishedAtLiteral = row.postedAt; rebuildRaw(row);
  assert.ok(nativeGithubReleaseContextReasons(row, f.snapshot).includes("invalid_future_or_conflicting_native_release_publication"));
});

function rebuildRaw(row, validation) {
  row.rawVisibleText = JSON.stringify({ source: "official_snapshot_native_github_release_v1", repositoryFullName: row.repositoryFullName,
    post: { platformPostId: row.platformPostId, sourceUrl: row.sourceUrl, title: Object.hasOwn(row, "nativeTitle") ? row.nativeTitle : row.title, tag: row.tag, text: row.text, published_at: row.postedAt, author: row.nativeAuthor },
    nativeCollectionArchivePath: row.nativeCollectionArchivePath, nativeCollectionArchiveSha256: row.nativeCollectionArchiveSha256,
    officialRepositoryLineage: row.officialRepositoryLineage, ...(validation ? { validation } : {}) });
}
async function fixture(t, { body = "## Native release\n\nExact original release prose.", companySlug = "fixture", companyName = "Fixture", repositoryFullName = "fixture/native" } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "fall-github-release-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entityId = `company-${companySlug}`, fullName = repositoryFullName;
  const repositoryUrl = `https://github.com/${fullName}`, sourceUrl = `${repositoryUrl}/releases/tag/v1`;
  const author = { login: "release-maintainer", id: 7, html_url: "https://github.com/release-maintainer" };
  const native = { id: 12345, body, name: body ? "Native v1" : null, tag_name: "v1", html_url: sourceUrl, published_at: "2026-11-01T12:00:00Z", author, draft: false, prerelease: false };
  const repo = { id: 888, fullName, htmlUrl: repositoryUrl, stars: 9999, forks: 500 };
  const ownerSnapshot = { entityType: "company", entityId, companySlug, companyName, name: companyName, sourceUrl: `https://www.ycombinator.com/companies/${companySlug}`, githubUrl: repositoryUrl, discoverySource: "yc_profile", matchReason: "Official snapshot link", login: "fixture", fetched: true };
  const snapshot = { source: { observedAt: "2026-11-15T23:00:00Z" }, accounts: [{ ...ownerSnapshot, aggregate: { totalStars: 9999 }, repos: [repo] }] };
  const snapshotPath = "src/lib/social/github-traction-fall-2026.json", catalogPath = "src/lib/yc/fall-2026-companies.json";
  await mkdir(join(directory, "src/lib/social"), { recursive: true }); await mkdir(join(directory, "src/lib/yc"), { recursive: true });
  const snapshotFile = join(directory, snapshotPath), snapshotText = JSON.stringify(snapshot);
  await writeFile(snapshotFile, snapshotText); await writeFile(join(directory, catalogPath), JSON.stringify({ companies: [{ slug: companySlug, name: companyName }] }));
  const nativeCollectionArchivePath = "outputs/fall-2026/github-release-cache/fixture/page-1.json", archive = join(directory, nativeCollectionArchivePath);
  await mkdir(join(directory, "outputs/fall-2026/github-release-cache/fixture"), { recursive: true });
  const observedAt = "2026-11-15T23:00:00Z", requestUrl = `https://api.github.com/repos/${fullName}/releases?per_page=100&page=1`;
  const bytes = JSON.stringify({ requestUrl, observedAt, repository: fullName, nativeResponse: [native], responseContent: JSON.stringify([native]) }); await writeFile(archive, bytes);
  const row = { batchSlug: "F26", platform: "github", platformPostId: "12345", nativeReleaseId: 12345, entityType: "company", entityId, companySlug, companyName,
    sourceUrl, repositoryUrl, repositoryFullName: fullName, title: native.name, tag: native.tag_name, text: body ?? "", nativeBody: body,
    nativeDraft: false, nativePrerelease: false, postedAt: native.published_at, nativePublishedAtLiteral: native.published_at, observedAt,
    nativeAuthor: author, authorName: author.login, nativeAuthorUrl: author.html_url, metrics: {}, contributionScore: 0,
    nativeCollectionArchivePath, nativeCollectionArchiveSha256: sha(bytes), nativeCollectionRequestUrl: requestUrl,
    officialRepositoryLineage: { snapshotPath, snapshotSha256: sha(snapshotText), owners: [{ ownerSnapshot, repositorySnapshot: repo, snapshotAccountIndex: 0, snapshotRepositoryIndex: 0 }] } };
  rebuildRaw(row);
  const input = join(directory, "input.json"), target = join(directory, "target.json");
  const older = { id: "older-unchanged", batchSlug: "S26", entityId: "company-older", platform: "github", contentKind: "github_release_post", nativeReleaseId: 12345, text: "Earlier cohort \"prose\"", metrics: { stars: 12 } };
  await writeFile(target, JSON.stringify({ source: {}, evidence: [older] }));
  const save = (r) => writeFile(input, JSON.stringify({ source: {}, context: [r] })); await save(row);
  return { directory, target, input, snapshotFile, snapshot, archive, native, row, older, save };
}
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const run = (f, mode, output, extra = {}) => ingestFallGithubReleaseContext({ root: f.directory, mode, input: "input.json", target: "target.json", output, ...extra });

async function addOwnershipAudit(f) {
  const repo = "https://github.com/AgentWorkforce/relay", paragraph = `Agent Relay is [open source](${repo}). You can self-host it.`;
  const launch = { id: 124128, url: "https://www.ycombinator.com/launches/WI4-agent-relay", state: "public", created_at: "2026-10-23T15:00:00.238Z", authorName: "Will Washburn", body: `We built Agent Relay.\n\n${paragraph}`, outboundLinks: [repo] };
  const company = { companySlug: "agent-relay", companyName: "Agent Relay", sourceUrl: "https://www.ycombinator.com/companies/agent-relay", sourceHtmlSha256: "a".repeat(64), observedAt: "2026-11-15T23:00:00Z", launches: [launch] };
  const sourcePath = "outputs/source-hunt/2026-11-15-fall-2026-web-context.json", auditPath = "outputs/source-hunt/2026-11-15-fall-2026-github-review-owner-proof-audit.json";
  await mkdir(join(f.directory, "outputs/source-hunt"), { recursive: true });
  const sourceBytes = JSON.stringify({ companies: [company] });
  f.ownershipSourcePath = join(f.directory, sourcePath); f.ownershipAuditPath = join(f.directory, auditPath);
  await writeFile(f.ownershipSourcePath, sourceBytes);
  const receipt = { nativeLaunchId: launch.id, nativeLaunchUrl: launch.url, authorName: launch.authorName, postedAt: launch.created_at, nativeState: launch.state, nativeFullBodySha256: sha(launch.body), companyPageUrl: company.sourceUrl, sourceHtmlSha256: company.sourceHtmlSha256, observedAt: company.observedAt, exactRepositoryLinks: [repo], ownershipParagraphs: [paragraph] };
  await writeFile(f.ownershipAuditPath, JSON.stringify({ source: { archives: { ycLaunchArchive: { path: sourcePath, sha256: sha(sourceBytes) } } }, proofs: [{ companySlug: "agent-relay", companyName: "Agent Relay", entityId: "company-agent-relay", repositoryFullName: "AgentWorkforce/relay", repositoryUrl: repo, ycLaunchProofs: [receipt] }] }));
}
