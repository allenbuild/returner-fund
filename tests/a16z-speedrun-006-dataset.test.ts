import { describe, expect, it } from "vitest";
import {
  A16Z_SPEEDRUN_006_BATCH_LABEL,
  A16Z_SPEEDRUN_006_BATCH_SLUG
} from "@/lib/graph/a16z-speedrun-006-dataset";
import { buildGraphResponse } from "@/lib/graph/graph-builder";
import type { GraphNode, Platform, SocialAccountSummary } from "@/lib/graph/types";
import { ycSpring2026GraphDataset } from "@/lib/graph/yc-spring-2026-dataset";
import socialAccountSeedSnapshot from "@/lib/social/a16z-speedrun-006-social-accounts.json";

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
const CREBIT_SCREENSHOT_POST_URL =
  "https://www.linkedin.com/posts/simmi-sen_crebit-founding-engineer-application-activity-7475266867537039360-QwfJ";
const CREBIT_BACKED_BY_A16Z_POST_URL =
  "https://www.linkedin.com/posts/simmi-sen_crebit-is-backed-by-a16z-speedrun-since-activity-7424504480077062144-_L5q";
const CREBIT_GROWTH_INTERN_POST_URL =
  "https://www.linkedin.com/posts/simmi-sen_we-are-hiring-ten-paid-growth-interns-for-activity-7403840813530570752-U_Nm";

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
    expect(sentra?.topPlatform).toBe("linkedin");
    expect(sentra?.score).toBeGreaterThan(0);
    expect(sentra?.socialAccounts.map((account) => account.platform)).toContain("linkedin");
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

    expect(sunYouTubeEvidence).toHaveLength(11);
    expect(sunYouTubeEvidence.map((item) => item.sourceUrl)).toEqual(
      expect.arrayContaining([
        "https://www.youtube.com/watch?v=FTVKNZtv7-o",
        "https://www.youtube.com/watch?v=Qj6VFxD0Hbo",
        "https://www.youtube.com/watch?v=qHlEhqdAZxc",
        "https://www.youtube.com/watch?v=tJS3OsGtGQw",
        "https://www.youtube.com/watch?v=HbJiEHaSz-s"
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

  it("scores seeded A16Z Product Hunt launches from native Product Hunt URLs", () => {
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
    expect(taxnovaLaunchEvidence?.contributionScore).toBeGreaterThan(0);
    expect(sun?.socialAccounts.map((account) => account.url)).toContain("https://www.producthunt.com/products/sun-ai");
    expect(taxnova?.socialAccounts.map((account) => account.url)).toContain("https://www.producthunt.com/products/taxnova");
    expect(sunNode?.platformScores.product_hunt).toBeGreaterThan(0);
    expect(taxnovaNode?.platformScores.product_hunt).toBeGreaterThan(0);
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
    expect(heavi?.score).toBe(0);
  });
});

function nodeSocialAccounts(node: GraphNode | undefined): SocialAccountSummary[] {
  if (!node) return [];

  return [
    ...node.socialAccounts,
    ...node.founders.flatMap((founder) => founder.socialAccounts)
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
