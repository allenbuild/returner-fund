import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/seo/site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/admin/", "/debug/", "/api/"]
    },
    sitemap: siteUrl("/sitemap.xml"),
    host: siteUrl("/")
  };
}
