import type { Metadata } from "next";
import { TopStoriesDashboard } from "@/components/dashboard/TopStoriesDashboard";
import type { DashboardPublicFeedSnapshot } from "@/lib/dashboard/contracts";
import { loadPublicDashboardFeedSnapshot } from "@/lib/dashboard/store";
import { publicMetadata } from "@/lib/seo/site";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const title = "Top 100 Today";
const description = "The 100 most important technology developments from the rolling last 24 hours, ranked by attention and momentum.";

export const metadata: Metadata = publicMetadata({
  title,
  description,
  path: "/dashboard"
});

export default async function PublicDashboardPage() {
  let snapshot: DashboardPublicFeedSnapshot | null = null;

  try {
    snapshot = await loadPublicDashboardFeedSnapshot();
  } catch {
    // The public route remains useful during a failed publication. The client
    // renders an explicit empty state instead of performing live discovery.
  }

  return <TopStoriesDashboard snapshot={snapshot} />;
}
