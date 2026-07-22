import type { Metadata } from "next";

export const SITE_NAME = "Returner.fund";
export const SITE_DESCRIPTION =
  "Explore YC and a16z Speedrun startup network maps, company rankings, founders, industries, and evidence-linked social traction.";

export function siteUrl(path = "/"): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://www.returner.fund";
  const canonical = new URL(configured.endsWith("/") ? configured : `${configured}/`);

  // Production permanently redirects the apex host to www. Normalize a stale
  // environment value so canonicals, schema, robots, and sitemap URLs always
  // describe the final 200 URL rather than a redirecting URL.
  if (canonical.hostname === "returner.fund") {
    canonical.hostname = "www.returner.fund";
  }
  canonical.pathname = "/";
  canonical.search = "";
  canonical.hash = "";

  return new URL(path.replace(/^\//, ""), canonical).toString();
}

export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90) || "item";
}

export function publicMetadata(input: {
  title: string;
  description: string;
  path: string;
  index?: boolean;
  imagePath?: string;
}): Metadata {
  const canonical = siteUrl(input.path);
  const image = siteUrl(input.imagePath ?? "/opengraph-image");
  const index = input.index ?? true;

  return {
    title: input.title,
    description: input.description,
    alternates: { canonical },
    robots: { index, follow: true },
    openGraph: {
      type: "website",
      siteName: SITE_NAME,
      title: input.title,
      description: input.description,
      url: canonical,
      images: [{ url: image, width: 1200, height: 630, alt: input.title }]
    },
    twitter: {
      card: "summary_large_image",
      title: input.title,
      description: input.description,
      images: [image]
    }
  };
}

export function truncateDescription(value: string, maxLength = 158): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).replace(/\s+\S*$/, "")}…`;
}
