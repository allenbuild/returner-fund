import { getCatalog } from "@/lib/seo/catalog";
import { JsonLd } from "@/components/seo/JsonLd";
import { SITE_DESCRIPTION, SITE_NAME, siteUrl } from "@/lib/seo/site";

export function HomeStructuredData() {
  const catalog = getCatalog();
  const organizationId = siteUrl("/#organization");
  const datasetCreator = {
    "@type": "Organization",
    "@id": organizationId,
    name: SITE_NAME,
    url: siteUrl("/")
  };
  const datasetLicense = {
    "@type": "CreativeWork",
    name: "Returner.fund dataset use terms",
    url: siteUrl("/data-sources#dataset-use")
  };

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
      creator: datasetCreator,
      license: datasetLicense,
      isAccessibleForFree: true,
      keywords: ["startup traction", "accelerator cohorts", "founders", "public evidence"],
      hasPart: catalog.cohorts.map((cohort) => ({
        "@type": "Dataset",
        name: `${cohort.label} public startup traction data`,
        description: `Public startup traction data for ${cohort.label}, covering ${cohort.companies.length} companies and ${cohort.evidenceCount.toLocaleString("en-US")} attributable evidence records.`,
        url: siteUrl(`/cohorts/${cohort.slug}`),
        creator: datasetCreator,
        license: datasetLicense,
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

  return <JsonLd data={structuredData} />;
}
