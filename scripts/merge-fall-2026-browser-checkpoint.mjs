import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { freezeFallNativeCheckpointUnion } from "./lib/fall-native-checkpoint-union.mjs";
import { isVerifiedNativeTikTokReceipt } from "../src/lib/graph/tiktok-native-receipt.mjs";
import { verifiedFallLinkedInFounderAccounts } from "../src/lib/graph/linkedin-founder-aliases.mjs";
import { freezeFallNativeArticleContexts } from "./lib/fall-native-article-context-archive.mjs";
import { verifyNativeYouTubeDomInput } from "./convert-fall-2026-youtube-native-dom.mjs";

const args = process.argv.slice(2);
const value = (key, fallback) => args.find((arg) => arg.startsWith(`${key}=`))?.slice(key.length + 1) ?? fallback;
const values = (key) => args.filter((arg) => arg.startsWith(`${key}=`)).map((arg) => arg.slice(key.length + 1));
const write = args.includes("--write");
if (write === args.includes("--dry-run")) throw new Error("Pass exactly one of --write or --dry-run.");
const observedAt = new Date().toISOString();
const output = value("--output", `outputs/fall-2026/collection/checkpoint-${observedAt.replace(/[^0-9]/g, "")}`);
const target = "src/lib/social/targeted-evidence-current.json";
const beforeText = await readFile(target, "utf8");
const before = JSON.parse(beforeText);
const read = async (path) => JSON.parse(await readFile(path, "utf8"));
const save = async (name, data) => writeFile(resolve(output, name), `${JSON.stringify(data, null, 2)}\n`);
await mkdir(output, { recursive: false });
await writeFile(resolve(output, "targeted-before.json"), beforeText);
await freezeFallNativeArticleContexts({ frozenDirectory: output });
const youtubeNativeInputs = [], youtubeNativeArchives = new Map(), youtubeNativeAudit = [];
await mkdir(resolve(output, "youtube-native-source-archives"));
for (const [index, sourcePath] of values("--youtube-native-input").entries()) {
  const bytes = await readFile(sourcePath), input = JSON.parse(bytes), verification = await verifyNativeYouTubeDomInput(input);
  const filename = `youtube-native-${index}-importable.json`;
  await writeFile(resolve(output, filename), bytes);
  youtubeNativeInputs.push(`youtube-native-${index}`);
  youtubeNativeAudit.push({ sourcePath, sourceSha256: createHash("sha256").update(bytes).digest("hex"), frozenPath: `${output}/${filename}`, accepted: verification.accepted, held: verification.held });
  for (const archive of verification.archives) {
    const sourceBytes = await readFile(archive.path);
    if (createHash("sha256").update(sourceBytes).digest("hex") !== archive.sha256) throw new Error("Native YouTube source changed during freeze.");
    const frozenPath = `${output}/youtube-native-source-archives/${archive.sha256}`;
    await writeFile(frozenPath, sourceBytes);
    youtubeNativeArchives.set(archive.path, { ...archive, frozenPath, bytes: sourceBytes.length });
  }
}
await save("youtube-native-source-freeze-audit.json", { inputs: youtubeNativeAudit, archives: [...youtubeNativeArchives.values()] });
for (const [source, filename] of [
  [value("--x-input", "outputs/source-hunt/2026-11-15-fall-2026-x-ui-native-importable.json"), "x-importable.json"],
  [value("--linkedin-input", "outputs/fall-2026/linkedin-browser-importable.json"), "linkedin-importable.json"],
  [value("--instagram-input", "outputs/fall-2026/browser-checkpoints/instagram-all-ui-current.json"), "instagram-native-checkpoint.json"]
]) {
  await save(filename, await read(source));
}
const linkedinMediaSource = value("--linkedin-media-input", "outputs/fall-2026/linkedin-media-only-observations.json");
await save("x-unscored-importable.json", await read(value("--x-unscored-input", "outputs/source-hunt/2026-11-15-fall-2026-x-ui-zero-engagement-importable.json")).catch((error) => {
  if (error.code === "ENOENT") return { evidence: [] };
  throw error;
}));
const xUnscoredExtraInputs = [];
for (const [index, path] of values("--x-unscored-extra-input").entries()) {
  const name = `x-unscored-extra-${index}`;
  await save(`${name}-importable.json`, await read(path));
  xUnscoredExtraInputs.push(name);
}
const founderSourcePaths = values("--linkedin-founder-input");
if (!founderSourcePaths.length) founderSourcePaths.push("outputs/fall-2026/browser-checkpoints/linkedin-founder-jay-carousel-ui-current.json", "outputs/fall-2026/browser-checkpoints/linkedin-founder-jay-native-receipts-ui-current.json", "outputs/fall-2026/browser-checkpoints/linkedin-founder-jay-native-detail-receipts-ui-current.json");
const founderInputs = [], founderSourceAudit = [];
for (const [index, path] of founderSourcePaths.entries()) {
  let bytes;
  try { bytes = await readFile(path); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
  const input = JSON.parse(bytes), original = `linkedin-founder-native-original-${index}.json`, adapted = `linkedin-founder-native-checkpoint-${index}.json`;
  await writeFile(resolve(output, original), bytes);
  const audit = { sourcePath: path, sourceSha256: createHash("sha256").update(bytes).digest("hex"), original, adapted };
  if (input.sourceHistory) {
    const historyBytes = await readFile(input.sourceHistory.path);
    if (createHash("sha256").update(historyBytes).digest("hex") !== input.sourceHistory.sha256) throw new Error("Native founder history changed before freeze.");
    const historyPath = `${output}/linkedin-founder-source-history-${index}.json`;
    await writeFile(historyPath, historyBytes);
    audit.sourceHistory = { ...input.sourceHistory, frozenPath: historyPath };
    input.sourceHistory = { ...input.sourceHistory, path: historyPath };
  }
  await save(adapted, input);
  founderSourceAudit.push(audit);
  founderInputs.push(`--input=${output}/${adapted}`);
}
await save("linkedin-founder-source-freeze-audit.json", { inputs: founderSourceAudit });
const aliasRegistryPath = value("--linkedin-founder-alias-proofs", "src/lib/social/linkedin-founder-aliases-fall-2026.json");
const aliasBytes = await readFile(aliasRegistryPath), aliasRegistry = JSON.parse(aliasBytes);
await writeFile(resolve(output, "linkedin-founder-alias-proofs.json"), aliasBytes);
await mkdir(resolve(output, "linkedin-founder-alias-source-archives"));
for (const proof of aliasRegistry.proofs ?? []) for (const archive of proof.archives ?? []) {
  const bytes = await readFile(archive.path);
  if (createHash("sha256").update(bytes).digest("hex") !== archive.sha256) throw new Error("Founder alias archive changed before freeze.");
  await writeFile(resolve(output, "linkedin-founder-alias-source-archives", archive.sha256), bytes);
}
const companyDetailSource = value("--linkedin-company-detail-input", "outputs/fall-2026/browser-checkpoints/linkedin-ui-lane2.json");
try { await writeFile(resolve(output, "linkedin-company-detail-native-checkpoint.json"), await readFile(companyDetailSource)); }
catch (error) { if (error.code !== "ENOENT") throw error; await save("linkedin-company-detail-native-checkpoint.json", { profiles: [] }); }
await save("linkedin-media-native-observations.json", await read(linkedinMediaSource).catch((error) => {
  if (error.code === "ENOENT") return { source: "authorized_linkedin_browser_dom_v1", observations: [] };
  throw error;
}));
await save("instagram-dialog-native-checkpoint.json", await read(value("--instagram-dialog-input", "outputs/fall-2026/browser-checkpoints/instagram-jan-dialog-ui-current.json")).catch((error) => {
  if (error.code === "ENOENT") return { nativePosts: [] };
  throw error;
}));
await save("instagram-aly-dialog-native-checkpoint.json", await read(value("--instagram-aly-dialog-input", "outputs/fall-2026/browser-checkpoints/instagram-alyveeza-dialog-ui-current.json")).catch((error) => {
  if (error.code === "ENOENT") return { nativePosts: [] };
  throw error;
}));
await save("other-platform-native-checkpoint.json", await read(value("--other-platform-input", "outputs/fall-2026/browser-checkpoints/other-platform-ui-current.json")).catch((error) => {
  if (error.code === "ENOENT") return { profiles: [], nativePosts: [] };
  throw error;
}));
await save("facebook-native-checkpoint.json", await read(value("--facebook-input", "outputs/fall-2026/browser-checkpoints/facebook-ui-current.json")).catch((error) => {
  if (error.code === "ENOENT") return { profiles: [], nativePosts: [] };
  throw error;
}));
await save("threads-native-checkpoint.json", await read(value("--threads-input", "outputs/fall-2026/browser-checkpoints/threads-sirsho-ui-current.json")).catch((error) => {
  if (error.code === "ENOENT") return { source: { batchSlug: "F26" }, nativePosts: [] };
  throw error;
}));
for (const [flag, base, filename] of [
  ["--other-platform-extra-input", value("--other-platform-input", "outputs/fall-2026/browser-checkpoints/other-platform-ui-current.json"), "other-platform-native-checkpoint.json"],
  ["--facebook-extra-input", value("--facebook-input", "outputs/fall-2026/browser-checkpoints/facebook-ui-current.json"), "facebook-native-checkpoint.json"]
]) {
  if (values(flag).length) await freezeFallNativeCheckpointUnion([base, ...values(flag)], resolve(output, filename));
}
const instagramExtraInputs = [];
const instagramPartSources = [];
await mkdir(resolve(output, "instagram-native-part-source-archives"));
for (const [index, source] of values("--instagram-extra-dialog-input").entries()) {
  const filename = `instagram-extra-dialog-native-checkpoint-${index}.json`;
  const native = await read(source);
  await save(filename, native);
  for (const parent of native.source?.frozenSources ?? []) {
    const bytes = await readFile(parent.path);
    if (createHash("sha256").update(bytes).digest("hex") !== parent.sha256) throw new Error("Native Instagram dialog part archive SHA changed.");
    const frozenPath = `${output}/instagram-native-part-source-archives/${parent.sha256}.json`;
    await writeFile(frozenPath, bytes);
    instagramPartSources.push({ sourcePath: parent.path, frozenPath, sha256: parent.sha256, bytes: bytes.length });
  }
  instagramExtraInputs.push(`--input=${output}/${filename}`);
}
await save("instagram-native-part-source-freeze-audit.json", { archives: instagramPartSources });
for (const [source, filename] of [
  ["outputs/source-hunt/2026-11-15-fall-2026-x-ui-resume-ledger.json", "x-account-history-resume-ledger.json"],
  ["outputs/source-hunt/2026-11-15-fall-2026-x-ui-native-search-coverage.json", "x-native-search-coverage.json"],
  ["outputs/source-hunt/2026-11-15-fall-2026-x-ui-search-ledger.json", "x-native-search-ledger.json"],
  ["outputs/fall-2026/browser-checkpoints/linkedin-founder-jay-history-coverage.json", "linkedin-founder-jay-history-coverage.json"],
  ["outputs/fall-2026/browser-checkpoints/linkedin-founder-kevin-history-coverage.json", "linkedin-founder-kevin-history-coverage.json"],
  ["outputs/fall-2026/browser-checkpoints/instagram-jansenderek-history-coverage.json", "instagram-jansenderek-history-coverage.json"],
  ["outputs/fall-2026/browser-checkpoints/instagram-alyveeza-history-coverage.json", "instagram-alyveeza-history-coverage.json"],
  ["outputs/fall-2026/browser-checkpoints/instagram-sridipto-history-coverage.json", "instagram-sridipto-history-coverage.json"],
  ["outputs/fall-2026/browser-checkpoints/instagram-sirsho-history-coverage.json", "instagram-sirsho-history-coverage.json"],
  ["outputs/fall-2026/browser-checkpoints/instagram-antimattr-in-history-coverage.json", "instagram-antimattr-in-history-coverage.json"],
  ["outputs/fall-2026/browser-checkpoints/instagram-yam-history-coverage.json", "instagram-yam-history-coverage.json"],
  ["outputs/fall-2026/browser-checkpoints/instagram-native-history-coverage.json", "instagram-native-history-coverage.json"],
  ["outputs/fall-2026/browser-checkpoints/instagram-haris-history-coverage.json", "instagram-haris-history-coverage.json"],
  ["outputs/fall-2026/browser-checkpoints/instagram-jacobhardware-history-coverage.json", "instagram-jacobhardware-history-coverage.json"],
  ["outputs/fall-2026/browser-checkpoints/instagram-rhem-history-coverage.json", "instagram-rhem-history-coverage.json"],
  ["outputs/fall-2026/browser-checkpoints/instagram-rhem-history-inventory.json", "instagram-rhem-history-inventory.json"],
  ["outputs/fall-2026/browser-checkpoints/instagram-slavzilla-history-coverage.json", "instagram-slavzilla-history-coverage.json"],
  ["outputs/fall-2026/browser-checkpoints/instagram-slavzilla-history-inventory.json", "instagram-slavzilla-history-inventory.json"],
  ["outputs/fall-2026/browser-checkpoints/instagram-deepmark-history-coverage.json", "instagram-deepmark-history-coverage.json"],
  ["outputs/fall-2026/browser-checkpoints/instagram-deepmark-history-inventory.json", "instagram-deepmark-history-inventory.json"],
  ["outputs/fall-2026/browser-checkpoints/instagram-altair-health-history-coverage.json", "instagram-altair-health-history-coverage.json"],
  ["outputs/fall-2026/browser-checkpoints/instagram-altair-health-history-inventory.json", "instagram-altair-health-history-inventory.json"],
  ["outputs/fall-2026/browser-checkpoints/instagram-ignition-history-coverage.json", "instagram-ignition-history-coverage.json"],
  ["outputs/fall-2026/browser-checkpoints/instagram-ignition-history-inventory-complete.json", "instagram-ignition-history-inventory-complete.json"],
  ["outputs/fall-2026/instagram-caption-absence-decisions.json", "instagram-caption-absence-decisions.json"],
  ...values("--coverage-input").map((source) => [source, basename(source)])
]) {
  try { await save(filename, await read(source)); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
function run(scriptArgs, logName) {
  const result = spawnSync(process.execPath, scriptArgs, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  return writeFile(resolve(output, logName), result.stdout + result.stderr).then(() => {
    if (result.status !== 0) throw new Error(`${scriptArgs[0]} failed; inspect ${output}/${logName}`);
    return result.stdout;
  });
}
await run([
  "scripts/build-fall-2026-instagram-identity-proofs.mjs",
  `--input=${output}/instagram-native-checkpoint.json`,
  `--input=${output}/instagram-dialog-native-checkpoint.json`,
  `--input=${output}/instagram-aly-dialog-native-checkpoint.json`,
  ...instagramExtraInputs,
  `--output=${output}/instagram-identity-proofs.json`,
  ...(value("--instagram-seed") ? [`--seed=${value("--instagram-seed")}`] : [])
], "instagram-proof-build.log");
const instagramProofArchives = [];
await mkdir(resolve(output, "instagram-founder-identity-source-archives"));
for (const group of (await read(resolve(output, "instagram-identity-proofs.json"))).companies ?? []) {
  for (const proof of group.accounts ?? []) {
    const receipt = proof.nativeFounderNamingReceipt;
    const archives = [
      ...(receipt ? [{ path: receipt.artifactPath, sha256: receipt.artifactSha256, kind: "native_founder_name_link_profile" }] : []),
      ...(proof.nativeFounderTeamIdentity?.archives ?? []),
      ...(proof.nativeCompanyProfileReceipt?.archives ?? [])
    ];
    for (const archive of archives) {
      const bytes = await readFile(archive.path);
      if (createHash("sha256").update(bytes).digest("hex") !== archive.sha256) throw new Error("Instagram founder identity archive changed before freeze.");
      const frozenPath = `${output}/instagram-founder-identity-source-archives/${archive.sha256}${archive.path.endsWith(".html") ? ".html" : ".json"}`;
      await writeFile(frozenPath, bytes);
      instagramProofArchives.push({ companySlug: group.companySlug, founderId: proof.founderId, handle: proof.handle, kind: archive.kind, sourcePath: archive.path, frozenPath, sha256: archive.sha256, bytes: bytes.length });
    }
  }
}
await save("instagram-founder-identity-source-freeze-audit.json", { archives: instagramProofArchives });
await run([
  "scripts/convert-fall-2026-instagram-observations.mjs",
  "--input=outputs/fall-2026/instagram-vexo-native-observations.json",
  "--input=outputs/fall-2026/instagram-vexo-additional-native-observations.json",
  `--input=${output}/instagram-native-checkpoint.json`,
  `--input=${output}/instagram-dialog-native-checkpoint.json`,
  `--input=${output}/instagram-aly-dialog-native-checkpoint.json`,
  ...instagramExtraInputs,
  `--identity-proofs=${output}/instagram-identity-proofs.json`,
  `--output=${output}/instagram-importable.json`
], "instagram-conversion.log");
await run([
  "scripts/convert-fall-2026-linkedin-media-observations.mjs",
  `--input=${output}/linkedin-media-native-observations.json`,
  `--output=${output}/linkedin-media-importable.json`
], "linkedin-media-conversion.log");
if (founderInputs.length) await run([
  "scripts/convert-fall-2026-linkedin-founder-observations.mjs", ...founderInputs, `--alias-proofs=${output}/linkedin-founder-alias-proofs.json`, `--alias-archives-directory=${output}/linkedin-founder-alias-source-archives`, `--output=${output}/linkedin-founder-importable.json`
], "linkedin-founder-conversion.log");
else await save("linkedin-founder-importable.json", { evidence: [], needsReview: [] });
await run([
  "scripts/convert-fall-2026-linkedin-company-details.mjs", `--input=${output}/linkedin-company-detail-native-checkpoint.json`, `--output=${output}/linkedin-company-detail-importable.json`
], "linkedin-company-detail-conversion.log");
await run([
  "scripts/convert-fall-2026-tiktok-observations.mjs",
  `--input=${output}/other-platform-native-checkpoint.json`,
  `--output=${output}/tiktok-importable.json`
], "tiktok-conversion.log");
await run([
  "scripts/convert-fall-2026-facebook-observations.mjs",
  `--input=${output}/facebook-native-checkpoint.json`,
  `--output=${output}/facebook-importable.json`
], "facebook-conversion.log");
const threadsInput = await read(resolve(output, "threads-native-checkpoint.json"));
if (threadsInput.nativePosts?.length) await run([
  "scripts/convert-fall-2026-threads-observations.mjs", `--input=${output}/threads-native-checkpoint.json`, `--output=${output}/threads-importable.json`
], "threads-conversion.log");
else await save("threads-importable.json", { evidence: [], needsReview: [] });
const nativeInputs = ["x", "x-unscored", ...xUnscoredExtraInputs, "linkedin", "linkedin-founder", "linkedin-company-detail", "instagram", "linkedin-media", "tiktok", "facebook", "threads", ...youtubeNativeInputs];
for (const platform of nativeInputs) {
  const input = await read(resolve(output, `${platform}-importable.json`));
  for (const row of input.evidence ?? []) {
    if (row.batchSlug !== "F26") throw new Error(`Non-F26 incoming ${platform} row.`);
    if (row.postedAt && (!Number.isFinite(Date.parse(row.postedAt)) || Date.parse(row.postedAt) > Date.parse(observedAt))) {
      throw new Error(`Invalid or future native publication date: ${row.sourceUrl}`);
    }
  }
}
const importerArgs = [
  "scripts/import-source-hunt-evidence.mjs",
  ...nativeInputs.map((platform) => `--input=${output}/${platform}-importable.json`),
  "--include-batches=F26", "--scope-batch-dedupe", "--retain-zero-engagement", "--append-only", "--strict",
  `--observed-at=${observedAt}`
];
const dryRunAudit = JSON.parse(await run([...importerArgs, "--dry-run", `--audit-output=${output}/dry-run-audit.json`], "dry-run.log"));
let writeAudit = null;
if (write) {
  if (await readFile(target, "utf8") !== beforeText) throw new Error("Canonical evidence changed during preflight; retry from a new checkpoint.");
  writeAudit = JSON.parse(await run([...importerArgs, "--write", `--audit-output=${output}/write-audit.json`], "write.log"));
}
const after = write ? await read(target) : before;
if (write && args.includes("--normalize-unscored-native")) {
  const originalBytes = await readFile(target, "utf8"), roster = await read("src/lib/yc/fall-2026-companies.json");
  if (JSON.stringify(after) !== JSON.stringify(JSON.parse(originalBytes))) throw new Error("Canonical changed before unscored-native normalization.");
  const corrections = [];
  after.evidence = after.evidence.map((row) => {
    if (row.batchSlug !== "F26" || row.platform !== "tiktok" || row.contributionScore === 0 && row.tractionStatus === "unscored") return row;
    const company = roster.companies.find((entry) => entry.slug === row.companySlug);
    if (!isVerifiedNativeTikTokReceipt(row, company)) throw new Error(`Cannot normalize unverified TikTok native history: ${row.sourceUrl}`);
    corrections.push({ platformPostId: row.platformPostId, sourceUrl: row.sourceUrl, previousContributionScore: row.contributionScore, previousTractionStatus: row.tractionStatus ?? null });
    return { ...row, contributionScore: 0, tractionStatus: "unscored", tractionLimitations: [...new Set([...(row.tractionLimitations ?? []), "No calibrated TikTok traction model is configured; native history contributes zero traction while observed engagement remains available."])] };
  });
  if (await readFile(target, "utf8") !== originalBytes) throw new Error("Canonical changed during unscored-native normalization.");
  if (corrections.length) { await writeFile(`${target}.tmp`, `${JSON.stringify(after, null, 2)}\n`); await rename(`${target}.tmp`, target); }
  await save("unscored-native-normalization-audit.json", { scope: "F26_tiktok_verified_native_only", metricsAndOriginalBodiesPreserved: true, corrected: corrections.length, corrections });
}
const earlierRows = (artifact) => artifact.evidence.filter((row) => (row.batchSlug ?? row.batch) !== "F26");
const earlierHash = (artifact) => createHash("sha256").update(JSON.stringify(earlierRows(artifact))).digest("hex");
if (earlierHash(before) !== earlierHash(after)) throw new Error("Earlier cohort evidence changed unexpectedly.");
if (write) {
  const overridesPath = "src/lib/social/verified-social-overrides.json";
  const [overrides, roster, proofs] = await Promise.all([
    read(overridesPath), read("src/lib/yc/fall-2026-companies.json"), read(resolve(output, "instagram-identity-proofs.json"))
  ]);
  for (const group of proofs.companies) {
    if (group.companySlug === "vexo") continue;
    const company = roster.companies.find((entry) => entry.slug === group.companySlug);
    const proof = group.accounts.find((account) => account.entityType === "company");
    const previous = overrides[group.companySlug] ?? {};
    overrides[group.companySlug] = {
      ...previous, batchSlug: "F26",
      companySocialLinks: { ...previous.companySocialLinks, instagram: proof.profileUrl },
      instagramValidation: {
        review_state: "verified",
        method: proof.visibleWebsite ? "native_profile_exact_official_domain_and_company_identity" : "official_website_outbound_instagram_anchor_and_native_profile",
        sourceUrl: proof.profileUrl, officialWebsite: company.websiteUrl, checkedAt: proof.observedAt,
        ...(proof.officialWebsiteOutboundReceipt ? { officialWebsiteOutboundReceipt: proof.officialWebsiteOutboundReceipt } : {})
      },
      sourceUrl: company.ycProfileUrl,
      matchReason: "Authorized native profile identity is bound to the exact official company domain or its literal outbound Instagram anchor; collaborator posts retain their actual native author."
    };
    const founderAliases = [...(previous.founders ?? [])];
    for (const founder of group.accounts.filter((account) => account.entityType === "founder")) {
      const index = founderAliases.findIndex((entry) => String(entry.id) === String(founder.founderId));
      const prior = index >= 0 ? founderAliases[index] : {};
      const alias = {
        ...prior, id: founder.founderId, name: founder.founderName,
        socialLinks: { ...prior.socialLinks, instagram: founder.profileUrl },
        sourceUrl: founder.profileUrl,
        matchReason: founder.verificationNotes
      };
      if (index >= 0) founderAliases[index] = alias;
      else founderAliases.push(alias);
    }
    if (founderAliases.length) overrides[group.companySlug].founders = founderAliases;
  }
  for (const row of (await read(resolve(output, "tiktok-importable.json"))).evidence) {
    const previous = overrides[row.companySlug] ?? {};
    const receipt = JSON.parse(row.rawVisibleText);
    overrides[row.companySlug] = {
      ...previous, batchSlug: "F26", companySocialLinks: { ...previous.companySocialLinks, tiktok: row.accountUrl },
      tiktokValidation: {
        review_state: "verified", method: "literal_official_website_anchor_and_native_company_profile_video",
        sourceUrl: row.accountUrl, officialWebsite: receipt.identityProof.officialWebsite,
        officialOutboundReceipt: receipt.identityProof.officialOutboundReceipt,
        inventorySha256: receipt.identityProof.inventorySha256, checkedAt: receipt.observedAt
      }
    };
  }
  for (const row of (await read(resolve(output, "facebook-importable.json"))).evidence) {
    const previous = overrides[row.companySlug] ?? {}, receipt = JSON.parse(row.rawVisibleText);
    overrides[row.companySlug] = {
      ...previous, batchSlug: "F26", companySocialLinks: { ...previous.companySocialLinks, facebook: row.accountUrl },
      facebookValidation: {
        review_state: "verified", method: "literal_official_website_anchor_and_native_own_author_post",
        sourceUrl: row.accountUrl, officialWebsite: receipt.identityProof.officialWebsite,
        officialOutboundReceipt: receipt.identityProof.officialOutboundReceipt,
        inventorySha256: receipt.identityProof.inventorySha256, checkedAt: receipt.observedAt
      }
    };
  }
  for (const row of (await read(resolve(output, "threads-importable.json"))).evidence) {
    const previous = overrides[row.companySlug] ?? {}, proof = JSON.parse(row.rawVisibleText).identityProof;
    const founders = [...(previous.founders ?? [])];
    const index = founders.findIndex((entry) => String(entry.id) === proof.founderId);
    if (index < 0) throw new Error("Threads proof must extend an existing verified founder identity.");
    founders[index] = { ...founders[index], socialLinks: { ...founders[index].socialLinks, threads: row.accountUrl }, threadsValidation: { review_state: "verified", sourceUrl: row.accountUrl, identityArchivePath: proof.identityArchivePath, identityArchiveSha256: proof.identityArchiveSha256 } };
    overrides[row.companySlug] = { ...previous, founders };
  }
  for (const row of (await read(resolve(output, "linkedin-founder-importable.json"))).evidence) {
    const proof = JSON.parse(row.rawVisibleText).founderAccountIdentityProof;
    if (!proof) continue;
    const company = roster.companies.find((entry) => entry.slug === row.companySlug);
    const founder = company?.founders.find((entry) => String(entry.id) === proof.founderId && entry.name === proof.founderName);
    if (!founder || !verifiedFallLinkedInFounderAccounts(company, founder, aliasRegistry).includes(row.accountUrl)) throw new Error("Founder LinkedIn override does not match the frozen identity registry.");
    const previous = overrides[row.companySlug] ?? {}, founders = [...(previous.founders ?? [])];
    const index = founders.findIndex((entry) => String(entry.id) === String(founder.id));
    const prior = index < 0 ? {} : founders[index];
    const alias = { ...prior, id: String(founder.id), name: founder.name, socialLinks: { ...prior.socialLinks, linkedin: row.accountUrl }, sourceUrl: row.accountUrl, matchReason: `Exact roster founder identity is bound to the current native LinkedIn account by ${proof.method}; archived source hashes are preserved.`, linkedinIdentityProof: proof };
    if (index < 0) founders.push(alias); else founders[index] = alias;
    overrides[row.companySlug] = { ...previous, batchSlug: "F26", founders };
  }
  await writeFile(`${overridesPath}.tmp`, `${JSON.stringify(overrides, null, 2)}\n`);
  await rename(`${overridesPath}.tmp`, overridesPath);
  await save("verified-social-overrides.json", overrides);
  await save("targeted-after.json", after);
  await writeFile("outputs/fall-2026/collection/targeted-evidence-canonical-checkpoint.json", `${JSON.stringify(after, null, 2)}\n`);
  await run(["scripts/prepare-graph-runtime-evidence.mjs"], "runtime-preparation.log");
}
const fall = after.evidence.filter((row) => row.batchSlug === "F26");
const nativePlatforms = ["x", "linkedin", "instagram", "tiktok", "facebook", "threads"];
const native = fall.filter((row) => nativePlatforms.includes(row.platform));
const retainedNativeIds = new Set(fall.map((row) => `${row.platform}:${row.platformPostId}`));
const missingIncomingNativePosts = [];
if (write) for (const platform of nativeInputs) {
  for (const row of (await read(resolve(output, `${platform}-importable.json`))).evidence ?? []) {
    if (!retainedNativeIds.has(`${row.platform}:${row.platformPostId}`)) missingIncomingNativePosts.push({ platform: row.platform, platformPostId: row.platformPostId, entityId: row.entityId, sourceUrl: row.sourceUrl });
  }
}
await save("native-physical-post-retention-audit.json", { incomingPostsMissingFromCanonical: missingIncomingNativePosts.length, missingIncomingNativePosts });
if (missingIncomingNativePosts.length) throw new Error("An approved incoming native physical ID is absent after dedupe; inspect native-physical-post-retention-audit.json before calling this checkpoint complete.");
const summary = {
  observedAt, status: write ? "canonical_checkpoint_validated_graph_publication_pending" : "strict_preflight_passed_canonical_unchanged",
  fullHistoryComplete: false, before: before.evidence.length, after: after.evidence.length,
  incoming: dryRunAudit.received, newRows: dryRunAudit.accepted, duplicates: dryRunAudit.duplicates,
  rejected: dryRunAudit.rejected, updated: writeAudit?.updated ?? 0,
  fallEvidence: fall.length, nativePosts: native.length,
  uniqueNativePosts: new Set(native.map((row) => `${row.platform}:${row.platformPostId}`)).size,
  byPlatform: Object.fromEntries(nativePlatforms.map((platform) => [platform, native.filter((row) => row.platform === platform).length])),
  unscoredNative: native.filter((row) => row.tractionStatus === "unscored").length,
  nativeYouTubePosts: fall.filter((row) => row.platform === "youtube").length,
  nativeYouTubeUnscoredPosts: fall.filter((row) => row.platform === "youtube" && row.tractionStatus === "unscored").length,
  incomingPostsMissingFromCanonical: missingIncomingNativePosts.length,
  preservedEarlierCohortRows: earlierRows(after).length, preservedEarlierCohortSha256: earlierHash(after)
};
await save("merge-summary.json", summary);
console.log(JSON.stringify({ output, ...summary }));
