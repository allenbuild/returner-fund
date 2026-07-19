import { Dashboard } from "@/components/Dashboard";
import type { Metadata } from "next";
import { HomeDiscovery } from "@/components/seo/HomeDiscovery";
import { findCohort, getCatalog, type PublicCohort } from "@/lib/seo/catalog";
import { publicMetadata, SITE_NAME, truncateDescription } from "@/lib/seo/site";
import type { Platform, TopVoiceAudienceId } from "@/lib/graph/types";
import { normalizeTopVoiceAudienceId } from "@/lib/social/top-voices";

const DEFAULT_BATCH_SLUG = "S2026";
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
  const cohort = selectedCohort(singleQueryValue(params.batch));
  const isQueryView = Object.values(params).some((value) => value !== undefined);
  const description = truncateDescription(
    `${cohort.label} startup traction map with ${cohort.companies.length} companies and ${cohort.evidenceCount.toLocaleString("en-US")} public evidence records.`
  );

  const metadata = publicMetadata({
    title: isQueryView ? `${cohort.label} traction map | ${SITE_NAME}` : `Startup traction intelligence | ${SITE_NAME}`,
    description: isQueryView ? description : "Explore public startup traction across accelerator cohorts, founders, industries, and social platforms.",
    path: isQueryView ? `/cohorts/${cohort.slug}` : "/",
    index: !isQueryView
  });

  return {
    ...metadata,
    robots: {
      index: !isQueryView,
      follow: true,
      googleBot: {
        index: !isQueryView,
        follow: true,
        "max-image-preview": "large",
        "max-snippet": -1,
        "max-video-preview": -1
      }
    }
  };
}

export default async function Home({ searchParams }: PageProps) {
  const params = (await searchParams) ?? {};
  const cohort = selectedCohort(singleQueryValue(params.batch));
  const platforms = parsePlatformList(singleQueryValue(params.platforms));
  const topVoices = normalizeTopVoiceAudienceId(singleQueryValue(params.topVoices));

  return (
    <HomeContent
      selectedBatchSlug={cohort.batchSlug}
      platforms={platforms}
      topVoices={topVoices}
      manualRefreshEnabled={process.env.NODE_ENV !== "production"}
    />
  );
}

function HomeContent({
  selectedBatchSlug,
  platforms,
  topVoices,
  manualRefreshEnabled
}: {
  selectedBatchSlug: string;
  platforms: Platform[];
  topVoices: TopVoiceAudienceId;
  manualRefreshEnabled: boolean;
}) {
  return (
    <>
      <Dashboard
        initialBatchSlug={selectedBatchSlug}
        initialTopVoiceAudience={topVoices}
        initialFilters={{ platforms }}
        manualRefreshEnabled={manualRefreshEnabled}
      />
      <HomeDiscovery selectedBatchSlug={selectedBatchSlug} />
    </>
  );
}

function selectedCohort(batchSlug: string | undefined): PublicCohort {
  const catalog = getCatalog();
  return findCohort(batchSlug ?? DEFAULT_BATCH_SLUG) ??
    findCohort(DEFAULT_BATCH_SLUG) ??
    catalog.cohorts[0];
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
