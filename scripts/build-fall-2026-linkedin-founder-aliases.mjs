import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { canonicalLinkedInFounderProfile, verifiedFallLinkedInFounderAccounts } from "../src/lib/graph/linkedin-founder-aliases.mjs";

const args = process.argv.slice(2), inputs = args.filter((arg) => arg.startsWith("--input=")).map((arg) => arg.slice(8));
if (!inputs.length) throw new Error("Pass explicit --input=<native-founder-profile-identity-proof> arguments.");
const output = args.find((arg) => arg.startsWith("--output="))?.slice(9) ?? "src/lib/social/linkedin-founder-aliases-fall-2026.json";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const roster = JSON.parse(await readFile("src/lib/yc/fall-2026-companies.json", "utf8"));
const proofs = [];
for (const path of inputs) {
  const bytes = await readFile(path), input = JSON.parse(bytes);
  const company = roster.companies.find((row) => row.slug === input.companySlug), founder = company?.founders.find((row) => String(row.id) === String(input.founderId) && row.name === input.founderName);
  const original = input.requestedOfficialProfileUrl ?? input.officialProfileUrl;
  if (input.source !== "authorized_linkedin_founder_native_dom_v1" || !founder || canonicalLinkedInFounderProfile(original) !== canonicalLinkedInFounderProfile(founder.socialLinks.linkedin) || input.officialIdentitySourceUrl !== company.ycProfileUrl || input.officialFounderIdentitySourceUrl !== founder.ycProfileUrl) throw new Error("Founder alias does not match the exact official roster identity.");
  const profile = input.nativeRedirectObservation ?? input.profile, target = profile?.resolvedUrl;
  if (!Number.isFinite(Date.parse(profile?.observedAt)) || new Date(profile.observedAt).toISOString() !== profile.observedAt || Date.parse(profile.observedAt) > Date.now() || !canonicalLinkedInFounderProfile(target) || canonicalLinkedInFounderProfile(input.observation?.url) !== canonicalLinkedInFounderProfile(target) || !profile.headings?.includes(founder.name) || typeof profile.mainHtml !== "string" || !profile.links?.some((link) => canonicalLinkedInFounderProfile(link.href) === canonicalLinkedInFounderProfile(target) && normalize(link.text).startsWith(founder.name)) || !normalize(profile.visibleText).startsWith(founder.name)) throw new Error("Native alias profile header and exact target are not corroborated.");
  const profileAnchors = profile.mainHtml.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) ?? [];
  if (!profileAnchors.some((anchor) => anchor.includes(target.replace(/\/$/, "")) && normalize(anchor.replace(/<[^>]*>/g, "")).startsWith(founder.name))) throw new Error("Native alias primary profile HTML is missing.");
  const archives = [{ path, sha256: sha(bytes) }];
  let method, ownership = null;
  if (input.nativeRedirectObservation) {
    method = "native_official_profile_redirect";
  } else {
    const proof = input.officialHomepageFounderLinkProof, htmlBytes = await readFile(proof?.archivedHtmlPath), html = htmlBytes.toString();
    const root = new URL(company.websiteUrl), source = new URL(proof.sourceUrl);
    if (root.hostname.replace(/^www\./, "") !== source.hostname.replace(/^www\./, "") || !["", "/"].includes(source.pathname) || sha(htmlBytes) !== proof.sha256 || canonicalLinkedInFounderProfile(proof.href) !== canonicalLinkedInFounderProfile(target)) throw new Error("Official homepage founder alias archive or domain conflicts.");
    const first = founder.name.split(" ")[0];
    if (company.founders.filter((row) => row.name.split(" ")[0] === first).length !== 1) throw new Error("Homepage first-name founder is not unique in the roster.");
    const figure = (html.match(/<figcaption\b[^>]*>[\s\S]*?<\/figcaption>/gi) ?? []).find((part) => part.includes(`href="${proof.href}"`) && part.includes(`aria-label="${first} on LinkedIn"`) && /<small[^>]*>Co-founder<\/small>/.test(part));
    if (!figure || !normalize(figure.replace(/<[^>]*>/g, "")).startsWith(first)) throw new Error("Exact homepage founder figcaption/role/anchor proof is absent.");
    method = "official_homepage_founder_link_and_native_profile";
    ownership = { officialWebsite: company.websiteUrl, sourceUrl: proof.sourceUrl, founderFigcaptionHtml: figure, htmlSha256: proof.sha256 };
    archives.push({ path: proof.archivedHtmlPath, sha256: proof.sha256 });
  }
  const content = { source: "fall_2026_linkedin_founder_alias_v1", batchSlug: "F26", companySlug: company.slug, founderId: String(founder.id), founderName: founder.name, officialProfileUrl: founder.socialLinks.linkedin, profileUrl: target, method, observedAt: profile.observedAt, officialIdentitySourceUrl: company.ycProfileUrl, officialFounderIdentitySourceUrl: founder.ycProfileUrl, nativeProfile: { heading: founder.name, resolvedUrl: target, mainHtmlSha256: sha(profile.mainHtml) }, ownership, archives };
  const proof = { ...content, validation: { source: "fall_2026_linkedin_founder_alias_ingestion_v1", archiveHashesVerified: true, contentSha256: sha(JSON.stringify(content)) } };
  if (!verifiedFallLinkedInFounderAccounts(company, founder, { proofs: [proof] }).includes(target)) throw new Error("Runtime founder alias validation failed.");
  proofs.push(proof);
}
let previous = { proofs: [] };
try { previous = JSON.parse(await readFile(output, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
const key = (proof) => `${proof.companySlug}:${proof.founderId}:${proof.profileUrl}`;
const merged = new Map((previous.proofs ?? []).map((proof) => [key(proof), proof]));
for (const proof of proofs) merged.set(key(proof), proof);
for (const proof of merged.values()) {
  const company = roster.companies.find((row) => row.slug === proof.companySlug), founder = company?.founders.find((row) => String(row.id) === proof.founderId);
  if (!founder || !verifiedFallLinkedInFounderAccounts(company, founder, { proofs: [proof] }).includes(proof.profileUrl)) throw new Error("Existing founder alias registry entry no longer validates.");
  for (const archive of proof.archives) if (sha(await readFile(archive.path)) !== archive.sha256) throw new Error("Existing founder identity archive changed; rebuild its explicit proof before retaining the alias.");
}
await writeFile(output, `${JSON.stringify({ source: "fall_2026_verified_linkedin_founder_alias_registry_v1", proofs: [...merged.values()] }, null, 2)}\n`);
console.log(JSON.stringify({ output, verifiedAliases: [...merged.values()].map(({ companySlug, founderId, profileUrl, method }) => ({ companySlug, founderId, profileUrl, method })) }));
