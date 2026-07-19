import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EntityBreadcrumbs } from "@/components/seo/EntityBreadcrumbs";
import { EntityEvidenceList } from "@/components/seo/EntityEvidenceList";
import { EntitySiteNav } from "@/components/seo/EntitySiteNav";
import { JsonLd } from "@/components/seo/JsonLd";
import type { EvidenceItem } from "@/lib/graph/types";
import { findFounder, getCatalog, platformLabel, type PublicFounder } from "@/lib/seo/catalog";
import { publicMetadata, siteUrl, slugify, truncateDescription } from "@/lib/seo/site";
import styles from "../../companies/entity-pages.module.css";

interface FounderPageProps {
  params: Promise<{ slug: string }>;
}

export const dynamicParams = false;

export function generateStaticParams() {
  return getCatalog().founders.map((founder) => ({ slug: founder.slug }));
}

export async function generateMetadata({ params }: FounderPageProps): Promise<Metadata> {
  const { slug } = await params;
  const founder = findFounder(slug);
  if (!founder) notFound();

  return publicMetadata({
    title: `${founder.name}, founder of ${founder.company.node.label}`,
    description: founderDescription(founder),
    path: `/founders/${founder.slug}`,
    imagePath: `/companies/${founder.company.slug}/opengraph-image`,
    index: founder.indexable,
  });
}

export default async function FounderPage({ params }: FounderPageProps) {
  const { slug } = await params;
  const founder = findFounder(slug);
  if (!founder) notFound();

  const catalog = getCatalog();
  const company = founder.company;
  const canonicalPath = `/founders/${founder.slug}`;
  const founderSummary = company.node.founders.find((summary) => summary.id === founder.id);
  const evidence = selectedEvidence(founder.evidence);
  const cofounders = catalog.founders
    .filter((candidate) => candidate.company.node.entityId === company.node.entityId && candidate.id !== founder.id)
    .sort((left, right) => left.name.localeCompare(right.name));
  const relatedCompanies = catalog.companies
    .filter(
      (candidate) =>
        candidate.indexable &&
        candidate.node.entityId !== company.node.entityId &&
        candidate.node.industries.some((industry) => company.node.industries.includes(industry))
    )
    .sort((left, right) => right.node.score - left.node.score || left.node.label.localeCompare(right.node.label))
    .slice(0, 5);
  const cohort = catalog.cohorts.find((item) => item.batchSlug === company.node.batchSlug);
  const sources = founderSources(founder, founderSummary?.ycProfileUrl);
  const breadcrumbs = [
    { label: "Home", href: "/" },
    { label: "Founders", href: "/founders" },
    { label: founder.name },
  ];
  const jsonLd = [
    breadcrumbJsonLd(breadcrumbs.map((item) => ({ name: item.label, path: item.href ?? canonicalPath }))),
    founderJsonLd(founder, evidence, founderSummary?.ycProfileUrl),
  ];

  return (
    <main className={styles.page}>
      <EntitySiteNav className={styles.siteNav} />
      <div className={styles.breadcrumbs}>
        <EntityBreadcrumbs items={breadcrumbs} />
      </div>

      <header className={styles.header}>
        <span className={styles.eyebrow}>{company.graph.batch.label} founder</span>
        <h1>{founder.name}</h1>
        <p>
          Founder of <Link href={`/companies/${company.slug}` as Route}>{company.node.label}</Link>
          {company.node.tagline ? `, ${company.node.tagline}` : "."}
        </p>
        <div className={styles.badgeRow} aria-label="Founder profile classifications">
          <Link href={`/companies/${company.slug}` as Route}>{company.node.label}</Link>
          {company.node.industries.map((industry) => (
            <Link href={`/industries/${slugify(industry)}` as Route} key={industry}>
              {industry}
            </Link>
          ))}
          <span>{founder.evidence.length} public signals</span>
        </div>
        <div className={styles.actions}>
          <Link className={styles.primaryLink} href={`/companies/${company.slug}` as Route}>
            View company profile
          </Link>
          {founderSummary?.ycProfileUrl ? (
            <a className={styles.secondaryLink} href={founderSummary.ycProfileUrl} target="_blank" rel="noopener noreferrer">
              View accelerator profile
            </a>
          ) : null}
        </div>
      </header>

      <div className={styles.detailGrid}>
        <div className={styles.mainColumn}>
          <section className={styles.section} aria-labelledby="company-heading">
            <h2 id="company-heading">Company</h2>
            <p className={styles.sectionLead}>
              {founder.name} is listed as a founder of {company.node.label}. {company.node.description || company.node.tagline || ""}
            </p>
            <div className={styles.relatedLinks}>
              <Link href={`/companies/${company.slug}` as Route}>{company.node.label} company profile</Link>
            </div>
          </section>

          <section className={`${styles.section} ${styles.evidence}`} aria-labelledby="evidence-heading">
            <div>
              <h2 id="evidence-heading">Founder traction evidence</h2>
              <p className={styles.sectionLead}>Public posts and activity attributed directly to this founder.</p>
            </div>
            <EntityEvidenceList evidence={evidence} />
          </section>

          {relatedCompanies.length > 0 ? (
            <section className={styles.section} aria-labelledby="related-heading">
              <h2 id="related-heading">Companies in related industries</h2>
              <div className={styles.relatedLinks}>
                {relatedCompanies.map((candidate) => (
                  <Link href={`/companies/${candidate.slug}` as Route} key={`${candidate.node.entityId}-${candidate.node.batchSlug}`}>
                    {candidate.node.label}
                  </Link>
                ))}
              </div>
            </section>
          ) : null}
        </div>

        <aside className={styles.sideColumn} aria-label={`${founder.name} profile details`}>
          <section className={styles.section} aria-labelledby="facts-heading">
            <h2 id="facts-heading">Founder facts</h2>
            <dl className={styles.facts}>
              <div>
                <dt>Company</dt>
                <dd>{company.node.label}</dd>
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
                <dt>Public accounts</dt>
                <dd>{founder.socialAccounts.length}</dd>
              </div>
              <div>
                <dt>Evidence sources</dt>
                <dd>{founder.evidence.length}</dd>
              </div>
              <div>
                <dt>Company score</dt>
                <dd>{Math.round(company.node.score)}</dd>
              </div>
            </dl>
          </section>

          <section className={styles.section} aria-labelledby="sources-heading">
            <h2 id="sources-heading">Public profiles</h2>
            <div className={styles.sourceLinks}>
              {sources.map((source) => (
                <a href={source.url} target="_blank" rel="nofollow noopener noreferrer" key={`${source.label}-${source.url}`}>
                  {source.label}
                </a>
              ))}
            </div>
          </section>

          {cofounders.length > 0 ? (
            <section className={styles.section} aria-labelledby="cofounders-heading">
              <h2 id="cofounders-heading">Cofounders</h2>
              <div className={styles.relatedLinks}>
                {cofounders.map((candidate) => (
                  <Link href={`/founders/${candidate.slug}` as Route} key={candidate.id}>
                    {candidate.name}
                  </Link>
                ))}
              </div>
            </section>
          ) : null}

          <section className={styles.section} aria-labelledby="explore-heading">
            <h2 id="explore-heading">Explore more</h2>
            <div className={styles.relatedLinks}>
              {cohort ? <Link href={`/cohorts/${cohort.slug}` as Route}>{cohort.label}</Link> : null}
              {company.node.industries.slice(0, 2).map((industry) => (
                <Link href={`/industries/${slugify(industry)}` as Route} key={industry}>
                  {industry} companies
                </Link>
              ))}
              <Link href={"/founders" as Route}>All founders</Link>
            </div>
          </section>
        </aside>
      </div>

      <footer className={styles.footer}>
        <span>Public evidence may change as sources are refreshed.</span>
        <Link href={"/founders" as Route}>Back to founder directory</Link>
      </footer>
      <JsonLd data={jsonLd} />
    </main>
  );
}

function founderDescription(founder: PublicFounder): string {
  const companySummary = founder.company.node.tagline || founder.company.node.primaryIndustry;
  return truncateDescription(
    `${founder.name} is a founder of ${founder.company.node.label}. Explore verified public profiles, company context, and attributable traction evidence. ${companySummary}`
  );
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

function founderSources(founder: PublicFounder, acceleratorUrl?: string) {
  const candidates = [
    acceleratorUrl ? { label: "Accelerator profile", url: acceleratorUrl } : null,
    ...founder.socialAccounts.map((account) => ({
      label: `${platformLabel(account.platform)}${account.handle ? ` @${account.handle}` : ""}`,
      url: account.url,
    })),
  ].filter((source): source is { label: string; url: string } => source !== null);

  const seen = new Set<string>();
  return candidates.filter((source) => {
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

function founderJsonLd(founder: PublicFounder, evidence: EvidenceItem[], acceleratorUrl?: string) {
  const canonical = siteUrl(`/founders/${founder.slug}`);
  const sameAs = [acceleratorUrl, ...founder.socialAccounts.map((account) => account.url)].filter(
    (url): url is string => Boolean(url)
  );

  return {
    "@context": "https://schema.org",
    "@type": "Person",
    "@id": `${canonical}#person`,
    name: founder.name,
    url: canonical,
    mainEntityOfPage: canonical,
    sameAs: [...new Set(sameAs)],
    worksFor: {
      "@type": "Organization",
      "@id": `${siteUrl(`/companies/${founder.company.slug}`)}#organization`,
      name: founder.company.node.label,
      url: siteUrl(`/companies/${founder.company.slug}`),
    },
    knowsAbout: founder.company.node.industries,
    subjectOf: evidence.map((item) => ({
      "@type": "CreativeWork",
      name: item.title?.trim() || `${platformLabel(item.platform)} traction evidence`,
      url: item.sourceUrl,
      datePublished: item.postedAt,
    })),
  };
}
