import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isOfficialInstagramOutboundReceipt } from "./lib/instagram-official-outbound-proof.mjs";

const args = process.argv.slice(2);
const value = (key, fallback) => args.find((arg) => arg.startsWith(`${key}=`))?.slice(key.length + 1) ?? fallback;
const input = value("--input", "outputs/fall-2026/browser-checkpoints/instagram-all-ui-current.json");
const output = value("--output", "outputs/fall-2026/instagram-verified-identity-proofs.json");
const seedPath = value("--seed", "outputs/fall-2026/instagram-all-identity-seed.json");
const websiteLinksPath = value("--website-links", "outputs/fall-2026/instagram-official-website-outbound-links.json");
const read = async (file) => JSON.parse(await readFile(resolve(file), "utf8"));
const [checkpoint, roster, seed] = await Promise.all([read(input), read("src/lib/yc/fall-2026-companies.json"), read(seedPath)]);
const websiteLinks = await read(websiteLinksPath).catch((error) => {
  if (error.code === "ENOENT") return { links: [] };
  throw error;
});
if (checkpoint.source?.batchSlug !== "F26") throw new Error("Explicit F26 native checkpoint required.");
const companies = [...(seed.companies ?? [seed])];
const known = new Set(companies.map((company) => company.companySlug));
const reviews = [];
for (const profile of checkpoint.verifiedProfiles ?? []) {
  const url = new URL(profile.url);
  const handle = url.pathname.replace(/^\/|\/$/g, "");
  if (url.hostname !== "www.instagram.com" || !/^[A-Za-z0-9_.]+$/.test(handle)) throw new Error("Native profile URL is not a public Instagram account root.");
  if (!String(profile.identity ?? "").split("\n").some((line) => line.trim().toLowerCase() === handle.toLowerCase()) || /sorry, this page isn't available|page may have been removed/i.test(profile.identity)) {
    reviews.push({ profileUrl: profile.url, reason: "native_profile_unavailable_or_identity_header_missing" });
    continue;
  }
  // A dotted username or display name is not a visible website link. Only the
  // bio/link area after the profile statistics can supply native-domain proof.
  const visibleBio = String(profile.identity).split(/\n[\d,.KM]+\s+following\n/i)[1]?.split(/\nFollow\n|\nMessage\n/)[0] ?? "";
  const visibleDomains = new Set((visibleBio.match(/(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}/g) ?? []).map((domain) => domain.toLowerCase().replace(/^www\./, "")));
  const matches = roster.companies.filter((company) => {
    if (!company.websiteUrl) return false;
    return visibleDomains.has(new URL(company.websiteUrl).hostname.toLowerCase().replace(/^www\./, "")) ||
      websiteLinks.links.some((receipt) => isOfficialInstagramOutboundReceipt(receipt, company, profile.url));
  });
  if (matches.length !== 1) {
    reviews.push({ profileUrl: profile.url, reason: "native_bio_domain_does_not_uniquely_match_official_company_website", matchingCompanySlugs: matches.map((company) => company.slug) });
    continue;
  }
  const company = matches[0];
  const visibleWebsite = visibleDomains.has(new URL(company.websiteUrl).hostname.toLowerCase().replace(/^www\./, "")) ? new URL(company.websiteUrl).hostname : null;
  const outboundReceipt = websiteLinks.links.find((receipt) => isOfficialInstagramOutboundReceipt(receipt, company, profile.url));
  if (known.has(company.slug)) continue;
  known.add(company.slug);
  companies.push({
    batchSlug: "F26", companySlug: company.slug, companyHandle: handle,
    accounts: [{
      handle, entityType: "company", profileUrl: profile.url,
      visibleWebsite,
      ...(outboundReceipt ? { officialWebsiteOutboundReceipt: outboundReceipt, websiteReceiptSource: websiteLinksPath } : {}),
      visibleBio: profile.identity, review_state: "verified", observedAt: profile.observedAt,
      verificationNotes: visibleWebsite
        ? "Authorized native company profile DOM contains the exact official YC-listed website domain; the complete observed header is retained as the identity receipt."
        : "The official YC-listed company website links directly to this native account through its Instagram/footer anchor. The exact website receipt and observed native profile header are retained separately.",
      observationSource: input
    }]
  });
}
await writeFile(resolve(output), `${JSON.stringify({ batchSlug: "F26", source: input, companies, needsReview: reviews }, null, 2)}\n`);
console.log(JSON.stringify({ output, companySlugs: companies.map((company) => company.companySlug), needsReview: reviews }));
