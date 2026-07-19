import type { Route } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

export function DirectoryLink({
  href,
  className,
  children,
  ariaLabel
}: {
  href: string;
  className?: string;
  children: ReactNode;
  ariaLabel?: string;
}) {
  return <Link href={href as Route} className={className} aria-label={ariaLabel}>{children}</Link>;
}
