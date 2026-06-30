import fs from "node:fs/promises";
import path from "node:path";

const apiUrl = process.env.INGEST_API_URL ?? "http://127.0.0.1:3001/api/ingest/batch";
const platforms = (process.env.PUBLIC_INGEST_PLATFORMS ?? "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const response = await fetch(apiUrl, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    batchSlug: "S2026",
    options: {
      demo: process.env.PUBLIC_INGEST_DATABASE === "true" ? false : true,
      refreshProfiles: true,
      refreshPosts: true,
      maxCompanies: Number(process.env.PUBLIC_INGEST_MAX_COMPANIES ?? 197),
      ...(platforms.length ? { platforms } : {})
    }
  })
});

const payload = await response.json();
const outputPath = path.join("outputs", "ingest-public-s2026.json");
await fs.mkdir("outputs", { recursive: true });
await fs.writeFile(outputPath, JSON.stringify(payload, null, 2));

if (!response.ok) {
  console.error(JSON.stringify({ outputPath, status: response.status, errors: payload.errors ?? [] }, null, 2));
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      outputPath,
      status: payload.status,
      runId: payload.runId,
      nodeCount: payload.graph?.nodes?.length ?? 0,
      edgeCount: payload.graph?.edges?.length ?? 0
    },
    null,
    2
  )
);
