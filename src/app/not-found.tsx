import type { Metadata } from "next";
import { DirectoryLink, DirectoryShell } from "@/components/seo/DirectoryShell";

export const metadata: Metadata = {
  title: "Page not found",
  robots: { index: false, follow: true }
};

export default function NotFound() {
  return (
    <DirectoryShell
      eyebrow="404"
      title="This page is not in the public catalog"
      description="The URL may be outdated, or the requested company, founder, or collection is not available as a public page."
      breadcrumbs={[{ label: "Home", href: "/" }, { label: "Page not found" }]}
    >
      <section className="rf-directory-section" aria-labelledby="not-found-next">
        <h2 id="not-found-next">Continue exploring</h2>
        <p className="rf-directory-note">
          Browse the <DirectoryLink href="/companies">company directory</DirectoryLink>, explore{" "}
          <DirectoryLink href="/cohorts">cohorts</DirectoryLink>, or use the{" "}
          <DirectoryLink href="/search">catalog search</DirectoryLink>.
        </p>
      </section>
    </DirectoryShell>
  );
}
