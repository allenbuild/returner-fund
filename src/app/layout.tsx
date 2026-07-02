import type { Metadata } from "next";
import { Poppins } from "next/font/google";
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={poppins.variable}>{children}</body>
    </html>
  );
}
