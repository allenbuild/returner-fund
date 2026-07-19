import { ImageResponse } from "next/og";
import { notFound } from "next/navigation";
import { findCompany } from "@/lib/seo/catalog";

export const runtime = "nodejs";
export const alt = "Returner public company profile";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function CompanyOpenGraphImage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const company = findCompany(slug);
  if (!company) notFound();

  const industry = company.node.primaryIndustry || company.node.industries[0] || "Startup";
  const summary = shorten(
    company.node.tagline || company.node.description || "Public company profile and traction intelligence",
    150
  );

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "64px 72px",
          background: "#fff6ef",
          color: "#1c1917",
          fontFamily: "Arial, sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
            <div
              style={{
                width: 54,
                height: 54,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 6,
                background: "#ff6600",
                color: "#ffffff",
                fontSize: 28,
                fontWeight: 800,
              }}
            >
              R
            </div>
            <span style={{ fontSize: 30, fontWeight: 800 }}>Returner</span>
          </div>
          <span style={{ color: "#6b4226", fontSize: 22, fontWeight: 700 }}>{company.graph.batch.label}</span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 24, maxWidth: 1020 }}>
          <span style={{ color: "#b83f00", fontSize: 22, fontWeight: 800, textTransform: "uppercase" }}>
            {industry}
          </span>
          <div style={{ display: "flex", fontSize: 68, fontWeight: 800, lineHeight: 1.04 }}>{company.node.label}</div>
          <div style={{ display: "flex", color: "#44403c", fontSize: 29, fontWeight: 500, lineHeight: 1.35 }}>
            {summary}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", gap: 28, color: "#57534e", fontSize: 21, fontWeight: 700 }}>
            <span>{company.node.founders.length} founders</span>
            <span>{company.evidence.length} public signals</span>
            <span>Traction score {Math.round(company.node.score)}</span>
          </div>
          <span style={{ color: "#b83f00", fontSize: 22, fontWeight: 800 }}>returner.fund</span>
        </div>
      </div>
    ),
    size
  );
}

function shorten(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).replace(/\s+\S*$/, "")}...`;
}
