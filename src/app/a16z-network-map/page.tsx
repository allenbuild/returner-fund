import { EcosystemIntentPage } from "@/components/seo/EcosystemIntentPage";
import { publicMetadata } from "@/lib/seo/site";

const path = "/a16z-network-map";
const title = "a16z Speedrun network map: Batch 006 startups";
const description = "Explore the independent a16z Speedrun 006 network map, with startups organized by founders, industries, group partners, and public traction evidence.";

export const metadata = publicMetadata({ title, description, path });

export default function A16zNetworkMapPage() {
  return <EcosystemIntentPage ecosystem="a16z" intent="network-map" path={path} title={title} description={description} />;
}
