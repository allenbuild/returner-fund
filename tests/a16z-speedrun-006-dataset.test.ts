import { describe, expect, it } from "vitest";
import {
  A16Z_SPEEDRUN_006_BATCH_LABEL,
  A16Z_SPEEDRUN_006_BATCH_SLUG,
  a16zSpeedrun006GraphDataset
} from "@/lib/graph/a16z-speedrun-006-dataset";
import { calibrateBatchCompanyScores } from "@/lib/scoring/batch-calibration";
import { buildGraphResponse } from "@/lib/graph/graph-builder";
import { TRACTION_SCORING_CONFIG } from "@/lib/graph/traction-scoring-config";
import { scoringEligibility } from "@/lib/graph/traction-scoring";
import type { CompanyRecord, GraphNode, Platform, SocialAccountSummary } from "@/lib/graph/types";
import { ycSpring2026GraphDataset } from "@/lib/graph/yc-spring-2026-dataset";
import socialAccountSeedSnapshot from "@/lib/social/a16z-speedrun-006-social-accounts.json";
import seededSocialEvidenceSnapshot from "@/lib/social/a16z-speedrun-006-social-evidence.json";

const A16Z_NATIVE_SOCIAL_TRACTION_PLATFORM_LIST: Platform[] = [
  "github",
  "linkedin",
  "instagram",
  "x",
  "youtube",
  "reddit",
  "product_hunt",
  "hacker_news",
  "bilibili"
];
const A16Z_NATIVE_SOCIAL_TRACTION_PLATFORMS = new Set<Platform>(A16Z_NATIVE_SOCIAL_TRACTION_PLATFORM_LIST);
const A16Z_SPEEDRUN_SOURCE_PREFIX = "https://speedrun.a16z.com/";
const A16Z_REPRESENTATIVE_SOCIAL_SEED_COMPANIES = ["SUN", "ZeroDrift", "Acceler8", "Modaic", "Sentra"];
const A16Z_SECOND_PASS_ARTIFACT_PATH = "outputs/source-hunt/2026-07-19-a16z-second-pass.json";
const A16Z_SECOND_PASS_NATIVE_IDENTITIES = [
  "instagram:Da9k4VbyCs8",
  "instagram:Da9Upd2jDqN",
  "instagram:Da9FP68vX_n",
  "instagram:Da8DniaARMi",
  "instagram:Da6ZEZvSOiJ",
  "instagram:Da6PkazmxSj",
  "instagram:Da6PULkj2OH",
  "instagram:Da6NVouSjPN",
  "instagram:Da5-2-DB_4L",
  "instagram:Da5-KPTDnVJ",
  "instagram:Da57Q5cBmsS",
  "instagram:Da526dyv09U",
  "x:2078180286441955781",
  "instagram:Da5r6ONJJvs",
  "instagram:Da5ng7iEaag",
  "instagram:Da3IzIwAGDD",
  "instagram:Da3twqGSBl6",
  "instagram:Da3q_PqSmkm",
  "instagram:Da3JzWVBJKQ",
  "instagram:Da3JQ0njmn9",
  "instagram:Da3JQo0lUgh",
  "instagram:Da3JPClkfF4",
  "instagram:Da3Im_6kdC3",
  "instagram:Da3IjF5ALWH",
  "instagram:Da2ss8zDD9W",
  "instagram:Da1toCqARGL",
  "instagram:Da1ZmfzymHv"
] as const;
const CREBIT_SCREENSHOT_POST_URL =
  "https://www.linkedin.com/posts/simmi-sen_crebit-founding-engineer-application-activity-7475266867537039360-QwfJ";
const CREBIT_BACKED_BY_A16Z_POST_URL =
  "https://www.linkedin.com/posts/simmi-sen_crebit-is-backed-by-a16z-speedrun-since-activity-7424504480077062144-_L5q";
const CREBIT_GROWTH_INTERN_POST_URL =
  "https://www.linkedin.com/posts/simmi-sen_we-are-hiring-ten-paid-growth-interns-for-activity-7403840813530570752-U_Nm";
const SIMULA_GITHUB_REPOSITORY_CASES = [
  {
    sourceUrl: "https://github.com/Simula-AI-SDK/simula-ad-sdk-kotlin",
    platformPostId: "simula-ai-sdk/simula-ad-sdk-kotlin",
    sourceCommitUrl:
      "https://github.com/Simula-AI-SDK/simula-ad-sdk-kotlin/commit/11709687a966f26f9932bfef08adf724108cc989",
    sourceCommitId: "11709687a966f26f9932bfef08adf724108cc989",
    metrics: { stars: 0, forks: 0, issues: 1, recent_commits_30d: 1 }
  },
  {
    sourceUrl: "https://github.com/Simula-AI-SDK/simula-ad-sdk-swift",
    platformPostId: "simula-ai-sdk/simula-ad-sdk-swift",
    sourceCommitUrl:
      "https://github.com/Simula-AI-SDK/simula-ad-sdk-swift/commit/5e28c5e37da6d987cec0b10457993a98fb79687c",
    sourceCommitId: "5e28c5e37da6d987cec0b10457993a98fb79687c",
    metrics: { stars: 0, forks: 0, issues: 1, recent_commits_30d: 1 }
  },
  {
    sourceUrl: "https://github.com/Simula-AI-SDK/simula-ad-sdk-react-native",
    platformPostId: "simula-ai-sdk/simula-ad-sdk-react-native",
    sourceCommitUrl:
      "https://github.com/Simula-AI-SDK/simula-ad-sdk-react-native/commit/7a51abafc1a825bed71010845b9124e964a19deb",
    sourceCommitId: "7a51abafc1a825bed71010845b9124e964a19deb",
    metrics: { stars: 0, forks: 0, issues: 0, recent_commits_30d: 1 }
  },
  {
    sourceUrl: "https://github.com/Simula-AI-SDK/simula-ad-sdk",
    platformPostId: "simula-ai-sdk/simula-ad-sdk",
    sourceCommitUrl:
      "https://github.com/Simula-AI-SDK/simula-ad-sdk/commit/4c8b9bec1d45f6d1f2ebb5658eea6eed919e2c17",
    sourceCommitId: "4c8b9bec1d45f6d1f2ebb5658eea6eed919e2c17",
    metrics: { stars: 0, forks: 0, issues: 3, recent_commits_30d: 1 }
  }
] as const;
const EXTERNAL_TOP_VOICE_ATTENTION_CASES = [
  {
    companyName: "Panorama",
    companyId: "a16z-speedrun-006-panorama",
    targetFounderId: "a16z-speedrun-006-panorama-founder-jingwei-hao",
    sourceUrl: "https://x.com/andrewchen/status/2046634958152991118"
  },
  {
    companyName: "Quo Labs",
    companyId: "a16z-speedrun-006-quo-labs",
    targetFounderId: "a16z-speedrun-006-quo-labs-founder-audrey-lo",
    sourceUrl: "https://x.com/andrewchen/status/2044330562874421368"
  },
  {
    companyName: "Hotbox",
    companyId: "a16z-speedrun-006-hotbox",
    targetFounderId: "a16z-speedrun-006-hotbox-founder-harpriya-bagri",
    sourceUrl: "https://x.com/andrewchen/status/2034761120188379267"
  },
  {
    companyName: "Oasis",
    companyId: "a16z-speedrun-006-oasis",
    targetFounderId: "a16z-speedrun-006-oasis-founder-stefano-fantini-delmanto",
    sourceUrl: "https://x.com/andrewchen/status/2078236768370147766"
  }
] as const;

interface A16zSocialSeedSnapshot {
  companies: A16zSocialSeedCompany[];
}

interface A16zSocialSeedCompany {
  companyName: string;
  accounts?: A16zSocialSeedAccount[];
  founders?: A16zSocialSeedFounder[];
}

interface A16zSocialSeedFounder {
  accounts?: A16zSocialSeedAccount[];
}

interface A16zSocialSeedAccount {
  platform: Platform;
  url: string;
  handle?: string | null;
}

interface A16zSecondPassProvenance {
  artifactPath: string;
  candidateId: string;
  profile: {
    username: string;
    url: string;
    relationship?: "company" | "founder";
  };
  post: {
    id: string;
    shortcode?: string;
    url: string;
    authorHandle: string;
  };
  counts: Record<string, number>;
  target: {
    companyName: string;
    founderName?: string | null;
    entityId?: string;
    founderId?: string;
  };
  verification: {
    status: string;
    nativeItem?: boolean;
    nativeAuthorVerified?: boolean;
    metricsVisible: boolean;
    notProfileOrSearchPage: boolean;
    ownerMatchesSeededAccount?: boolean;
    dedupeStatus: string;
  };
}

function canonicalSecondPassMetrics(platform: Platform, counts: Record<string, number>): Record<string, number> {
  const metrics = { ...counts };
  if (metrics.plays !== undefined) {
    metrics.views = Math.max(metrics.views ?? 0, metrics.plays);
    delete metrics.plays;
  }
  if (metrics.retweets !== undefined) {
    metrics.reposts = Math.max(metrics.reposts ?? 0, metrics.retweets);
    delete metrics.retweets;
  }
  if (platform === "x" && metrics.comments !== undefined) {
    metrics.replies = Math.max(metrics.replies ?? 0, metrics.comments);
    delete metrics.comments;
  }
  if (platform === "x" && metrics.saves !== undefined) {
    metrics.bookmarks = Math.max(metrics.bookmarks ?? 0, metrics.saves);
    delete metrics.saves;
  }
  return metrics;
}

const a16zSocialSeedSnapshot = socialAccountSeedSnapshot as A16zSocialSeedSnapshot;

describe("a16z speedrun 006 dataset", () => {
  it("exposes all 59 company profiles as a selectable batch", () => {
    const graph = buildGraphResponse({ batchSlug: A16Z_SPEEDRUN_006_BATCH_SLUG }, ycSpring2026GraphDataset);
    const companyNodes = graph.nodes.filter((node) => node.entityType === "company");

    expect(graph.batch).toEqual({
      slug: A16Z_SPEEDRUN_006_BATCH_SLUG,
      label: A16Z_SPEEDRUN_006_BATCH_LABEL,
      companyCountExpected: 59,
      companyCountObserved: 59
    });
    expect(companyNodes).toHaveLength(59);
    expect(new Set(companyNodes.map((node) => node.label)).size).toBe(59);
    expect(companyNodes.map((node) => node.label)).toEqual(
      expect.arrayContaining(["Acceler8", "Piper-ai", "Snapp Stats", "ZeroDrift"])
    );
  });

  it("uses tie-aware percentiles without erasing absolute or positive scores", () => {
    const calibrated = calibrateBatchCompanyScores([
      calibrationCompany("low-a", 10),
      calibrationCompany("low-b", 10),
      calibrationCompany("high", 80),
      calibrationCompany("none", 0)
    ]);
    const byId = new Map(calibrated.map((company) => [company.id, company]));

    expect(byId.get("low-a")?.totalScore).toBe(1);
    expect(byId.get("low-b")?.totalScore).toBe(1);
    expect(byId.get("high")?.totalScore).toBe(100);
    expect(byId.get("none")?.totalScore).toBe(0);
    expect(byId.get("low-a")?.scoreBreakdown).toEqual(
      expect.objectContaining({
        absoluteScore: 10,
        calibration: {
          method: "tie_aware_percentile_blend",
          cohortSize: 3,
          percentile: 0.3333,
          inputScore: 10
        }
      })
    );
    expect(byId.get("low-b")?.scoreBreakdown?.calibration.percentile).toBe(0.3333);
    expect(byId.get("none")?.scoreBreakdown?.calibration).toEqual({
      method: "none",
      cohortSize: 3,
      percentile: null,
      inputScore: 0
    });
  });

  it("counts only native social/code platforms for A16Z traction", () => {
    expect(A16Z_NATIVE_SOCIAL_TRACTION_PLATFORM_LIST).toEqual([
      "github",
      "linkedin",
      "instagram",
      "x",
      "youtube",
      "reddit",
      "product_hunt",
      "hacker_news",
      "bilibili"
    ]);
    expect(A16Z_NATIVE_SOCIAL_TRACTION_PLATFORMS.has("web")).toBe(false);
    expect(A16Z_NATIVE_SOCIAL_TRACTION_PLATFORMS.has("rss")).toBe(false);
    expect(A16Z_NATIVE_SOCIAL_TRACTION_PLATFORMS.has("youtube")).toBe(true);
    expect(A16Z_NATIVE_SOCIAL_TRACTION_PLATFORMS.has("reddit")).toBe(true);
    expect(A16Z_NATIVE_SOCIAL_TRACTION_PLATFORMS.has("product_hunt")).toBe(true);
    expect(A16Z_NATIVE_SOCIAL_TRACTION_PLATFORMS.has("hacker_news")).toBe(true);
    expect(A16Z_NATIVE_SOCIAL_TRACTION_PLATFORMS.has("bilibili")).toBe(true);
  });

  it("scores Quanto only from the exact founder post, not its Product Hunt product profile", () => {
    const graph = buildGraphResponse({ batchSlug: A16Z_SPEEDRUN_006_BATCH_SLUG }, ycSpring2026GraphDataset);
    const productProfile = graph.evidence.find(
      (item) => item.sourceUrl === "https://www.producthunt.com/products/quanto"
    );
    const founderPost = graph.evidence.find(
      (item) => item.platformPostId === "7453449486699290624"
    );
    const quanto = graph.nodes.find(
      (node) => node.entityType === "company" && node.entityId === "a16z-speedrun-006-quanto"
    );

    expect(productProfile).toEqual(expect.objectContaining({
      platform: "product_hunt",
      contributionScore: 0
    }));
    expect(productProfile?.why).toContain("not_native_evidence");
    expect(scoringEligibility(productProfile!)).toEqual({ eligible: false, reason: "upstream_excluded" });
    expect(founderPost).toEqual(expect.objectContaining({
      entityType: "founder",
      entityId: "a16z-speedrun-006-quanto-founder-anderson-petergeorge",
      platform: "linkedin",
      accountUrl: "https://www.linkedin.com/in/andersonpetergeorge",
      metrics: { reactions: 70, comments: 18 }
    }));
    expect(scoringEligibility(founderPost!)).toEqual({ eligible: true, reason: "eligible" });
    expect(quanto?.score).toBeGreaterThan(0);
  });

  it("links founders to Speedrun company profiles without using Speedrun URLs as social accounts", () => {
    const graph = buildGraphResponse({ batchSlug: A16Z_SPEEDRUN_006_BATCH_SLUG }, ycSpring2026GraphDataset);
    const zeroDrift = graph.nodes.find((node) => node.entityType === "company" && node.label === "ZeroDrift");
    const zeroDriftAccounts = nodeSocialAccounts(zeroDrift);

    expect(zeroDrift?.founders.map((founder) => founder.name)).toEqual(["Kumesh Aroomoogan"]);
    expect(zeroDrift?.founders[0]?.ycProfileUrl).toContain("/companies/zerodrift/kumesh-aroomoogan");
    expect(zeroDriftAccounts.filter(accountHasWebOrSpeedrunUrl)).toEqual([]);
  });

  it("uses only verified native social/code evidence as positive A16Z traction", () => {
    const graph = buildGraphResponse({ batchSlug: A16Z_SPEEDRUN_006_BATCH_SLUG }, ycSpring2026GraphDataset);
    const scoredEvidence = graph.evidence.filter((item) => item.contributionScore > 0);
    const companyNodes = graph.nodes.filter((node) => node.entityType === "company");
    const scoredCompanyNodes = graph.nodes.filter((node) => node.entityType === "company" && node.score > 0);
    const scoredLeaderboardRows = graph.leaderboard.filter((row) => row.score > 0);

    expect(scoredEvidence.length).toBeGreaterThan(0);
    expect(scoredCompanyNodes.length).toBeGreaterThan(0);
    expect(scoredLeaderboardRows.length).toBeGreaterThan(0);

    expect(
      scoredEvidence.filter(
        (item) =>
          !A16Z_NATIVE_SOCIAL_TRACTION_PLATFORMS.has(item.platform) ||
          item.platform === "web" ||
          isSpeedrunUrl(item.sourceUrl) ||
          isSpeedrunUrl(item.accountUrl)
      )
    ).toEqual([]);

    expect(graph.evidence.filter((item) => item.platform === "web" && item.contributionScore > 0)).toEqual([]);
    expect(
      companyNodes.filter(
        (node) =>
          node.topPlatform === "web" ||
          hasPositivePlatformScore(node.platformScores, "web") ||
          hasPositivePlatformScore(node.scoreBreakdown?.platformScores ?? {}, "web") ||
          (node.scoreBreakdown?.weightedPlatforms ?? []).some(
            (platformScore) => platformScore.platform === "web" && platformScore.score > 0
          )
      )
    ).toEqual([]);
    expect(
      graph.leaderboard.filter(
        (row) =>
          row.topPlatform === "web" ||
          row.biggestContribution?.platform === "web" ||
          isSpeedrunUrl(row.biggestContribution?.sourceUrl) ||
          isSpeedrunUrl(row.biggestContribution?.accountUrl)
      )
    ).toEqual([]);

    expect(
      scoredCompanyNodes.filter(
        (node) =>
          !node.topPlatform ||
          !A16Z_NATIVE_SOCIAL_TRACTION_PLATFORMS.has(node.topPlatform) ||
          hasAnyPositiveNonNativePlatformScore(node.platformScores) ||
          hasAnyPositiveNonNativePlatformScore(node.scoreBreakdown?.platformScores ?? {}) ||
          (node.scoreBreakdown?.weightedPlatforms ?? []).some(
            (platformScore) =>
              platformScore.score > 0 && !A16Z_NATIVE_SOCIAL_TRACTION_PLATFORMS.has(platformScore.platform)
          )
      )
    ).toEqual([]);

    expect(
      scoredLeaderboardRows.filter((row) => {
        const contribution = row.biggestContribution;

        return (
          !row.topPlatform ||
          !A16Z_NATIVE_SOCIAL_TRACTION_PLATFORMS.has(row.topPlatform) ||
          !contribution ||
          !A16Z_NATIVE_SOCIAL_TRACTION_PLATFORMS.has(contribution.platform) ||
          contribution.platform === "web" ||
          isSpeedrunUrl(contribution.sourceUrl) ||
          isSpeedrunUrl(contribution.accountUrl)
        );
      })
    ).toEqual([]);

    const modaic = graph.nodes.find((node) => node.entityType === "company" && node.label === "Modaic");
    const sentra = graph.nodes.find((node) => node.entityType === "company" && node.label === "Sentra");

    expect(modaic?.topPlatform).toBe("github");
    expect(modaic?.score).toBeGreaterThan(0);
    expect(modaic?.socialAccounts.map((account) => account.platform)).toContain("github");
    expect(sentra?.topPlatform).toBe("x");
    expect(sentra?.score).toBeGreaterThan(0);
    expect(sentra?.socialAccounts.map((account) => account.platform)).toEqual(
      expect.arrayContaining(["linkedin", "x"])
    );
  });

  it("renders A16Z account buttons from platform URLs instead of Speedrun profile URLs", () => {
    const graph = buildGraphResponse({ batchSlug: A16Z_SPEEDRUN_006_BATCH_SLUG }, ycSpring2026GraphDataset);
    const companyNodes = graph.nodes.filter((node) => node.entityType === "company");
    const socialAccounts = companyNodes.flatMap(nodeSocialAccounts);

    expect(socialAccounts.length).toBeGreaterThan(0);
    expect(
      socialAccounts.filter(
        (account) =>
          account.platform === "web" ||
          !A16Z_NATIVE_SOCIAL_TRACTION_PLATFORMS.has(account.platform) ||
          accountHasWebOrSpeedrunUrl(account) ||
          !accountUrlMatchesPlatform(account)
      )
    ).toEqual([]);
  });

  it("keeps evidence account lineage materialized and unique across account owners and URLs", () => {
    const owners = materializedAccountOwners(a16zSpeedrun006GraphDataset);
    const ownersById = new Map<string, typeof owners>();
    for (const owner of owners) {
      ownersById.set(owner.account.id, [...(ownersById.get(owner.account.id) ?? []), owner]);
    }

    const linkedEvidence = a16zSpeedrun006GraphDataset.evidence.filter(
      (item) => item.socialAccountId !== null && item.socialAccountId !== undefined
    );
    const unresolvedEvidence = linkedEvidence.filter((item) => !ownersById.has(item.socialAccountId!));
    const wrongOwnerEvidence = linkedEvidence.filter(
      (item) =>
        !ownersById
          .get(item.socialAccountId!)
          ?.some(
            (owner) =>
              owner.entityType === item.entityType &&
              owner.entityId === item.entityId &&
              owner.account.platform === item.platform
          )
    );
    const collidingAccountIds = [...ownersById.entries()].filter(([, accountOwners]) =>
      new Set(
        accountOwners.map(
          (owner) => `${owner.entityType}:${owner.entityId}:${owner.account.platform}:${owner.account.url}`
        )
      ).size > 1
    );
    const scoredLinkedEvidence = linkedEvidence.filter((item) => item.contributionScore > 0);
    const crebitFounderPost = a16zSpeedrun006GraphDataset.evidence.find(
      (item) => item.sourceUrl === CREBIT_SCREENSHOT_POST_URL
    );
    const smartBricksInstagramAccounts = owners.filter(
      (owner) =>
        owner.entityType === "company" &&
        owner.entityId === "a16z-speedrun-006-smart-bricks" &&
        owner.account.platform === "instagram"
    );

    expect(linkedEvidence.length).toBeGreaterThan(0);
    expect(scoredLinkedEvidence.length).toBeGreaterThan(0);
    expect(unresolvedEvidence).toHaveLength(0);
    expect(wrongOwnerEvidence).toHaveLength(0);
    expect(collidingAccountIds).toHaveLength(0);
    expect(smartBricksInstagramAccounts).toHaveLength(2);
    expect(new Set(smartBricksInstagramAccounts.map((owner) => owner.account.url)).size).toBe(2);
    expect(new Set(smartBricksInstagramAccounts.map((owner) => owner.account.id)).size).toBe(2);
    expect(crebitFounderPost).toEqual(
      expect.objectContaining({
        entityType: "founder",
        platform: "linkedin",
        contributionScore: expect.any(Number)
      })
    );
    expect(crebitFounderPost?.contributionScore).toBeGreaterThan(0);
    expect(ownersById.get(crebitFounderPost?.socialAccountId ?? "")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityType: "founder",
          entityId: crebitFounderPost?.entityId,
          account: expect.objectContaining({ platform: "linkedin" })
        })
      ])
    );
  });

  it("keeps seeded native social accounts visible on representative A16Z companies", () => {
    const graph = buildGraphResponse({ batchSlug: A16Z_SPEEDRUN_006_BATCH_SLUG }, ycSpring2026GraphDataset);

    for (const companyName of A16Z_REPRESENTATIVE_SOCIAL_SEED_COMPANIES) {
      const node = graph.nodes.find((item) => item.entityType === "company" && item.label === companyName);
      const visibleAccounts = nodeSocialAccounts(node);
      const seededAccounts = nativeSeedAccountsForCompany(companyName);

      expect(node, `Expected ${companyName} to be present in the A16Z batch`).toBeDefined();
      expect(visibleAccounts.filter(accountHasWebOrSpeedrunUrl)).toEqual([]);

      for (const seededAccount of seededAccounts) {
        expect(visibleAccounts).toContainEqual(
          expect.objectContaining({
            platform: seededAccount.platform,
            url: seededAccount.url
          })
        );
      }

      if (seededAccounts.length > 0 && node?.score === 0) {
        expect(visibleAccounts.length).toBeGreaterThan(0);
      }
    }
  });

  it("keeps company account buttons separate from founder social accounts", () => {
    const graph = buildGraphResponse({ batchSlug: A16Z_SPEEDRUN_006_BATCH_SLUG }, ycSpring2026GraphDataset);
    const thirdbrain = graph.nodes.find((node) => node.entityType === "company" && node.label === "Thirdbrain Labs");
    const leaderboardRow = graph.leaderboard.find((row) => row.companyName === "Thirdbrain Labs");
    const founderAccountUrls = thirdbrain?.founders.flatMap((founder) =>
      founder.socialAccounts.map((account) => account.url)
    ) ?? [];
    const companyAccountUrls = thirdbrain?.socialAccounts.map((account) => account.url) ?? [];

    expect(founderAccountUrls).toEqual(
      expect.arrayContaining([
        "https://www.linkedin.com/in/margaretczhang",
        "https://x.com/_margaretzhang",
        "https://www.linkedin.com/in/ds-huang",
        "https://x.com/latentius"
      ])
    );
    expect(companyAccountUrls).toEqual([
      "https://www.linkedin.com/company/thirdbrain-labs",
      "https://x.com/ThirdbrainLabs"
    ]);
    expect(leaderboardRow?.socialAccounts.map((account) => account.url)).toEqual(companyAccountUrls);
    expect(companyAccountUrls.some((url) => founderAccountUrls.includes(url))).toBe(false);
  });

  it("carries founder account buttons onto A16Z leaderboard rows separately from company accounts", () => {
    const graph = buildGraphResponse({ batchSlug: A16Z_SPEEDRUN_006_BATCH_SLUG }, ycSpring2026GraphDataset);
    const hammock = graph.leaderboard.find((row) => row.companyName === "Hammock");
    const founderUrls = hammock?.founderAccounts?.flatMap((founder) =>
      founder.socialAccounts.map((account) => account.url)
    ) ?? [];

    expect(hammock?.socialAccounts.map((account) => account.url)).toEqual([
      "https://www.linkedin.com/company/usehammockco",
      "https://www.instagram.com/usehammock.co"
    ]);
    expect(founderUrls).toEqual(
      expect.arrayContaining([
        "https://www.linkedin.com/in/jesserose",
        "https://x.com/senor_rose",
        "https://www.linkedin.com/in/williamldennis",
        "https://x.com/willydennis"
      ])
    );
    expect(founderUrls.filter((url) => isSpeedrunUrl(url))).toEqual([]);
  });

  it("scores seeded A16Z LinkedIn traction posts from native post URLs", () => {
    const graph = buildGraphResponse({ batchSlug: A16Z_SPEEDRUN_006_BATCH_SLUG }, ycSpring2026GraphDataset);
    const crebit = graph.leaderboard.find((row) => row.companyName === "Crebit");
    const screenshotEvidence = graph.evidence.find((item) => item.sourceUrl === CREBIT_SCREENSHOT_POST_URL);

    expect(screenshotEvidence).toEqual(
      expect.objectContaining({
        entityType: "founder",
        platform: "linkedin",
        attachedCompanyName: "Crebit",
        sourceUrl: CREBIT_SCREENSHOT_POST_URL,
        accountUrl: "https://www.linkedin.com/in/simmi-sen",
        metrics: expect.objectContaining({
          likes: 142,
          comments: 18,
          reposts: 8
        })
      })
    );
    expect(screenshotEvidence?.contributionScore).toBeGreaterThan(0);
    expect(isSpeedrunUrl(screenshotEvidence?.sourceUrl)).toBe(false);
    expect(isSpeedrunUrl(screenshotEvidence?.accountUrl)).toBe(false);

    expect(crebit?.score).toBeGreaterThan(0);
    expect(crebit?.topPlatform).toBe("linkedin");
    expect(crebit?.biggestContribution?.sourceUrl).toBe(CREBIT_GROWTH_INTERN_POST_URL);
    expect(
      graph.evidence
        .filter((item) =>
          [CREBIT_GROWTH_INTERN_POST_URL, CREBIT_BACKED_BY_A16Z_POST_URL, CREBIT_SCREENSHOT_POST_URL].includes(
            item.sourceUrl
          )
        )
        .sort((left, right) => right.contributionScore - left.contributionScore)
        .map((item) => item.sourceUrl)
    ).toEqual([CREBIT_GROWTH_INTERN_POST_URL, CREBIT_BACKED_BY_A16Z_POST_URL, CREBIT_SCREENSHOT_POST_URL]);
    expect(crebit?.biggestContribution?.sourceUrl).toMatch(/^https:\/\/(www\.linkedin\.com\/posts\/|www\.youtube\.com\/watch\?v=)/);
    expect(crebit?.biggestContribution?.sourceUrl).not.toContain("speedrun.a16z.com");
    expect(crebit?.biggestContribution?.sourceUrl).not.toContain("a16z.com");
  });

  it("scores seeded A16Z YouTube videos from native watch URLs", () => {
    const graph = buildGraphResponse({ batchSlug: A16Z_SPEEDRUN_006_BATCH_SLUG }, ycSpring2026GraphDataset);
    const sun = graph.leaderboard.find((row) => row.companyName === "SUN");
    const sunNode = graph.nodes.find((node) => node.entityType === "company" && node.label === "SUN");
    const sunYouTubeEvidence = graph.evidence.filter((item) => item.attachedCompanyName === "SUN" && item.platform === "youtube");
    const crebitYouTubeEvidence = graph.evidence.find(
      (item) => item.sourceUrl === "https://www.youtube.com/watch?v=RqS_WpgsPdY"
    );

    expect(sunYouTubeEvidence).toHaveLength(16);
    expect(sunYouTubeEvidence.map((item) => item.sourceUrl)).toEqual(
      expect.arrayContaining([
        "https://www.youtube.com/watch?v=pHTVgy_HSS0",
        "https://www.youtube.com/watch?v=42eSvpyKiJk",
        "https://www.youtube.com/watch?v=FTVKNZtv7-o",
        "https://www.youtube.com/watch?v=Qj6VFxD0Hbo",
        "https://www.youtube.com/watch?v=qHlEhqdAZxc",
        "https://www.youtube.com/watch?v=tJS3OsGtGQw",
        "https://www.youtube.com/watch?v=HbJiEHaSz-s",
        "https://www.youtube.com/watch?v=HWO_-A7oWDc",
        "https://www.youtube.com/watch?v=PwRToG-32Jg",
        "https://www.youtube.com/watch?v=weMHJD_lQ_Y"
      ])
    );
    expect(sunYouTubeEvidence.every((item) => item.contributionScore > 0)).toBe(true);
    expect(sunYouTubeEvidence.every((item) => item.metrics.views && item.metrics.views > 0)).toBe(true);
    expect(sun?.score).toBeGreaterThan(0);
    expect(sunNode?.platformScores.youtube).toBeGreaterThan(0);
    expect(nodeSocialAccounts(sunNode).map((account) => account.url)).toContain("https://www.youtube.com/@getsunapp");
    expect(crebitYouTubeEvidence).toEqual(
      expect.objectContaining({
        platform: "youtube",
        attachedCompanyName: "Crebit",
        metrics: expect.objectContaining({ views: 120 })
      })
    );
  });

  it("imports recent A16Z source-hunt rows once with exact native metrics and provenance", () => {
    const recentRows = [
      {
        sourceUrl: "https://www.youtube.com/watch?v=pHTVgy_HSS0",
        platformPostId: "pHTVgy_HSS0",
        companyName: "SUN",
        metrics: { views: 3, likes: 1 },
        artifactPath: "outputs/source-hunt/2026-07-19-a16z-recent.json"
      },
      {
        sourceUrl: "https://www.youtube.com/watch?v=42eSvpyKiJk",
        platformPostId: "42eSvpyKiJk",
        companyName: "SUN",
        metrics: { views: 71, likes: 6 },
        artifactPath: "outputs/source-hunt/2026-07-19-a16z-recent.json"
      },
      {
        sourceUrl: "https://www.youtube.com/watch?v=HwKIvuXrMaY",
        platformPostId: "HwKIvuXrMaY",
        companyName: "Antihero Studios",
        metrics: { views: 973, likes: 87 },
        artifactPath: "outputs/source-hunt/2026-07-19-a16z-recent.json"
      },
      {
        sourceUrl: "https://x.com/andrewchen/status/2078236768370147766",
        platformPostId: "2078236768370147766",
        companyName: "Oasis",
        metrics: {
          views: 837,
          likes: 5,
          comments: 1,
          replies: 1,
          reposts: 0,
          retweets: 0,
          quotes: 0,
          saves: 0
        },
        artifactPath: "outputs/source-hunt/2026-07-19-topvoices-recent.json"
      }
    ] as const;

    for (const recentRow of recentRows) {
      const urlMatches = a16zSpeedrun006GraphDataset.evidence.filter(
        (item) => item.sourceUrl === recentRow.sourceUrl
      );
      const nativeIdMatches = a16zSpeedrun006GraphDataset.evidence.filter(
        (item) => item.platformPostId === recentRow.platformPostId
      );
      const item = urlMatches[0];

      expect(urlMatches).toHaveLength(1);
      expect(nativeIdMatches).toHaveLength(1);
      expect(item).toEqual(
        expect.objectContaining({
          attachedCompanyName: recentRow.companyName,
          platformPostId: recentRow.platformPostId,
          metrics: expect.objectContaining(recentRow.metrics),
          review_state: "verified"
        })
      );
      expect(item?.contributionScore).toBeGreaterThan(0);
      expect(scoringEligibility(item!)).toEqual({ eligible: true, reason: "eligible" });
      expect(JSON.parse(item?.rawVisibleText ?? "")).toEqual(
        expect.objectContaining({ artifactPath: recentRow.artifactPath })
      );
    }
  });

  it("strictly imports every accepted Jul 19 A16Z second-pass row once", () => {
    const seededSnapshot = seededSocialEvidenceSnapshot as unknown as {
      source: {
        evidenceCount: number;
        latestSourceHuntImport: {
          artifactPath: string;
          strictCandidatesEvaluated: number;
          accepted: number;
          rejected: number;
          duplicates: number;
          rejectedRowsWritten: number;
          acceptedByPlatform: Record<string, number>;
          rejectedRowsByPlatform: Record<string, number>;
        };
      };
      evidence: unknown[];
    };
    const secondPassRows = a16zSpeedrun006GraphDataset.evidence.flatMap((item) => {
      try {
        const provenance = JSON.parse(item.rawVisibleText ?? "null") as A16zSecondPassProvenance | null;
        return provenance?.artifactPath === A16Z_SECOND_PASS_ARTIFACT_PATH ? [{ item, provenance }] : [];
      } catch {
        return [];
      }
    });

    expect(seededSnapshot.source.evidenceCount).toBe(seededSnapshot.evidence.length);
    expect(seededSnapshot.source.latestSourceHuntImport).toEqual({
      artifactPath: A16Z_SECOND_PASS_ARTIFACT_PATH,
      strictCandidatesEvaluated: 34,
      accepted: 27,
      rejected: 4,
      duplicates: 3,
      rejectedRowsWritten: 7,
      acceptedByPlatform: { instagram: 26, x: 1 },
      rejectedRowsByPlatform: { instagram: 1, x: 1, youtube: 3, hacker_news: 1, reddit: 1 }
    });
    expect(secondPassRows).toHaveLength(27);
    expect(secondPassRows.filter(({ item }) => item.platform === "instagram")).toHaveLength(26);
    expect(secondPassRows.filter(({ item }) => item.platform === "x")).toHaveLength(1);
    expect(secondPassRows.map(({ item }) => `${item.platform}:${item.platformPostId}`).sort()).toEqual(
      [...A16Z_SECOND_PASS_NATIVE_IDENTITIES].sort()
    );
    expect(new Set(secondPassRows.map(({ item }) => item.sourceUrl)).size).toBe(secondPassRows.length);
    expect(new Set(secondPassRows.map(({ item }) => `${item.platform}:${item.platformPostId}`)).size).toBe(
      secondPassRows.length
    );
    expect(new Set(secondPassRows.map(({ provenance }) => provenance.candidateId)).size).toBe(secondPassRows.length);

    for (const { item, provenance } of secondPassRows) {
      const nativePostId = item.platform === "instagram" ? provenance.post.shortcode : provenance.post.id;
      const expectedEntityType =
        provenance.profile.relationship === "founder" || provenance.target.founderName ? "founder" : "company";
      const expectedEntityId =
        expectedEntityType === "founder"
          ? provenance.target.founderId ?? provenance.target.entityId
          : provenance.target.entityId;

      expect(item).toEqual(
        expect.objectContaining({
          entityType: expectedEntityType,
          entityId: expectedEntityId,
          attachedCompanyName: provenance.target.companyName,
          authorHandle: provenance.post.authorHandle,
          platformPostId: nativePostId,
          sourceUrl: provenance.post.url,
          review_state: "verified",
          metrics: expect.objectContaining(canonicalSecondPassMetrics(item.platform, provenance.counts))
        })
      );
      expect(item.accountUrl?.replace(/\/$/, "")).toBe(provenance.profile.url.replace(/\/$/, ""));
      expect(item.authorHandle).toBe(provenance.profile.username);
      expect(item.socialAccountId).toEqual(expect.any(String));
      expect(provenance.verification).toEqual(
        expect.objectContaining({
          status: "accepted",
          metricsVisible: true,
          notProfileOrSearchPage: true,
          dedupeStatus: "net_new"
        })
      );
      expect(
        provenance.verification.ownerMatchesSeededAccount ?? provenance.verification.nativeAuthorVerified
      ).toBe(true);
      expect(item.contributionScore).toBeGreaterThan(0);
      expect(scoringEligibility(item)).toEqual({ eligible: true, reason: "eligible" });
      expect(a16zSpeedrun006GraphDataset.evidence.filter((candidate) => candidate.sourceUrl === item.sourceUrl)).toHaveLength(1);
      expect(
        a16zSpeedrun006GraphDataset.evidence.filter(
          (candidate) => candidate.platform === item.platform && candidate.platformPostId === item.platformPostId
        )
      ).toHaveLength(1);
    }
  });

  it("scores seeded A16Z Instagram traction posts from native post URLs", () => {
    const graph = buildGraphResponse({ batchSlug: A16Z_SPEEDRUN_006_BATCH_SLUG }, ycSpring2026GraphDataset);
    const clair = graph.leaderboard.find((row) => row.companyName === "Clair Health");
    const mirrorMirror = graph.leaderboard.find((row) => row.companyName === "Mirror Mirror AI");
    const clairInstagramEvidence = graph.evidence.find(
      (item) => item.sourceUrl === "https://www.instagram.com/reel/DWt6B3bieXE/"
    );
    const yusanInstagramEvidence = graph.evidence.find(
      (item) => item.sourceUrl === "https://www.instagram.com/p/DV9vi8vgUkp/"
    );

    expect(clairInstagramEvidence).toEqual(
      expect.objectContaining({
        entityType: "company",
        platform: "instagram",
        attachedCompanyName: "Clair Health",
        accountUrl: "https://www.instagram.com/clair_health",
        metrics: expect.objectContaining({
          likes: 5364,
          comments: 104
        })
      })
    );
    expect(yusanInstagramEvidence).toEqual(
      expect.objectContaining({
        entityType: "founder",
        platform: "instagram",
        attachedCompanyName: "Mirror Mirror AI",
        accountUrl: "https://www.instagram.com/yusan.lin",
        metrics: expect.objectContaining({
          likes: 1961,
          comments: 29
        })
      })
    );
    expect(clairInstagramEvidence?.contributionScore).toBeGreaterThan(0);
    expect(yusanInstagramEvidence?.contributionScore).toBeGreaterThan(0);
    expect(clair?.score).toBeGreaterThan(0);
    expect(mirrorMirror?.score).toBeGreaterThan(0);
    expect(clair?.socialAccounts.map((account) => account.platform)).toContain("instagram");
    expect(mirrorMirror?.founderAccounts?.flatMap((founder) => founder.socialAccounts.map((account) => account.url))).toContain(
      "https://www.instagram.com/yusan.lin"
    );
  });

  it("scores native Product Hunt launches and preserves product roots as context", () => {
    const graph = buildGraphResponse({ batchSlug: A16Z_SPEEDRUN_006_BATCH_SLUG }, ycSpring2026GraphDataset);
    const sun = graph.leaderboard.find((row) => row.companyName === "SUN");
    const taxnova = graph.leaderboard.find((row) => row.companyName === "Taxnova");
    const sunNode = graph.nodes.find((node) => node.entityType === "company" && node.label === "SUN");
    const taxnovaNode = graph.nodes.find((node) => node.entityType === "company" && node.label === "Taxnova");
    const sunLaunchEvidence = graph.evidence.find(
      (item) => item.sourceUrl === "https://www.producthunt.com/products/sun-ai/launches/sun-to-spotify"
    );
    const taxnovaLaunchEvidence = graph.evidence.find(
      (item) => item.sourceUrl === "https://www.producthunt.com/products/taxnova"
    );

    expect(sunLaunchEvidence).toEqual(
      expect.objectContaining({
        entityType: "company",
        platform: "product_hunt",
        attachedCompanyName: "SUN",
        accountUrl: "https://www.producthunt.com/products/sun-ai",
        metrics: expect.objectContaining({
          upvotes: 361,
          comments: 32
        })
      })
    );
    expect(taxnovaLaunchEvidence).toEqual(
      expect.objectContaining({
        platform: "product_hunt",
        attachedCompanyName: "Taxnova",
        accountUrl: "https://www.producthunt.com/products/taxnova",
        metrics: expect.objectContaining({
          upvotes: 66
        })
      })
    );
    expect(sunLaunchEvidence?.contributionScore).toBeGreaterThan(0);
    expect(taxnovaLaunchEvidence?.contributionScore).toBe(0);
    expect(taxnovaLaunchEvidence?.why).toContain("not_native_evidence");
    expect(sun?.socialAccounts.map((account) => account.url)).toContain("https://www.producthunt.com/products/sun-ai");
    expect(taxnova?.socialAccounts.map((account) => account.url)).toContain("https://www.producthunt.com/products/taxnova");
    expect(sunNode?.platformScores.product_hunt).toBeGreaterThan(0);
    expect(taxnovaNode?.platformScores.product_hunt ?? 0).toBe(0);
  });

  it("surfaces second-pass A16Z LinkedIn and GitHub evidence in the graph", () => {
    const graph = buildGraphResponse({ batchSlug: A16Z_SPEEDRUN_006_BATCH_SLUG }, ycSpring2026GraphDataset);

    expectA16zEvidence(
      graph.evidence,
      "https://www.linkedin.com/posts/davewevans_im-excited-to-announce-that-auto-has-raised-activity-7477783080536014849-LBsU",
      "Auto",
      "linkedin"
    );
    expectA16zEvidence(
      graph.evidence,
      "https://www.linkedin.com/posts/sanjaydasari_today-were-officially-launching-heavi-ai-activity-7434677355584856065-mh5S",
      "Heavi",
      "linkedin"
    );
    expectA16zEvidence(
      graph.evidence,
      "https://www.linkedin.com/posts/andrewchen_ai-retention-say-no-more-activity-7449510003406815232-aewb",
      "Sirius Technology",
      "linkedin"
    );
    expectA16zEvidence(graph.evidence, "https://github.com/Belong-dev/careers", "Belong", "github");
    expectA16zEvidence(
      graph.evidence,
      "https://www.linkedin.com/posts/margaretczhang_i-joined-forces-with-david-s-huang-to-unlock-activity-7449510766657060864-g9St",
      "Thirdbrain Labs",
      "linkedin"
    );
    expectA16zEvidence(
      graph.evidence,
      "https://www.linkedin.com/posts/ben-segal-39306311b_this-has-been-hard-to-keep-quiet-variant-activity-7429910776573886464-Akw3",
      "VariantNow",
      "linkedin"
    );
    expectA16zEvidence(
      graph.evidence,
      "https://www.linkedin.com/posts/addihd_some-news-we-are-backed-by-a16z-speedrun-activity-7444826615626424320-_cUR",
      "Alike",
      "linkedin"
    );
    expectA16zEvidence(
      graph.evidence,
      "https://www.linkedin.com/posts/aaron-hao-tan_excited-to-share-lume-a-lamp-that-does-your-activity-7454570532571873280-osow",
      "Syncere",
      "linkedin"
    );
    expectA16zEvidence(graph.evidence, "https://x.com/aaronistan/status/2039859651500761143", "Syncere", "x");
    expectA16zEvidence(
      graph.evidence,
      "https://www.linkedin.com/posts/ryanlau512_today-im-super-excited-to-share-that-straia-activity-7404579406955872258-spWu",
      "Straia",
      "linkedin"
    );
    expectA16zEvidence(graph.evidence, "https://www.youtube.com/watch?v=yykNCQBosHs", "snag", "youtube");
    expectA16zEvidence(graph.evidence, "https://github.com/modaic-ai/ds.ts", "Modaic", "github");
    expectA16zEvidence(graph.evidence, "https://github.com/modaic-ai/gepa-viz", "Modaic", "github");
    expectA16zEvidence(graph.evidence, "https://github.com/modaic-ai/microcode", "Modaic", "github");
    expectA16zEvidence(graph.evidence, "https://github.com/modaic-ai/modaic", "Modaic", "github");
    expectA16zEvidence(graph.evidence, "https://github.com/modaic-ai/gepa-rpc", "Modaic", "github");
    expectA16zEvidence(graph.evidence, "https://github.com/firetix/vibe-coding-penetration-tester", "SafeWorld", "github");
    expectA16zEvidence(graph.evidence, "https://www.instagram.com/reel/DL8lQcXSma5/", "Mirror Mirror AI", "instagram");
    expectA16zEvidence(
      graph.evidence,
      "https://www.linkedin.com/posts/chinmaychauhan_excited-to-announce-that-acceler8-has-raised-activity-7434784959380279296-DUM6",
      "Acceler8",
      "linkedin"
    );
    expectA16zEvidence(
      graph.evidence,
      "https://www.linkedin.com/posts/samuel-oh1_why-are-my-hands-in-the-air-cheering-while-activity-7452803290792361985-i6SA",
      "Concorda",
      "linkedin"
    );
    expectA16zEvidence(graph.evidence, "https://github.com/amdahlco/amdahl-cookbook", "Amdahl", "github");
  });

  it("surfaces Sol Ultra A16Z founder posts in the graph", () => {
    const graph = buildGraphResponse({ batchSlug: A16Z_SPEEDRUN_006_BATCH_SLUG }, ycSpring2026GraphDataset);

    expectA16zEvidence(
      graph.evidence,
      "https://www.linkedin.com/posts/kash-nathan_weve-spent-the-past-6-weeks-building-closely-activity-7415075507148619776-5TRg",
      "Meridian",
      "linkedin"
    );
    expectA16zEvidence(
      graph.evidence,
      "https://www.linkedin.com/posts/arlenmarmel_ahr-activity-7426329274074234880-roTw",
      "Quinn",
      "linkedin"
    );
    expectA16zEvidence(
      graph.evidence,
      "https://www.linkedin.com/posts/arlenmarmel_ahr-ahr-ahr2026-activity-7424261864970162176-bf4u",
      "Quinn",
      "linkedin"
    );
    expectA16zEvidence(
      graph.evidence,
      "https://www.linkedin.com/posts/arlenmarmel_why-frontline-training-fails-real-insights-activity-7469821319237410819-QnOe",
      "Quinn",
      "linkedin"
    );
    expectA16zEvidence(
      graph.evidence,
      "https://www.linkedin.com/posts/arlenmarmel_scale-training-capacity-beyond-limited-windows-activity-7468638529665863680-ds-F",
      "Quinn",
      "linkedin"
    );
    expectA16zEvidence(graph.evidence, "https://github.com/MeetQuinn/anima", "Quinn", "github");
    expectA16zEvidence(graph.evidence, "https://github.com/MeetQuinn/quinn-sdk", "Quinn", "github");
    for (const repositoryCase of SIMULA_GITHUB_REPOSITORY_CASES) {
      expectA16zEvidence(graph.evidence, repositoryCase.sourceUrl, "Simula", "github");
    }
    expectA16zEvidence(graph.evidence, "https://x.com/stedelmanto/status/2072374506149064784", "Oasis", "x");
    expectA16zEvidence(graph.evidence, "https://x.com/stedelmanto/status/2070183181970530569", "Oasis", "x");
    expectA16zEvidence(graph.evidence, "https://x.com/stedelmanto/status/2068042968410247494", "Oasis", "x");
  });

  it("canonicalizes Simula GitHub repositories without making commit URLs scoreable", () => {
    const graph = buildGraphResponse({ batchSlug: A16Z_SPEEDRUN_006_BATCH_SLUG }, ycSpring2026GraphDataset);
    const simula = graph.nodes.find((node) => node.entityType === "company" && node.label === "Simula");
    const githubEvidence = graph.evidence.filter(
      (item) => item.attachedCompanyName === "Simula" && item.platform === "github"
    );

    expect(githubEvidence).toHaveLength(SIMULA_GITHUB_REPOSITORY_CASES.length);
    expect(new Set(githubEvidence.map((item) => item.sourceUrl)).size).toBe(githubEvidence.length);
    expect(githubEvidence.some((item) => /\/commit\//i.test(item.sourceUrl))).toBe(false);

    for (const repositoryCase of SIMULA_GITHUB_REPOSITORY_CASES) {
      const item = githubEvidence.find((candidate) => candidate.sourceUrl === repositoryCase.sourceUrl);
      const provenance = JSON.parse(item?.rawVisibleText ?? "null") as {
        canonicalRepository?: unknown;
        sourceProvenance?: {
          kind?: string;
          sourceUrl?: string;
          platformPostId?: string;
          rawVisibleText?: { verification?: { status?: string; metricsVisible?: boolean } };
        };
      };

      expect(item).toEqual(
        expect.objectContaining({
          sourceUrl: repositoryCase.sourceUrl,
          platformPostId: repositoryCase.platformPostId,
          mediaType: "repo",
          mediaUrl: repositoryCase.sourceUrl,
          metrics: repositoryCase.metrics,
          contributionScore: expect.any(Number)
        })
      );
      expect(item?.contributionScore).toBeGreaterThan(0);
      expect(scoringEligibility(item!)).toEqual({ eligible: true, reason: "eligible" });
      expect(provenance).toEqual(
        expect.objectContaining({
          canonicalRepository: {
            sourceUrl: repositoryCase.sourceUrl,
            platformPostId: repositoryCase.platformPostId,
            metrics: repositoryCase.metrics
          },
          sourceProvenance: expect.objectContaining({
            kind: "github_commit",
            sourceUrl: repositoryCase.sourceCommitUrl,
            platformPostId: repositoryCase.sourceCommitId,
            rawVisibleText: expect.objectContaining({
              verification: expect.objectContaining({ status: "accepted", metricsVisible: true })
            })
          })
        })
      );

      expect(
        scoringEligibility({
          ...item!,
          id: `${item!.id}-source-commit`,
          sourceUrl: repositoryCase.sourceCommitUrl,
          platformPostId: repositoryCase.sourceCommitId,
          contributionScore: 1
        })
      ).toEqual({ eligible: false, reason: "not_native_evidence" });
    }

    expect(simula?.platformScores.github).toBeGreaterThan(0);
    expect(simula?.scoreBreakdown?.absoluteScore).toBeGreaterThan(0);
    expect(simula?.score).toBeGreaterThan(0);
  });

  it("keeps external Top Voice attention on the company while retaining its founder target", () => {
    for (const regressionCase of EXTERNAL_TOP_VOICE_ATTENTION_CASES) {
      const item = a16zSpeedrun006GraphDataset.evidence.find(
        (candidate) => candidate.sourceUrl === regressionCase.sourceUrl
      );

      expect(item).toEqual(
        expect.objectContaining({
          entityType: "company",
          entityId: regressionCase.companyId,
          attachedCompanyId: regressionCase.companyId,
          attachedCompanyName: regressionCase.companyName,
          authorName: "Andrew Chen",
          authorHandle: "andrewchen",
          targetFounderId: regressionCase.targetFounderId
        })
      );
    }

    expect(
      a16zSpeedrun006GraphDataset.evidence.find(
        (item) => item.sourceUrl === "https://www.linkedin.com/posts/harpriya_what-a-week-at-a16z-speedrun-in-san-francisco-activity-7448045636349775872-R-MR"
      )
    ).toEqual(
      expect.objectContaining({
        entityType: "founder",
        entityId: "a16z-speedrun-006-hotbox-founder-harpriya-bagri",
        authorName: "Harpriya Bagri"
      })
    );
  });

  it("surfaces external A16Z attention in Insider mode without inflating founder rollups", () => {
    const graph = buildGraphResponse(
      { batchSlug: A16Z_SPEEDRUN_006_BATCH_SLUG, topVoices: "insiders" },
      ycSpring2026GraphDataset
    );

    for (const regressionCase of EXTERNAL_TOP_VOICE_ATTENTION_CASES) {
      const item = graph.evidence.find((candidate) => candidate.sourceUrl === regressionCase.sourceUrl);
      const companyNode = graph.nodes.find((node) => node.entityId === regressionCase.companyId);
      const targetFounder = companyNode?.founders.find((founder) => founder.id === regressionCase.targetFounderId);
      const targetFounderEvidence = graph.evidence.filter(
        (candidate) =>
          targetFounder?.evidenceIds.includes(candidate.id) &&
          candidate.entityType === "founder" &&
          candidate.entityId === regressionCase.targetFounderId
      );

      expect(item).toEqual(
        expect.objectContaining({
          entityType: "company",
          entityId: regressionCase.companyId,
          attachedCompanyId: regressionCase.companyId,
          topVoice: expect.objectContaining({
            audienceId: "insiders",
            displayName: "Andrew Chen"
          })
        })
      );
      expect(companyNode?.evidenceIds).toContain(item?.id);
      expect(targetFounder?.evidenceIds).not.toContain(item?.id);
      expect(targetFounderEvidence.map((candidate) => candidate.id)).toEqual(targetFounder?.evidenceIds);
    }
  });

  it("does not count unseeded previous founder history as company traction", () => {
    const graph = buildGraphResponse({ batchSlug: A16Z_SPEEDRUN_006_BATCH_SLUG }, ycSpring2026GraphDataset);
    const hammock = graph.nodes.find((node) => node.entityType === "company" && node.label === "Hammock");
    const heavi = graph.nodes.find((node) => node.entityType === "company" && node.label === "Heavi");

    expect(hammock?.score).toBeGreaterThan(0);
    expect(
      graph.evidence
        .filter((item) => item.attachedCompanyName === "Hammock")
        .map((item) => item.sourceUrl)
    ).toEqual(expect.arrayContaining([
      "https://www.linkedin.com/posts/jesserose_ai-a16z-speedrun-activity-7442990067469553664-UgHd",
      "https://www.linkedin.com/posts/williamldennis_im-excited-to-share-that-my-long-time-friend-activity-7442990082891894784-H7Iw"
    ]));
    expect(
      graph.evidence
        .filter((item) => item.attachedCompanyName === "Heavi")
        .map((item) => item.sourceUrl)
    ).not.toContain("https://www.linkedin.com/posts/williamldennis_im-excited-to-share-that-my-long-time-friend-activity-7442990082891894784-H7Iw");
    expect(heavi?.score).toBeGreaterThan(0);
  });
});

function calibrationCompany(id: string, absoluteScore: number): CompanyRecord {
  const hasEvidence = absoluteScore > 0;

  return {
    id,
    batchSlug: "test",
    name: id,
    ycProfileUrl: `https://example.com/${id}`,
    websiteUrl: `https://example.com/${id}`,
    tagline: id,
    description: id,
    groupPartner: null,
    primaryIndustry: "test",
    businessModel: "b2b",
    review_state: "verified",
    sourceUrl: `https://example.com/${id}`,
    industries: [],
    founderIds: [],
    socialAccounts: [],
    totalScore: absoluteScore,
    previousScore: absoluteScore,
    platformScores: hasEvidence ? { x: absoluteScore } : {},
    scoreBreakdown: {
      modelId: TRACTION_SCORING_CONFIG.modelId,
      modelVersion: TRACTION_SCORING_CONFIG.version,
      modelName: TRACTION_SCORING_CONFIG.name,
      totalScore: absoluteScore,
      absoluteScore,
      weightedAvailableScore: absoluteScore,
      coverageFactor: hasEvidence ? 1 : 0,
      platformsWithEvidence: hasEvidence ? 1 : 0,
      totalSupportedPlatforms: 1,
      platformScores: hasEvidence ? { x: absoluteScore } : {},
      weightedPlatforms: hasEvidence
        ? [{
            platform: "x",
            score: absoluteScore,
            configuredWeight: 1,
            appliedWeight: 1,
            contribution: absoluteScore,
            evidenceCount: 1
          }]
        : [],
      signalFamilyScores: {
        reach: absoluteScore,
        engagement: absoluteScore,
        developerAdoption: 0,
        launchAndCommunity: 0,
        momentum: 0
      },
      confidence: {
        level: "low",
        value: hasEvidence ? 0.5 : 0,
        reasons: [],
        scoredEvidenceCount: hasEvidence ? 1 : 0,
        datedEvidenceCount: hasEvidence ? 1 : 0,
        verifiedLinkCount: hasEvidence ? 1 : 0
      },
      calibration: {
        method: "none",
        cohortSize: 0,
        percentile: null,
        inputScore: absoluteScore
      },
      limitations: [],
      evidenceAsOf: null,
      explanation: "Absolute score."
    }
  };
}

function nodeSocialAccounts(node: GraphNode | undefined): SocialAccountSummary[] {
  if (!node) return [];

  return [
    ...node.socialAccounts,
    ...node.founders.flatMap((founder) => founder.socialAccounts)
  ];
}

function materializedAccountOwners(
  dataset: Pick<typeof a16zSpeedrun006GraphDataset, "companies" | "founders">
): Array<{
  entityType: "company" | "founder";
  entityId: string;
  account: SocialAccountSummary;
}> {
  return [
    ...dataset.companies.flatMap((company) =>
      company.socialAccounts.map((account) => ({ entityType: "company" as const, entityId: company.id, account }))
    ),
    ...dataset.founders.flatMap((founder) =>
      founder.socialAccounts.map((account) => ({ entityType: "founder" as const, entityId: founder.id, account }))
    )
  ];
}

function nativeSeedAccountsForCompany(companyName: string): A16zSocialSeedAccount[] {
  const seedCompany = a16zSocialSeedSnapshot.companies.find((company) => company.companyName === companyName);
  if (!seedCompany) return [];

  return [
    ...(seedCompany.accounts ?? []),
    ...(seedCompany.founders ?? []).flatMap((founder) => founder.accounts ?? [])
  ].filter((account) => A16Z_NATIVE_SOCIAL_TRACTION_PLATFORMS.has(account.platform));
}

function hasPositivePlatformScore(scores: Partial<Record<Platform, number>>, platform: Platform): boolean {
  return (scores[platform] ?? 0) > 0;
}

function hasAnyPositiveNonNativePlatformScore(scores: Partial<Record<Platform, number>>): boolean {
  return Object.entries(scores).some(
    ([platform, score]) => (score ?? 0) > 0 && !A16Z_NATIVE_SOCIAL_TRACTION_PLATFORMS.has(platform as Platform)
  );
}

function accountHasWebOrSpeedrunUrl(account: SocialAccountSummary): boolean {
  return (
    account.platform === "web" ||
    isSpeedrunUrl(account.url)
  );
}

function isSpeedrunUrl(url: string | null | undefined): boolean {
  return Boolean(url?.startsWith(A16Z_SPEEDRUN_SOURCE_PREFIX));
}

function accountUrlMatchesPlatform(account: SocialAccountSummary): boolean {
  switch (account.platform) {
    case "github":
      return /^https:\/\/(www\.)?github\.com\//.test(account.url);
    case "x":
      return /^https:\/\/(www\.)?(x|twitter)\.com\//.test(account.url);
    case "linkedin":
      return /^https:\/\/(www\.)?linkedin\.com\//.test(account.url);
    case "instagram":
      return /^https:\/\/(www\.)?instagram\.com\//.test(account.url);
    case "youtube":
      return /^https:\/\/(www\.)?youtube\.com\//.test(account.url);
    case "reddit":
      return /^https:\/\/(www\.)?reddit\.com\//.test(account.url);
    case "product_hunt":
      return /^https:\/\/(www\.)?producthunt\.com\//.test(account.url);
    case "hacker_news":
      return /^https:\/\/news\.ycombinator\.com\//.test(account.url);
    case "bilibili":
      return /^https:\/\/(www\.)?(space\.)?bilibili\.com\//.test(account.url);
    case "web":
      return false;
    default:
      return false;
  }
}

function expectA16zEvidence(
  items: Array<{ sourceUrl: string; attachedCompanyName?: string; platform: Platform; contributionScore: number }>,
  sourceUrl: string,
  companyName: string,
  platform: Platform
): void {
  const item = items.find((candidate) => candidate.sourceUrl === sourceUrl);

  expect(item).toEqual(
    expect.objectContaining({
      platform,
      attachedCompanyName: companyName,
      sourceUrl
    })
  );
  expect(item?.contributionScore).toBeGreaterThan(0);
}
