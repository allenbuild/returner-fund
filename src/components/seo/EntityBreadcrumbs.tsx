import type { Route } from "next";
import Link from "next/link";

export interface EntityBreadcrumbItem {
  label: string;
  href?: string;
}

export function EntityBreadcrumbs({ items }: { items: EntityBreadcrumbItem[] }) {
  return (
    <nav aria-label="Breadcrumb">
      <ol>
        {items.map((item, index) => {
          const current = index === items.length - 1;
          return (
            <li key={`${item.label}-${index}`}>
              {item.href && !current ? (
                <Link href={item.href as Route}>{item.label}</Link>
              ) : (
                <span aria-current={current ? "page" : undefined}>{item.label}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
