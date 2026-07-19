import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Debug",
  alternates: { canonical: null },
  robots: { index: false, follow: false, nocache: true }
};

export default function DebugLayout({ children }: { children: React.ReactNode }) {
  return children;
}
