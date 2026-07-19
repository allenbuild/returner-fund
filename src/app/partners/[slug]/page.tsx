import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DirectoryCompanyList } from "@/components/seo/DirectoryCompanyList";
import { DirectoryLink, DirectoryShell } from "@/components/seo/DirectoryShell";
import { DirectoryCollectionJsonLd } from "@/components/seo/DirectoryStructuredData";
import { findPartner, getCatalog } from "@/lib/seo/catalog";
import { publicMetadata, truncateDescription } from "@/lib/seo/site";

type PartnerPageProps = { params: Promise<{ slug: string }> };

export function generateStaticParams() {
  return getCatalog().partners.map((partner) => ({ slug: partner.slug }));
}

export async function generateMetadata({ params }: PartnerPageProps): Promise<Metadata> {
  const partner = findPartner((await params).slug);
  if (!partner) return publicMetadata({ title: "Partner group not found", description: "This partner group is not in the public catalog.", path: "/partners", index: false });
  const description = truncateDescription(`Browse ${partner.companies.length} companies assigned to ${partner.name} in accelerator source records, with public traction scores from Returner.`);
  return publicMetadata({ title: `${partner.name} companies`, description, path: `/partners/${partner.slug}`, index: partner.indexable });
}

export default async function PartnerDetailPage({ params }: PartnerPageProps) {
  const partner = findPartner((await params).slug);
  if (!partner) notFound();
  const companies = [...partner.companies].sort((a, b) => b.node.score - a.node.score || a.node.label.localeCompare(b.node.label));
  const description = `${partner.companies.length} companies carry the ${partner.name} group partner label in the current accelerator source records.`;

  return (
    <DirectoryShell
      eyebrow="Group partner"
      title={partner.name}
      description={description}
      breadcrumbs={[{ label: "Partners", href: "/partners" }, { label: partner.name }]}
      stats={[
        { label: "Companies", value: companies.length },
        { label: "Cohorts represented", value: new Set(companies.map((company) => company.node.batchSlug)).size },
        { label: "Index status", value: partner.indexable ? "Public" : "Limited" }
      ]}
    >
      <DirectoryCollectionJsonLd
        name={`${partner.name} companies`}
        description={description}
        path={`/partners/${partner.slug}`}
        items={companies.map((company) => ({ name: company.node.label, path: `/companies/${company.slug}` }))}
      />
      <p className="rf-directory-note">Group partner labels are descriptive catalog fields. This page does not claim a current advisory relationship or endorsement.</p>
      <section className="rf-directory-section" aria-labelledby="partner-companies-heading">
        <div className="rf-directory-section-header">
          <h2 id="partner-companies-heading">Companies by traction score</h2>
          <p>Scores summarize public observed signals and are not investment rankings.</p>
        </div>
        <DirectoryCompanyList companies={companies} ranked />
      </section>
      <div className="rf-inline-links"><DirectoryLink href="/cohorts">Browse cohorts</DirectoryLink><DirectoryLink href="/methodology">Read methodology</DirectoryLink><DirectoryLink href="/corrections">Report a correction</DirectoryLink></div>
    </DirectoryShell>
  );
}
