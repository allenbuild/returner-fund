const benchmarkRuntimeData = [
  "outputs/benchmarks/**/*.json",
];
const graphEvidenceRuntimeData = [
  "generated-runtime/graph/public-evidence-current.json",
  "generated-runtime/graph/logged-in-evidence-current.json",
  "generated-runtime/graph/targeted-evidence-current.json",
];
const timelineRuntimeData = [
  "public/timelines/**/*.json",
];
const timelineInternalRuntimeData = [
  "artifacts/company-timeline/coverage.json",
];
const graphRuntimeData = [
  ...benchmarkRuntimeData,
  ...graphEvidenceRuntimeData,
  "src/lib/social/github-traction-a16z-speedrun-006.json",
  "src/lib/social/a16z-speedrun-006-attribution-reconciliation.json",
  "src/lib/social/a16z-speedrun-006-social-evidence.json",
  "src/lib/social/a16z-speedrun-006-social-accounts.json",
  "src/lib/social/verified-social-overrides.json",
  "src/lib/yc/summer-2026-companies.json",
  "src/lib/yc/spring-2026-companies.json"
];

const graphTraceExcludes = [
  ".git/**/*",
  ".github/**/*",
  "artifacts/**/*",
  "docs/**/*",
  "outputs/*.*",
  "outputs/attribution-feedback-loop/**/*",
  "outputs/final-verification-process/**/*",
  "outputs/longrun/**/*",
  "outputs/source-hunt/**/*",
  "public/brand/**/*",
  "public/evidence-thumbnails/**/*",
  "public/timelines/**/*",
  "scripts/**/*",
  "src/lib/social/logged-in-evidence-current.json",
  "src/lib/social/public-evidence-current.json",
  "src/lib/social/targeted-evidence-current.json",
  "src/**/*.{css,ts,tsx}",
  "supabase/**/*",
  "tests/**/*",
  "work/**/*",
  ".gitignore",
  "README.md",
  "next.config.mjs",
  "package-lock.json",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "tsconfig.tsbuildinfo",
  "vercel.json",
  "vitest.config.ts"
];
const debugGraphTraceExcludes = [
  ".git/**/*",
  ".github/**/*",
  "artifacts/**/*",
  "docs/**/*",
  "public/brand/**/*",
  "public/evidence-thumbnails/**/*",
  "public/timelines/**/*",
  "scripts/**/*",
  "src/lib/social/logged-in-evidence-current.json",
  "src/lib/social/public-evidence-current.json",
  "src/lib/social/targeted-evidence-current.json",
  "supabase/**/*",
  "tests/**/*",
  "work/**/*"
];
const adminDiagnosticsTraceExcludes = [
  ".git/**/*",
  ".github/**/*",
  "artifacts/**/*",
  "docs/**/*",
  "generated-runtime/**/*",
  "outputs/**/*",
  "public/**/*",
  "scripts/**/*",
  "src/**/*.json",
  "supabase/**/*",
  "tests/**/*",
  "work/**/*"
];
const fullGraphTraceExcludes = [
  ...graphTraceExcludes,
  "public/graph/**/*"
];
const insiderRecomputeTraceExcludes = [
  ...graphTraceExcludes,
  // The recompute route allowlists only base and Insider snapshots. Turbopack
  // also discovers these sibling files through the bounded dynamic path, but
  // they can never be opened by that route.
  "public/graph/*-yc-partners.json",
  "public/graph/manifest.json"
];
const insiderRuntimeSnapshots = [
  "public/graph/s2026.json",
  "public/graph/s2026-insiders.json",
  "public/graph/s26.json",
  "public/graph/s26-insiders.json",
  "public/graph/a16zsr006.json",
  "public/graph/a16zsr006-insiders.json"
];
const publishedGraphRuntimeSnapshots = [
  "public/graph/s2026.json",
  "public/graph/s2026-yc-partners.json",
  "public/graph/s2026-insiders.json",
  "public/graph/s26.json",
  "public/graph/s26-yc-partners.json",
  "public/graph/s26-insiders.json",
  "public/graph/a16zsr006.json",
  "public/graph/a16zsr006-yc-partners.json",
  "public/graph/a16zsr006-insiders.json"
];
// Next matches trace keys with substring semantics. The negative extglob keeps
// the lightweight graph snapshot bundle from leaking into /api/graph/full and
// /api/graph/refresh while still matching the canonical /api/graph route.
const canonicalGraphTraceKey = "/api/graph!(/**)";

/** @type {import('next').NextConfig} */
const nextConfig = {
  typedRoutes: true,
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  // Graph routes import the complete multi-batch evidence snapshot. Limiting
  // static-generation workers prevents each worker from materializing the
  // large catalog concurrently and exhausting local or Vercel build memory.
  experimental: { cpus: 2 },
  async redirects() {
    return [
      {
        source: "/yc-network-map",
        destination: "/",
        permanent: true
      },
      {
        source: "/yc-social-traction",
        destination: "/",
        permanent: true
      },
      {
        source: "/a16z-network-map",
        destination: "/?batch=A16ZSR006",
        permanent: true
      },
      {
        source: "/a16z-social-traction",
        destination: "/?batch=A16ZSR006",
        permanent: true
      }
    ];
  },
  outputFileTracingIncludes: {
    [canonicalGraphTraceKey]: [...benchmarkRuntimeData, ...publishedGraphRuntimeSnapshots],
    "/api/graph/full": graphRuntimeData,
    "/api/graph/refresh": [...graphRuntimeData, "public/graph/*.json"],
    "/debug/duplicates": graphRuntimeData,
    "/debug/evidence": graphRuntimeData,
    "/debug/instagram-coverage": [
      ...graphRuntimeData,
      "outputs/instagram-discovery-candidates.json"
    ],
    "/debug/scoring": graphRuntimeData,
    "/debug/thumbnails": graphRuntimeData,
    "/debug/workers": graphRuntimeData,
    "/api/insiders/recompute": [...insiderRuntimeSnapshots, ...benchmarkRuntimeData],
    "/api/companies/[slug]/timeline": [...timelineRuntimeData, ...timelineInternalRuntimeData],
    "/api/timeline/events/[eventId]": [...timelineRuntimeData, ...timelineInternalRuntimeData],
    "/api/admin/timeline/**/*": [...timelineRuntimeData, ...timelineInternalRuntimeData]
  },
  outputFileTracingExcludes: {
    [canonicalGraphTraceKey]: graphTraceExcludes,
    "/api/graph/full": fullGraphTraceExcludes,
    "/api/graph/refresh": graphTraceExcludes,
    "/api/insiders/recompute": insiderRecomputeTraceExcludes,
    "/api/admin/ingestion": adminDiagnosticsTraceExcludes,
    "/debug/duplicates": debugGraphTraceExcludes,
    "/debug/evidence": debugGraphTraceExcludes,
    "/debug/instagram-coverage": debugGraphTraceExcludes,
    "/debug/scoring": debugGraphTraceExcludes,
    "/debug/thumbnails": debugGraphTraceExcludes,
    "/debug/workers": debugGraphTraceExcludes
  }
};

export default nextConfig;
