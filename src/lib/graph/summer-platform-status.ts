import type { GraphResponse, Platform } from "./types";

const YC_SUMMER_2026_BATCH_SLUG = "S26";

type SocialPlatform = Extract<Platform, "github" | "x" | "linkedin" | "instagram" | "youtube">;

export function enrichSummerPlatformStatus(graph: GraphResponse): GraphResponse {
  if (graph.batch.slug !== YC_SUMMER_2026_BATCH_SLUG) {
    return graph;
  }

  const officialCounts = countOfficialSocialAccounts(graph);
  const evidenceCounts = countEvidenceByPlatform(graph);

  return {
    ...graph,
    platformStatus: graph.platformStatus.map((item) => {
      if (item.platform === "x") {
        return {
          ...item,
          notes: `Found ${officialCounts.x.company} company and ${officialCounts.x.founder} founder X URLs on official Summer 2026 YC profiles, but ${evidenceCounts.x ?? 0} scored Summer X post rows are currently available. Anonymous public reads were blocked, and Spring/P26 evidence is filtered out.`
        };
      }
      if (item.platform === "linkedin") {
        return {
          ...item,
          status: evidenceCounts.linkedin ? "working" : item.status,
          authMethod: "Public unauthenticated profile and post discovery only",
          notes: `Found ${officialCounts.linkedin.company} company and ${officialCounts.linkedin.founder} founder LinkedIn URLs on official Summer 2026 YC profiles. ${evidenceCounts.linkedin ?? 0} scored Summer LinkedIn post rows are currently available; no account login, cookies, browser session, or auth headers are used, and prior Spring rows remain excluded.`
        };
      }
      if (item.platform === "instagram") {
        return {
          ...item,
          notes: `Found ${officialCounts.instagram.company} company and ${officialCounts.instagram.founder} founder Instagram URLs on official Summer 2026 YC profiles, so Instagram needs discovery/verified overrides before posts can be fetched. Spring demo/profile snapshots are filtered out.`
        };
      }
      if (item.platform === "youtube") {
        return {
          ...item,
          notes: `Public YouTube results are attempted without login. ${evidenceCounts.youtube ?? 0} verified Summer 2026 YouTube row currently scores.`
        };
      }
      return item;
    })
  };
}

function countOfficialSocialAccounts(graph: GraphResponse): Record<SocialPlatform, { company: number; founder: number }> {
  const result: Record<SocialPlatform, { company: number; founder: number }> = {
    github: { company: 0, founder: 0 },
    x: { company: 0, founder: 0 },
    linkedin: { company: 0, founder: 0 },
    instagram: { company: 0, founder: 0 },
    youtube: { company: 0, founder: 0 }
  };
  const seen = new Set<string>();

  for (const node of graph.nodes) {
    for (const account of node.socialAccounts) {
      if (!isTrackedSocialPlatform(account.platform)) continue;
      const key = `company:${account.platform}:${account.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result[account.platform].company += 1;
    }
    for (const founder of node.founders) {
      for (const account of founder.socialAccounts) {
        if (!isTrackedSocialPlatform(account.platform)) continue;
        const key = `founder:${account.platform}:${account.url}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result[account.platform].founder += 1;
      }
    }
  }

  return result;
}

function countEvidenceByPlatform(graph: GraphResponse): Partial<Record<SocialPlatform, number>> {
  const result: Partial<Record<SocialPlatform, number>> = {};
  for (const item of graph.evidence) {
    if (isTrackedSocialPlatform(item.platform) && item.contributionScore > 0) {
      result[item.platform] = (result[item.platform] ?? 0) + 1;
    }
  }
  return result;
}

function isTrackedSocialPlatform(platform: Platform): platform is SocialPlatform {
  return ["github", "x", "linkedin", "instagram", "youtube"].includes(platform);
}
