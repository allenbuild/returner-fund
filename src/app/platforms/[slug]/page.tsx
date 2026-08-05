import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DirectoryCompanyList } from "@/components/seo/DirectoryCompanyList";
import { DirectoryLink, DirectoryShell } from "@/components/seo/DirectoryShell";
import { DirectoryCollectionJsonLd } from "@/components/seo/DirectoryStructuredData";
import { findPlatform, getCatalog } from "@/lib/seo/catalog";
import { publicMetadata, truncateDescription } from "@/lib/seo/site";

type PlatformPageProps = { params: Promise<{ slug: string }> };

export function generateStaticParams() {
  return getCatalog().platforms.map((platform) => ({ slug: platform.slug }));
}

export async function generateMetadata({ params }: PlatformPageProps): Promise<Metadata> {
  const platform = findPlatform((await params).slug);
  if (!platform) return publicMetadata({ title: "Platform not found", description: "This platform is not in the public catalog.", path: "/platforms", index: false });
  const description = truncateDescription(`Explore ${platform.companies.length} startups with ${platform.label} accounts or evidence and ${platform.evidenceCount} public evidence items in Returner.`);
  return publicMetadata({ title: `${platform.label} startup traction`, description, path: `/platforms/${platform.slug}`, index: platform.indexable });
}

export default async function PlatformDetailPage({ params }: PlatformPageProps) {
  const platform = findPlatform((await params).slug);
  if (!platform) notFound();
  const companies = [...platform.companies].sort((a, b) => b.node.score - a.node.score || a.node.label.localeCompare(b.node.label));
  const description = `${platform.companies.length} companies have a public ${platform.label} account or evidence signal in the catalog. ${platform.evidenceCount} company evidence items are currently attributed to this platform.`;

  return (
    <DirectoryShell
      eyebrow="Platform"
      title={platform.label}
      description={description}
      breadcrumbs={[{ label: "Platforms", href: "/platforms" }, { label: platform.label }]}
      stats={[
        { label: "Companies", value: companies.length },
        { label: "Evidence items", value: platform.evidenceCount },
        { label: "Catalog key", value: platform.platform }
      ]}
    >
      <DirectoryCollectionJsonLd
        name={`${platform.label} startup traction`}
        description={description}
        path={`/platforms/${platform.slug}`}
        items={companies.map((company) => ({ name: company.node.label, path: `/companies/${company.slug}` }))}
      />
      <section className="rf-directory-section" aria-labelledby="platform-companies-heading">
        <div className="rf-directory-section-header">
          <h2 id="platform-companies-heading">Companies by overall traction score</h2>
          <p>The score shown is the overall catalog score, not a platform-only score.</p>
        </div>
        <DirectoryCompanyList companies={companies} ranked />
      </section>
      <div className="rf-inline-links"><DirectoryLink href="/data-sources">Review source coverage</DirectoryLink><DirectoryLink href="/methodology">Understand scoring</DirectoryLink><DirectoryLink href="/rankings">All rankings</DirectoryLink></div>
    </DirectoryShell>
  );
}
