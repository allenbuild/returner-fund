import type { Route } from "next";
import Link from "next/link";

export function EntitySiteNav({ className }: { className?: string }) {
  return (
    <nav className={className} aria-label="Primary navigation">
      <Link className="entity-site-brand" href={"/" as Route}>
        Returner
      </Link>
      <div className="entity-site-links">
        <Link href={"/yc-network-map" as Route}>YC map</Link>
        <Link href={"/a16z-network-map" as Route}>a16z map</Link>
        <Link href={"/companies" as Route}>Companies</Link>
        <Link href={"/founders" as Route}>Founders</Link>
        <Link href={"/" as Route}>Network map</Link>
      </div>
    </nav>
  );
}
