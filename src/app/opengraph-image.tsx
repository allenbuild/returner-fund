import { ImageResponse } from "next/og";
import { SITE_NAME } from "@/lib/seo/site";

export const alt = `${SITE_NAME} startup traction intelligence`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          alignItems: "stretch",
          background: "#fff6ef",
          color: "#101828",
          display: "flex",
          flexDirection: "column",
          fontFamily: "Arial, sans-serif",
          height: "100%",
          justifyContent: "space-between",
          padding: "72px 80px",
          width: "100%"
        }}
      >
        <div style={{ alignItems: "center", display: "flex", gap: 20 }}>
          <div
            style={{
              alignItems: "center",
              background: "#ff6600",
              color: "#ffffff",
              display: "flex",
              fontSize: 40,
              fontWeight: 800,
              height: 72,
              justifyContent: "center",
              width: 72
            }}
          >
            R
          </div>
          <div style={{ display: "flex", fontSize: 42, fontWeight: 800 }}>{SITE_NAME}</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div style={{ display: "flex", fontSize: 72, fontWeight: 800, lineHeight: 1.05, maxWidth: 980 }}>
            Public startup traction, connected.
          </div>
          <div style={{ color: "#475467", display: "flex", fontSize: 30, lineHeight: 1.35, maxWidth: 940 }}>
            Explore accelerator cohorts, companies, founders, industries, and public traction evidence.
          </div>
        </div>

        <div style={{ background: "#ff6600", display: "flex", height: 12, width: "100%" }} />
      </div>
    ),
    size
  );
}
