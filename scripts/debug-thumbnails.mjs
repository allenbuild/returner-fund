import fs from "node:fs/promises";
import path from "node:path";

const apiUrl = process.env.GRAPH_API_URL ?? "http://127.0.0.1:3001/api/graph?batch=S2026&includeNonScoring=1";
const graph = await fetchJson(apiUrl);
const rows = graph.evidence ?? [];
const report = buildThumbnailCoverageReport(rows);

await fs.mkdir("outputs", { recursive: true });
await fs.writeFile(path.join("outputs", "thumbnail-coverage-debug-s2026.json"), JSON.stringify(report, null, 2));
await updateDocs(report);

console.log(
  JSON.stringify(
    {
      outputPath: "outputs/thumbnail-coverage-debug-s2026.json",
      evidenceRows: report.evidenceRows,
      rowsWithThumbnail: report.rowsWithThumbnail,
      rowsWithRealThumbnail: report.rowsWithRealThumbnail,
      rowsMissingThumbnail: report.rowsMissingThumbnail,
      rowsWithFallbackThumbnail: report.rowsWithFallbackThumbnail
    },
    null,
    2
  )
);

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Graph API failed with ${response.status}`);
  return response.json();
}

function buildThumbnailCoverageReport(rows) {
  const withThumbnail = rows.filter((item) => item.thumbnailUrl);
  const fallback = rows.filter((item) => isFallbackThumbnail(item.thumbnailUrl));
  const real = withThumbnail.filter((item) => !isFallbackThumbnail(item.thumbnailUrl));
  const missing = rows.filter((item) => !item.thumbnailUrl);

  return {
    generatedAt: new Date().toISOString(),
    evidenceRows: rows.length,
    rowsWithThumbnail: withThumbnail.length,
    rowsWithRealThumbnail: real.length,
    rowsWithFallbackThumbnail: fallback.length,
    rowsMissingThumbnail: missing.length,
    platformCoverage: platforms(rows).map((platform) => platformRow(platform, rows.filter((item) => item.platform === platform))),
    missingExamples: missing.slice(0, 100).map(exampleRow),
    blockedOrFallbackExamples: fallback.slice(0, 100).map(exampleRow)
  };
}

function platformRow(platform, rows) {
  const withThumbnail = rows.filter((item) => item.thumbnailUrl);
  const fallback = rows.filter((item) => isFallbackThumbnail(item.thumbnailUrl));
  const real = withThumbnail.filter((item) => !isFallbackThumbnail(item.thumbnailUrl));

  return {
    platform,
    evidenceRows: rows.length,
    withThumbnail: withThumbnail.length,
    withRealThumbnail: real.length,
    withFallback: fallback.length,
    missing: rows.length - withThumbnail.length,
    thumbnailSources: countBy(rows, (item) => item.thumbnailSource ?? "none")
  };
}

function exampleRow(item) {
  return {
    id: item.id,
    platform: item.platform,
    companyName: item.attachedCompanyName ?? null,
    title: item.title ?? item.text,
    sourceUrl: item.sourceUrl,
    thumbnailUrl: item.thumbnailUrl ?? null,
    thumbnailSource: item.thumbnailSource ?? null,
    linkStatus: item.linkStatus ?? null,
    linkFailureReason: item.linkFailureReason ?? null
  };
}

function platforms(rows) {
  return [...new Set(rows.map((item) => item.platform))].sort();
}

function isFallbackThumbnail(url) {
  if (!url) return false;
  const normalized = url.toLowerCase();
  return (
    /^\/evidence-thumbnails\/.+\.svg(?:$|[?#])/.test(normalized) ||
    normalized.includes("generated-preview") ||
    normalized.includes("fallback") ||
    normalized.includes("placeholder")
  );
}

function countBy(items, getKey) {
  return items.reduce((counts, item) => {
    const key = getKey(item);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

async function updateDocs(report) {
  const lines = [
    "# Thumbnail Coverage",
    "",
    `Generated at: ${report.generatedAt}`,
    "",
    "## Summary",
    "",
    `- Evidence rows: ${report.evidenceRows}`,
    `- Rows with thumbnails: ${report.rowsWithThumbnail}`,
    `- Rows with real thumbnails: ${report.rowsWithRealThumbnail}`,
    `- Rows with fallback thumbnails: ${report.rowsWithFallbackThumbnail}`,
    `- Rows missing thumbnails: ${report.rowsMissingThumbnail}`,
    "",
    "## Platform Coverage",
    "",
    ...report.platformCoverage.map(
      (row) =>
        `- ${row.platform}: ${row.withRealThumbnail}/${row.evidenceRows} real thumbnails, ${row.withFallback} fallback, ${row.missing} missing, sources ${JSON.stringify(row.thumbnailSources)}.`
    ),
    "",
    "## Missing Examples",
    "",
    ...report.missingExamples.slice(0, 50).map((row) => `- ${row.platform} ${row.companyName ?? "unknown"}: ${row.sourceUrl}`),
    "",
    "## Fallback Examples",
    "",
    ...report.blockedOrFallbackExamples
      .slice(0, 50)
      .map((row) => `- ${row.platform} ${row.companyName ?? "unknown"}: ${row.thumbnailSource ?? "none"} ${row.sourceUrl}`),
    "",
    "## Resume Commands",
    "",
    "- `npm run thumbnails:backfill -- --platform=instagram --cache-instagram --force --limit=200 --delay-ms=1200`",
    "- `npm run thumbnails:backfill -- --platform=x --cache-x --validate-x --force --limit=200 --delay-ms=600`",
    "- `npm run thumbnails:links -- --limit=200 --max-rows=200 --checkpoint-rows=25`",
    "- `npm run debug:thumbnails`",
    ""
  ];
  await fs.mkdir("docs", { recursive: true });
  await fs.writeFile(path.join("docs", "THUMBNAIL_STATUS.md"), lines.join("\n"));
}
