import { describe, expect, it } from "vitest";
import { buildGraphResponse } from "@/lib/graph/graph-builder";
import { ycSpring2026GraphDataset } from "@/lib/graph/yc-spring-2026-dataset";
import { buildInstagramCoverageReport } from "@/lib/ingestion/instagram-debug";
import companiesSnapshot from "@/lib/yc/spring-2026-companies.json";
import overridesSnapshot from "@/lib/social/verified-social-overrides.json";
import publicEvidenceSnapshot from "@/lib/social/public-evidence-current.json";
import loggedInEvidenceSnapshot from "@/lib/social/logged-in-evidence-current.json";
import targetedEvidenceSnapshot from "@/lib/social/targeted-evidence-current.json";

type InstagramOverride = {
  companySocialLinks?: {
    instagram?: string;
  };
  instagramValidation?: {
    review_state?: string;
  };
  founders?: Array<{
    name?: string;
    socialLinks?: {
      instagram?: string;
    };
  }>;
  rejectedInstagram?: Array<{
    url?: string;
    reason?: string;
  }>;
  matchReason?: string;
};

const instagramOverrides = overridesSnapshot as Record<string, InstagramOverride>;

function canonicalInstagramUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (!/(^|\.)instagram\.com$/i.test(url.hostname)) return null;
    const handle = url.pathname.split("/").filter(Boolean)[0];
    return handle ? `https://www.instagram.com/${handle.toLowerCase()}/` : null;
  } catch {
    return null;
  }
}

function companyNodeId(slug: string) {
  return `company-${slug}`;
}

function instagramHandle(rawUrl: string | null | undefined): string | null {
  const canonical = canonicalInstagramUrl(rawUrl);
  if (!canonical) return null;
  return canonical.split("/").filter(Boolean).at(-1) ?? null;
}

function instagramHandleFromEvidence(item: { rawVisibleText?: string | null; id?: string | null }): string | null {
  const rawVisibleText = String(item.rawVisibleText ?? "");
  try {
    const parsed = JSON.parse(rawVisibleText);
    const profileHandle = instagramHandle(parsed?.profile?.url) ?? parsed?.profile?.username?.toLowerCase();
    if (profileHandle) return profileHandle;
    const rawHref = parsed?.gridUrl?.rawHref ?? parsed?.gridUrl?.href;
    const rawHrefMatch = String(rawHref ?? "").match(/instagram\.com\/([^/]+)\/(?:p|reel|tv)\//i);
    if (rawHrefMatch?.[1]) return rawHrefMatch[1].toLowerCase();
  } catch {
    // Fall through to regex extraction.
  }

  const rawHrefMatch = rawVisibleText.match(/instagram\.com\/([^/]+)\/(?:p|reel|tv)\//i);
  if (rawHrefMatch?.[1]) return rawHrefMatch[1].toLowerCase();
  const profileUrlMatch = rawVisibleText.match(/"url"\s*:\s*"https?:\/\/(?:www\.)?instagram\.com\/([^"/]+)/i);
  if (profileUrlMatch?.[1]) return profileUrlMatch[1].toLowerCase();
  return null;
}

function verifiedInstagramHandlesBySlug(): Map<string, Set<string>> {
  const handles = new Map<string, Set<string>>();
  for (const [slug, override] of Object.entries(instagramOverrides)) {
    const current = new Set<string>();
    const companyHandle = instagramHandle(override.companySocialLinks?.instagram);
    if (companyHandle) current.add(companyHandle);
    for (const founder of override.founders ?? []) {
      const founderHandle = instagramHandle(founder.socialLinks?.instagram);
      if (founderHandle) current.add(founderHandle);
    }
    if (current.size) handles.set(slug, current);
  }
  return handles;
}

describe("instagram coverage debug report", () => {
  it("explains why Instagram coverage is currently shallow across S2026", () => {
    const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
    const report = buildInstagramCoverageReport({
      graph,
      companies: companiesSnapshot.companies,
      overrides: overridesSnapshot,
      snapshots: [publicEvidenceSnapshot, loggedInEvidenceSnapshot, targetedEvidenceSnapshot],
      discovery: {
        companies_checked: 3,
        searched_with_opencli: false,
        searched_with_web: false,
        candidates: [],
        attempts: []
      }
    });

    expect(report.companyCount).toBe(197);
    expect(report.profiles.snapshotCompanyProfiles).toBe(0);
    expect(report.profiles.snapshotFounderProfiles).toBe(0);
    expect(report.profiles.verifiedCompanyOverrides).toBeGreaterThanOrEqual(1);
    expect(report.rootCause).toContain("The YC Spring 2026 snapshot has zero company-level Instagram profile URLs.");
    expect(report.missingCompanies.length).toBeGreaterThan(100);
    expect(report.feedCompanies.some((row) => row.companyName.toLowerCase() === "heyclicky")).toBe(true);
  });

  it("keeps Synphony attached to its official-site Instagram profile and scored feed rows", () => {
    const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
    const report = buildInstagramCoverageReport({
      graph,
      companies: companiesSnapshot.companies,
      overrides: overridesSnapshot,
      snapshots: [publicEvidenceSnapshot, loggedInEvidenceSnapshot, targetedEvidenceSnapshot],
      discovery: {
        companies_checked: 197,
        searched_with_opencli: false,
        searched_with_web: true,
        candidates: [],
        attempts: []
      }
    });

    const synphonyRows = loggedInEvidenceSnapshot.evidence.filter(
      (item) => item.companySlug === "synphony" && item.platform === "instagram"
    );

    expect(overridesSnapshot.synphony.companySocialLinks.instagram).toBe("https://www.instagram.com/synphonyco/");
    expect(overridesSnapshot.synphony.rejectedInstagram?.[0]?.url).toBe("https://www.instagram.com/Synphony/");
    expect(synphonyRows.length).toBeGreaterThanOrEqual(4);
    expect(synphonyRows.every((item) => item.contributionScore > 0)).toBe(true);
    expect(
      synphonyRows.every(
        (item) =>
          item.thumbnailUrl?.startsWith("/evidence-thumbnails/instagram/") &&
          ["cached-instagram-media", "opencli-screenshot"].includes(item.thumbnailSource ?? "")
      )
    ).toBe(true);
    expect(report.evidence.companiesWithScoredEvidence).toBeGreaterThanOrEqual(3);
  });

  it("trusts official-site verified Instagram accounts as company social accounts", () => {
    const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
    const officialSiteOverrides = Object.entries(instagramOverrides).filter(([, override]) => {
      const matchReason = String(override.matchReason ?? "");
      return (
        override.companySocialLinks?.instagram &&
        /official company website|official-domain instagram handle/i.test(matchReason)
      );
    });

    expect(officialSiteOverrides.length).toBeGreaterThanOrEqual(10);

    for (const [slug, override] of officialSiteOverrides) {
      const node = graph.nodes.find((candidate) => candidate.entityId === companyNodeId(slug));
      const expectedUrl = canonicalInstagramUrl(override.companySocialLinks?.instagram);
      const instagramAccount = node?.socialAccounts.find(
        (account) => account.platform === "instagram" && canonicalInstagramUrl(account.url) === expectedUrl
      );

      expect(node, `${slug} should be present in the S2026 graph`).toBeDefined();
      expect(instagramAccount, `${slug} should expose its official-site Instagram account`).toMatchObject({
        platform: "instagram",
        review_state: "verified"
      });
      expect(instagramAccount?.matchReason.toLowerCase()).toMatch(/official|verified/);
    }
  });

  it("does not promote handles that are recorded as rejected Instagram identities", () => {
    const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
    const rejectedUrls = new Map<string, string>();

    for (const [slug, override] of Object.entries(instagramOverrides)) {
      for (const rejected of override.rejectedInstagram ?? []) {
        const canonical = canonicalInstagramUrl(rejected.url);
        if (canonical) rejectedUrls.set(canonical, `${slug}: ${rejected.reason}`);
      }
    }

    const promotedUrls = new Map<string, string[]>();
    for (const [slug, override] of Object.entries(instagramOverrides)) {
      const companyUrl = canonicalInstagramUrl(override.companySocialLinks?.instagram);
      if (companyUrl) promotedUrls.set(companyUrl, [...(promotedUrls.get(companyUrl) ?? []), `${slug}:company`]);
      for (const founder of override.founders ?? []) {
        const founderUrl = canonicalInstagramUrl(founder.socialLinks?.instagram);
        if (founderUrl) promotedUrls.set(founderUrl, [...(promotedUrls.get(founderUrl) ?? []), `${slug}:founder:${founder.name}`]);
      }
    }

    for (const node of graph.nodes) {
      for (const account of node.socialAccounts) {
        if (account.platform !== "instagram") continue;
        const canonical = canonicalInstagramUrl(account.url);
        if (canonical) promotedUrls.set(canonical, [...(promotedUrls.get(canonical) ?? []), `${node.entityId}:graph`]);
      }
      for (const founder of node.founders) {
        for (const account of founder.socialAccounts) {
          if (account.platform !== "instagram") continue;
          const canonical = canonicalInstagramUrl(account.url);
          if (canonical) promotedUrls.set(canonical, [...(promotedUrls.get(canonical) ?? []), `${founder.id}:graph`]);
        }
      }
    }

    const promotedRejectedUrls = [...rejectedUrls.keys()].filter((url) => promotedUrls.has(url));

    expect(rejectedUrls.size).toBeGreaterThan(0);
    expect(
      promotedRejectedUrls.map((url) => ({
        url,
        rejectedReason: rejectedUrls.get(url),
        promotedAs: promotedUrls.get(url)
      }))
    ).toEqual([]);
  });

  it("does not treat unvalidated search-derived Instagram handles as verified", () => {
    const unsafeSearchDerivedOverrides = Object.entries(instagramOverrides).filter(([, override]) => {
      const reason = String(override.matchReason ?? "");
      return (
        override.companySocialLinks?.instagram &&
        /(?:Web Instagram search|OpenCLI Instagram search)/i.test(reason) &&
        override.instagramValidation?.review_state !== "verified"
      );
    });

    expect(
      unsafeSearchDerivedOverrides.map(([slug, override]) => ({
        slug,
        instagram: override.companySocialLinks?.instagram,
        matchReason: override.matchReason
      }))
    ).toEqual([]);
  });

  it("keeps verified visible Instagram evidence scored and backed by real thumbnails", () => {
    const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
    const instagramRows = loggedInEvidenceSnapshot.evidence.filter(
      (item) => item.platform === "instagram" && item.review_state === "verified" && item.contributionScore > 0
    );
    const rowsByCompany = instagramRows.reduce((map, row) => {
      map.set(row.companySlug, [...(map.get(row.companySlug) ?? []), row]);
      return map;
    }, new Map<string, typeof instagramRows>());
    const graphInstagramRowsByCompany = graph.evidence
      .filter((item) => item.platform === "instagram")
      .reduce((map, row) => {
        const slug = row.attachedCompanyId?.replace(/^company-/, "");
        if (!slug) return map;
        map.set(slug, [...(map.get(slug) ?? []), row]);
        return map;
      }, new Map<string, typeof graph.evidence>());

    expect(instagramRows.length).toBeGreaterThan(0);
    expect(rowsByCompany.size).toBeGreaterThanOrEqual(3);

    for (const [companySlug, rows] of rowsByCompany) {
      const graphRows = graphInstagramRowsByCompany.get(companySlug) ?? [];
      const verifiedHandles = verifiedInstagramHandlesBySlug().get(companySlug) ?? new Set<string>();

      expect(rows.some((row) => row.contributionScore > 0), `${companySlug} should have scored Instagram rows`).toBe(true);
      for (const row of rows) {
        if (row.contributionScore > 0) {
          const evidenceHandle = instagramHandleFromEvidence(row);
          expect(
            verifiedHandles.has(evidenceHandle ?? ""),
            `${row.id} should come from a verified company/founder Instagram handle`
          ).toBe(true);
        }
        expect(row.review_state, `${row.id} should be verified before scoring`).toBe("verified");
        expect(row.contributionScore, `${row.id} should have positive Instagram traction`).toBeGreaterThan(0);
        expect(row.thumbnailUrl, `${row.id} should have a thumbnail`).toBeTruthy();
        expect(row.thumbnailSource, `${row.id} should record thumbnail provenance`).toMatch(/instagram|opencli|cached|media/);
      }
      expect(graphRows.length, `${companySlug} should have Instagram evidence in the graph`).toBeGreaterThan(0);
      expect(graphRows.some((row) => row.contributionScore > 0), `${companySlug} graph rows should be scored`).toBe(true);
      expect(graphRows.every((row) => row.thumbnailUrl), `${companySlug} graph rows should keep thumbnails`).toBe(true);
    }
  });
});
