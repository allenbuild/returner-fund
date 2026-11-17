import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareRobinFounderPublicationContexts } from "./prepare-fall-2026-robin-publication-context.mjs";
import {
  ROBIN_FOUNDER_PUBLICATION_SOURCE, isVerifiedRobinFounderPublicationContext,
  robinPublicationNativeFields, robinPublicationSha256 as sha
} from "../src/lib/graph/robin-founder-publication-context-receipt.mjs";

const TARGET = "src/lib/social/targeted-evidence-current.json";
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hash = (value) => /^[a-f0-9]{64}$/.test(value ?? "");
const requireCondition = (condition, reason) => { if (!condition) throw new Error(reason); };
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// Locate top-level JSON values without reserializing any existing evidence row.
function valueEnd(text, start) {
  const initial = text[start];
  if (initial === '"') {
    for (let at = start + 1; at < text.length; at++) {
      if (text[at] === "\\") at++;
      else if (text[at] === '"') return at + 1;
    }
  } else if (initial === "{" || initial === "[") {
    let depth = 1, quoted = false;
    for (let at = start + 1; at < text.length; at++) {
      const character = text[at];
      if (quoted) { if (character === "\\") at++; else if (character === '"') quoted = false; }
      else if (character === '"') quoted = true;
      else if (character === "{" || character === "[") depth++;
      else if ((character === "}" || character === "]") && --depth === 0) return at + 1;
    }
  } else {
    let at = start;
    while (at < text.length && !/[\s,}\]]/.test(text[at])) at++;
    return at;
  }
  throw new Error("malformed_target_json_value");
}

function envelopeSpans(text) {
  const spans = new Map();
  let at = text.search(/\S/);
  requireCondition(text[at++] === "{", "target_must_be_json_object");
  while (at < text.length) {
    while (/\s/.test(text[at] ?? "") && at < text.length) at++;
    if (text[at] === "}") break;
    const keyEnd = valueEnd(text, at), key = JSON.parse(text.slice(at, keyEnd));
    at = keyEnd;
    while (/\s/.test(text[at] ?? "") && at < text.length) at++;
    requireCondition(text[at++] === ":", "target_json_property_colon_missing");
    while (/\s/.test(text[at] ?? "") && at < text.length) at++;
    const end = valueEnd(text, at);
    if (key === "source" || key === "evidence") {
      requireCondition(!spans.has(key), "duplicate_target_envelope_property");
      spans.set(key, { start: at, end });
    }
    at = end;
    while (/\s/.test(text[at] ?? "") && at < text.length) at++;
    if (text[at] === ",") at++;
    else { requireCondition(text[at] === "}", "target_json_property_separator_missing"); break; }
  }
  requireCondition(spans.has("source") && spans.has("evidence"), "target_source_and_evidence_required");
  return spans;
}

function sameOriginal(prior, row, entity) {
  return isVerifiedRobinFounderPublicationContext(prior, entity)
    && equal(robinPublicationNativeFields(prior), robinPublicationNativeFields(row))
    && prior.entityId === row.entityId && prior.companySlug === row.companySlug
    && prior.authorName === row.authorName && prior.originalText === row.originalText;
}

/** Pure append plan; the CLI always obtains prepared rows from physical verification. */
export function planRobinPublicationAppend(beforeText, prepared) {
  const before = JSON.parse(beforeText), spans = envelopeSpans(beforeText);
  requireCondition(isRecord(before.source) && Array.isArray(before.evidence), "invalid_targeted_evidence_envelope");
  requireCondition(prepared?.source?.kind === ROBIN_FOUNDER_PUBLICATION_SOURCE && prepared.evidence?.length === 2
    && prepared.audit?.status === "physically_verified_prepared_context_only", "physical_robin_preparation_required");
  const entity = prepared.audit.exactOwner, accepted = [], duplicates = [];
  requireCondition(new Set(prepared.evidence.map((row) => row.sourceUrl)).size === prepared.evidence.length
    && new Set(prepared.evidence.map((row) => row.nativePostId)).size === prepared.evidence.length, "duplicate_prepared_robin_publication_identity");
  const urls = new Map(), nativeIds = new Map(), ids = new Set();
  const addIndex = (map, key, row) => { if (key) map.set(key, [...(map.get(key) ?? []), row]); };
  const index = (row) => {
    addIndex(urls, row.sourceUrl, row);
    if (row.platformPostId !== row.sourceUrl) addIndex(urls, row.platformPostId, row);
    if (row.publisherPlatform === "substack" || row.nativePublicationId === 2319101
      || /^https:\/\/[^/]*substack\.com\//.test(row.sourceUrl ?? "")) addIndex(nativeIds, String(row.nativePostId ?? ""), row);
    if (row.id) ids.add(row.id);
  };
  before.evidence.forEach(index);
  for (const candidate of prepared.evidence) {
    requireCondition(isVerifiedRobinFounderPublicationContext(candidate, entity), "prepared_robin_receipt_rejected");
    const row = { ...candidate, id: `web-f26-founder-publication-${sha(`${candidate.entityId}:${candidate.nativePublicationId}:${candidate.nativePostId}`).slice(0, 24)}`,
      publishedAtPrecision: "exact", mediaType: "text", first_seen_at: candidate.observedAt,
      last_checked_at: candidate.observedAt, last_updated_at: candidate.postedAt,
      linkStatus: "verified", linkCheckedAt: candidate.observedAt, attributionVersion: 3,
      why: "Full public founder-owned publication original preserved with verified byline and native publication date; zero score.",
      matchReason: "The official roster founder's native profile links his personal website; its self biography, reciprocal account link and literal publication footer establish ownership. Hashed public article HTML and RSS agree on the full body, Robin Choy byline and native publication date.",
      attributionSignals: ["exact_official_roster_founder_and_native_profile_anchor", "personal_site_self_biography_reciprocal_account_and_owned_publication_anchor", "full_public_article_html_and_rss_body_byline_native_date_sha256_verified"] };
    const collisions = [...new Set([...(urls.get(row.sourceUrl) ?? []), ...(nativeIds.get(row.nativePostId) ?? [])])];
    if (collisions.length) {
      requireCondition(collisions.length === 1 && sameOriginal(collisions[0], row, entity), "existing_robin_publication_identity_body_owner_or_date_conflict");
      duplicates.push({ sourceUrl: row.sourceUrl, nativePostId: row.nativePostId, existingId: collisions[0].id ?? null });
      continue;
    }
    requireCondition(!ids.has(row.id), "existing_robin_publication_evidence_id_conflict");
    accepted.push(row); index(row);
  }
  const earlier = JSON.stringify(before.evidence.filter((row) => row.batchSlug !== "F26"));
  const existingRowsSha256 = sha(JSON.stringify(before.evidence));
  const array = spans.get("evidence"), source = spans.get("source");
  requireCondition(beforeText[array.start] === "[" && beforeText[array.end - 1] === "]", "target_evidence_array_required");
  const priorArrayContents = beforeText.slice(array.start + 1, array.end - 1);
  let nextText = beforeText;
  if (accepted.length) {
    const timestamps = [before.source.fetchedAt, ...accepted.map((row) => row.observedAt)].map((value) => Date.parse(value ?? "")).filter(Number.isFinite);
    requireCondition(timestamps.length > 0, "native_observation_clock_required");
    const nextSource = { ...before.source, fetchedAt: new Date(Math.max(...timestamps)).toISOString(), evidenceCount: before.evidence.length + accepted.length };
    const additions = accepted.map((row) => JSON.stringify(row, null, 2).split("\n").map((line) => `    ${line}`).join("\n")).join(",\n");
    const edits = [
      { start: array.end - 1, end: array.end - 1, text: `${before.evidence.length ? "," : ""}\n${additions}\n  ` },
      { start: source.start, end: source.end, text: JSON.stringify(nextSource, null, 2).replace(/\n/g, "\n  ") }
    ].sort((a, b) => b.start - a.start);
    for (const edit of edits) nextText = nextText.slice(0, edit.start) + edit.text + nextText.slice(edit.end);
  }
  // Only source metadata and new rows are changed. Keep the original array bytes as an exact prefix.
  const nextArray = envelopeSpans(nextText).get("evidence");
  requireCondition(nextText.slice(nextArray.start + 1, nextArray.start + 1 + priorArrayContents.length) === priorArrayContents, "existing_evidence_raw_bytes_changed");
  return { nextText, accepted, duplicates, audit: {
    received: prepared.evidence.length, accepted: accepted.length, duplicates: duplicates.length, rejected: 0,
    before: before.evidence.length, after: before.evidence.length + accepted.length,
    beforeTargetSha256: sha(beforeText), proposedTargetSha256: sha(nextText),
    earlierCohortRowsSha256: sha(earlier), existingRowsSha256,
    priorEvidenceArrayContentsSha256: sha(priorArrayContents), existingRowsByteEquivalent: true,
    earlierCohortsUnchanged: true, nativeSocialPostsAdded: 0, fullPublicationHistoryEndProven: false
  } };
}

/** Cooperative lock plus a final byte-for-byte CAS; no stale-lock takeover. */
export async function commitRobinPublicationAppend({ targetPath, beforeText, nextText, expectedTargetSha256 }) {
  requireCondition(hash(expectedTargetSha256) && sha(beforeText) === expectedTargetSha256, "target_compare_and_swap_hash_conflict");
  const lockPath = `${targetPath}.lock`, temporary = `${targetPath}.robin-${randomUUID()}.next`;
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
    requireCondition(await readFile(targetPath, "utf8") === beforeText, "target_changed_before_robin_commit");
    const staged = await open(temporary, "wx", 0o600);
    try { await staged.writeFile(nextText); await staged.sync(); } finally { await staged.close(); }
    const latest = await readFile(targetPath, "utf8");
    requireCondition(latest === beforeText && sha(latest) === expectedTargetSha256, "target_compare_and_swap_changed_before_robin_rename");
    await rename(temporary, targetPath);
    requireCondition(sha(await readFile(targetPath)) === sha(nextText), "robin_committed_target_hash_conflict");
    return sha(nextText);
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
    if (lock) { await lock.close(); await unlink(lockPath); }
  }
}

export async function ingestRobinFounderPublicationContexts({ rootDir = process.cwd(), mode = "dry-run", target = TARGET,
  inputPath, expectedInputSha256, expectedTargetSha256, output, readArchive } = {}) {
  requireCondition(["dry-run", "write"].includes(mode), "choose_dry_run_or_write");
  if (mode === "write") requireCondition(hash(expectedTargetSha256), "write_requires_expected_target_sha256");
  rootDir = await realpath(resolve(rootDir));
  const targetPath = await realpath(resolve(rootDir, target));
  requireCondition(relative(rootDir, targetPath) && !relative(rootDir, targetPath).startsWith(".."), "target_must_stay_under_root");
  const beforeText = await readFile(targetPath, "utf8");
  if (expectedTargetSha256 !== undefined) requireCondition(expectedTargetSha256 === sha(beforeText), "target_compare_and_swap_hash_conflict");
  // Never trust prepared-contexts.json: reconstruct and rehash the complete physical chain each run.
  const prepared = await prepareRobinFounderPublicationContexts({ rootDir, inputPath, expectedInputSha256, readArchive });
  const plan = planRobinPublicationAppend(beforeText, prepared);
  requireCondition(await readFile(targetPath, "utf8") === beforeText, "target_changed_during_robin_physical_preflight");
  const audit = { ...plan.audit, status: mode === "write" ? "written" : "dry_run", mode, target,
    expectedTargetSha256: expectedTargetSha256 ?? null, archives: prepared.archives,
    archiveFilesVerified: prepared.archives.length, exactOwner: prepared.audit.exactOwner,
    canonicalWritten: false, afterTargetSha256: sha(beforeText), acceptedRows: plan.accepted.map((row) => ({ id: row.id, sourceUrl: row.sourceUrl, nativePostId: row.nativePostId, originalTextSha256: sha(row.text), postedAt: row.postedAt })),
    duplicateRows: plan.duplicates };
  let outputPath;
  if (output) {
    outputPath = resolve(rootDir, output);
    requireCondition(outputPath.startsWith(`${resolve(rootDir, "outputs")}/`), "audit_output_must_stay_under_outputs");
    await mkdir(outputPath, { recursive: false });
    await writeFile(resolve(outputPath, "prepared-contexts.json"), `${JSON.stringify({ source: prepared.source, evidence: plan.accepted }, null, 2)}\n`);
  }
  if (mode === "write" && plan.accepted.length) {
    audit.afterTargetSha256 = await commitRobinPublicationAppend({ targetPath, beforeText, nextText: plan.nextText, expectedTargetSha256 });
    audit.canonicalWritten = true;
    if (outputPath) await writeFile(resolve(outputPath, "targeted-after.json"), plan.nextText);
  }
  if (outputPath) await writeFile(resolve(outputPath, "audit.json"), `${JSON.stringify(audit, null, 2)}\n`);
  return audit;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), value = (flag) => args.find((argument) => argument.startsWith(`${flag}=`))?.slice(flag.length + 1);
  requireCondition(args.includes("--write") !== args.includes("--dry-run"), "choose_exactly_one_of_write_or_dry_run");
  const audit = await ingestRobinFounderPublicationContexts({ mode: args.includes("--write") ? "write" : "dry-run", target: value("--target") ?? TARGET,
    inputPath: value("--input"), expectedInputSha256: value("--expected-input-sha256"), expectedTargetSha256: value("--expected-target-sha256"),
    output: value("--output") ?? `outputs/fall-2026/collection/robin-publication-${Date.now()}` });
  console.log(JSON.stringify(audit));
}
