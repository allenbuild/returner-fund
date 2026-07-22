import { EcosystemIntentPage } from "@/components/seo/EcosystemIntentPage";
import { publicMetadata } from "@/lib/seo/site";

const path = "/yc-network-map";
const title = "YC network map: Spring and Summer 2026 startups";
const description = "Explore an independent YC network map covering Spring and Summer 2026 startups, with founders, industries, group partners, and public traction evidence.";

export const metadata = publicMetadata({ title, description, path });

export default function YcNetworkMapPage() {
  return <EcosystemIntentPage ecosystem="yc" intent="network-map" path={path} title={title} description={description} />;
}
