import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { verifiedNativeLinkedInFounderHistoryReasons } from "../src/lib/graph/linkedin-founder-history-receipt.mjs";
import { verifiedNativeLinkedInCompanyDetailReasons } from "../src/lib/graph/linkedin-company-detail-receipt.mjs";
import { verifiedFallLinkedInFounderAccounts } from "../src/lib/graph/linkedin-founder-aliases.mjs";

const option = (key) => process.argv.find((arg) => arg.startsWith(`${key}=`))?.slice(key.length + 1);
const write = process.argv.includes("--write");
if (write === process.argv.includes("--dry-run")) throw new Error("Pass exactly one of --write or --dry-run.");
const output = option("--output");
if (!output || write && !option("--expected-target-sha256")) throw new Error("Pass a new --output directory and an expected target SHA for writes.");
const path = "src/lib/social/targeted-evidence-current.json", bytes = await readFile(path);
const sha = (value) => createHash("sha256").update(value).digest("hex");
if (write && sha(bytes) !== option("--expected-target-sha256")) throw new Error("Canonical evidence changed before the repair.");
const source = JSON.parse(bytes), roster = JSON.parse(await readFile("src/lib/yc/fall-2026-companies.json", "utf8")), aliases = JSON.parse(await readFile("src/lib/social/linkedin-founder-aliases-fall-2026.json", "utf8"));
const earlier = (value) => sha(JSON.stringify(value.evidence.filter((row) => row.batchSlug !== "F26")));
const earlierSha256 = earlier(source), corrections = [];
const slugify = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
for (const row of source.evidence) {
  if (row.batchSlug !== "F26" || row.platform !== "linkedin" || !["native_linkedin_founder_history_v1", "native_linkedin_company_detail_v1"].includes(row.attributionProvenance)) continue;
  const raw = JSON.parse(row.rawVisibleText), native = raw.post?.text;
  if (typeof native !== "string" || row.text === native) continue;
  if (row.text !== native.trim() || row.originalText !== native) throw new Error(`Native body conflict requires independent review: ${row.sourceUrl}`);
  const company = roster.companies.find((company) => company.slug === row.companySlug);
  if (!company) throw new Error("Unknown company in scoped whitespace repair.");
  let reasons;
  const candidate = { ...row, text: native };
  if (row.attributionProvenance === "native_linkedin_founder_history_v1") {
    const founder = company.founders.find((founder) => String(founder.id) === raw.post.nativeFounderHistoryReceipt?.founderId);
    reasons = founder ? verifiedNativeLinkedInFounderHistoryReasons(candidate, { entityId: `founder-${company.slug}-${slugify(founder.name)}-${founder.id}`, companySlug: company.slug, companyName: company.name, founderName: founder.name, socialAccounts: { linkedin: verifiedFallLinkedInFounderAccounts(company, founder, aliases) } }) : ["unknown_founder"];
  } else reasons = verifiedNativeLinkedInCompanyDetailReasons(candidate, { entityId: `company-${company.slug}`, companySlug: company.slug, companyName: company.name, socialAccounts: { linkedin: [company.socialLinks.linkedin] } });
  if (reasons.length) throw new Error(`Restored native body did not pass its full receipt gate: ${reasons.join(",")}`);
  if (!raw.observationSource || sha(await readFile(raw.observationSource)) !== raw.observationSourceSha256) throw new Error("Frozen native source archive SHA changed.");
  if (raw.sourceHistory && sha(await readFile(raw.sourceHistory.path)) !== raw.sourceHistory.sha256) throw new Error("Frozen native history archive SHA changed.");
  corrections.push({ entityId: row.entityId, platformPostId: row.platformPostId, sourceUrl: row.sourceUrl, beforeText: row.text, afterText: native, originalTextPreserved: true, nativeBodySha256: sha(native), observationSource: raw.observationSource, observationSourceSha256: raw.observationSourceSha256 });
  row.text = native;
}
if (earlier(source) !== earlierSha256) throw new Error("Earlier cohort evidence changed during scoped repair.");
await mkdir(output, { recursive: false });
await writeFile(`${output}/targeted-before.json`, bytes);
const after = `${JSON.stringify(source, null, 2)}\n`;
if (write) {
  if (sha(await readFile(path)) !== sha(bytes)) throw new Error("Canonical evidence changed during the repair.");
  await writeFile(`${path}.tmp`, after); await rename(`${path}.tmp`, path);
  await writeFile(`${output}/targeted-after.json`, after);
}
const audit = { status: write ? "written" : "dry_run", scope: "F26_verified_native_linkedin_whitespace_only", targetBeforeSha256: sha(bytes), targetAfterSha256: write ? sha(after) : null, preservedEarlierCohortSha256: earlierSha256, corrected: corrections.length, corrections };
await writeFile(`${output}/audit.json`, `${JSON.stringify(audit, null, 2)}\n`);
console.log(JSON.stringify(audit));
