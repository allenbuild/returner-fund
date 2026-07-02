import type { Metadata } from "next";
import { Poppins } from "next/font/google";
import Script from "next/script";
import "./globals.css";

export const metadata: Metadata = {
  title: "YC Network Map",
  description: "Read-only YC startup and founder traction graph",
  icons: {
    icon: [
      { url: "/favicon.ico?v=returner-3" },
      { url: "/icon.png?v=returner-3", type: "image/png" }
    ],
    shortcut: "/favicon.ico?v=returner-3",
    apple: "/icon.png?v=returner-3"
  }
};

const poppins = Poppins({
  subsets: ["latin"],
  weight: ["500", "600", "700", "800", "900"],
  variable: "--font-poppins",
  display: "swap"
});

const graphIntroPreloadScript = `
(function () {
  try {
    var key = "yc-network-map-intro-played-v1";
    var reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var entries = performance.getEntriesByType ? performance.getEntriesByType("navigation") : [];
    var navigationType = entries && entries[0] ? entries[0].type : "";
    var hasPlayed = window.sessionStorage && window.sessionStorage.getItem(key);
    if (!reducedMotion && (!hasPlayed || navigationType === "reload")) {
      document.documentElement.classList.add("graph-intro-preload");
    }
  } catch (error) {
    document.documentElement.classList.add("graph-intro-preload");
  }
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={poppins.variable}>
        <Script
          id="graph-intro-preload"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: graphIntroPreloadScript }}
        />
        {children}
      </body>
    </html>
  );
}
