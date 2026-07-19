import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DirectoryCompanyList } from "@/components/seo/DirectoryCompanyList";
import { DirectoryLink, DirectoryShell } from "@/components/seo/DirectoryShell";
import { DirectoryCollectionJsonLd } from "@/components/seo/DirectoryStructuredData";
import { findIndustry, getCatalog } from "@/lib/seo/catalog";
import { publicMetadata, truncateDescription } from "@/lib/seo/site";

type IndustryPageProps = { params: Promise<{ slug: string }> };

export function generateStaticParams() {
  return getCatalog().industries.map((industry) => ({ slug: industry.slug }));
}

export async function generateMetadata({ params }: IndustryPageProps): Promise<Metadata> {
  const industry = findIndustry((await params).slug);
  if (!industry) return publicMetadata({ title: "Industry not found", description: "This industry is not in the public catalog.", path: "/industries", index: false });
  const description = truncateDescription(`Browse ${industry.companies.length} ${industry.name} startups and their public traction scores in the current Returner catalog.`);
  return publicMetadata({ title: `${industry.name} startups`, description, path: `/industries/${industry.slug}`, index: industry.indexable });
}

export default async function IndustryDetailPage({ params }: IndustryPageProps) {
  const industry = findIndustry((await params).slug);
  if (!industry) notFound();
  const companies = [...industry.companies].sort((a, b) => b.node.score - a.node.score || a.node.label.localeCompare(b.node.label));
  const evidenceCount = companies.reduce((sum, company) => sum + company.evidence.length, 0);
  const description = `${industry.companies.length} companies are tagged ${industry.name} in the current source records. This page compares their public traction signals.`;

  return (
    <DirectoryShell
      eyebrow="Industry"
      title={industry.name}
      description={description}
      breadcrumbs={[{ label: "Industries", href: "/industries" }, { label: industry.name }]}
      stats={[
        { label: "Companies", value: companies.length },
        { label: "Evidence items", value: evidenceCount },
        { label: "Index status", value: industry.indexable ? "Public" : "Limited" }
      ]}
    >
      <DirectoryCollectionJsonLd
        name={`${industry.name} startups`}
        description={description}
        path={`/industries/${industry.slug}`}
        items={companies.map((company) => ({ name: company.node.label, path: `/companies/${company.slug}` }))}
      />
      <section className="rf-directory-section" aria-labelledby="industry-companies-heading">
        <div className="rf-directory-section-header">
          <h2 id="industry-companies-heading">Companies by traction score</h2>
          <p>Industry labels come from the catalog source records and can overlap.</p>
        </div>
        <DirectoryCompanyList companies={companies} ranked />
      </section>
      <div className="rf-inline-links"><DirectoryLink href="/methodology">How scoring works</DirectoryLink><DirectoryLink href="/rankings">All rankings</DirectoryLink><DirectoryLink href="/corrections">Report a correction</DirectoryLink></div>
    </DirectoryShell>
  );
}
