import { DirectoryCards } from "@/components/seo/DirectoryCards";
import { DirectoryLink, DirectoryShell } from "@/components/seo/DirectoryShell";
import { DirectoryCollectionJsonLd } from "@/components/seo/DirectoryStructuredData";
import { getCatalog } from "@/lib/seo/catalog";
import { publicMetadata } from "@/lib/seo/site";

const title = "Startup cohorts";
const description = "Browse the accelerator cohorts represented in Returner, with company counts and public traction evidence coverage.";

export const metadata = publicMetadata({ title, description, path: "/cohorts" });

export default function CohortsPage() {
  const { cohorts } = getCatalog();
  const companyCount = cohorts.reduce((sum, cohort) => sum + cohort.companies.length, 0);
  const evidenceCount = cohorts.reduce((sum, cohort) => sum + cohort.evidenceCount, 0);

  return (
    <DirectoryShell
      eyebrow="Cohort directory"
      title={title}
      description={description}
      breadcrumbs={[{ label: "Cohorts" }]}
      stats={[
        { label: "Cohorts", value: cohorts.length },
        { label: "Companies", value: companyCount },
        { label: "Evidence items", value: evidenceCount }
      ]}
    >
      <DirectoryCollectionJsonLd
        name={title}
        description={description}
        path="/cohorts"
        items={cohorts.map((cohort) => ({ name: cohort.label, path: `/cohorts/${cohort.slug}` }))}
      />
      <section className="rf-directory-section" aria-labelledby="cohort-list-heading">
        <div className="rf-directory-section-header">
          <h2 id="cohort-list-heading">All cohorts</h2>
          <p>Counts reflect the current public catalog snapshot and may change when source data is refreshed.</p>
        </div>
        <DirectoryCards items={cohorts.map((cohort) => ({
          title: cohort.label,
          href: `/cohorts/${cohort.slug}`,
          description: `${cohort.companies.length} companies are represented in this cohort.`,
          meta: [`${cohort.companies.length} companies`, `${cohort.evidenceCount} evidence items`]
        }))} />
      </section>
      <p className="rf-directory-note">Compare companies across cohorts in the <DirectoryLink href="/rankings">traction rankings</DirectoryLink>, or read how scores are produced in the <DirectoryLink href="/methodology">methodology</DirectoryLink>.</p>
    </DirectoryShell>
  );
}
