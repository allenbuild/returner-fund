import { Dashboard } from "@/components/Dashboard";
import type { DashboardPublicFeedSnapshot } from "@/lib/dashboard/contracts";
import { loadPublicDashboardFeedSnapshot } from "@/lib/dashboard/store";
import type { Metadata } from "next";
import { HomeStructuredData } from "@/components/seo/HomeDiscovery";
import { findCohort, getCatalog, type PublicCohort } from "@/lib/seo/catalog";
import { publicMetadata, truncateDescription } from "@/lib/seo/site";
import { networkMapTitle } from "@/lib/graph/network-map-branding";
import type { Platform, TopVoiceAudienceId } from "@/lib/graph/types";
import { normalizeTopVoiceAudienceId } from "@/lib/social/top-voices";
import { COMPANY_VERTICALS, isCompanyVertical, type CompanyVertical } from "@/lib/graph/company-verticals";
import { normalizePostTopics, type PostTopic } from "@/lib/graph/post-topics";

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
  const requestedBatch = singleQueryValue(params.batch);
  const cohort = selectedCohort(requestedBatch);
  const isQueryView = Object.values(params).some((value) => value !== undefined);
  const title = networkMapTitle(cohort.batchSlug);
  const description = truncateDescription(
    `${cohort.label} startup traction map with ${cohort.companies.length} companies and ${cohort.evidenceCount.toLocaleString("en-US")} public evidence records.`
  );

  const metadata = publicMetadata({
    title,
    description,
    path: "/",
    index: !isQueryView
  });

  return {
    ...metadata,
    title: { absolute: title },
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
  const initialSurface = singleQueryValue(params.mode) === "top100" ? "top100" : "map";
  const dashboardSnapshot = initialSurface === "top100"
    ? await loadDashboardSnapshot()
    : null;
  const platforms = parsePlatformList(singleQueryValue(params.platforms));
  const topics = parseTopicList(singleQueryValue(params.topics));
  const verticals = parseVerticalList(singleQueryValue(params.verticals));
  const topVoices = normalizeTopVoiceAudienceId(singleQueryValue(params.topVoices));

  return (
    <HomeContent
      initialDashboardSnapshot={dashboardSnapshot}
      initialSurface={initialSurface}
      selectedBatchSlug={cohort.batchSlug}
      platforms={platforms}
      topics={topics}
      verticals={verticals}
      topVoices={topVoices}
      manualRefreshEnabled={process.env.NODE_ENV !== "production"}
    />
  );
}

function HomeContent({
  initialDashboardSnapshot,
  initialSurface,
  selectedBatchSlug,
  platforms,
  topics,
  verticals,
  topVoices,
  manualRefreshEnabled
}: {
  initialDashboardSnapshot: DashboardPublicFeedSnapshot | null;
  initialSurface: "map" | "top100";
  selectedBatchSlug: string;
  platforms: Platform[];
  topics: PostTopic[];
  verticals: CompanyVertical[];
  topVoices: TopVoiceAudienceId;
  manualRefreshEnabled: boolean;
}) {
  return (
    <>
      <Dashboard
        initialBatchSlug={selectedBatchSlug}
        initialDashboardSnapshot={initialDashboardSnapshot}
        initialTopVoiceAudience={topVoices}
        initialFilters={{ platforms, topics, verticals }}
        initialSurface={initialSurface}
        manualRefreshEnabled={manualRefreshEnabled}
      />
      <HomeStructuredData />
    </>
  );
}

async function loadDashboardSnapshot(): Promise<DashboardPublicFeedSnapshot | null> {
  try {
    return await loadPublicDashboardFeedSnapshot();
  } catch {
    // The client Top 100 surface retries the already-published API artifact
    // without initiating live collection in a visitor request.
    return null;
  }
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

function parseTopicList(value: string | undefined): PostTopic[] {
  return normalizePostTopics((value ?? "").split(",").map((item) => item.trim()));
}

function parseVerticalList(value: string | undefined): CompanyVertical[] {
  const selected = new Set((value ?? "").split(",").map((item) => item.trim()).filter(isCompanyVertical));
  return COMPANY_VERTICALS.map(({ slug }) => slug).filter((vertical) => selected.has(vertical));
}
