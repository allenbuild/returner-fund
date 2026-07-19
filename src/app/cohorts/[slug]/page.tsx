import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DirectoryCompanyList } from "@/components/seo/DirectoryCompanyList";
import { DirectoryLink, DirectoryShell } from "@/components/seo/DirectoryShell";
import { DirectoryCollectionJsonLd } from "@/components/seo/DirectoryStructuredData";
import { findCohort, getCatalog } from "@/lib/seo/catalog";
import { publicMetadata, truncateDescription } from "@/lib/seo/site";

type CohortPageProps = { params: Promise<{ slug: string }> };

export function generateStaticParams() {
  return getCatalog().cohorts.map((cohort) => ({ slug: cohort.slug }));
}

export async function generateMetadata({ params }: CohortPageProps): Promise<Metadata> {
  const cohort = findCohort((await params).slug);
  if (!cohort) return publicMetadata({ title: "Cohort not found", description: "This cohort is not in the public catalog.", path: "/cohorts", index: false });
  const description = truncateDescription(`Explore ${cohort.companies.length} companies in ${cohort.label}, with ${cohort.evidenceCount} public traction evidence items in the current Returner snapshot.`);
  return publicMetadata({ title: `${cohort.label} companies`, description, path: `/cohorts/${cohort.slug}`, index: cohort.companies.length >= 2 });
}

export default async function CohortDetailPage({ params }: CohortPageProps) {
  const cohort = findCohort((await params).slug);
  if (!cohort) notFound();
  const companies = [...cohort.companies].sort((a, b) => b.node.score - a.node.score || a.node.label.localeCompare(b.node.label));
  const description = `${cohort.label} includes ${cohort.companies.length} companies in the current catalog, supported by ${cohort.evidenceCount} public evidence items.`;

  return (
    <DirectoryShell
      eyebrow="Cohort"
      title={cohort.label}
      description={description}
      breadcrumbs={[{ label: "Cohorts", href: "/cohorts" }, { label: cohort.label }]}
      stats={[
        { label: "Companies", value: cohort.companies.length },
        { label: "Evidence items", value: cohort.evidenceCount },
        { label: "Batch ID", value: cohort.batchSlug }
      ]}
    >
      <DirectoryCollectionJsonLd
        name={`${cohort.label} companies`}
        description={description}
        path={`/cohorts/${cohort.slug}`}
        items={companies.map((company) => ({ name: company.node.label, path: `/companies/${company.slug}` }))}
      />
      <section className="rf-directory-section" aria-labelledby="cohort-companies-heading">
        <div className="rf-directory-section-header">
          <h2 id="cohort-companies-heading">Companies by traction score</h2>
          <p>Scores are observational signals, not investment recommendations or company valuations.</p>
        </div>
        <DirectoryCompanyList companies={companies} ranked />
      </section>
      <div className="rf-inline-links">
        <DirectoryLink href="/rankings">All rankings</DirectoryLink>
        <DirectoryLink href="/industries">Browse industries</DirectoryLink>
        <DirectoryLink href="/data-sources">Review data sources</DirectoryLink>
      </div>
    </DirectoryShell>
  );
}
