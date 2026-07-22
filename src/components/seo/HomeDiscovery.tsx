import { getCatalog } from "@/lib/seo/catalog";
import { DirectoryLink } from "@/components/seo/DirectoryLink";
import { JsonLd } from "@/components/seo/JsonLd";
import { SITE_DESCRIPTION, SITE_NAME, siteUrl } from "@/lib/seo/site";
import styles from "./HomeDiscovery.module.css";

export function HomeStructuredData() {
  const catalog = getCatalog();
  const organizationId = siteUrl("/#organization");

  const structuredData = [
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      "@id": siteUrl("/#website"),
      url: siteUrl("/"),
      name: SITE_NAME,
      alternateName: "Returner",
      description: SITE_DESCRIPTION,
      publisher: { "@id": organizationId },
      potentialAction: {
        "@type": "SearchAction",
        target: {
          "@type": "EntryPoint",
          urlTemplate: siteUrl("/search?q={search_term_string}")
        },
        "query-input": "required name=search_term_string"
      }
    },
    {
      "@context": "https://schema.org",
      "@type": "Dataset",
      "@id": siteUrl("/#dataset"),
      name: "Returner public startup traction dataset",
      description: SITE_DESCRIPTION,
      url: siteUrl("/"),
      creator: { "@id": organizationId },
      isAccessibleForFree: true,
      keywords: ["startup traction", "accelerator cohorts", "founders", "public evidence"],
      hasPart: catalog.cohorts.map((cohort) => ({
        "@type": "Dataset",
        name: `${cohort.label} public startup traction data`,
        description: `Public startup traction data for ${cohort.label}, covering ${cohort.companies.length} companies and ${cohort.evidenceCount.toLocaleString("en-US")} attributable evidence records.`,
        url: siteUrl(`/cohorts/${cohort.slug}`),
        creator: { "@id": organizationId },
        size: `${cohort.companies.length} companies; ${cohort.evidenceCount} evidence records`
      }))
    },
    {
      "@context": "https://schema.org",
      "@type": "Organization",
      "@id": organizationId,
      name: SITE_NAME,
      alternateName: "Returner",
      url: siteUrl("/"),
      description: "An independent public-data project for exploring startup traction."
    }
  ];

  return (
    <>
      <section className={styles.discovery} aria-labelledby="explore-returner-heading">
        <div>
          <p className={styles.eyebrow}>Explore Returner.fund</p>
          <h2 id="explore-returner-heading">Startup network maps and social traction rankings</h2>
          <p>
            Browse server-rendered YC and a16z Speedrun directories, rankings, and evidence-linked
            public traction data. Returner.fund is an independent public-data project and is not
            affiliated with Y Combinator or Andreessen Horowitz.
          </p>
        </div>
        <nav className={styles.links} aria-label="Startup maps and public directories">
          <DirectoryLink href="/yc-network-map">YC network map</DirectoryLink>
          <DirectoryLink href="/a16z-network-map">a16z network map</DirectoryLink>
          <DirectoryLink href="/yc-social-traction">YC social traction</DirectoryLink>
          <DirectoryLink href="/a16z-social-traction">a16z social traction</DirectoryLink>
          <DirectoryLink href="/companies">Company directory</DirectoryLink>
          <DirectoryLink href="/founders">Founder directory</DirectoryLink>
          <DirectoryLink href="/rankings">Startup rankings</DirectoryLink>
          <DirectoryLink href="/methodology">Methodology</DirectoryLink>
          <DirectoryLink href="/data-sources">Data sources</DirectoryLink>
        </nav>
      </section>
      <JsonLd data={structuredData} />
    </>
  );
}
