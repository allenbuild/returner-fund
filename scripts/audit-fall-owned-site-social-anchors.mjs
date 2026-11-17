import fs from "node:fs";
import crypto from "node:crypto";
import * as cheerio from "cheerio";

// A literal-anchor inventory over files already on disk. No requests or identity promotions.
const base = "outputs/fall-2026";
const manifest = new Map();
const hash = (s) => crypto.createHash("sha256").update(s).digest("hex");
const read = (p) => {
  const b = fs.readFileSync(p);
  manifest.set(p, { path: p, sha256: hash(b), bytes: b.length });
  return JSON.parse(b);
};
const archivePath = "outputs/source-hunt/2026-11-15-fall-2026-public-history-archive.json";
const archive = read(archivePath);
const roster = read("src/lib/yc/fall-2026-companies.json").companies;
const official = read(`${base}/official-social-targets.json`);
const instagram = read(`${base}/instagram-official-website-outbound-links.json`);
const identities = read(`${base}/instagram-verified-identity-proofs-current.json`);
const approved = read("src/lib/social/targeted-evidence-current.json");
const host = (v) => { try { return new URL(v).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };
const social = (value) => {
  try {
    const u = new URL(value), h = u.hostname.toLowerCase().replace(/^www\./, ""), ps = u.pathname.split("/").filter(Boolean);
    if (h === "instagram.com") {
      if (!ps[0] || /^(?:p|reel|reels|explore|accounts|direct|stories|about|developer|directory)$/.test(ps[0])) return { platform: "instagram", kind: "generic_or_post_link", key: `instagram:url:${u.href}` };
      return { platform: "instagram", kind: ps.length === 1 ? "profile" : "account_post_or_tab", account: ps[0].toLowerCase(), key: `instagram:${ps[0].toLowerCase()}` };
    }
    if (h === "threads.net" || h === "threads.com") {
      if (!ps[0]?.startsWith("@")) return { platform: "threads", kind: "generic_or_action", key: `threads:url:${u.href}` };
      return { platform: "threads", kind: ps.length === 1 ? "profile" : "account_post_or_tab", account: ps[0].slice(1).toLowerCase(), key: `threads:${ps[0].slice(1).toLowerCase()}` };
    }
    if (h === "tiktok.com" || h === "m.tiktok.com" || h === "vm.tiktok.com" || h === "vt.tiktok.com") {
      if (!ps[0]?.startsWith("@")) return { platform: "tiktok", kind: "generic_or_unresolved_shortlink", key: `tiktok:url:${u.href}` };
      return { platform: "tiktok", kind: ps.length === 1 ? "profile" : "account_post_or_tab", account: ps[0].slice(1).toLowerCase(), key: `tiktok:${ps[0].slice(1).toLowerCase()}` };
    }
    if (["facebook.com", "m.facebook.com", "fb.com"].includes(h)) {
      if (!ps[0] || /^(?:sharer|sharer.php|share.php|share|dialog|plugins|login|privacy|policies|help|business|ads|groups|events|watch|reel|reels|story.php|photo|photo.php)$/.test(ps[0])) return { platform: "facebook", kind: "generic_or_action", key: `facebook:url:${u.href}` };
      const account = ps[0] === "profile.php" ? u.searchParams.get("id") : ["people", "pages"].includes(ps[0]) ? ps.at(-1) : ps[0];
      return { platform: "facebook", kind: "profile_or_page", account, key: `facebook:${account?.toLowerCase()}` };
    }
  } catch { /* Literal malformed URL remains outside the inventory. */ }
  return null;
};
const known = new Set();
for (const url of [
  ...official.targets.map((t) => t.url), ...instagram.links.map((l) => l.instagramUrl),
  ...identities.companies.flatMap((c) => c.accounts.map((a) => a.profileUrl)),
  ...approved.evidence.filter((r) => r.batchSlug === "F26" && r.review_state === "verified").map((r) => r.accountUrl),
]) { const s = social(url); if (s) known.add(s.key); }

const candidates = new Map(), held = new Map(), alreadyKnown = new Map(), scanned = new Map(), failures = [];
let anchorOccurrences = 0;
const fold = (v) => v.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
for (const company of archive.companies) {
  const co = roster.find((c) => c.slug === company.companySlug);
  if (!co) continue;
  const officialHost = host(company.officialWebsite);
  const homes = company.attempts.filter((a) => a.kind === "official_homepage" && a.status >= 200 && a.status < 400);
  const allowedHosts = new Set([officialHost, ...homes.map((a) => host(a.finalUrl))].filter(Boolean));
  const ownedHost = (value) => [...allowedHosts].some((h) => value === h || value.endsWith(`.${h}`));
  for (const attempt of company.attempts) {
    const file = attempt.bodyArchivePath;
    if (!file?.endsWith(".html") || scanned.has(`${company.companySlug}:${file}`) || !fs.existsSync(file)) continue;
    const bytes = fs.readFileSync(file), sha256 = hash(bytes), html = bytes.toString("utf8");
    const sourceHost = host(attempt.finalUrl);
    const hostOwned = ownedHost(sourceHost);
    scanned.set(`${company.companySlug}:${file}`, { companySlug: company.companySlug, path: file, sha256, declaredSha256: attempt.sha256, shaMatches: sha256 === attempt.sha256, requestedUrl: attempt.requestedUrl, finalUrl: attempt.finalUrl, kind: attempt.kind, hostOwned });
    if (sha256 !== attempt.sha256) { failures.push({ file, reason: "archive_sha_mismatch" }); continue; }
    if (!/<a\b[^>]*\bhref\s*=\s*["'][^"']*(?:instagram\.com|threads\.(?:net|com)|tiktok\.com|facebook\.com|fb\.com)/i.test(html)) continue;
    const $ = cheerio.load(html);
    for (const a of $("a[href]").toArray()) {
      const literalHref = $(a).attr("href");
      let url;
      try { url = new URL(literalHref, attempt.finalUrl).href; } catch { continue; }
      const s = social(url); if (!s) continue;
      anchorOccurrences++;
      const anchorHtml = $.html(a), anchorText = $(a).text().replace(/\s+/g, " ").trim();
      const parents = $(a).parents().toArray();
      const footer = parents.find((e) => e.tagName === "footer" || $(e).attr("role") === "contentinfo");
      const contactNavigation = parents.find((e) => /contact|social/i.test($(e).attr("class") ?? "") && $(e).text().length < 1000 && [...allowedHosts].some((h) => $(e).find("a[href^='mailto:']").toArray().some((l) => $(l).attr("href")?.toLowerCase().split("?")[0].endsWith(`@${h}`))));
      const biography = parents.find((e) => {
        const text = $(e).text().replace(/\s+/g, " ").trim();
        return text.length < 1800 && /founder|co-founder|cofounder|ceo|cto|cso/i.test(text) && co.founders.some((f) => fold(text).includes(fold(f.name)));
      });
      const ancestor = biography ?? footer ?? contactNavigation ?? a.parent;
      const ancestorText = $(ancestor).text().replace(/\s+/g, " ").trim();
      const founderMatches = co.founders.filter((f) => fold(ancestorText).includes(fold(f.name))).map((f) => ({ id: f.id, name: f.name, title: f.title, ycProfileUrl: f.ycProfileUrl }));
      const articleContext = /\/(?:blog|blogs|news|articles?|press|interviews?|case-studies|customers?|stories|testimonials)(?:\/|$)/i.test(new URL(attempt.finalUrl).pathname);
      const testimonialContext = parents.some((e) => /testimonial|customer-review|blockquote/i.test(`${e.tagName} ${$(e).attr("class") ?? ""} ${$(e).attr("id") ?? ""}`));
      const companyFooter = Boolean(footer && (fold($(footer).text()).includes(fold(co.name)) || [...allowedHosts].some((h) => fold($(footer).text()).includes(h)) || $(footer).find("a[href]").toArray().some((l) => { try { return ownedHost(host(new URL($(l).attr("href"), attempt.finalUrl).href)); } catch { return false; } })));
      let confidence = "unverified_outbound_link", entityType = null, holdReason = "ownership_not_established_by_literal_anchor_alone";
      if (!hostOwned) holdReason = "external_domain_not_proven_by_official_homepage_redirect";
      else if (!s.account) holdReason = "generic_platform_action_or_post_only_link_not_account_identity";
      else if (testimonialContext) holdReason = "testimonial_or_quoted_customer_context_not_owned_identity";
      else if (biography && founderMatches.length === 1 && !articleContext) { confidence = "exact_roster_founder_in_bounded_owned_team_biography"; entityType = "founder"; holdReason = "native_profile_identity_and_current_access_state_pending"; }
      else if (companyFooter) { confidence = "literal_company_footer_on_proven_official_domain"; entityType = "company"; holdReason = "native_profile_identity_pending_company_footer_is_not_native_authorship"; }
      else if (contactNavigation) { confidence = "literal_company_contact_social_navigation_with_official_email_domain"; entityType = "company"; holdReason = "native_profile_identity_pending_official_contact_link_is_not_native_authorship"; }
      else if (articleContext) holdReason = "article_guest_interview_or_press_context_not_owned_team_identity";
      const row = {
        companySlug: co.slug, companyName: co.name, platform: s.platform, observedUrl: url, literalHref,
        observedAccount: s.account ?? null, urlKind: s.kind, intendedEntityType: entityType,
        ownershipConfidence: confidence, holdReason, promoted: false,
        source: { path: file, sha256, sourceUrl: attempt.finalUrl, requestedUrl: attempt.requestedUrl, kind: attempt.kind, observedAt: attempt.observedAt, officialWebsite: company.officialWebsite, officialYcProfileUrl: company.officialYcProfileUrl, hostOwned, homepageRedirectLineage: homes.map((h) => ({ requestedUrl: h.requestedUrl, finalUrl: h.finalUrl, status: h.status, path: h.bodyArchivePath, sha256: h.sha256 })) },
        anchorHtml, anchorText, containingAncestorHtml: $.html(ancestor), containingAncestorText: ancestorText,
        containingAncestorKind: biography ? "bounded_founder_role_biography" : footer ? "footer" : contactNavigation ? "official_contact_social_navigation" : "anchor_parent",
        matchedRosterFounders: founderMatches,
      };
      const key = `${co.slug}:${s.key}`;
      const target = known.has(s.key) ? alreadyKnown : entityType ? candidates : held;
      if (!target.has(key)) target.set(key, { ...row, occurrenceCount: 0, additionalSourceReceipts: [] });
      const record = target.get(key); record.occurrenceCount++;
      if (record.source.path !== file && record.additionalSourceReceipts.length < 4) record.additionalSourceReceipts.push({ path: file, sha256, sourceUrl: attempt.finalUrl, anchorHtml });
    }
  }
}
const out = {
  schemaVersion: 1, generatedAt: new Date().toISOString(), batchSlug: "F26", source: "offline_literal_owned_site_anchor_audit",
  networkRequestsMade: 0, identityPromotionsMade: 0,
  summary: { companies: archive.companies.length, physicalHtmlFiles: scanned.size, officialOwnedHtmlFiles: [...scanned.values()].filter((s) => s.hostOwned).length, externalHtmlFiles: [...scanned.values()].filter((s) => !s.hostOwned).length, literalSocialAnchorOccurrences: anchorOccurrences, newOwnershipCandidates: candidates.size, heldNewLinks: held.size, alreadyKnownAccountsOrLinks: alreadyKnown.size, archiveHashFailures: failures.length },
  candidates: [...candidates.values()].sort((a, b) => Number(b.intendedEntityType === "founder") - Number(a.intendedEntityType === "founder") || a.companySlug.localeCompare(b.companySlug)),
  held: [...held.values()], alreadyKnown: [...alreadyKnown.values()].map((row) => { const r = { ...row }; delete r.containingAncestorHtml; delete r.containingAncestorText; return r; }),
  physicalSourceManifest: [...scanned.values()], inputManifest: [...manifest.values()], failures,
};
const outputPath = `${base}/owned-site-social-anchor-candidate-queue.json`;
fs.writeFileSync(outputPath, `${JSON.stringify(out, null, 2)}\n`);
const bytes = fs.readFileSync(outputPath);
console.log(JSON.stringify({ outputPath, bytes: bytes.length, sha256: hash(bytes), summary: out.summary, candidates: out.candidates.map((c) => ({ company: c.companySlug, platform: c.platform, url: c.observedUrl, entityType: c.intendedEntityType, confidence: c.ownershipConfidence })) }));
