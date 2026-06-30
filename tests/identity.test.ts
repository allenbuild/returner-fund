import { describe, expect, it } from "vitest";
import { rankIdentityCandidates, scoreIdentityCandidate } from "@/lib/identity";

describe("identity review-state scoring", () => {
  it("accepts verified official-site profile matches", () => {
    const result = scoreIdentityCandidate(
      {
        type: "company",
        id: "company-1",
        name: "Orbit AI",
        companyName: "Orbit AI",
        batchSlug: "S2026",
        websiteUrl: "https://orbitai.example"
      },
      {
        platform: "x",
        url: "https://x.com/orbitai",
        handle: "orbitai",
        displayName: "Orbit AI",
        bio: "YC S2026 company building reliable AI ops.",
        websiteUrl: "https://orbitai.example",
        verified: true,
        foundOnOfficialSite: true,
        recentActivityAt: "2026-06-10T00:00:00Z"
      },
      { now: "2026-06-27T00:00:00Z" }
    );

    expect(result.review_state).toBe("verified");
    expect(result.canonical).toBe(true);
    expect(result.explanationJson.matchedSignals).toContain("found_on_official_site");
    expect(result.explanationJson.matchedSignals).toContain("website_domain_match");
  });

  it("marks weak profile matches as needs_review instead of canonical", () => {
    const result = scoreIdentityCandidate(
      {
        type: "founder",
        id: "founder-1",
        name: "Avery Chen",
        companyName: "Orbit AI",
        batchSlug: "S2026",
        websiteUrl: "https://orbitai.example"
      },
      {
        platform: "linkedin",
        url: "https://linkedin.com/in/avery-other",
        handle: "avery-other",
        displayName: "Avery C.",
        bio: "Investor and product advisor.",
        websiteUrl: "https://avery.example",
        foundOnOfficialSite: false,
        verified: false
      }
    );

    expect(result.review_state).toBe("needs_review");
    expect(result.canonical).toBe(false);
    expect(result.explanationJson.limitations).toContain(
      "Candidate is plausible but lacks an unambiguous verified-profile rule; keep it in needs_review."
    );
  });

  it("ranks candidate identities by transparent review-state signals", () => {
    const ranked = rankIdentityCandidates(
      {
        type: "founder",
        id: "founder-2",
        name: "Mina Patel",
        companyName: "LedgerBloom",
        batchSlug: "S2026",
        websiteUrl: "https://ledgerbloom.example"
      },
      [
        {
          platform: "x",
          url: "https://x.com/mina_builds",
          handle: "mina_builds",
          displayName: "Mina",
          bio: "Building tools for finance.",
          websiteUrl: "https://mina.example"
        },
        {
          platform: "x",
          url: "https://x.com/minapatel",
          handle: "minapatel",
          displayName: "Mina Patel",
          bio: "Founder of LedgerBloom, YC S2026.",
          websiteUrl: "https://ledgerbloom.example",
          foundOnOfficialSite: true,
          recentActivityAt: "2026-06-12T00:00:00Z"
        }
      ],
      { now: "2026-06-27T00:00:00Z" }
    );

    expect(ranked[0].url).toBe("https://x.com/minapatel");
    expect(ranked[0].review_state).toBe("verified");
    expect(ranked[1].review_state).toBe("needs_review");
  });
});
