import { DirectoryLink, DirectoryShell } from "@/components/seo/DirectoryShell";
import { DirectoryArticleJsonLd } from "@/components/seo/DirectoryStructuredData";
import { getCatalog, platformLabel } from "@/lib/seo/catalog";
import { publicMetadata } from "@/lib/seo/site";

const title = "Traction score methodology";
const description = "How Returner combines public evidence, platform scores, signal families, coverage, confidence, and cohort calibration into a startup traction score.";

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
      <div className="rf-prose">
        <section><h2>What the score measures</h2><p>The 0-100 traction score summarizes observable public activity. The current model groups evidence into reach, engagement, developer adoption, launch and community, and momentum signal families. It is designed for comparison within the available catalog, not as a measure of enterprise value or investment return.</p></section>
        <section><h2>Evidence and platform scores</h2><p>Eligible evidence is attributed to a company or founder and normalized within its platform. The current catalog includes {Array.from(supportedPlatforms).map(platformLabel).join(", ")}. Platform availability differs by company, and missing coverage is not treated as proof of missing traction.</p></section>
        <section><h2>Weighting and coverage</h2><p>Available platform scores are combined using configured platform weights. The score breakdown records each applied weight, platform contribution, evidence count, weighted available score, and coverage factor. This keeps a displayed score tied to the evidence available at build time.</p></section>
        <section><h2>Confidence and calibration</h2><p>Confidence reflects scored evidence volume, platform coverage, dated evidence, and link checks. The current score breakdown can apply tie-aware percentile calibration against a company cohort. Calibration makes peer comparisons more useful but does not remove source bias or make unlike companies directly equivalent.</p></section>
        <section><h2>Limitations</h2><ul><li>Public activity can be incomplete, delayed, deleted, or difficult to verify.</li><li>Platforms expose different metrics and access levels.</li><li>Public attention can reflect events unrelated to durable business performance.</li><li>Scores can change when evidence is refreshed, corrected, deduplicated, or reattributed.</li></ul></section>
        <section><h2>Reading a result</h2><p>Use the score alongside the company evidence, confidence reasons, limitations, and evidence date. See <DirectoryLink href="/data-sources">data sources</DirectoryLink> for provenance and <DirectoryLink href="/corrections">corrections</DirectoryLink> for disputed records.</p></section>
      </div>
    </DirectoryShell>
  );
}
