import type { Metadata } from "next";
import { Fraunces, Poppins } from "next/font/google";
import "./globals.css";

export const metadata: Metadata = {
  title: "YC Network Map",
  description: "Read-only YC startup and founder traction graph",
  icons: {
    icon: [
      { url: "/favicon.ico?v=returner-2" },
      { url: "/icon.png?v=returner-2", type: "image/png" }
    ],
    shortcut: "/favicon.ico?v=returner-2",
    apple: "/icon.png?v=returner-2"
  }
};

const poppins = Poppins({
  subsets: ["latin"],
  weight: ["500", "600", "700", "800", "900"],
  variable: "--font-poppins",
  display: "swap"
});

const fraunces = Fraunces({
  subsets: ["latin"],
  weight: "variable",
  style: "italic",
  axes: ["SOFT", "WONK", "opsz"],
  variable: "--font-fraunces",
  display: "swap",
  fallback: ["serif"]
});

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${poppins.variable} ${fraunces.variable}`}>{children}</body>
    </html>
  );
}
