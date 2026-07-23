import { DirectoryCards } from "@/components/seo/DirectoryCards";
import { DirectoryLink, DirectoryShell } from "@/components/seo/DirectoryShell";
import { DirectoryArticleJsonLd } from "@/components/seo/DirectoryStructuredData";
import { getCatalog } from "@/lib/seo/catalog";
import { publicMetadata } from "@/lib/seo/site";

const title = "Public data sources";
const description = "Review the public accelerator, company, founder, social, developer, launch, community, and web sources represented in Returner.";

export const metadata = publicMetadata({ title, description, path: "/data-sources" });

export default function DataSourcesPage() {
  const catalog = getCatalog();
  const evidenceCount = catalog.companies.reduce((sum, company) => sum + company.evidence.length, 0);
  const verifiedCompanies = catalog.companies.filter((company) => company.node.review_state === "verified").length;

  return (
    <DirectoryShell
      eyebrow="Provenance"
      title={title}
      description={description}
      breadcrumbs={[{ label: "Data sources" }]}
      stats={[
        { label: "Evidence items", value: evidenceCount },
        { label: "Verified companies", value: verifiedCompanies },
        { label: "Platforms", value: catalog.platforms.length }
      ]}
    >
      <DirectoryArticleJsonLd name={title} description={description} path="/data-sources" />
      <div className="rf-prose">
        <section><h2>Entity records</h2><p>Company names, descriptions, industries, founders, batch labels, group partner labels, websites, and accelerator profile URLs come from public accelerator and company records included in the catalog snapshots.</p></section>
        <section><h2>Public evidence</h2><p>Evidence records can include public posts, repositories, launch pages, videos, articles, feeds, and community activity. Each item retains a source URL, platform, attribution, visible text or title when available, observed metrics, timestamps, and review state.</p></section>
        <section><h2>Verification</h2><p>Catalog records distinguish verified, needs-review, and rejected states. Indexable company pages require a verified company record, descriptive content, and at least one website, social account, or evidence item. Link checks and publication dates are recorded where available, but not every source can be rechecked continuously.</p></section>
        <section id="dataset-use"><h2>Dataset use terms</h2><p>Returner&apos;s compiled catalog metadata may be used for research and discovery with attribution to Returner.fund and links to the original public sources. Underlying posts, media, repository content, company descriptions, and other third-party material remain the property of their respective rights holders and are not relicensed by Returner. These terms do not grant permission to reproduce underlying source content.</p></section>
      </div>
      <section className="rf-directory-section" aria-labelledby="source-platforms-heading">
        <div className="rf-directory-section-header"><h2 id="source-platforms-heading">Platform coverage</h2><p>Counts describe the checked-in public catalog snapshot, not complete platform-wide coverage.</p></div>
        <DirectoryCards items={catalog.platforms.map((platform) => ({
          title: platform.label,
          href: `/platforms/${platform.slug}`,
          description: `${platform.evidence.length} company evidence items and ${platform.companies.length} companies with an account or evidence signal.`,
          meta: [`${platform.evidence.length} evidence items`, `${platform.companies.length} companies`]
        }))} />
      </section>
      <div className="rf-inline-links"><DirectoryLink href="/methodology">Scoring methodology</DirectoryLink><DirectoryLink href="/faq">Frequently asked questions</DirectoryLink><DirectoryLink href="/corrections">Correction requests</DirectoryLink></div>
    </DirectoryShell>
  );
}
