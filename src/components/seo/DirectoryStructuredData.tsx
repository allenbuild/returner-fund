import { JsonLd } from "./JsonLd";
import { SITE_NAME, siteUrl } from "@/lib/seo/site";

export function DirectoryCollectionJsonLd({
  name,
  description,
  path,
  items
}: {
  name: string;
  description: string;
  path: string;
  items: { name: string; path: string }[];
}) {
  return (
    <JsonLd
      data={{
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        name,
        description,
        url: siteUrl(path),
        isPartOf: { "@type": "WebSite", name: SITE_NAME, url: siteUrl("/") },
        mainEntity: {
          "@type": "ItemList",
          numberOfItems: items.length,
          itemListElement: items.map((item, index) => ({
            "@type": "ListItem",
            position: index + 1,
            name: item.name,
            url: siteUrl(item.path)
          }))
        }
      }}
    />
  );
}

export function DirectoryArticleJsonLd({
  name,
  description,
  path,
  type = "Article"
}: {
  name: string;
  description: string;
  path: string;
  type?: "Article" | "AboutPage" | "WebPage";
}) {
  return (
    <JsonLd
      data={{
        "@context": "https://schema.org",
        "@type": type,
        name,
        description,
        url: siteUrl(path),
        publisher: { "@type": "Organization", name: SITE_NAME, url: siteUrl("/") }
      }}
    />
  );
}
