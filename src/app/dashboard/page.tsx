import type { Metadata } from "next";
import { Dashboard } from "@/components/Dashboard";
import type { DashboardPublicFeedSnapshot } from "@/lib/dashboard/contracts";
import { loadPublicDashboardFeedSnapshot } from "@/lib/dashboard/store";
import { publicMetadata } from "@/lib/seo/site";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const title = "Top 100";
const description = "A consolidated technology article index inside the Returner network map.";

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
    // The client surface retries the compact published API artifact if this
    // first server read is unavailable.
  }

  return <Dashboard initialDashboardSnapshot={snapshot} initialSurface="top100" manualRefreshEnabled={false} />;
}
