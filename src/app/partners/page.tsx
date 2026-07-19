import { DirectoryCards } from "@/components/seo/DirectoryCards";
import { DirectoryLink, DirectoryShell } from "@/components/seo/DirectoryShell";
import { DirectoryCollectionJsonLd } from "@/components/seo/DirectoryStructuredData";
import { getCatalog } from "@/lib/seo/catalog";
import { publicMetadata } from "@/lib/seo/site";

const title = "Accelerator group partners";
const description = "Browse companies by the group partner labels included in their accelerator source records.";

export const metadata = publicMetadata({ title, description, path: "/partners" });

export default function PartnersPage() {
  const { partners } = getCatalog();
  const companyAssignments = partners.reduce((sum, partner) => sum + partner.companies.length, 0);

  return (
    <DirectoryShell
      eyebrow="Partner directory"
      title={title}
      description={description}
      breadcrumbs={[{ label: "Partners" }]}
      stats={[
        { label: "Partner labels", value: partners.length },
        { label: "Company assignments", value: companyAssignments },
        { label: "Multi-company groups", value: partners.filter((partner) => partner.indexable).length }
      ]}
    >
      <DirectoryCollectionJsonLd
        name={title}
        description={description}
        path="/partners"
        items={partners.map((partner) => ({ name: partner.name, path: `/partners/${partner.slug}` }))}
      />
      <section className="rf-directory-section" aria-labelledby="partner-list-heading">
        <div className="rf-directory-section-header">
          <h2 id="partner-list-heading">Partner groupings</h2>
          <p>These labels reproduce source-record group assignments and do not imply endorsement by a named person or program.</p>
        </div>
        <DirectoryCards items={partners.map((partner) => ({
          title: partner.name,
          href: `/partners/${partner.slug}`,
          description: `${partner.companies.length} ${partner.companies.length === 1 ? "company is" : "companies are"} assigned this group partner label.`,
          meta: [`${partner.companies.length} companies`, partner.indexable ? "Directory group" : "Limited coverage"]
        }))} />
      </section>
      <div className="rf-inline-links"><DirectoryLink href="/cohorts">Browse cohorts</DirectoryLink><DirectoryLink href="/about">About Returner</DirectoryLink><DirectoryLink href="/corrections">Corrections policy</DirectoryLink></div>
    </DirectoryShell>
  );
}
