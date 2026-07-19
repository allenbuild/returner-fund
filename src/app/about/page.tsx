import { DirectoryLink, DirectoryShell } from "@/components/seo/DirectoryShell";
import { DirectoryArticleJsonLd } from "@/components/seo/DirectoryStructuredData";
import { getCatalog } from "@/lib/seo/catalog";
import { publicMetadata } from "@/lib/seo/site";

const title = "About Returner";
const description = "Returner organizes public startup, founder, cohort, industry, and traction evidence into a browsable research directory.";

export const metadata = publicMetadata({ title, description, path: "/about" });

export default function AboutPage() {
  const catalog = getCatalog();

  return (
    <DirectoryShell
      eyebrow="About"
      title={title}
      description={description}
      breadcrumbs={[{ label: "About" }]}
      stats={[
        { label: "Companies", value: catalog.companies.length },
        { label: "Founders", value: catalog.founders.length },
        { label: "Cohorts", value: catalog.cohorts.length }
      ]}
    >
      <DirectoryArticleJsonLd name={title} description={description} path="/about" type="AboutPage" />
      <div className="rf-prose">
        <section><h2>What Returner is</h2><p>Returner is a public research directory for comparing observable startup traction across accelerator cohorts. It connects company and founder records with public evidence from social, developer, launch, community, and web sources.</p></section>
        <section><h2>What Returner is not</h2><p>Returner does not provide investment advice, valuation estimates, private company financials, or a complete measure of company quality. A traction score reflects the public evidence available to the current snapshot and should be read with its coverage and confidence limitations.</p></section>
        <section><h2>How to use the directory</h2><p>Start with <DirectoryLink href="/cohorts">cohorts</DirectoryLink>, <DirectoryLink href="/industries">industries</DirectoryLink>, or <DirectoryLink href="/platforms">platforms</DirectoryLink>. Use <DirectoryLink href="/rankings">rankings</DirectoryLink> for a score-ordered view, then open individual records to inspect the evidence behind a result.</p></section>
        <section><h2>Trust and accountability</h2><p>The <DirectoryLink href="/methodology">methodology</DirectoryLink> explains score construction, the <DirectoryLink href="/data-sources">data sources page</DirectoryLink> describes source coverage, and the <DirectoryLink href="/corrections">corrections policy</DirectoryLink> explains what is needed to review a disputed record.</p></section>
      </div>
    </DirectoryShell>
  );
}
