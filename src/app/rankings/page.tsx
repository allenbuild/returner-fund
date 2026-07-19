import { DirectoryCompanyList } from "@/components/seo/DirectoryCompanyList";
import { DirectoryLink, DirectoryShell } from "@/components/seo/DirectoryShell";
import { DirectoryCollectionJsonLd } from "@/components/seo/DirectoryStructuredData";
import { getCatalog } from "@/lib/seo/catalog";
import { publicMetadata } from "@/lib/seo/site";

const title = "Startup traction rankings";
const description = "Compare verified companies by Returner traction score, a snapshot of observable public reach, engagement, developer adoption, launch, community, and momentum signals.";

export const metadata = publicMetadata({ title, description, path: "/rankings" });

export default function RankingsPage() {
  const catalog = getCatalog();
  const companies = catalog.companies
    .filter((company) => company.indexable)
    .sort((a, b) => b.node.score - a.node.score || b.evidence.length - a.evidence.length || a.node.label.localeCompare(b.node.label));
  const generatedAt = catalog.graphs.map((graph) => graph.generatedAt).sort().at(-1);
  const asOf = generatedAt ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(generatedAt)) : "Current snapshot";

  return (
    <DirectoryShell
      eyebrow="Public leaderboard"
      title={title}
      description={description}
      breadcrumbs={[{ label: "Rankings" }]}
      stats={[
        { label: "Ranked companies", value: companies.length },
        { label: "Cohorts", value: catalog.cohorts.length },
        { label: "Snapshot", value: asOf }
      ]}
    >
      <DirectoryCollectionJsonLd
        name={title}
        description={description}
        path="/rankings"
        items={companies.slice(0, 100).map((company) => ({ name: company.node.label, path: `/companies/${company.slug}` }))}
      />
      <p className="rf-directory-note">Rank order uses the current overall traction score. It does not measure company quality, financial performance, valuation, or investment potential. Read the <DirectoryLink href="/methodology">methodology and limitations</DirectoryLink>.</p>
      <section className="rf-directory-section" aria-labelledby="ranking-list-heading">
        <div className="rf-directory-section-header">
          <h2 id="ranking-list-heading">Verified companies</h2>
          <p>Ties are ordered by evidence count and then company name. Scores can change as public evidence is refreshed or corrected.</p>
        </div>
        <DirectoryCompanyList companies={companies} ranked />
      </section>
      <div className="rf-inline-links"><DirectoryLink href="/cohorts">Compare cohorts</DirectoryLink><DirectoryLink href="/industries">Compare industries</DirectoryLink><DirectoryLink href="/data-sources">Inspect data sources</DirectoryLink></div>
    </DirectoryShell>
  );
}
