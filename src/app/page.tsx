import { Dashboard } from "@/components/Dashboard";
import type { Metadata } from "next";
import type { Platform } from "@/lib/graph/types";
import { normalizeTopVoiceAudienceId } from "@/lib/social/top-voices";

const A16Z_SPEEDRUN_BATCH_SLUG = "A16ZSR006";
const queryPlatforms: Platform[] = [
  "github",
  "x",
  "linkedin",
  "instagram",
  "product_hunt",
  "youtube",
  "rss",
  "web",
  "reddit",
  "hacker_news",
  "bilibili",
  "tiktok",
  "bluesky"
];

interface PageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ searchParams }: PageProps): Promise<Metadata> {
  const params = (await searchParams) ?? {};
  const batchSlug = singleQueryValue(params.batch);

  return {
    title: batchSlug === A16Z_SPEEDRUN_BATCH_SLUG ? "a16z Network Map" : "YC Network Map"
  };
}

export default async function Home({ searchParams }: PageProps) {
  const params = (await searchParams) ?? {};
  const batchSlug = singleQueryValue(params.batch);
  const platforms = parsePlatformList(singleQueryValue(params.platforms));
  const topVoices = normalizeTopVoiceAudienceId(singleQueryValue(params.topVoices));

  return (
    <Dashboard
      initialBatchSlug={batchSlug}
      initialTopVoiceAudience={topVoices}
      initialFilters={{ platforms }}
      manualRefreshEnabled={process.env.NODE_ENV !== "production"}
    />
  );
}

function singleQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parsePlatformList(value: string | undefined): Platform[] {
  if (!value) {
    return [];
  }

  const allowed = new Set(queryPlatforms);
  return [...new Set(value.split(",").map((item) => item.trim()).filter((item): item is Platform => allowed.has(item as Platform)))];
}
