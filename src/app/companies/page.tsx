import type { Metadata, Route } from "next";
import Link from "next/link";
import { EntityBreadcrumbs } from "@/components/seo/EntityBreadcrumbs";
import { EntitySiteNav } from "@/components/seo/EntitySiteNav";
import { JsonLd } from "@/components/seo/JsonLd";
import { getCatalog } from "@/lib/seo/catalog";
import { publicMetadata, siteUrl } from "@/lib/seo/site";
import styles from "./entity-pages.module.css";

const title = "Startup company profiles and public traction";
const description =
  "Browse public company profiles with founders, industries, official sources, and attributable traction evidence across startup accelerator cohorts.";

export function generateMetadata(): Metadata {
  const featured = getCatalog().companies.find((company) => company.indexable);
  return publicMetadata({
    title,
    description,
    path: "/companies",
    imagePath: featured ? `/companies/${featured.slug}/opengraph-image` : undefined,
  });
}

export default function CompaniesPage() {
  const companies = getCatalog().companies
    .filter((company) => company.indexable)
    .sort((left, right) => right.node.score - left.node.score || left.node.label.localeCompare(right.node.label));
  const canonical = siteUrl("/companies");

  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: siteUrl("/") },
        { "@type": "ListItem", position: 2, name: "Companies", item: canonical },
      ],
    },
    {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      "@id": `${canonical}#page`,
      name: title,
      description,
      url: canonical,
      mainEntity: {
        "@type": "ItemList",
        numberOfItems: companies.length,
        itemListElement: companies.map((company, index) => ({
          "@type": "ListItem",
          position: index + 1,
          name: company.node.label,
          url: siteUrl(`/companies/${company.slug}`),
        })),
      },
    },
  ];

  return (
    <main className={styles.page}>
      <EntitySiteNav className={styles.siteNav} />
      <div className={styles.breadcrumbs}>
        <EntityBreadcrumbs items={[{ label: "Home", href: "/" }, { label: "Companies" }]} />
      </div>

      <header className={`${styles.header} ${styles.directoryHeader}`}>
        <span className={styles.eyebrow}>Public startup directory</span>
        <h1>Company profiles</h1>
        <p>{description}</p>
        <div className={styles.badgeRow} aria-label="Directory coverage">
          <span>{companies.length} indexable companies</span>
          <span>Evidence-linked profiles</span>
          <span>Multiple accelerator cohorts</span>
        </div>
      </header>

      <section aria-labelledby="company-directory-heading">
        <h2 id="company-directory-heading" className="sr-only">
          Public company directory
        </h2>
        <div className={styles.directoryGrid}>
          {companies.map((company) => (
            <Link className={styles.directoryCard} href={`/companies/${company.slug}` as Route} key={`${company.node.entityId}-${company.node.batchSlug}`}>
              <span className={styles.eyebrow}>{company.graph.batch.label}</span>
              <h2>{company.node.label}</h2>
              <p>{company.node.tagline || company.node.description || "Public startup profile"}</p>
              <div className={styles.directoryMeta}>
                <span>{company.node.primaryIndustry}</span>
                <span>{company.evidence.length} evidence sources</span>
                <span>Score {Math.round(company.node.score)}</span>
              </div>
            </Link>
          ))}
        </div>
      </section>

      <footer className={styles.footer}>
        <span>Profiles are assembled from attributed public sources.</span>
        <Link href={"/founders" as Route}>Browse founder profiles</Link>
      </footer>
      <JsonLd data={jsonLd} />
    </main>
  );
}
