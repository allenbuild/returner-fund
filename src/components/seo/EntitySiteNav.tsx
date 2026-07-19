import type { Route } from "next";
import Link from "next/link";

export function EntitySiteNav({ className }: { className?: string }) {
  return (
    <nav className={className} aria-label="Primary navigation">
      <Link className="entity-site-brand" href={"/" as Route}>
        Returner
      </Link>
      <div className="entity-site-links">
        <Link href={"/companies" as Route}>Companies</Link>
        <Link href={"/founders" as Route}>Founders</Link>
        <Link href={"/" as Route}>Network map</Link>
      </div>
    </nav>
  );
}
