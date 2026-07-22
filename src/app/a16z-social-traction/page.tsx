import { EcosystemIntentPage } from "@/components/seo/EcosystemIntentPage";
import { publicMetadata } from "@/lib/seo/site";

const path = "/a16z-social-traction";
const title = "a16z Speedrun social traction rankings: Batch 006";
const description = "Compare a16z Speedrun 006 startups by public social, developer, launch, video, community, and web traction with source-level evidence.";

export const metadata = publicMetadata({ title, description, path });

export default function A16zSocialTractionPage() {
  return <EcosystemIntentPage ecosystem="a16z" intent="social-traction" path={path} title={title} description={description} />;
}
