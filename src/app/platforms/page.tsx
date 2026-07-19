import { DirectoryCards } from "@/components/seo/DirectoryCards";
import { DirectoryLink, DirectoryShell } from "@/components/seo/DirectoryShell";
import { DirectoryCollectionJsonLd } from "@/components/seo/DirectoryStructuredData";
import { getCatalog } from "@/lib/seo/catalog";
import { publicMetadata } from "@/lib/seo/site";

const title = "Public traction platforms";
const description = "See which public web, social, developer, and launch platforms contribute observable startup traction signals to Returner.";

export const metadata = publicMetadata({ title, description, path: "/platforms" });

export default function PlatformsPage() {
  const { platforms } = getCatalog();
  const evidenceCount = platforms.reduce((sum, platform) => sum + platform.evidence.length, 0);

  return (
    <DirectoryShell
      eyebrow="Platform directory"
      title={title}
      description={description}
      breadcrumbs={[{ label: "Platforms" }]}
      stats={[
        { label: "Platforms", value: platforms.length },
        { label: "Evidence items", value: evidenceCount },
        { label: "With evidence", value: platforms.filter((platform) => platform.indexable).length }
      ]}
    >
      <DirectoryCollectionJsonLd
        name={title}
        description={description}
        path="/platforms"
        items={platforms.map((platform) => ({ name: platform.label, path: `/platforms/${platform.slug}` }))}
      />
      <section className="rf-directory-section" aria-labelledby="platform-list-heading">
        <div className="rf-directory-section-header">
          <h2 id="platform-list-heading">Observed platforms</h2>
          <p>Evidence counts include public catalog items assigned to companies; account coverage can be broader.</p>
        </div>
        <DirectoryCards items={platforms.map((platform) => ({
          title: platform.label,
          href: `/platforms/${platform.slug}`,
          description: `${platform.companies.length} companies have an account or evidence signal associated with ${platform.label}.`,
          meta: [`${platform.companies.length} companies`, `${platform.evidence.length} evidence items`]
        }))} />
      </section>
      <div className="rf-inline-links"><DirectoryLink href="/data-sources">Data source policy</DirectoryLink><DirectoryLink href="/methodology">Scoring methodology</DirectoryLink><DirectoryLink href="/industries">Browse industries</DirectoryLink></div>
    </DirectoryShell>
  );
}
