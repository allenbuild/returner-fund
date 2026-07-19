import { JsonLd } from "./JsonLd";
import { DirectoryLink } from "./DirectoryLink";
import { siteUrl } from "@/lib/seo/site";

export interface DirectoryBreadcrumbItem {
  label: string;
  href?: string;
}

export function DirectoryBreadcrumbs({ items }: { items: DirectoryBreadcrumbItem[] }) {
  const crumbs = [{ label: "Home", href: "/" }, ...items];

  return (
    <>
      <nav className="rf-directory-breadcrumbs" aria-label="Breadcrumb">
        <ol>
          {crumbs.map((item, index) => (
            <li key={`${item.label}-${index}`}>
              {item.href && index < crumbs.length - 1 ? <DirectoryLink href={item.href}>{item.label}</DirectoryLink> : <span>{item.label}</span>}
            </li>
          ))}
        </ol>
      </nav>
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "BreadcrumbList",
          itemListElement: crumbs.map((item, index) => ({
            "@type": "ListItem",
            position: index + 1,
            name: item.label,
            ...(item.href ? { item: siteUrl(item.href) } : {})
          }))
        }}
      />
    </>
  );
}
