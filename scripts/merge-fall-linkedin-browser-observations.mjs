import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const checkpointPath = resolve(root, "outputs/fall-2026/linkedin-browser-checkpoint.json");
const inputPaths = process.argv.slice(2);
if (!inputPaths.length) throw new Error("Pass at least one local browser observation JSON path.");
const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
const roster = JSON.parse(await readFile(resolve(root, "src/lib/yc/fall-2026-companies.json"), "utf8"));
const companies = new Map(roster.companies.map((company) => [company.slug, company]));
const evidenceById = new Map(checkpoint.evidence.map((row) => [row.platformPostId, row]));
const profilesBySlug = new Map(checkpoint.profiles.map((profile) => [profile.companySlug, profile]));
let inserted = 0;
let refreshed = 0;
const normalizeAccount = (url) => {
  const parsed = new URL(url.replace(/^http:/, "https:"));
  const path = parsed.pathname.replace(/\/$/, "").toLowerCase();
  return path.startsWith("/company/") || path.startsWith("/in/") ? path : `${path}${parsed.search}`;
};
for (const inputPath of inputPaths) {
  const observation = JSON.parse(await readFile(resolve(root, inputPath), "utf8"));
  for (const profile of observation.profiles ?? []) {
    const company = companies.get(profile.companySlug);
    if (!company || normalizeAccount(profile.officialProfileUrl) !== normalizeAccount(company.socialLinks.linkedin)) {
      throw new Error(`Unverified official LinkedIn identity: ${profile.companySlug}`);
    }
    for (const captured of profile.rows ?? []) {
      const postId = captured.sourceUrl?.match(/^https:\/\/www\.linkedin\.com\/feed\/update\/urn:li:(?:activity|ugcPost):(\d+)\/?$/)?.[1];
      if (!postId || !captured.text?.trim() || !Number.isFinite(Date.parse(captured.observedAt))) {
        throw new Error(`Incomplete native LinkedIn observation: ${profile.companySlug}/${captured.sourceUrl}`);
      }
      if (captured.preview?.activityUrn && captured.preview.activityUrn !== `urn:li:activity:${postId}`) {
        throw new Error(`Mismatched native preview receipt: ${postId}`);
      }
      const metrics = {};
      for (const link of captured.preview?.links ?? []) {
        const label = link.ariaLabel ?? link.text ?? "";
        const metric = label.match(/^(\d[\d,]*)\s+(Reactions|Comments|Reposts)$/i);
        if (metric) metrics[metric[2].toLowerCase()] = Number(metric[1].replace(/,/g, ""));
      }
      for (const control of captured.visibleMetricControls ?? []) {
        const key = control.label?.startsWith("Reaction button state:") ? "reactions"
          : control.label === "Comment" ? "comments"
            : control.label === "Repost" ? "reposts" : null;
        if (key && /^\d[\d,]*$/.test(control.text)) metrics[key] = Number(control.text.replace(/,/g, ""));
      }
      for (const [label, key] of [["reactions", "reactions"], ["comments", "comments"], ["reposts", "reposts"]]) {
        const value = captured.cardText?.match(new RegExp(`(?:^|\\n)([\\d,]+) ${label}(?:$|\\n)`, "i"))?.[1];
        if (value && metrics[key] === undefined) metrics[key] = Number(value.replace(/,/g, ""));
      }
      const row = {
        platformPostId: postId,
        dateLabel: captured.dateLabel,
        metrics,
        text: captured.text,
        originalText: captured.text,
        kind: captured.dateLabel?.startsWith("with ") ? "coauthored_company_post" : "original_company_post",
        companySlug: company.slug,
        companyName: company.name,
        batchSlug: "F26",
        entityType: "company",
        entityId: `company-${company.slug}`,
        authorName: profile.observedAccountName ?? company.name,
        accountUrl: company.socialLinks.linkedin,
        sourceUrl: `${captured.sourceUrl.replace(/\/$/, "")}/`,
        postedAt: null,
        publishedAtPrecision: "unknown",
        platform: "linkedin",
        collectionMethod: captured.collectionMethod ?? "signed_in_browser_dom_embed_preview",
        collectionSurface: captured.collectionSurface ?? (profile.status?.includes("home")
          ? "public_company_home_posts" : "public_company_posts_history"),
        observedAt: captured.observedAt,
        identitySourceUrl: company.ycProfileUrl,
        browserObservationPath: inputPath,
        nativePreviewActivityUrn: captured.preview?.activityUrn ?? null
      };
      const existing = evidenceById.get(postId);
      if (existing && existing.companySlug !== row.companySlug) throw new Error(`Native post has conflicting company attribution: ${postId}`);
      evidenceById.set(postId, { ...existing, ...row });
      if (existing) refreshed += 1;
      else inserted += 1;
    }
    const existingProfile = profilesBySlug.get(company.slug) ?? {};
    profilesBySlug.set(company.slug, {
      ...existingProfile,
      companySlug: company.slug,
      accountUrl: company.socialLinks.linkedin,
      observedAccountName: profile.observedAccountName ?? company.name,
      status: profile.status ?? (profile.historyComplete ? "captured_posts_history" : "partial_posts_history"),
      originalRows: [...evidenceById.values()].filter((row) => row.companySlug === company.slug).length,
      historyComplete: Boolean(profile.historyComplete || existingProfile.historyComplete),
      ...(profile.historyEndProof ? { historyEndProof: profile.historyEndProof } : {}),
      ...(profile.excludedPlainRepostCount !== undefined ? { excludedPlainRepostCount: profile.excludedPlainRepostCount } : {}),
      ...(profile.coverageNote ? { coverageNote: profile.coverageNote } : {}),
      ...(profile.identityNote ? { identityNote: profile.identityNote } : {}),
      ...(profile.resolvedProfileUrl ? { resolvedProfileUrl: profile.resolvedProfileUrl } : {}),
      browserObservationPath: inputPath,
      observedAt: profile.observedAt
    });
  }
}
checkpoint.evidence = [...evidenceById.values()];
checkpoint.profiles = [...profilesBySlug.values()];
checkpoint.source.lastUpdatedAt = new Date().toISOString();
checkpoint.status = "partial_full_history_collection";
checkpoint.coverage = {
  profilesChecked: checkpoint.profiles.length,
  originalPostRows: checkpoint.evidence.length,
  historyCompleteProfiles: checkpoint.profiles.filter((profile) => profile.historyComplete).length,
  rateLimitOrChallengeObserved: false
};
await writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
console.log(JSON.stringify({ inserted, refreshed, ...checkpoint.coverage }));
