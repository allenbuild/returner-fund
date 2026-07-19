import { DirectoryLink, DirectoryShell } from "@/components/seo/DirectoryShell";
import { DirectoryArticleJsonLd } from "@/components/seo/DirectoryStructuredData";
import { publicMetadata } from "@/lib/seo/site";

const title = "Corrections policy";
const description = "How to document a correction to a Returner company, founder, cohort, source, attribution, or public evidence record.";

export const metadata = publicMetadata({ title, description, path: "/corrections" });

export default function CorrectionsPage() {
  return (
    <DirectoryShell eyebrow="Accountability" title={title} description={description} breadcrumbs={[{ label: "Corrections" }]}>
      <DirectoryArticleJsonLd name={title} description={description} path="/corrections" />
      <div className="rf-prose">
        <section><h2>What can be corrected</h2><p>Correction review can cover company or founder identity, websites and public accounts, cohort and industry labels, group partner fields, evidence attribution, source URLs, timestamps, metrics, duplicate records, and review state.</p></section>
        <section><h2>What to include</h2><ol><li>The exact Returner page URL and the field or evidence item in question.</li><li>The current value and the requested corrected value.</li><li>A primary public source that supports the correction.</li><li>The date observed when the information can change over time.</li><li>A short explanation of identity or attribution when names or accounts are ambiguous.</li></ol></section>
        <section><h2>Review standard</h2><p>Primary sources are preferred, including an official accelerator profile, company website, founder profile, or the original public post. A correction should preserve provenance rather than silently replacing a disputed observation. Historical metrics can remain part of the record when they were accurate at the recorded observation time.</p></section>
        <section><h2>Score impact</h2><p>Accepted evidence changes can alter platform scores, confidence, coverage, calibration, and rank. A score change is a consequence of the corrected inputs, not a separately negotiated adjustment.</p></section>
        <section><h2>Before reporting</h2><p>Check the <DirectoryLink href="/data-sources">data source policy</DirectoryLink> and <DirectoryLink href="/methodology">methodology</DirectoryLink> to distinguish a factual error from a documented coverage limitation. Search the <DirectoryLink href="/search">catalog</DirectoryLink> for duplicate entity records.</p></section>
      </div>
    </DirectoryShell>
  );
}
