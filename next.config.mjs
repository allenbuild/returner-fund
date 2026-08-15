const benchmarkRuntimeData = [
  "outputs/benchmarks/**/*.json",
];
const graphEvidenceRuntimeData = [
  "generated-runtime/graph/public-evidence-current.json",
  "generated-runtime/graph/logged-in-evidence-current.json",
  "generated-runtime/graph/targeted-evidence-current.json",
  "generated-runtime/graph/volume-evidence-current.json",
];
const timelineRuntimeData = [
  "public/timelines/**/*.json",
];
const timelineInternalRuntimeData = [
  "artifacts/company-timeline/coverage.json",
];
const dashboardRuntimeData = [
  "artifacts/dashboard/current.json",
  "public/dashboard/feed.json",
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
  "src/lib/social/volume-evidence-current.json",
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
  // Vercel's Node functions run the linux-x64 glibc Sharp build. Sharp selects
  // exactly one libc family at runtime, but Node File Trace conservatively
  // discovers the parallel musl packages as well. They cannot be loaded on the
  // deployed runtime and add roughly 16 MiB to every server-rendered debug page.
  "node_modules/@img/sharp-libvips-linuxmusl-*/**/*",
  "node_modules/@img/sharp-linuxmusl-*/**/*",
  "public/brand/**/*",
  "public/evidence-thumbnails/**/*",
  "public/timelines/**/*",
  "scripts/**/*",
  "src/lib/social/logged-in-evidence-current.json",
  "src/lib/social/public-evidence-current.json",
  "src/lib/social/targeted-evidence-current.json",
  "src/lib/social/volume-evidence-current.json",
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
  // Dashboard thumbnail URLs are accepted only from the reviewed media/CDN
  // hosts in src/lib/dashboard/thumbnail-policy.ts. The image optimizer keeps
  // full-sized third-party originals out of the browser and caps the response
  // size; it is not configured as a general-purpose image proxy.
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "avatars.githubusercontent.com", pathname: "/**" },
      { protocol: "https", hostname: "opengraph.githubassets.com", pathname: "/**" },
      { protocol: "https", hostname: "github.githubassets.com", pathname: "/**" },
      { protocol: "https", hostname: "pbs.twimg.com", pathname: "/**" },
      { protocol: "https", hostname: "media.licdn.com", pathname: "/**" },
      { protocol: "https", hostname: "static.licdn.com", pathname: "/**" },
      { protocol: "https", hostname: "**.cdninstagram.com", pathname: "/**" },
      { protocol: "https", hostname: "i.ytimg.com", pathname: "/**" },
      { protocol: "https", hostname: "yt3.ggpht.com", pathname: "/**" },
      { protocol: "https", hostname: "ph-files.imgix.net", pathname: "/**" },
      { protocol: "https", hostname: "ph-avatars.imgix.net", pathname: "/**" },
      // The dashboard's runtime thumbnail policy still permits only the
      // three exact Reddit media hosts; this optimizer pattern is compacted
      // to stay within Next's remote-pattern limit.
      { protocol: "https", hostname: "**.redd.it", pathname: "/**" },
      { protocol: "https", hostname: "cdn.bsky.app", pathname: "/**" },
      { protocol: "https", hostname: "www.technologyreview.com", pathname: "/**" },
      { protocol: "https", hostname: "wp.technologyreview.com", pathname: "/**" },
      { protocol: "https", hostname: "cdn.arstechnica.net", pathname: "/**" },
      { protocol: "https", hostname: "spectrum.ieee.org", pathname: "/**" },
      { protocol: "https", hostname: "news.mit.edu", pathname: "/**" },
      { protocol: "https", hostname: "static01.nyt.com", pathname: "/**" },
      { protocol: "https", hostname: "ichef.bbci.co.uk", pathname: "/**" },
      { protocol: "https", hostname: "i.guim.co.uk", pathname: "/**" },
      { protocol: "https", hostname: "www.engadget.com", pathname: "/**" },
      { protocol: "https", hostname: "media.wired.com", pathname: "/**" },
      { protocol: "https", hostname: "platform.theverge.com", pathname: "/**" },
      { protocol: "https", hostname: "image.theregister.com", pathname: "/**" },
      { protocol: "https", hostname: "images.ctfassets.net", pathname: "/**" },
      { protocol: "https", hostname: "assets.rbl.ms", pathname: "/**" },
      { protocol: "https", hostname: "gizmodo.com", pathname: "/**" },
      { protocol: "https", hostname: "helios-i.mashable.com", pathname: "/**" },
      { protocol: "https", hostname: "www.cnet.com", pathname: "/**" },
      { protocol: "https", hostname: "cdn.ex.co", pathname: "/**" },
      { protocol: "https", hostname: "9to5google.com", pathname: "/**" },
      { protocol: "https", hostname: "assets.science.nasa.gov", pathname: "/**" },
      { protocol: "https", hostname: "cdn.geekwire.com", pathname: "/**" },
      { protocol: "https", hostname: "cdn.mos.cms.futurecdn.net", pathname: "/**" },
      { protocol: "https", hostname: "cdn.thenewstack.io", pathname: "/**" },
      { protocol: "https", hostname: "eu-images.contentstack.com", pathname: "/**" },
      { protocol: "https", hostname: "imageio.forbes.com", pathname: "/**" },
      { protocol: "https", hostname: "media.datacenterdynamics.com", pathname: "/**" },
      { protocol: "https", hostname: "res.infoq.com", pathname: "/**" },
      { protocol: "https", hostname: "scx1.b-cdn.net", pathname: "/**" },
      { protocol: "https", hostname: "the-decoder.com", pathname: "/**" },
      { protocol: "https", hostname: "www.hpcwire.com", pathname: "/**" },
      { protocol: "https", hostname: "www.infoq.com", pathname: "/**" },
      { protocol: "https", hostname: "www.nasa.gov", pathname: "/**" },
      { protocol: "https", hostname: "www.sciencealert.com", pathname: "/**" },
      { protocol: "https", hostname: "www.techspot.com", pathname: "/**" },
      { protocol: "https", hostname: "**.tiktokcdn.com", pathname: "/**" },
      { protocol: "https", hostname: "**.tiktokcdn-us.com", pathname: "/**" },
      { protocol: "https", hostname: "**.hdslb.com", pathname: "/**" }
    ],
    qualities: [75],
    maximumRedirects: 0,
    maximumResponseBody: 5_000_000,
    dangerouslyAllowLocalIP: false,
    dangerouslyAllowSVG: false,
    contentDispositionType: "attachment"
  },
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
    "/api/yc-partners": ["public/graph/*.json"],
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
    "/api/admin/timeline/**/*": [...timelineRuntimeData, ...timelineInternalRuntimeData],
    "/dashboard": dashboardRuntimeData,
    "/api/dashboard": dashboardRuntimeData,
    "/api/dashboard/stories/[stableKey]/sources": dashboardRuntimeData
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
