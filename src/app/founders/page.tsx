import type { Metadata, Route } from "next";
import Link from "next/link";
import { EntityBreadcrumbs } from "@/components/seo/EntityBreadcrumbs";
import { EntitySiteNav } from "@/components/seo/EntitySiteNav";
import { JsonLd } from "@/components/seo/JsonLd";
import { getCatalog } from "@/lib/seo/catalog";
import { publicMetadata, siteUrl } from "@/lib/seo/site";
import styles from "../companies/entity-pages.module.css";

const title = "Startup founder profiles and public traction";
const description =
  "Browse startup founder profiles with company relationships, verified public accounts, and attributable traction evidence across accelerator cohorts.";

export function generateMetadata(): Metadata {
  const featured = getCatalog().founders.find((founder) => founder.indexable);
  return publicMetadata({
    title,
    description,
    path: "/founders",
    imagePath: featured ? `/companies/${featured.company.slug}/opengraph-image` : undefined,
  });
}

export default function FoundersPage() {
  const founders = getCatalog().founders
    .filter((founder) => founder.indexable)
    .sort((left, right) => left.name.localeCompare(right.name) || left.company.node.label.localeCompare(right.company.node.label));
  const canonical = siteUrl("/founders");
  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: siteUrl("/") },
        { "@type": "ListItem", position: 2, name: "Founders", item: canonical },
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
        numberOfItems: founders.length,
        itemListElement: founders.map((founder, index) => ({
          "@type": "ListItem",
          position: index + 1,
          name: founder.name,
          url: siteUrl(`/founders/${founder.slug}`),
        })),
      },
    },
  ];

  return (
    <main className={styles.page}>
      <EntitySiteNav className={styles.siteNav} />
      <div className={styles.breadcrumbs}>
        <EntityBreadcrumbs items={[{ label: "Home", href: "/" }, { label: "Founders" }]} />
      </div>

      <header className={`${styles.header} ${styles.directoryHeader}`}>
        <span className={styles.eyebrow}>Public founder directory</span>
        <h1>Founder profiles</h1>
        <p>{description}</p>
        <div className={styles.badgeRow} aria-label="Directory coverage">
          <span>{founders.length} indexable founders</span>
          <span>Verified public identities</span>
          <span>Company-linked profiles</span>
        </div>
      </header>

      <section aria-labelledby="founder-directory-heading">
        <h2 id="founder-directory-heading" className="sr-only">
          Public founder directory
        </h2>
        <div className={styles.directoryGrid}>
          {founders.map((founder) => (
            <Link className={styles.directoryCard} href={`/founders/${founder.slug}` as Route} key={founder.id}>
              <span className={styles.eyebrow}>{founder.company.graph.batch.label}</span>
              <h2>{founder.name}</h2>
              <p>
                Founder of {founder.company.node.label}, {founder.company.node.tagline || "a public startup company"}.
              </p>
              <div className={styles.directoryMeta}>
                <span>{founder.company.node.primaryIndustry}</span>
                <span>{founder.socialAccounts.length} public accounts</span>
                <span>{founder.evidence.length} evidence sources</span>
              </div>
            </Link>
          ))}
        </div>
      </section>

      <footer className={styles.footer}>
        <span>Founder identities are linked from attributed public sources.</span>
        <Link href={"/companies" as Route}>Browse company profiles</Link>
      </footer>
      <JsonLd data={jsonLd} />
    </main>
  );
}
