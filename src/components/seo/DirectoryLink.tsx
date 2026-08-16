import type { Route } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

export function DirectoryLink({
  href,
  className,
  children,
  ariaLabel,
  ariaCurrent
}: {
  href: string;
  className?: string;
  children: ReactNode;
  ariaLabel?: string;
  ariaCurrent?: "page";
}) {
  return (
    <Link href={href as Route} className={className} aria-current={ariaCurrent} aria-label={ariaLabel}>
      {children}
    </Link>
  );
}
