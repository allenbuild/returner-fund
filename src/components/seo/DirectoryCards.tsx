export interface DirectoryCardItem {
  title: string;
  href: string;
  description: string;
  meta?: string[];
}

export function DirectoryCards({ items }: { items: DirectoryCardItem[] }) {
  return (
    <div className="rf-directory-grid">
      {items.map((item) => (
        <article className="rf-directory-card" key={item.href}>
          <h2><DirectoryLink href={item.href}>{item.title}</DirectoryLink></h2>
          <p>{item.description}</p>
          {item.meta?.length ? (
            <div className="rf-directory-card-meta">
              {item.meta.map((value) => <span key={value}>{value}</span>)}
            </div>
          ) : null}
        </article>
      ))}
    </div>
  );
}
import { DirectoryLink } from "./DirectoryLink";
