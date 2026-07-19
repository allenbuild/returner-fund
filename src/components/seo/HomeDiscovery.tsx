import Link from "next/link";
import { getCatalog } from "@/lib/seo/catalog";
import { JsonLd } from "@/components/seo/JsonLd";
import { SITE_DESCRIPTION, SITE_NAME, siteUrl } from "@/lib/seo/site";

interface HomeDiscoveryProps {
  selectedBatchSlug: string;
}

export function HomeDiscovery({ selectedBatchSlug }: HomeDiscoveryProps) {
  const catalog = getCatalog();
  const selectedCohort = catalog.cohorts.find((cohort) => cohort.batchSlug === selectedBatchSlug) ?? catalog.cohorts[0];
  const evidenceCount = catalog.cohorts.reduce((total, cohort) => total + cohort.evidenceCount, 0);
  const featuredIndustries = catalog.industries.filter((industry) => industry.indexable).slice(0, 6);
  const featuredPlatforms = catalog.platforms.filter((platform) => platform.indexable).slice(0, 6);
  const organizationId = siteUrl("/#organization");

  const structuredData = [
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      "@id": siteUrl("/#website"),
      url: siteUrl("/"),
      name: SITE_NAME,
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
        url: siteUrl(`/cohorts/${cohort.slug}`),
        size: `${cohort.companies.length} companies; ${cohort.evidenceCount} evidence records`
      }))
    },
    {
      "@context": "https://schema.org",
      "@type": "Organization",
      "@id": organizationId,
      name: SITE_NAME,
      url: siteUrl("/"),
      description: "An independent public-data project for exploring startup traction."
    }
  ];

  return (
    <>
      <JsonLd data={structuredData} />
      <section
        aria-labelledby="returner-discovery-title"
        style={{
          background: "#ffffff",
          borderBottom: "1px solid #e7e3dc",
          color: "#101828",
          display: "grid",
          gap: 12,
          padding: "18px 24px"
        }}
      >
        <header style={{ display: "grid", gap: 6 }}>
          <h2 id="returner-discovery-title">Explore public startup traction</h2>
          <p>
            Returner organizes {catalog.companies.length} companies and {evidenceCount.toLocaleString("en-US")} public
            evidence records across {catalog.cohorts.length} accelerator cohorts. The dashboard below is currently set to{" "}
            <Link href={{ pathname: `/cohorts/${selectedCohort.slug}` }}>{selectedCohort.label}</Link>, with{" "}
            {selectedCohort.companies.length} companies.
          </p>
        </header>

        <nav aria-label="Startup data directories" style={{ display: "flex", flexWrap: "wrap", gap: "8px 18px" }}>
          <Link href="/companies">Companies</Link>
          <Link href="/founders">Founders</Link>
          <Link href="/rankings">Traction rankings</Link>
          <Link href="/methodology">Methodology</Link>
          {catalog.cohorts.map((cohort) => (
            <Link href={{ pathname: `/cohorts/${cohort.slug}` }} key={cohort.batchSlug}>{cohort.label}</Link>
          ))}
          {featuredIndustries.map((industry) => (
            <Link href={{ pathname: `/industries/${industry.slug}` }} key={industry.slug}>{industry.name} startups</Link>
          ))}
          {featuredPlatforms.map((platform) => (
            <Link href={{ pathname: `/platforms/${platform.slug}` }} key={platform.slug}>{platform.label} traction</Link>
          ))}
        </nav>

        <aside aria-label="Affiliation disclaimer">
          <small>
            Returner is an independent public-data project and is not affiliated with, endorsed by, or sponsored by
            Y Combinator or Andreessen Horowitz (a16z).
          </small>
        </aside>
      </section>
    </>
  );
}
