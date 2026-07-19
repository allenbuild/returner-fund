import { DirectoryLink, DirectoryShell } from "@/components/seo/DirectoryShell";
import { JsonLd } from "@/components/seo/JsonLd";
import { publicMetadata, siteUrl } from "@/lib/seo/site";

const title = "Frequently asked questions";
const description = "Answers about Returner traction scores, public evidence, coverage, ranking changes, source attribution, and corrections.";

export const metadata = publicMetadata({ title, description, path: "/faq" });

const questions = [
  { question: "What does a Returner traction score mean?", answer: "It is a 0-100 summary of observable public traction signals in the current catalog snapshot. It is not a valuation, investment recommendation, or prediction of company performance." },
  { question: "Why can a score change?", answer: "Scores can change when public evidence is refreshed, corrected, deduplicated, reattributed, or recalibrated against the available peer cohort." },
  { question: "Does a missing platform mean a company has no traction there?", answer: "No. Missing coverage means the current catalog does not contain an eligible public account or evidence signal for that platform. It is not proof of absence." },
  { question: "Where do company and founder details come from?", answer: "They come from public accelerator profiles, company websites, verified public accounts, and the source records stored in the catalog snapshots." },
  { question: "Are rankings investment rankings?", answer: "No. Rankings order eligible catalog companies by public traction score. They do not assess valuation, financial health, product quality, or expected investment return." },
  { question: "How are corrections reviewed?", answer: "A useful correction identifies the affected page and field, supplies a primary public source, explains the requested change, and includes a date when the claim is time-sensitive." }
];

export default function FaqPage() {
  return (
    <DirectoryShell eyebrow="Help" title={title} description={description} breadcrumbs={[{ label: "FAQ" }]}>
      <JsonLd data={{
        "@context": "https://schema.org",
        "@type": "FAQPage",
        url: siteUrl("/faq"),
        mainEntity: questions.map((item) => ({
          "@type": "Question",
          name: item.question,
          acceptedAnswer: { "@type": "Answer", text: item.answer }
        }))
      }} />
      <div className="rf-prose">
        {questions.map((item) => <section key={item.question}><h2>{item.question}</h2><p>{item.answer}</p></section>)}
        <section><h2>Where can I learn more?</h2><p>Read the full <DirectoryLink href="/methodology">methodology</DirectoryLink>, review <DirectoryLink href="/data-sources">data source coverage</DirectoryLink>, browse <DirectoryLink href="/rankings">rankings</DirectoryLink>, or prepare a <DirectoryLink href="/corrections">correction request</DirectoryLink>.</p></section>
      </div>
    </DirectoryShell>
  );
}
