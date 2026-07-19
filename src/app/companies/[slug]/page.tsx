import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EntityBreadcrumbs } from "@/components/seo/EntityBreadcrumbs";
import { EntityEvidenceList } from "@/components/seo/EntityEvidenceList";
import { EntitySiteNav } from "@/components/seo/EntitySiteNav";
import { JsonLd } from "@/components/seo/JsonLd";
import type { EvidenceItem, SocialAccountSummary } from "@/lib/graph/types";
import { findCompany, getCatalog, graphUrl, platformLabel, type PublicCompany } from "@/lib/seo/catalog";
import { publicMetadata, siteUrl, slugify, truncateDescription } from "@/lib/seo/site";
import styles from "../entity-pages.module.css";

interface CompanyPageProps {
  params: Promise<{ slug: string }>;
}

export const dynamicParams = false;

export function generateStaticParams() {
  return getCatalog().companies.map((company) => ({ slug: company.slug }));
}

export async function generateMetadata({ params }: CompanyPageProps): Promise<Metadata> {
  const { slug } = await params;
  const company = findCompany(slug);
  if (!company) notFound();

  const description = companyDescription(company);
  return publicMetadata({
    title: `${company.node.label} company profile, founders and traction`,
    description,
    path: `/companies/${company.slug}`,
    imagePath: `/companies/${company.slug}/opengraph-image`,
    index: company.indexable,
  });
}

export default async function CompanyPage({ params }: CompanyPageProps) {
  const { slug } = await params;
  const company = findCompany(slug);
  if (!company) notFound();

  const catalog = getCatalog();
  const canonicalPath = `/companies/${company.slug}`;
  const founders = company.node.founders
    .map((summary) => catalog.founders.find((founder) => founder.id === summary.id))
    .filter((founder) => founder !== undefined);
  const evidence = selectedEvidence(company.evidence);
  const related = catalog.companies
    .filter(
      (candidate) =>
        candidate.node.entityId !== company.node.entityId &&
        candidate.indexable &&
        candidate.node.industries.some((industry) => company.node.industries.includes(industry))
    )
    .sort((left, right) => right.node.score - left.node.score || left.node.label.localeCompare(right.node.label))
    .slice(0, 6);
  const cohort = catalog.cohorts.find((item) => item.batchSlug === company.node.batchSlug);
  const sourceLinks = companySources(company);

  const breadcrumbs = [
    { label: "Home", href: "/" },
    { label: "Companies", href: "/companies" },
    { label: company.node.label },
  ];
  const jsonLd = [
    breadcrumbJsonLd(breadcrumbs.map((item) => ({ name: item.label, path: item.href ?? canonicalPath }))),
    companyJsonLd(company, evidence, founders.map((founder) => ({ name: founder.name, slug: founder.slug }))),
  ];

  return (
    <main className={styles.page}>
      <EntitySiteNav className={styles.siteNav} />
      <div className={styles.breadcrumbs}>
        <EntityBreadcrumbs items={breadcrumbs} />
      </div>

      <header className={styles.header}>
        <span className={styles.eyebrow}>{company.graph.batch.label} company</span>
        <h1>{company.node.label}</h1>
        <p>{company.node.tagline || company.node.description || "Public startup company profile."}</p>
        <div className={styles.badgeRow} aria-label="Company classifications">
          {company.node.industries.map((industry) => (
            <Link href={`/industries/${slugify(industry)}` as Route} key={industry}>
              {industry}
            </Link>
          ))}
          <span>{company.node.businessModel.replace(/_/g, " ")}</span>
          <span>{company.evidence.length} public signals</span>
        </div>
        <div className={styles.actions}>
          <Link className={styles.primaryLink} href={graphUrl(company) as Route}>
            View in network map
          </Link>
          {company.node.websiteUrl ? (
            <a className={styles.secondaryLink} href={company.node.websiteUrl} target="_blank" rel="noopener noreferrer">
              Visit company website
            </a>
          ) : null}
        </div>
      </header>

      <div className={styles.detailGrid}>
        <div className={styles.mainColumn}>
          <section className={styles.section} aria-labelledby="about-heading">
            <h2 id="about-heading">About {company.node.label}</h2>
            <p className={styles.sectionLead}>
              {company.node.description || company.node.tagline || "No public company description is available yet."}
            </p>
          </section>

          <section className={`${styles.section} ${styles.evidence}`} aria-labelledby="evidence-heading">
            <div>
              <h2 id="evidence-heading">Public traction evidence</h2>
              <p className={styles.sectionLead}>Each signal links to the public source used for attribution.</p>
            </div>
            <EntityEvidenceList evidence={evidence} />
          </section>

          {related.length > 0 ? (
            <section className={styles.section} aria-labelledby="related-heading">
              <h2 id="related-heading">Related companies</h2>
              <div className={styles.relatedLinks}>
                {related.map((candidate) => (
                  <Link href={`/companies/${candidate.slug}` as Route} key={`${candidate.node.entityId}-${candidate.node.batchSlug}`}>
                    {candidate.node.label}
                  </Link>
                ))}
              </div>
            </section>
          ) : null}
        </div>

        <aside className={styles.sideColumn} aria-label={`${company.node.label} profile details`}>
          <section className={styles.section} aria-labelledby="facts-heading">
            <h2 id="facts-heading">Company facts</h2>
            <dl className={styles.facts}>
              <div>
                <dt>Traction score</dt>
                <dd>{Math.round(company.node.score)}</dd>
              </div>
              <div>
                <dt>Top platform</dt>
                <dd>{company.node.topPlatform ? platformLabel(company.node.topPlatform) : "Not available"}</dd>
              </div>
              <div>
                <dt>Cohort</dt>
                <dd>{company.graph.batch.label}</dd>
              </div>
              <div>
                <dt>Primary industry</dt>
                <dd>{company.node.primaryIndustry}</dd>
              </div>
              <div>
                <dt>Founders</dt>
                <dd>{founders.length}</dd>
              </div>
              <div>
                <dt>Review status</dt>
                <dd>{company.node.review_state.replace(/_/g, " ")}</dd>
              </div>
            </dl>
          </section>

          {founders.length > 0 ? (
            <section className={styles.section} aria-labelledby="founders-heading">
              <h2 id="founders-heading">Founders</h2>
              <div className={styles.relatedLinks}>
                {founders.map((founder) => (
                  <Link href={`/founders/${founder.slug}` as Route} key={founder.id}>
                    {founder.name}
                  </Link>
                ))}
              </div>
            </section>
          ) : null}

          <section className={styles.section} aria-labelledby="sources-heading">
            <h2 id="sources-heading">Profile sources</h2>
            <div className={styles.sourceLinks}>
              {sourceLinks.map((source) => (
                <a href={source.url} target="_blank" rel="nofollow noopener noreferrer" key={`${source.label}-${source.url}`}>
                  {source.label}
                </a>
              ))}
            </div>
          </section>

          <section className={styles.section} aria-labelledby="explore-heading">
            <h2 id="explore-heading">Explore more</h2>
            <div className={styles.relatedLinks}>
              {cohort ? <Link href={`/cohorts/${cohort.slug}` as Route}>{cohort.label}</Link> : null}
              {company.node.groupPartner ? (
                <Link href={`/partners/${slugify(company.node.groupPartner)}` as Route}>{company.node.groupPartner} companies</Link>
              ) : null}
              {company.node.topPlatform ? (
                <Link href={`/platforms/${slugify(company.node.topPlatform)}` as Route}>{platformLabel(company.node.topPlatform)} traction</Link>
              ) : null}
              <Link href={"/companies" as Route}>All companies</Link>
            </div>
          </section>
        </aside>
      </div>

      <footer className={styles.footer}>
        <span>Public evidence may change as sources are refreshed.</span>
        <Link href={"/companies" as Route}>Back to company directory</Link>
      </footer>
      <JsonLd data={jsonLd} />
    </main>
  );
}

function companyDescription(company: PublicCompany): string {
  const summary = company.node.tagline || company.node.description || `${company.node.label} public company profile.`;
  return truncateDescription(`${company.node.label}: ${summary}`);
}

function selectedEvidence(evidence: EvidenceItem[]): EvidenceItem[] {
  return [...evidence]
    .filter((item) => item.sourceUrl && item.review_state !== "rejected")
    .sort(
      (left, right) =>
        right.contributionScore - left.contributionScore ||
        new Date(right.postedAt).getTime() - new Date(left.postedAt).getTime()
    )
    .slice(0, 8);
}

function companySources(company: PublicCompany): { label: string; url: string }[] {
  const candidates = [
    company.node.websiteUrl ? { label: "Company website", url: company.node.websiteUrl } : null,
    company.node.ycProfileUrl ? { label: "Accelerator profile", url: company.node.ycProfileUrl } : null,
    company.node.sourceUrl ? { label: "Company data source", url: company.node.sourceUrl } : null,
    ...company.node.socialAccounts.map((account) => ({
      label: `${platformLabel(account.platform)}${account.handle ? ` @${account.handle}` : ""}`,
      url: account.url,
    })),
  ].filter((source): source is { label: string; url: string } => source !== null && Boolean(source.url));

  return uniqueSources(candidates);
}

function uniqueSources(sources: { label: string; url: string }[]) {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const normalized = source.url.replace(/\/$/, "");
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function breadcrumbJsonLd(items: { name: string; path: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: siteUrl(item.path),
    })),
  };
}

function companyJsonLd(
  company: PublicCompany,
  evidence: EvidenceItem[],
  founders: { name: string; slug: string }[]
) {
  const canonical = siteUrl(`/companies/${company.slug}`);
  const sameAs = uniqueSources(
    [
      company.node.websiteUrl ? { label: "website", url: company.node.websiteUrl } : null,
      company.node.ycProfileUrl ? { label: "accelerator", url: company.node.ycProfileUrl } : null,
      ...company.node.socialAccounts.map((account: SocialAccountSummary) => ({ label: account.platform, url: account.url })),
    ].filter((source): source is { label: string; url: string } => source !== null)
  ).map((source) => source.url);

  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": `${canonical}#organization`,
    name: company.node.label,
    url: canonical,
    mainEntityOfPage: canonical,
    description: company.node.description || company.node.tagline || undefined,
    sameAs,
    knowsAbout: company.node.industries,
    founder: founders.map((founder) => ({
      "@type": "Person",
      name: founder.name,
      url: siteUrl(`/founders/${founder.slug}`),
    })),
    memberOf: {
      "@type": "Organization",
      name: company.graph.batch.label,
    },
    subjectOf: evidence.map((item) => ({
      "@type": "CreativeWork",
      name: item.title?.trim() || `${platformLabel(item.platform)} traction evidence`,
      url: item.sourceUrl,
      datePublished: item.postedAt,
    })),
  };
}
