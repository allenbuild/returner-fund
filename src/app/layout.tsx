import type { Metadata } from "next";
import { Poppins } from "next/font/google";
import { Telemetry } from "@/components/Telemetry";
import { SITE_DESCRIPTION, SITE_NAME, siteUrl } from "@/lib/seo/site";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl("/")),
  title: {
    default: `${SITE_NAME} | Startup network maps and social traction`,
    template: `%s | ${SITE_NAME}`
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  category: "technology",
  keywords: [
    "startup traction",
    "startup network map",
    "startup social traction",
    "YC network map",
    "YC social traction",
    "a16z network map",
    "a16z social traction",
    "accelerator cohorts",
    "startup founders",
    "public startup data",
    "Y Combinator",
    "a16z speedrun"
  ],
  alternates: { canonical: siteUrl("/") },
  manifest: "/manifest.webmanifest",
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1
    }
  },
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    title: `${SITE_NAME} | Startup network maps and social traction`,
    description: SITE_DESCRIPTION,
    url: siteUrl("/"),
    images: [
      {
        url: siteUrl("/opengraph-image"),
        width: 1200,
        height: 630,
        alt: `${SITE_NAME} startup traction intelligence`
      }
    ]
  },
  twitter: {
    card: "summary_large_image",
    title: `${SITE_NAME} | Startup network maps and social traction`,
    description: SITE_DESCRIPTION,
    images: [siteUrl("/opengraph-image")]
  },
  icons: {
    icon: [
      { url: "/favicon.ico?v=returner-3" },
      { url: "/icon.png?v=returner-3", type: "image/png" }
    ],
    shortcut: "/favicon.ico?v=returner-3",
    apple: "/icon.png?v=returner-3"
  },
  verification: process.env.GOOGLE_SITE_VERIFICATION
    ? { google: process.env.GOOGLE_SITE_VERIFICATION }
    : undefined
};

const poppins = Poppins({
  subsets: ["latin"],
  weight: ["500", "600", "700", "800", "900"],
  variable: "--font-poppins",
  display: "swap"
});

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={poppins.variable}>
        {children}
        <Telemetry />
      </body>
    </html>
  );
}
