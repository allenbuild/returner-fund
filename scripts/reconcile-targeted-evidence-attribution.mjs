import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = process.cwd();
const targetPath = resolve(root, stringArg("--target") ?? "src/lib/social/targeted-evidence-current.json");
const inputPath = resolve(root, requiredArg("--input"));
const auditOutput = stringArg("--audit-output");
const observedAt = validTimestamp(requiredArg("--observed-at"));
const dryRun = process.argv.includes("--dry-run");
const writeMode = process.argv.includes("--write");

if (dryRun === writeMode) throw new Error("Pass exactly one of --dry-run or --write.");

const [target, reconciliation] = await Promise.all([readJson(targetPath), readJson(inputPath)]);
const sourceRows = Array.isArray(target.evidence) ? target.evidence : [];
const workingRows = structuredClone(sourceRows);
const knownFounders = await knownFounderIds();
const reassignments = Array.isArray(reconciliation.reassign) ? reconciliation.reassign : [];
const retirements = Array.isArray(reconciliation.retire) ? reconciliation.retire : [];
const errors = [];
const reassigned = [];
const retired = [];
const touchedIndexes = new Set();

for (const [instructionIndex, instruction] of reassignments.entries()) {
  const platform = normalizePlatform(instruction?.platform);
  const platformPostId = cleanString(instruction?.platformPostId);
  const sourceUrl = canonicalUrl(instruction?.sourceUrl);
  const fromEntityId = cleanString(instruction?.fromEntityId);
  const toEntityId = cleanString(instruction?.toEntityId);
  const founderName = cleanString(instruction?.founderName);

  if (
    instruction?.action !== "reassign_company_to_founder" ||
    !platform ||
    !platformPostId ||
    !sourceUrl ||
    !fromEntityId?.startsWith("company-") ||
    !toEntityId?.startsWith("founder-") ||
    !founderName
  ) {
    errors.push({ kind: "reassign", instructionIndex, reason: "invalid_reassign_instruction" });
    continue;
  }
  if (!knownFounders.has(toEntityId)) {
    errors.push({ kind: "reassign", instructionIndex, reason: "unknown_target_founder", toEntityId });
    continue;
  }
  if (hasCommentReceipt(sourceUrl)) {
    errors.push({ kind: "reassign", instructionIndex, reason: "comment_receipt_cannot_be_reassigned", sourceUrl });
    continue;
  }

  const matches = matchingRows(workingRows, { platform, platformPostId, sourceUrl });
  if (matches.length !== 1) {
    errors.push({
      kind: "reassign",
      instructionIndex,
      reason: matches.length === 0 ? "source_row_not_found" : "ambiguous_source_row",
      platform,
      platformPostId,
      sourceUrl,
      matches: matches.length
    });
    continue;
  }

  const [matchIndex] = matches;
  const row = workingRows[matchIndex];
  if (cleanString(row.entityId) !== fromEntityId || row.entityType !== "company") {
    errors.push({
      kind: "reassign",
      instructionIndex,
      reason: "source_attribution_changed",
      expectedEntityId: fromEntityId,
      actualEntityId: cleanString(row.entityId),
      actualEntityType: row.entityType ?? null
    });
    continue;
  }
  const targetDuplicate = workingRows.findIndex((candidate, index) =>
    index !== matchIndex &&
    cleanString(candidate.entityId) === toEntityId &&
    normalizePlatform(candidate.platform) === platform &&
    cleanString(candidate.platformPostId) === platformPostId
  );
  if (targetDuplicate >= 0) {
    errors.push({
      kind: "reassign",
      instructionIndex,
      reason: "target_founder_already_has_post",
      duplicateIndex: targetDuplicate,
      toEntityId,
      platformPostId
    });
    continue;
  }
  if (touchedIndexes.has(matchIndex)) {
    errors.push({ kind: "reassign", instructionIndex, reason: "source_row_touched_twice", matchIndex });
    continue;
  }

  workingRows[matchIndex] = {
    ...row,
    entityType: "founder",
    entityId: toEntityId,
    entityName: founderName,
    last_updated_at: observedAt,
    attributionReconciledAt: observedAt,
    attributionReconciliation: {
      action: "company_to_founder",
      fromEntityId,
      toEntityId,
      input: relativePath(inputPath)
    }
  };
  touchedIndexes.add(matchIndex);
  reassigned.push({
    instructionIndex,
    evidenceIndex: matchIndex,
    platform,
    platformPostId,
    sourceUrl: canonicalUrl(row.sourceUrl),
    fromEntityId,
    toEntityId
  });
}

const retirementIndexes = [];
for (const [instructionIndex, instruction] of retirements.entries()) {
  const sourceUrl = canonicalUrl(instruction?.sourceUrl);
  const currentEntityId = cleanString(instruction?.currentEntityId);
  if (!sourceUrl || !currentEntityId || !hasCommentReceipt(sourceUrl)) {
    errors.push({ kind: "retire", instructionIndex, reason: "retirement_requires_comment_receipt" });
    continue;
  }
  const matches = workingRows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => canonicalUrl(row.sourceUrl) === sourceUrl)
    .map(({ index }) => index);
  if (matches.length !== 1) {
    errors.push({
      kind: "retire",
      instructionIndex,
      reason: matches.length === 0 ? "retirement_row_not_found" : "ambiguous_retirement_row",
      sourceUrl,
      matches: matches.length
    });
    continue;
  }
  const [matchIndex] = matches;
  const row = workingRows[matchIndex];
  if (cleanString(row.entityId) !== currentEntityId) {
    errors.push({
      kind: "retire",
      instructionIndex,
      reason: "retirement_attribution_changed",
      expectedEntityId: currentEntityId,
      actualEntityId: cleanString(row.entityId)
    });
    continue;
  }
  if (touchedIndexes.has(matchIndex)) {
    errors.push({ kind: "retire", instructionIndex, reason: "source_row_touched_twice", matchIndex });
    continue;
  }
  touchedIndexes.add(matchIndex);
  retirementIndexes.push(matchIndex);
  retired.push({
    instructionIndex,
    evidenceIndex: matchIndex,
    entityId: currentEntityId,
    platform: normalizePlatform(row.platform),
    platformPostId: cleanString(row.platformPostId),
    sourceUrl
  });
}

const audit = {
  generatedAt: observedAt,
  target: relativePath(targetPath),
  input: relativePath(inputPath),
  before: sourceRows.length,
  requestedReassignments: reassignments.length,
  requestedRetirements: retirements.length,
  reassigned: reassigned.length,
  retired: retired.length,
  errors,
  reassignments: reassigned,
  retirements: retired,
  after: sourceRows.length - retired.length,
  dryRun
};

if (auditOutput) await writeJsonAtomic(resolve(root, auditOutput), audit);
if (errors.length > 0) {
  console.log(JSON.stringify(audit, null, 2));
  throw new Error(`Attribution reconciliation rejected ${errors.length} instruction(s); target was not written.`);
}

if (writeMode) {
  const retiredSet = new Set(retirementIndexes);
  target.evidence = workingRows.filter((_, index) => !retiredSet.has(index));
  target.source = target.source && typeof target.source === "object" ? target.source : {};
  target.source.attributionReconciledAt = observedAt;
  target.source.evidenceCount = target.evidence.length;
  target.source.notes = Array.isArray(target.source.notes) ? target.source.notes : [];
  const note = `Reassigned ${reassigned.length} owner-native posts from company to founder entities and retired ${retired.length} comment receipts.`;
  if (!target.source.notes.includes(note)) target.source.notes.push(note);
  await writeJsonAtomic(targetPath, target);
}

console.log(JSON.stringify(audit, null, 2));

function matchingRows(rows, { platform, platformPostId, sourceUrl }) {
  const byPostId = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) =>
      normalizePlatform(row.platform) === platform &&
      cleanString(row.platformPostId) === platformPostId
    )
    .map(({ index }) => index);
  if (byPostId.length > 0) return byPostId;
  return rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) =>
      normalizePlatform(row.platform) === platform &&
      canonicalUrl(row.sourceUrl) === sourceUrl
    )
    .map(({ index }) => index);
}

async function knownFounderIds() {
  const ids = new Set();
  for (const path of [
    resolve(root, "src/lib/yc/spring-2026-companies.json"),
    resolve(root, "src/lib/yc/summer-2026-companies.json")
  ]) {
    const payload = await readJson(path);
    for (const company of payload.companies ?? []) {
      for (const founder of company.founders ?? []) {
        ids.add(`founder-${company.slug}-${slug(founder.name)}-${founder.id}`);
      }
    }
  }
  const a16z = await readJson(resolve(root, "src/lib/social/a16z-speedrun-006-social-accounts.json"));
  for (const company of a16z.companies ?? []) {
    for (const founder of company.founders ?? []) {
      ids.add(`founder-${company.companySlug}-${founder.founderSlug}`);
    }
  }
  return ids;
}

function hasCommentReceipt(value) {
  return /(?:[?&]commenturn=|urn%3ali%3acomment)/i.test(value);
}

function normalizePlatform(value) {
  const normalized = cleanString(value)?.toLowerCase().replace(/[\s-]+/g, "_");
  return normalized === "twitter" ? "x" : normalized;
}

function canonicalUrl(value) {
  const text = cleanString(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    url.protocol = "https:";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return text;
  }
}

function slug(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function cleanString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function validTimestamp(value) {
  const text = cleanString(value);
  return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : null;
}

function stringArg(name) {
  const prefix = `${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function requiredArg(name) {
  const value = stringArg(name);
  if (!value) throw new Error(`Pass ${name}=<value>.`);
  return value;
}

function relativePath(path) {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJsonAtomic(path, payload) {
  const tempPath = resolve(dirname(path), `.${path.split("/").pop()}.${process.pid}.tmp`);
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`);
  await rename(tempPath, path);
}
