import { DirectoryCards } from "@/components/seo/DirectoryCards";
import { DirectoryCompanyList } from "@/components/seo/DirectoryCompanyList";
import { DirectoryLink, DirectoryShell } from "@/components/seo/DirectoryShell";
import { JsonLd } from "@/components/seo/JsonLd";
import { getEcosystemSnapshot, type EcosystemKey } from "@/lib/seo/ecosystems";
import { SITE_NAME, siteUrl } from "@/lib/seo/site";

export type EcosystemIntent = "network-map" | "social-traction";

interface EcosystemIntentPageProps {
  ecosystem: EcosystemKey;
  intent: EcosystemIntent;
  path: string;
  title: string;
  description: string;
}

export function EcosystemIntentPage({
  ecosystem,
  intent,
  path,
  title,
  description
}: EcosystemIntentPageProps) {
  const snapshot = getEcosystemSnapshot(ecosystem);
  const isNetworkMap = intent === "network-map";
  const featuredCompanies = isNetworkMap
    ? [...snapshot.companies]
        .filter((company) => company.indexable)
        .sort((left, right) => left.node.label.localeCompare(right.node.label))
        .slice(0, 12)
    : snapshot.companies.slice(0, 25);

  return (
    <DirectoryShell
      eyebrow={isNetworkMap ? "Independent startup network map" : "Public traction research"}
      title={title}
      description={description}
      breadcrumbs={[{ label: title }]}
      stats={[
        { label: "Company records", value: snapshot.companyCount },
        { label: "Founder records", value: snapshot.founderCount },
        { label: "Public evidence", value: snapshot.evidenceCount.toLocaleString("en-US") },
        { label: "Updated", value: snapshot.snapshotLabel }
      ]}
    >
      <IntentStructuredData
        path={path}
        title={title}
        description={description}
        intent={intent}
        snapshot={snapshot}
        companies={featuredCompanies}
      />

      {isNetworkMap ? (
        <NetworkMapContent snapshot={snapshot} companies={featuredCompanies} />
      ) : (
        <SocialTractionContent snapshot={snapshot} companies={featuredCompanies} />
      )}

      <p className="rf-directory-note">
        Returner is an independent public-data project and is not affiliated with, endorsed by, or sponsored by
        {ecosystem === "yc" ? " Y Combinator" : " Andreessen Horowitz (a16z)"}. Public traction is an observational
        signal, not investment advice, a valuation, or a complete measure of company quality.
      </p>
      <div className="rf-inline-links">
        {isNetworkMap ? (
          <DirectoryLink href={ecosystem === "yc" ? "/yc-social-traction" : "/a16z-social-traction"}>
            Compare {snapshot.shortName} social traction
          </DirectoryLink>
        ) : (
          <DirectoryLink href={ecosystem === "yc" ? "/yc-network-map" : "/a16z-network-map"}>
            Explore the {snapshot.shortName} network map
          </DirectoryLink>
        )}
      </div>
    </DirectoryShell>
  );
}

function NetworkMapContent({
  snapshot,
  companies
}: {
  snapshot: ReturnType<typeof getEcosystemSnapshot>;
  companies: ReturnType<typeof getEcosystemSnapshot>["companies"];
}) {
  const isYc = snapshot.key === "yc";

  return (
    <>
      <div className="rf-prose">
        <section>
          <h2>What this startup network map shows</h2>
          <p>
            {isYc
              ? `The YC network map brings the Spring 2026 and Summer 2026 startup cohorts into one research view. Its ${snapshot.companyCount} cohort company records connect public company, founder, industry, batch, and group-partner context.`
              : `The a16z Speedrun network map organizes ${snapshot.companyCount} cohort company records in Speedrun 006 with their public founder, industry, group-partner, and traction context.`}
            {" "}Open a company to inspect the source-backed record, or use the live map to move between companies and
            related public attributes.
          </p>
        </section>
        <section>
          <h2>How to read the relationships</h2>
          <p>
            Map relationships describe shared source-record context such as cohort, industry, or group partner. They do
            not claim that two companies interacted, and they do not add points to a traction score. Scores and public
            evidence are documented separately in the <DirectoryLink href="/methodology">methodology</DirectoryLink>.
          </p>
        </section>
      </div>

      <section className="rf-directory-section" aria-labelledby="live-map-heading">
        <div className="rf-directory-section-header">
          <h2 id="live-map-heading">Open the live network map</h2>
          <p>Each map opens with its complete batch and can be narrowed by platform, industry, vertical, voice, partner, and topic.</p>
        </div>
        <DirectoryCards
          items={snapshot.cohorts.map((cohort) => ({
            title: `${cohort.label} network map`,
            href: cohort.batchSlug === "S2026" ? "/" : `/?batch=${cohort.batchSlug}`,
            description: `Explore ${cohort.companies.length} companies and ${cohort.evidenceCount.toLocaleString("en-US")} public evidence records in the interactive map.`,
            meta: [`${cohort.companies.length} companies`, `${cohort.evidenceCount.toLocaleString("en-US")} evidence records`]
          }))}
        />
      </section>

      <section className="rf-directory-section" aria-labelledby="network-industries-heading">
        <div className="rf-directory-section-header">
          <h2 id="network-industries-heading">Explore leading industries</h2>
          <p>Industry pages provide stable, crawlable company lists alongside the interactive map.</p>
        </div>
        <DirectoryCards
          items={snapshot.industries.slice(0, 8).map((industry) => ({
            title: `${industry.name} startups`,
            href: `/industries/${industry.slug}`,
            description: `${industry.count} ${snapshot.shortName} companies are classified in this primary industry.`,
            meta: [`${industry.count} companies`, "Public directory"]
          }))}
        />
      </section>

      <section className="rf-directory-section" aria-labelledby="network-profiles-heading">
        <div className="rf-directory-section-header">
          <h2 id="network-profiles-heading">Sample company records in the map</h2>
          <p>These alphabetized profiles illustrate the source-backed entities connected by the map. Cohort pages contain the complete company lists.</p>
        </div>
        <DirectoryCards
          items={companies.map((company) => ({
            title: company.node.label,
            href: `/companies/${company.slug}`,
            description: company.node.tagline || company.node.description || "Public startup profile",
            meta: [company.graph.batch.label, company.node.primaryIndustry]
          }))}
        />
      </section>

      <div className="rf-inline-links">
        <DirectoryLink href="/cohorts">Browse all cohorts</DirectoryLink>
        <DirectoryLink href="/companies">Browse company profiles</DirectoryLink>
        <DirectoryLink href="/data-sources">Review public data sources</DirectoryLink>
      </div>
    </>
  );
}

function SocialTractionContent({
  snapshot,
  companies
}: {
  snapshot: ReturnType<typeof getEcosystemSnapshot>;
  companies: ReturnType<typeof getEcosystemSnapshot>["companies"];
}) {
  const isYc = snapshot.key === "yc";

  return (
    <>
      <div className="rf-prose">
        <section>
          <h2>What social traction means here</h2>
          <p>
            Returner compares observable public signals for {isYc ? "YC" : "a16z Speedrun"} startups across social,
            developer, launch, video, community, and web sources. The current snapshot connects
            {` ${snapshot.evidenceCount.toLocaleString("en-US")} `}evidence records to {snapshot.companyCount} cohort company records;
            it does not infer private revenue, retention, growth, or investment performance.
          </p>
        </section>
        <section>
          <h2>How the ranking should be used</h2>
          <p>
            Use the ranking to discover companies with visible public momentum, then open each profile to inspect its
            evidence and coverage. Platform-native signals are normalized by the current documented scoring model; they
            are not converted with a hand-picked cross-platform exchange rate. Read the full
            {" "}<DirectoryLink href="/methodology">traction score methodology and limitations</DirectoryLink>.
          </p>
        </section>
      </div>

      <section className="rf-directory-section" aria-labelledby="traction-platforms-heading">
        <div className="rf-directory-section-header">
          <h2 id="traction-platforms-heading">Public traction by platform</h2>
          <p>Counts describe evidence records in the current snapshot, not the total activity of any company or platform.</p>
        </div>
        <DirectoryCards
          items={snapshot.platforms.map((platform) => ({
            title: `${platform.label} traction`,
            href: `/platforms/${platform.slug}`,
            description: `${platform.count.toLocaleString("en-US")} evidence records contribute source-level context for ${snapshot.shortName} companies.`,
            meta: [`${platform.count.toLocaleString("en-US")} evidence records`, "Platform directory"]
          }))}
        />
      </section>

      <section className="rf-directory-section" aria-labelledby="traction-ranking-heading">
        <div className="rf-directory-section-header">
          <h2 id="traction-ranking-heading">Current startup traction ranking</h2>
          <p>The first 25 companies are ordered by the current overall traction score. Scores can change when public evidence is refreshed or corrected.</p>
        </div>
        <DirectoryCompanyList companies={companies} ranked />
      </section>

      <section className="rf-directory-section" aria-labelledby="traction-cohorts-heading">
        <div className="rf-directory-section-header">
          <h2 id="traction-cohorts-heading">Compare cohort coverage</h2>
          <p>Open a cohort page for its complete ranked company list and current evidence total.</p>
        </div>
        <DirectoryCards
          items={snapshot.cohorts.map((cohort) => ({
            title: `${cohort.label} traction`,
            href: `/cohorts/${cohort.slug}`,
            description: `${cohort.companies.length} companies supported by ${cohort.evidenceCount.toLocaleString("en-US")} public evidence records.`,
            meta: [`${cohort.companies.length} companies`, `Updated ${snapshot.snapshotLabel}`]
          }))}
        />
      </section>

      <div className="rf-inline-links">
        <DirectoryLink href="/rankings">All startup traction rankings</DirectoryLink>
        <DirectoryLink href="/data-sources">Review source coverage</DirectoryLink>
        <DirectoryLink href="/corrections">Report a factual correction</DirectoryLink>
      </div>
    </>
  );
}

function IntentStructuredData({
  path,
  title,
  description,
  intent,
  snapshot,
  companies
}: {
  path: string;
  title: string;
  description: string;
  intent: EcosystemIntent;
  snapshot: ReturnType<typeof getEcosystemSnapshot>;
  companies: ReturnType<typeof getEcosystemSnapshot>["companies"];
}) {
  const canonical = siteUrl(path);
  const organizationId = siteUrl("/#organization");
  const keywords = snapshot.key === "yc"
    ? ["YC network map", "Y Combinator startups", "YC social traction", "startup traction rankings"]
    : ["a16z network map", "a16z Speedrun startups", "a16z social traction", "startup traction rankings"];

  return (
    <JsonLd
      data={[
        {
          "@context": "https://schema.org",
          "@type": "CollectionPage",
          "@id": `${canonical}#page`,
          name: title,
          description,
          url: canonical,
          isPartOf: { "@type": "WebSite", "@id": siteUrl("/#website"), name: SITE_NAME },
          dateModified: snapshot.generatedAt,
          mainEntity: {
            "@type": "ItemList",
            numberOfItems: companies.length,
            itemListElement: companies.map((company, index) => ({
              "@type": "ListItem",
              position: index + 1,
              name: company.node.label,
              url: siteUrl(`/companies/${company.slug}`)
            }))
          }
        },
        {
          "@context": "https://schema.org",
          "@type": "Dataset",
          "@id": `${canonical}#dataset`,
          name: `${title} public dataset`,
          description,
          url: canonical,
          creator: { "@type": "Organization", "@id": organizationId, name: SITE_NAME },
          isAccessibleForFree: true,
          dateModified: snapshot.generatedAt,
          temporalCoverage: "2026",
          keywords,
          measurementTechnique: intent === "network-map"
            ? "Organization of public cohort, company, founder, industry, group-partner, and evidence records"
            : "Aggregation and normalization of attributable platform-native public traction evidence",
          variableMeasured: ["traction score", "public evidence count", "platform-native engagement"],
          hasPart: snapshot.cohorts.map((cohort) => ({
            "@type": "Dataset",
            name: `${cohort.label} public startup traction data`,
            url: siteUrl(`/cohorts/${cohort.slug}`),
            dateModified: cohort.companies[0]?.graph.generatedAt ?? snapshot.generatedAt
          }))
        }
      ]}
    />
  );
}
