import { DirectoryCards, type DirectoryCardItem } from "@/components/seo/DirectoryCards";
import { DirectoryCompanyList } from "@/components/seo/DirectoryCompanyList";
import { DirectoryLink, DirectoryShell } from "@/components/seo/DirectoryShell";
import { DirectoryArticleJsonLd } from "@/components/seo/DirectoryStructuredData";
import { getCatalog } from "@/lib/seo/catalog";
import { publicMetadata } from "@/lib/seo/site";

const title = "Search the startup catalog";
const description = "Search Returner companies, founders, cohorts, industries, platforms, and partner groupings.";

export const metadata = publicMetadata({ title, description, path: "/search", index: false });

type SearchPageProps = { searchParams: Promise<{ q?: string | string[] }> };

export default async function SearchPage({ searchParams }: SearchPageProps) {
  const value = (await searchParams).q;
  const query = (Array.isArray(value) ? value[0] : value)?.trim().slice(0, 100) ?? "";
  const needle = query.toLocaleLowerCase("en-US");
  const catalog = getCatalog();
  const hasQuery = needle.length >= 2;
  const companies = hasQuery ? catalog.companies.filter((company) => [
    company.node.label,
    company.node.tagline,
    company.node.description,
    company.node.industries.join(" "),
    company.node.founders.map((founder) => founder.name).join(" ")
  ].some((field) => field?.toLocaleLowerCase("en-US").includes(needle))).slice(0, 50) : [];
  const directoryMatches: DirectoryCardItem[] = hasQuery ? [
    ...catalog.founders.filter((founder) => founder.name.toLocaleLowerCase("en-US").includes(needle)).map((founder) => ({
      title: founder.name,
      href: `/founders/${founder.slug}`,
      description: `Founder at ${founder.company.node.label}.`,
      meta: ["Founder"]
    })),
    ...catalog.cohorts.filter((cohort) => cohort.label.toLocaleLowerCase("en-US").includes(needle)).map((cohort) => ({
      title: cohort.label,
      href: `/cohorts/${cohort.slug}`,
      description: `${cohort.companies.length} companies in this cohort.`,
      meta: ["Cohort"]
    })),
    ...catalog.industries.filter((industry) => industry.name.toLocaleLowerCase("en-US").includes(needle)).map((industry) => ({
      title: industry.name,
      href: `/industries/${industry.slug}`,
      description: `${industry.companies.length} companies in this industry group.`,
      meta: ["Industry"]
    })),
    ...catalog.platforms.filter((platform) => platform.label.toLocaleLowerCase("en-US").includes(needle)).map((platform) => ({
      title: platform.label,
      href: `/platforms/${platform.slug}`,
      description: `${platform.companies.length} companies with accounts or evidence.`,
      meta: ["Platform"]
    })),
    ...catalog.partners.filter((partner) => partner.name.toLocaleLowerCase("en-US").includes(needle)).map((partner) => ({
      title: partner.name,
      href: `/partners/${partner.slug}`,
      description: `${partner.companies.length} companies with this source-record label.`,
      meta: ["Group partner"]
    }))
  ].slice(0, 50) : [];
  const resultCount = companies.length + directoryMatches.length;

  return (
    <DirectoryShell
      eyebrow="Catalog search"
      title={query ? `Search results for "${query}"` : title}
      description={query ? `${resultCount} matching catalog results are shown below. Search pages are excluded from public search indexes.` : description}
      breadcrumbs={[{ label: "Search" }]}
      stats={query ? [{ label: "Results", value: resultCount }, { label: "Company matches", value: companies.length }] : undefined}
    >
      <DirectoryArticleJsonLd name={title} description={description} path="/search" type="WebPage" />
      <section className="rf-directory-section" aria-labelledby="search-heading">
        <h2 id="search-heading" className="sr-only">Search form</h2>
        <form className="rf-search-form" action="/search" method="get" role="search">
          <label className="sr-only" htmlFor="directory-query">Search companies and directories</label>
          <input id="directory-query" name="q" type="search" defaultValue={query} placeholder="Company, founder, cohort, industry, or platform" minLength={2} />
          <button type="submit">Search</button>
        </form>
      </section>

      {!query ? (
        <section className="rf-directory-section" aria-labelledby="browse-heading">
          <div className="rf-directory-section-header"><h2 id="browse-heading">Browse instead</h2><p>Directory pages are crawlable and provide complete category lists.</p></div>
          <DirectoryCards items={[
            { title: "Cohorts", href: "/cohorts", description: `${catalog.cohorts.length} accelerator cohorts.`, meta: ["Directory"] },
            { title: "Industries", href: "/industries", description: `${catalog.industries.length} industry labels.`, meta: ["Directory"] },
            { title: "Platforms", href: "/platforms", description: `${catalog.platforms.length} observed public platforms.`, meta: ["Directory"] },
            { title: "Partners", href: "/partners", description: `${catalog.partners.length} source-record partner labels.`, meta: ["Directory"] }
          ]} />
        </section>
      ) : !hasQuery ? <p className="rf-directory-note">Enter at least two characters to search the catalog.</p> : resultCount === 0 ? (
        <p className="rf-directory-note">No catalog entries matched this query. Try a shorter company name or browse <DirectoryLink href="/industries">industries</DirectoryLink> and <DirectoryLink href="/cohorts">cohorts</DirectoryLink>.</p>
      ) : (
        <>
          {companies.length ? (
            <section className="rf-directory-section" aria-labelledby="company-results-heading">
              <div className="rf-directory-section-header"><h2 id="company-results-heading">Companies</h2><p>{companies.length} matching companies, capped at 50 results.</p></div>
              <DirectoryCompanyList companies={companies} />
            </section>
          ) : null}
          {directoryMatches.length ? (
            <section className="rf-directory-section" aria-labelledby="directory-results-heading">
              <div className="rf-directory-section-header"><h2 id="directory-results-heading">People and directories</h2><p>Matching founders and aggregate catalog pages.</p></div>
              <DirectoryCards items={directoryMatches} />
            </section>
          ) : null}
        </>
      )}
      <div className="rf-inline-links"><DirectoryLink href="/rankings">View rankings</DirectoryLink><DirectoryLink href="/faq">Search FAQ</DirectoryLink><DirectoryLink href="/industries">Browse industries</DirectoryLink></div>
    </DirectoryShell>
  );
}
