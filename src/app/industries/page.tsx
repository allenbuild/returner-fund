import { DirectoryCards } from "@/components/seo/DirectoryCards";
import { DirectoryLink, DirectoryShell } from "@/components/seo/DirectoryShell";
import { DirectoryCollectionJsonLd } from "@/components/seo/DirectoryStructuredData";
import { getCatalog } from "@/lib/seo/catalog";
import { publicMetadata } from "@/lib/seo/site";

const title = "Startup industries";
const description = "Explore startup industry groupings in the Returner public catalog and compare the companies and traction signals represented in each group.";

export const metadata = publicMetadata({ title, description, path: "/industries" });

export default function IndustriesPage() {
  const { industries } = getCatalog();
  const indexableCount = industries.filter((industry) => industry.indexable).length;

  return (
    <DirectoryShell
      eyebrow="Industry directory"
      title={title}
      description={description}
      breadcrumbs={[{ label: "Industries" }]}
      stats={[
        { label: "Industries", value: industries.length },
        { label: "Multi-company groups", value: indexableCount },
        { label: "Largest group", value: industries[0]?.companies.length ?? 0 }
      ]}
    >
      <DirectoryCollectionJsonLd
        name={title}
        description={description}
        path="/industries"
        items={industries.map((industry) => ({ name: industry.name, path: `/industries/${industry.slug}` }))}
      />
      <section className="rf-directory-section" aria-labelledby="industry-list-heading">
        <div className="rf-directory-section-header">
          <h2 id="industry-list-heading">Industry groups</h2>
          <p>Single-company groups remain available for discovery but are excluded from search indexing as thin pages.</p>
        </div>
        <DirectoryCards items={industries.map((industry) => ({
          title: industry.name,
          href: `/industries/${industry.slug}`,
          description: `${industry.companies.length} ${industry.companies.length === 1 ? "company is" : "companies are"} tagged with this industry in source records.`,
          meta: [`${industry.companies.length} companies`, industry.indexable ? "Directory group" : "Limited coverage"]
        }))} />
      </section>
      <div className="rf-inline-links"><DirectoryLink href="/cohorts">Browse cohorts</DirectoryLink><DirectoryLink href="/platforms">Browse platforms</DirectoryLink><DirectoryLink href="/search">Search the catalog</DirectoryLink></div>
    </DirectoryShell>
  );
}
