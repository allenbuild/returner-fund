import { DirectoryLink, DirectoryShell } from "@/components/seo/DirectoryShell";
import { DirectoryArticleJsonLd } from "@/components/seo/DirectoryStructuredData";
import { ScoringMethodology } from "@/components/ScoringMethodology";
import { getCatalog } from "@/lib/seo/catalog";
import { publicMetadata } from "@/lib/seo/site";

const title = "Traction score methodology";
const description = "The current V4 baseline, the pre-registered V5 research target, acceptance gates, platform support, uncertainty, and limitations.";

export const metadata = publicMetadata({ title, description, path: "/methodology" });

export default function MethodologyPage() {
  const catalog = getCatalog();
  const example = catalog.companies.find((company) => company.node.scoreBreakdown)?.node.scoreBreakdown;
  const modelName = example?.modelName ?? "Returner traction model";
  const modelVersion = example?.modelVersion ?? "current";
  const supportedPlatforms = new Set(catalog.platforms.map((platform) => platform.platform));

  return (
    <DirectoryShell
      eyebrow="Methodology"
      title={title}
      description={description}
      breadcrumbs={[{ label: "Methodology" }]}
      stats={[
        { label: "Model", value: modelName },
        { label: "Version", value: modelVersion },
        { label: "Observed platforms", value: supportedPlatforms.size }
      ]}
    >
      <DirectoryArticleJsonLd name={title} description={description} path="/methodology" />
      <ScoringMethodology />
      <div className="rf-prose">
        <section><h2>Reading a result</h2><p>Read the visible model version before comparing scores, and use the native evidence, observation cutoff, coverage, and limitations alongside the number. See <DirectoryLink href="/data-sources">data sources</DirectoryLink> for provenance and <DirectoryLink href="/corrections">corrections</DirectoryLink> for disputed records.</p></section>
      </div>
    </DirectoryShell>
  );
}
