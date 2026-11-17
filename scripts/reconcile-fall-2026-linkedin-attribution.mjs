import { spawnSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { linkedinReconciliationSha256 as sha, planFallLinkedInAttributionReconciliation } from "./lib/fall-linkedin-attribution-reconciliation.mjs";

export async function reconcileFallLinkedInAttribution(options) {
  const { target, auditPath, candidatePath, output, expectedTargetSha256, expectedAuditSha256, expectedCandidateSha256, write } = options;
  const [beforeText, auditText, candidateText, rosterText] = await Promise.all([
    readFile(target, "utf8"), readFile(auditPath, "utf8"), readFile(candidatePath, "utf8"), readFile("src/lib/yc/fall-2026-companies.json", "utf8")
  ]);
  for (const [label, actual, expected] of [["target", sha(beforeText), expectedTargetSha256], ["audit", sha(auditText), expectedAuditSha256], ["candidate", sha(candidateText), expectedCandidateSha256]]) {
    if (!/^[a-f0-9]{64}$/.test(expected ?? "") || actual !== expected) throw new Error(`${label} SHA256 does not match explicit expected value.`);
  }
  const before = JSON.parse(beforeText), audit = JSON.parse(auditText), candidates = JSON.parse(candidateText);
  const observations = new Map();
  const paths = new Set([...audit.corrections, ...audit.needsReview, ...candidates.needsReview].map((row) => row.browserObservationPath).filter(Boolean));
  await mkdir(output, { recursive: false });
  const sources = [];
  for (const path of paths) {
    if (!path.startsWith("outputs/fall-2026/browser-checkpoints/") || path.includes("..")) throw new Error("Native source path must be a local Fall browser checkpoint.");
    const text = await readFile(path, "utf8");
    observations.set(path, JSON.parse(text));
    const filename = `native-source-${sources.length}.json`;
    await writeFile(resolve(output, filename), text);
    sources.push({ originalPath: path, frozenPath: filename, sha256: sha(text) });
  }
  const save = (name, value) => writeFile(resolve(output, name), `${JSON.stringify(value, null, 2)}\n`);
  await Promise.all([writeFile(resolve(output, "targeted-before.json"), beforeText), writeFile(resolve(output, "attribution-audit.json"), auditText), writeFile(resolve(output, "linkedin-candidates.json"), candidateText), writeFile(resolve(output, "roster.json"), rosterText)]);
  const plan = planFallLinkedInAttributionReconciliation({ before, audit, candidates, roster: JSON.parse(rosterText), observations });
  await save("removed-original-versions.json", plan.removed);
  await save("quarantined-native-observations.json", plan.held);
  await save("corrected-founder-input.json", { evidence: plan.correctedInput });
  await save("staging-target.json", plan.staging);
  const observedAt = new Date().toISOString();
  const result = spawnSync(process.execPath, ["scripts/import-source-hunt-evidence.mjs", `--target=${output}/staging-target.json`, `--input=${output}/corrected-founder-input.json`, "--include-batches=F26", "--scope-batch-dedupe", "--retain-zero-engagement", "--append-only", "--strict", `--observed-at=${observedAt}`, `--audit-output=${output}/strict-import-audit.json`, "--write"], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  await writeFile(resolve(output, "strict-import.log"), result.stdout + result.stderr);
  if (result.status !== 0) throw new Error("Corrected native founders failed the unchanged strict importer.");
  const after = JSON.parse(await readFile(resolve(output, "staging-target.json"), "utf8"));
  const earlier = (artifact) => artifact.evidence.filter((row) => row.batchSlug !== "F26");
  if (sha(JSON.stringify(earlier(before))) !== sha(JSON.stringify(earlier(after)))) throw new Error("Earlier cohort evidence changed.");
  for (const [id, decision] of plan.decisions) {
    const rows = after.evidence.filter((row) => row.batchSlug === "F26" && row.platform === "linkedin" && row.platformPostId === id);
    if (decision.kind === "hold" ? rows.length : rows.length !== 1 || rows[0].entityId !== decision.entry.entityId) throw new Error(`Reconciled physical post mismatch: ${id}`);
  }
  const receipt = { source: "fall_2026_linkedin_native_author_reconciliation_v1", observedAt, expectedTargetSha256, expectedAuditSha256, expectedCandidateSha256, sourceArtifacts: sources, rosterSha256: sha(rosterText), auditArchivePath: resolve(output, "attribution-audit.json"), removedArchivePath: resolve(output, "removed-original-versions.json"), correctedFounderIds: plan.correctedInput.map((row) => row.platformPostId), quarantinedIds: plan.held.map((row) => row.platformPostId) };
  after.attributionReconciliationLedger = [...(after.attributionReconciliationLedger ?? []), receipt];
  const text = `${JSON.stringify(after, null, 2)}\n`;
  await writeFile(resolve(output, "targeted-after.json"), text);
  if (sha(await readFile(target, "utf8")) !== expectedTargetSha256) throw new Error("Canonical changed during preflight; no write performed.");
  if (write) {
    await writeFile(`${target}.${process.pid}.tmp`, text); await rename(`${target}.${process.pid}.tmp`, target);
    if (resolve(target) === resolve("src/lib/social/targeted-evidence-current.json")) await writeFile("outputs/fall-2026/collection/targeted-evidence-canonical-checkpoint.json", text);
  }
  const summary = { status: write ? "written" : "dry_run_canonical_unchanged", before: before.evidence.length, after: after.evidence.length, removedPreviousVersions: plan.removed.length, correctedFounderPosts: plan.correctedInput.length, quarantinedPosts: plan.held.length, preservedEarlierCohortRows: earlier(after).length, preservedEarlierCohortSha256: sha(JSON.stringify(earlier(after))), targetBeforeSha256: expectedTargetSha256, targetAfterSha256: sha(text), output };
  await save("audit.json", summary);
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), get = (key, fallback) => args.find((arg) => arg.startsWith(`${key}=`))?.slice(key.length + 1) ?? fallback;
  if (args.includes("--write") === args.includes("--dry-run")) throw new Error("Pass exactly one of --write or --dry-run.");
  console.log(JSON.stringify(await reconcileFallLinkedInAttribution({
    target: get("--target", "src/lib/social/targeted-evidence-current.json"), auditPath: get("--audit"), candidatePath: get("--candidates"), output: get("--output"),
    expectedTargetSha256: get("--expected-target-sha256"), expectedAuditSha256: get("--expected-audit-sha256"), expectedCandidateSha256: get("--expected-candidate-sha256"), write: args.includes("--write")
  })));
}
