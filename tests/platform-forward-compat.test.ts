import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildGraphResponse } from "@/lib/graph/graph-builder";
import { nativeEvidenceIdentityFromUrl } from "@/lib/graph/dedupe";
import { sanitizeGraphResponse } from "@/lib/graph/response-sanitizer";
import { normalizeEvidenceScores } from "@/lib/graph/traction-scoring";
import { DEFAULT_PLATFORM_WEIGHTS } from "@/lib/scoring/model";
import type { CompanyRecord, DemoGraphDataset, EvidenceItem, Platform } from "@/lib/graph/types";
import type { SocialPlatform } from "@/types/database";

// These cases pass their own complete dataset. Loading the unrelated global
// collection would rebuild every cohort before exercising this small contract.
vi.mock("@/lib/graph/yc-spring-2026-dataset", () => ({
  YC_SPRING_2026_BATCH_SLUG: "S26",
  yc2026GraphDataset: { mode: "official_snapshot", batches: [], companies: [], founders: [], evidence: [], needsReview: [], platformStatus: [] }
}));

describe("native platforms without calibrated scoring", () => {
  it("recognizes stable native post identities without accepting profiles or redirect-only links", () => {
    expect(
      nativeEvidenceIdentityFromUrl(
        "tiktok",
        "https://www.tiktok.com/@scout2015/video/6718335390845095173"
      )
    ).toBe("6718335390845095173");
    expect(nativeEvidenceIdentityFromUrl("tiktok", "https://www.tiktok.com/@scout2015/photo/6718335390845095173")).toBe("6718335390845095173");
    expect(nativeEvidenceIdentityFromUrl("facebook", "https://www.facebook.com/covera.agents/posts/pfbidExactCase")).toBe("pfbidExactCase");
    expect(nativeEvidenceIdentityFromUrl("facebook", "https://www.facebook.com/covera.agents")).toBeNull();
    expect(nativeEvidenceIdentityFromUrl("threads", "https://www.threads.com/@sirsho29/post/DeHy4pKHK09")).toBe("DeHy4pKHK09");
    expect(nativeEvidenceIdentityFromUrl("threads", "https://www.threads.com/@sirsho29")).toBeNull();
    expect(
      nativeEvidenceIdentityFromUrl(
        "bluesky",
        "https://bsky.app/profile/example.com/post/3k4duaz5vfs2b"
      )
    ).toBe("example.com/post/3k4duaz5vfs2b");

    expect(nativeEvidenceIdentityFromUrl("tiktok", "https://www.tiktok.com/@scout2015")).toBeNull();
    expect(nativeEvidenceIdentityFromUrl("tiktok", "https://vm.tiktok.com/example")).toBeNull();
    expect(nativeEvidenceIdentityFromUrl("bluesky", "https://bsky.app/profile/example.com")).toBeNull();
  });

  it("retains verified native rows in graph/API payloads while leaving score maps absent", () => {
    const normalizedEvidence = normalizeEvidenceScores([
      evidence(
        "tiktok",
        "https://www.tiktok.com/@acme/video/7512345678901234567",
        "7512345678901234567"
      ),
      evidence(
        "bluesky",
        "https://bsky.app/profile/acme.example/post/3ltforwardcompat",
        "3ltforwardcompat"
      ),
      evidence("facebook", "https://www.facebook.com/acme/posts/pfbidExactCase", "pfbidExactCase"),
      evidence("threads", "https://www.threads.com/@acme/post/DeHy4pKHK09", "DeHy4pKHK09")
    ], { asOf: "2026-07-16T12:00:00.000Z" });
    const dataset: DemoGraphDataset = {
      mode: "official_snapshot",
      batches: [{ slug: "FORWARD", label: "Forward compatibility" }],
      companies: [company()],
      founders: [],
      evidence: normalizedEvidence,
      needsReview: [],
      platformStatus: []
    };

    const graph = buildGraphResponse(
      { batchSlug: "FORWARD", platforms: ["tiktok", "bluesky", "facebook", "threads"] },
      dataset
    );
    const sanitized = sanitizeGraphResponse(graph);

    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]?.platformScores).toEqual({});
    expect(graph.nodes[0]?.scoreBreakdown).toBeUndefined();
    expect(sanitized.evidence).toHaveLength(4);
    expect(sanitized.evidence.map((item) => item.tractionStatus)).toEqual(["unscored", "unscored", "unscored", "unscored"]);
    expect(sanitized.evidence.every((item) => item.normalizedScore === undefined)).toBe(true);
    expect(DEFAULT_PLATFORM_WEIGHTS).not.toHaveProperty("tiktok");
    expect(DEFAULT_PLATFORM_WEIGHTS).not.toHaveProperty("bluesky");
    expect(DEFAULT_PLATFORM_WEIGHTS).not.toHaveProperty("facebook");
    expect(DEFAULT_PLATFORM_WEIGHTS).not.toHaveProperty("threads");
    expect(graph.platformStatus).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ platform: "tiktok", status: "public_only", notes: expect.stringMatching(/unscored/i) }),
        expect.objectContaining({ platform: "bluesky", status: "disabled", notes: expect.stringMatching(/unscored/i) })
      ])
    );
  });

  it("updates database platform constraints and hand-maintained types", () => {
    const typedPlatforms: SocialPlatform[] = ["tiktok", "bluesky"];
    const migration = fs.readFileSync(
      path.join(process.cwd(), "supabase", "migrations", "006_add_tiktok_bluesky_platforms.sql"),
      "utf8"
    );

    expect(typedPlatforms).toEqual(["tiktok", "bluesky"]);
    expect(migration).toMatch(/social_accounts_platform_check[\s\S]*'tiktok'[\s\S]*'bluesky'/i);
    expect(migration).toMatch(/posts_platform_check[\s\S]*'tiktok'[\s\S]*'bluesky'/i);
  });

  it("represents Facebook without assigning a scoring weight or removing earlier database platforms", () => {
    const platform: SocialPlatform = "facebook";
    const migration = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/033_add_facebook_native_context_platform.sql"), "utf8");
    expect(platform).toBe("facebook");
    expect(migration).toMatch(/social_accounts_platform_check[\s\S]*'facebook'/);
    expect(migration).toMatch(/posts_platform_check[\s\S]*'facebook'/);
    for (const legacy of ["twitter", "xiaohongshu", "tiktok", "bluesky", "other"]) expect(migration).toContain(`'${legacy}'`);
    const threadsMigration = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/034_add_threads_native_context_platform.sql"), "utf8");
    const threads: SocialPlatform = "threads";
    expect(threadsMigration).toMatch(/social_accounts_platform_check[\s\S]*'threads'/);
    expect(threadsMigration).toMatch(/posts_platform_check[\s\S]*'threads'/);
    expect(threads).toBe("threads");
    for (const legacy of ["facebook", "twitter", "xiaohongshu", "tiktok", "bluesky", "other"]) expect(threadsMigration).toContain(`'${legacy}'`);
  });
});

function evidence(platform: Platform, sourceUrl: string, platformPostId: string): EvidenceItem {
  return {
    id: `evidence-${platform}`,
    entityType: "company",
    entityId: "company-forward",
    platform,
    authorName: "Acme",
    authorHandle: "acme",
    postedAt: "2026-07-15T12:00:00.000Z",
    text: `${platform} product update`,
    mediaType: platform === "tiktok" ? "video" : "link",
    metrics: { views: 10_000, likes: 250 },
    contributionScore: 80,
    sourceUrl,
    platformPostId,
    linkStatus: "verified",
    review_state: "verified",
    why: "Verified native post evidence."
  };
}

function company(): CompanyRecord {
  return {
    id: "company-forward",
    batchSlug: "FORWARD",
    name: "Acme",
    ycProfileUrl: "https://example.com/acme",
    websiteUrl: "https://acme.example",
    tagline: "Forward-compatible evidence",
    description: "Test company",
    groupPartner: null,
    primaryIndustry: "consumer",
    businessModel: "consumer",
    review_state: "verified",
    sourceUrl: "https://example.com/acme",
    industries: ["Consumer"],
    founderIds: [],
    socialAccounts: [],
    totalScore: 40,
    previousScore: 40,
    platformScores: {}
  };
}
