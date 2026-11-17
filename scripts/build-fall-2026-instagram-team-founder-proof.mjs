import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { buildInstagramFounderTeamIdentity } from "./lib/instagram-founder-team-proof.mjs";

const value = (key, fallback) => process.argv.find((arg) => arg.startsWith(`${key}=`))?.slice(key.length + 1) ?? fallback;
const input = value("--input");
if (!input) throw new Error("Pass an explicit --input=<frozen-native-team-identity.json>.");
const seedPath = value("--seed", "outputs/fall-2026/instagram-all-identity-seed.json");
const output = value("--output", "outputs/fall-2026/instagram-team-founder-proof.json");
const sourceProofs = value("--company-proofs", "outputs/fall-2026/collection/checkpoint-24/instagram-identity-proofs.json");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const bytes = await readFile(input), artifact = JSON.parse(bytes);
if (value("--expected-sha256") && sha(bytes) !== value("--expected-sha256")) throw new Error("Frozen native founder identity SHA changed.");
const roster = JSON.parse(await readFile("src/lib/yc/fall-2026-companies.json", "utf8"));
const company = roster.companies.find((entry) => entry.slug === artifact.companySlug);
const founder = company?.founders.find((entry) => String(entry.id) === artifact.founderId && entry.name === artifact.founderName);
if (!founder) throw new Error("Native identity does not resolve to an exact existing Fall founder.");
const priorProofs = JSON.parse(await readFile(sourceProofs, "utf8"));
const companyGroup = priorProofs.companies.find((entry) => entry.companySlug === company.slug);
const companyProof = companyGroup?.accounts.find((account) => account.entityType === "company");
if (!companyProof) throw new Error("The exact official company account must already be verified.");
const identity = await buildInstagramFounderTeamIdentity({ artifactPath: input, artifactBytes: bytes, company, founder, companyProof });
const proof = {
  entityType: "founder", founderId: String(founder.id), founderName: founder.name,
  handle: identity.handle, profileUrl: identity.profileUrl, visibleWebsite: null,
  visibleBio: artifact.profile.visibleText, companyAccountMention: companyGroup.companyHandle,
  review_state: "verified", observedAt: artifact.profile.observedAt,
  observationSource: input, nativeProfileReceiptSha256: sha(bytes), nativeFounderTeamIdentity: identity,
  verificationNotes: "The official company’s formal team introduction names this exact existing YC founder and corroborating biography. Its captured native primary-company header links exactly the sole personal coauthor; following that literal anchor reaches the matching native personal profile. Source HTML/profile/intro archives are rehashed. Post authorship remains the actual native primary author, independently of coauthor identity."
};
const seedBytes = await readFile(seedPath), seed = JSON.parse(seedBytes);
let group = seed.companies.find((entry) => entry.companySlug === company.slug);
if (!group) { group = structuredClone(companyGroup); seed.companies.push(group); }
const existing = group.accounts.findIndex((entry) => entry.handle === proof.handle);
if (existing >= 0) {
  if (group.accounts[existing].founderId !== proof.founderId) throw new Error("Native account is already mapped to a different owner.");
  group.accounts[existing] = proof;
} else group.accounts.push(proof);
await writeFile(output, `${JSON.stringify({ companySlug: company.slug, founderId: founder.id, proof, identitySourceSha256: sha(bytes) }, null, 2)}\n`);
if (process.argv.includes("--write-seed")) {
  if (!(await readFile(seedPath)).equals(seedBytes)) throw new Error("Identity seed changed during proof validation.");
  await writeFile(`${output}.seed-before.json`, seedBytes);
  await writeFile(seedPath, `${JSON.stringify(seed, null, 2)}\n`);
}
console.log(JSON.stringify({ output, seedWritten: process.argv.includes("--write-seed"), companySlug: company.slug, founderId: founder.id, handle: proof.handle, entityId: identity.entityId }));
