import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "YC Network Map",
  description: "Read-only YC startup and founder traction graph"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
