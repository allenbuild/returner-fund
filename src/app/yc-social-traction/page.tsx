import { EcosystemIntentPage } from "@/components/seo/EcosystemIntentPage";
import { publicMetadata } from "@/lib/seo/site";

const path = "/yc-social-traction";
const title = "YC social traction rankings: Spring and Summer 2026";
const description = "Compare YC Spring and Summer 2026 startups by public social, developer, launch, video, community, and web traction with source-level evidence.";

export const metadata = publicMetadata({ title, description, path });

export default function YcSocialTractionPage() {
  return <EcosystemIntentPage ecosystem="yc" intent="social-traction" path={path} title={title} description={description} />;
}
